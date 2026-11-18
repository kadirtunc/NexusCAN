/**
 * Execution of the `uds_flash_image` block: image loading (file -> base64 -> `cmd_flash_load_image`),
 * safety pre-flight, the download itself (real: `cmd_flash_download` + progress Channel; DEMO: local
 * simulation) and cancellation (Flow Stop / Panic Stop -> `cmd_flash_cancel`).
 */
import { t } from '../../i18n';
import { diagnosticsStore } from '../../store/diagnosticsStore';
import { telemetryStore } from '../../store/telemetryStore';
import {
  apiFlashCancel,
  apiFlashDownload,
  apiFlashLoadImage,
  apiFlashReleaseImage,
  FlashCallError,
} from '../../services/flashApi';
import {
  bytesToBase64,
  formatAddress,
  formatCrc32,
  formatFromFileName,
  parseHexNumber,
  resolveLoadFormat,
} from '../../services/flashCodec';
import { simulateFlash, type SimCancelToken } from '../../services/flashSim';
import type {
  DownloadConfigDto,
  FirmwareFormat,
  FirmwareImageSummaryDto,
  FirmwareSegmentSummaryDto,
  FlashErrorDto,
  FlashImageHandleDto,
  FlashPhase,
  FlashProgressDto,
  FlashReportDto,
} from '../../types/flash';
import type { DiagSessionConfigDto } from '../../types/udsClient';
import type { FlowBlock } from './types';
import type { FlowTransport } from './flowTransport';
import { flashRuntime } from './flashRuntime';
import { crc32 } from './flowAlgos';

export interface FlashOutcome {
  message: string;
  result?: unknown;
  nextPort?: string;
  outputs?: Record<string, unknown>;
  /** Block failed: shown as an error, `fail_out` is taken. */
  failed?: boolean;
}

// ─── Block configuration ───────────────────────────────────────────────────────

/**
 * Optional per-segment erase BEFORE the download (OEMs that erase by address + length):
 * `31 01 <routineId> <eraseALFID> <address> <length>` for every segment of the loaded image.
 * OEMs that erase by logical-block id keep a separate `uds_routine_ctrl` block instead.
 */
export interface FlashEraseSettings {
  mode: 'none' | 'per_segment';
  routineId: number;
  /** addressAndLengthFormatIdentifier of the erase record (high nibble = length bytes, low = address bytes). */
  alfid: number;
  timeoutMs: number;
  busyRetryMax: number;
  busyRetryDelayMs: number | null;
  /** Required routineStatus byte (null = any positive response is accepted). */
  expectedStatus: number | null;
}

/**
 * Post-download verification:
 * - `none` / `total_crc32`: nothing in-block (`total_crc32` = wire the `crc32` output into a
 *   following check routine block: the previous behaviour);
 * - `per_segment_crc32`: `31 01 <routineId> <CRC32 BE of the segment>` per segment, requiring
 *   routineStatus == `expectedStatus`.
 */
export interface FlashVerifySettings {
  mode: 'none' | 'per_segment_crc32' | 'total_crc32';
  routineId: number;
  expectedStatus: number;
  timeoutMs: number;
}

export interface FlashBlockSettings {
  format: string;
  baseAddress: number;
  download: DownloadConfigDto;
  erase: FlashEraseSettings;
  verify: FlashVerifySettings;
}

function hexByte(raw: unknown, field: string, fallback: string): number {
  const n = parseHexNumber(raw === undefined || raw === '' ? fallback : raw);
  if (n === null || n > 0xff) throw new Error(t('diagReal.flow.invalidHex', { field }));
  return n;
}

function intField(raw: unknown): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function routineIdField(raw: unknown, field: string, fallback: string): number {
  const n = parseHexNumber(raw === undefined || raw === '' ? fallback : raw);
  if (n === null || n > 0xffff) throw new Error(t('diagReal.flow.invalidHex', { field }));
  return n;
}

function optionalStatus(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return hexByte(raw, field, '00');
}

function numberOr(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Reads and validates the saved block settings (throws a localized Error on invalid input). */
export function readFlashSettings(cfg: Record<string, unknown>): FlashBlockSettings {
  const format = String(cfg['format'] ?? 'auto');
  const base = parseHexNumber(cfg['base_address'] === undefined || cfg['base_address'] === '' ? '0' : cfg['base_address']);
  if (base === null) throw new Error(t('flash.err.badBase'));
  const alfid = hexByte(cfg['alfid'], 'ALFID', '44');
  const sizeLen = alfid >> 4;
  const addrLen = alfid & 0x0f;
  // Rust engine (DownloadConfig::validate) accepts 1..=4 bytes for each nibble (u32 address/length).
  if (sizeLen < 1 || sizeLen > 4 || addrLen < 1 || addrLen > 4) throw new Error(t('flash.err.badAlfid'));
  const dfi = hexByte(cfg['dfi'], 'DFI', '00');
  const maxBlock = intField(cfg['max_block_len']);
  const retries = Math.min(10, Math.max(0, intField(cfg['retries'] ?? 2)));
  const timeout = intField(cfg['transfer_timeout_ms']);
  const download: DownloadConfigDto = {
    dataFormatIdentifier: dfi,
    addressAndLengthFormatIdentifier: alfid,
    maxBlockLenOverride: maxBlock > 0 ? maxBlock : null,
    transferTimeoutMs: timeout > 0 ? timeout : null,
    retriesPerBlock: retries,
  };

  const eraseMode = cfg['erase_mode'] === 'per_segment' ? 'per_segment' : 'none';
  const eraseAlfid = hexByte(cfg['erase_alfid'], 'erase ALFID', '44');
  if (eraseMode === 'per_segment' && ((eraseAlfid >> 4) < 1 || (eraseAlfid >> 4) > 4 || (eraseAlfid & 0x0f) < 1 || (eraseAlfid & 0x0f) > 4)) {
    throw new Error(t('flash.err.badAlfid'));
  }
  const busyDelay = numberOr(cfg['erase_busy_delay_ms'], 200);
  const erase: FlashEraseSettings = {
    mode: eraseMode,
    routineId: routineIdField(cfg['erase_routine_id'], 'erase routine', 'FF00'),
    alfid: eraseAlfid,
    timeoutMs: Math.min(600_000, Math.max(100, numberOr(cfg['erase_timeout_ms'], 30_000))),
    busyRetryMax: Math.min(10, Math.max(0, numberOr(cfg['erase_busy_retry'], 3))),
    busyRetryDelayMs: busyDelay > 0 ? Math.min(5000, Math.max(10, busyDelay)) : null,
    expectedStatus: optionalStatus(cfg['erase_expected_status'], 'erase status'),
  };

  const vm = cfg['verify_mode'];
  const verify: FlashVerifySettings = {
    mode: vm === 'per_segment_crc32' || vm === 'none' ? vm : 'total_crc32',
    routineId: routineIdField(cfg['verify_routine_id'], 'verify routine', '0202'),
    expectedStatus: hexByte(cfg['verify_expected_status'], 'verify status', '00'),
    timeoutMs: Math.min(600_000, Math.max(100, numberOr(cfg['verify_timeout_ms'], 5000))),
  };
  return { format, baseAddress: base, download, erase, verify };
}

/** `value` big-endian in exactly `n` bytes; null when it does not fit. */
export function beBytes(value: number, n: number): number[] | null {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * n)) return null;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
  return out;
}

/** Erase request data (after SID 0x31): `01 <rid> <alfid> <address> <length>`. Throws when it does not fit the ALFID. */
export function eraseRequestData(seg: FirmwareSegmentSummaryDto, erase: FlashEraseSettings): number[] {
  const addr = beBytes(seg.address, erase.alfid & 0x0f);
  const len = beBytes(seg.length, erase.alfid >> 4);
  if (addr === null || len === null) {
    throw new Error(t('flash.err.addrRange', { addr: formatAddress(seg.address), alfid: hexNrc(erase.alfid).slice(2) }));
  }
  return [0x01, (erase.routineId >> 8) & 0xff, erase.routineId & 0xff, erase.alfid, ...addr, ...len];
}

/** Verify request data (after SID 0x31): `01 <rid> <CRC32 BE>`. */
export function verifyRequestData(seg: FirmwareSegmentSummaryDto, verify: FlashVerifySettings): number[] {
  const c = seg.crc32 >>> 0;
  return [0x01, (verify.routineId >> 8) & 0xff, verify.routineId & 0xff, (c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
}

/** Base address is only meaningful for raw binaries (explicit `binary`, or `auto` on a `.bin`). */
export function usesBaseAddress(format: string, fileName: string): boolean {
  return resolveLoadFormat(format, fileName) === 'binary';
}

// ─── Image loading ─────────────────────────────────────────────────────────────

const DEMO_BASE = 0x08000000;
const loadTokens = new Map<string, number>();
let tokenSeq = 0;

function releaseBackendImage(state: { handle: FlashImageHandleDto | null; mock: boolean }): void {
  if (state.handle && !state.mock) void apiFlashReleaseImage(state.handle.imageId).catch(() => undefined);
}

function mockHandle(fileName: string, bytes: Uint8Array, format: string, base: number): FlashImageHandleDto {
  const resolved = resolveLoadFormat(format, fileName);
  const fmt: FirmwareFormat = resolved === 'auto' ? (formatFromFileName(fileName) ?? 'intelHex') : resolved;
  const address = fmt === 'binary' ? base : DEMO_BASE;
  const c = crc32(bytes);
  return {
    imageId: `demo-${++tokenSeq}`,
    fileName,
    format: fmt,
    summary: { segments: [{ address, length: bytes.length, crc32: c }], totalBytes: bytes.length, crc32: c },
  };
}

/** Synthetic image used when a DEMO run has no picked file (64 KiB, deterministic pattern). */
function demoDefaultHandle(): FlashImageHandleDto {
  const data = new Uint8Array(65536);
  for (let i = 0; i < data.length; i++) data[i] = (0x20 + i) & 0xff;
  return mockHandle('demo_firmware.bin', data, 'binary', DEMO_BASE);
}

/**
 * File -> ArrayBuffer -> chunked base64 -> `cmd_flash_load_image` (real) or local fake summary (DEMO).
 * The `File` reference is kept so a later format / base address change can reload it.
 */
export async function loadImageFromFile(
  blockId: string,
  file: File,
  cfg: Record<string, unknown>,
  demo: boolean,
): Promise<void> {
  const token = ++tokenSeq;
  loadTokens.set(blockId, token);
  const prev = flashRuntime.getImage(blockId);
  flashRuntime.patchImage(blockId, { loading: true, loadError: null, file });
  try {
    const settings = readFlashSettings(cfg);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let handle: FlashImageHandleDto;
    if (demo) {
      handle = mockHandle(file.name, bytes, settings.format, settings.baseAddress);
    } else {
      const format = resolveLoadFormat(settings.format, file.name);
      handle = await apiFlashLoadImage({
        fileName: file.name,
        format,
        baseAddress: format === 'binary' ? settings.baseAddress : 0,
        dataBase64: bytesToBase64(bytes),
      });
    }
    if (loadTokens.get(blockId) !== token) {
      releaseBackendImage({ handle, mock: demo });
      return;
    }
    releaseBackendImage(prev);
    flashRuntime.patchImage(blockId, {
      handle,
      mock: demo,
      file,
      loadedFormat: settings.format,
      loadedBase: settings.baseAddress,
      loading: false,
      loadError: null,
    });
  } catch (e) {
    if (loadTokens.get(blockId) !== token) return;
    const msg = e instanceof Error ? e.message : String(e);
    flashRuntime.patchImage(blockId, { loading: false, loadError: msg });
  }
}

export function clearImage(blockId: string): void {
  loadTokens.set(blockId, ++tokenSeq);
  releaseBackendImage(flashRuntime.getImage(blockId));
  flashRuntime.removeImage(blockId);
}

// ─── Error text ────────────────────────────────────────────────────────────────

export function hexNrc(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** One-line description of a structured flash error (run log / block status). */
export function flashErrorSummary(e: FlashErrorDto): string {
  const parts: string[] = [`${t(`flash.err.kind.${e.kind}`)} @ ${t(`flash.phase.${e.phase}`)}`];
  if (e.segmentIndex !== null) parts.push(`${t('flash.err.segment')} ${e.segmentIndex}`);
  if (e.address !== null) parts.push(formatAddress(e.address));
  if (e.offset !== null) parts.push(`+${e.offset}`);
  if (e.lastNrc !== null) parts.push(`NRC ${hexNrc(e.lastNrc)}${e.lastNrcName ? ` ${e.lastNrcName}` : ''}`);
  if (e.message) parts.push(e.message);
  return parts.join(' · ');
}

// ─── Run / cancel ──────────────────────────────────────────────────────────────

interface ActiveRun {
  cancel: () => void;
}

const activeRuns = new Map<string, ActiveRun>();

/** Flow Stop / Panic Stop: abort every flash download started by a flow (`cmd_flash_cancel` per tab config). */
export function cancelAllFlashRuns(): void {
  for (const run of [...activeRuns.values()]) {
    try {
      run.cancel();
    } catch {
      // Cancel must always reach the next run.
    }
  }
}

function preflightBus(tabId: string): void {
  const tab = diagnosticsStore.getState().tabs.find((x) => x.id === tabId);
  if (!tab || !tab.session.connected) throw new Error(t('flash.err.notConnected'));
  const busId = tab.session.config.busId;
  const bus = telemetryStore.getHeaderSlice().buses.find((b) => b.busId === busId && b.connected);
  if (!bus) throw new Error(t('flash.err.noBus', { bus: busId }));
  // Same condition as DiagSessionSetup `needsArm`: Listen-Only or TX not armed.
  if (bus.listenOnly || !bus.txArmed) throw new Error(t('flash.err.notArmed', { bus: busId }));
}

/** Real mode: a usable loaded image for this block (reloads the kept file when settings changed). */
async function ensureRealImage(block: FlowBlock, settings: FlashBlockSettings): Promise<FlashImageHandleDto> {
  let img = flashRuntime.getImage(block.id);
  const stale = (): boolean =>
    img.handle === null ||
    img.mock ||
    img.loadedFormat !== settings.format ||
    (usesBaseAddress(settings.format, img.handle?.fileName ?? img.file?.name ?? '') && img.loadedBase !== settings.baseAddress);
  if (stale() && img.file !== null) {
    await loadImageFromFile(block.id, img.file, block.config, false);
    img = flashRuntime.getImage(block.id);
    if (img.loadError !== null) throw new Error(img.loadError);
  }
  if (stale() || img.handle === null) throw new Error(t('flash.err.noImage'));
  return img.handle;
}

/**
 * The `cmd_flash_*` side of a real flash run. `realFlashBackend` talks to the Tauri backend; the
 * headless flasher test injects a stub through `FlowTransport.flash`.
 */
export interface FlashBackend {
  /** Pre-flight (Listen-Only / Arm, session, image). Throws BEFORE anything is transmitted. */
  prepare(block: FlowBlock, settings: FlashBlockSettings, tabId: string): Promise<{ handle: FlashImageHandleDto; dto: DiagSessionConfigDto }>;
  download(dto: DiagSessionConfigDto, imageId: string, cfg: DownloadConfigDto, onProgress: (p: FlashProgressDto) => void): Promise<FlashReportDto>;
  cancel(dto: DiagSessionConfigDto): Promise<void>;
}

export const realFlashBackend: FlashBackend = {
  async prepare(block, settings, tabId) {
    preflightBus(tabId);
    const dto = diagnosticsStore.getTabConfigDto(tabId);
    if (dto === null) throw new Error(t('flash.err.notConnected'));
    const handle = await ensureRealImage(block, settings);
    return { handle, dto };
  },
  download: (dto, imageId, cfg, onProgress) => apiFlashDownload(dto, imageId, cfg, onProgress),
  cancel: (dto) => apiFlashCancel(dto),
};

function successOutcome(summary: FirmwareImageSummaryDto, report: FlashReportDto): FlashOutcome {
  return {
    message: t('flash.run.ok', { bytes: report.totalBytes, blocks: report.totalBlocks, ms: Math.round(report.durationMs) }),
    result: report,
    outputs: { crc32: summary.crc32 >>> 0, report },
  };
}

export interface FlashRunEnv {
  demo: boolean;
  /** Diagnostics tab the flow run is pinned to (null in DEMO). */
  tabId: string | null;
  log: (msg: string) => void;
  /** Transport of the run: the per-segment erase / verify routines go through it (normal gated path). */
  transport: FlowTransport;
  /** Override of the `cmd_flash_*` backend (tests); default `transport.flash ?? realFlashBackend`. */
  backend?: FlashBackend;
}

function cancelledError(phase: FlashPhase, segmentIndex: number | null, address: number | null, segmentsCompleted: number): FlashErrorDto {
  return {
    kind: 'cancelled',
    phase,
    segmentIndex,
    address,
    offset: null,
    blockCounter: null,
    lastNrc: null,
    lastNrcName: null,
    diagCode: null,
    bytesDone: 0,
    segmentsCompleted,
    message: '',
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs one `uds_flash_image` block. Pre-flight problems (bad settings, Listen-Only / disarmed bus,
 * no image) THROW before anything is sent; erase / download / verify failures return a `failed`
 * outcome (fail_out) with a message naming the segment, address and NRC.
 *
 * Order: pre-flight → [erase per segment] → download (backend 0x34/0x36/0x37) → [verify per segment].
 */
export async function runFlashBlock(block: FlowBlock, env: FlashRunEnv): Promise<FlashOutcome> {
  const settings = readFlashSettings(block.config);
  const { demo, tabId, log, transport } = env;
  const backend = env.backend ?? transport.flash ?? realFlashBackend;

  let handle: FlashImageHandleDto;
  let configDto: DiagSessionConfigDto | null = null;
  if (demo) {
    const img = flashRuntime.getImage(block.id);
    handle = img.handle !== null && img.mock ? img.handle : demoDefaultHandle();
  } else {
    if (tabId === null) throw new Error(t('flash.err.notConnected'));
    const prepared = await backend.prepare(block, settings, tabId);
    handle = prepared.handle;
    configDto = prepared.dto;
  }

  const summary = handle.summary;
  const segs = summary.segments;
  // Validate the erase records up-front: a segment that does not fit the erase ALFID must fail
  // before the first erase request goes out.
  const eraseData = settings.erase.mode === 'per_segment' ? segs.map((sg) => eraseRequestData(sg, settings.erase)) : [];

  flashRuntime.beginRun(block.id, demo);
  log(t('flash.log.start', { file: handle.fileName, segments: segs.length, bytes: summary.totalBytes, crc: formatCrc32(summary.crc32) }));

  const token: SimCancelToken = { cancelled: false };
  const dto = configDto;
  const run: ActiveRun = {
    cancel: () => {
      token.cancelled = true;
      if (!demo && dto !== null) void backend.cancel(dto).catch(() => undefined);
    },
  };
  activeRuns.set(block.id, run);

  try {
    // ── 1. Erase per segment (optional) ─────────────────────────────────────
    for (let i = 0; i < eraseData.length; i++) {
      const sg = segs[i];
      if (token.cancelled) return failOutcome(block.id, cancelledError('requestDownload', i, sg.address, 0), null, log);
      flashRuntime.setStage(block.id, { kind: 'erase', index: i + 1, count: segs.length });
      const where = { i: i + 1, n: segs.length, addr: formatAddress(sg.address), len: sg.length };
      log(t('flash.log.erase', { ...where, rid: settings.erase.routineId.toString(16).toUpperCase().padStart(4, '0') }));
      let pdu: number[];
      try {
        pdu = await transport.request(0x31, eraseData[i], {
          timeoutMs: settings.erase.timeoutMs,
          busyRetryMax: settings.erase.busyRetryMax,
          busyRetryDelayMs: settings.erase.busyRetryDelayMs,
        });
      } catch (e) {
        return failOutcome(block.id, null, t('flash.erase.fail', { ...where, msg: errText(e) }), log);
      }
      const status = pdu[4];
      if (settings.erase.expectedStatus !== null && status !== settings.erase.expectedStatus) {
        return failOutcome(block.id, null, t('flash.erase.badStatus', {
          ...where,
          got: status === undefined ? '--' : hexNrc(status).slice(2),
          exp: hexNrc(settings.erase.expectedStatus).slice(2),
        }), log);
      }
    }
    if (token.cancelled) return failOutcome(block.id, cancelledError('requestDownload', 0, segs[0]?.address ?? null, 0), null, log);

    // ── 2. Download (0x34 → 0x36* → 0x37) ───────────────────────────────────
    flashRuntime.setStage(block.id, eraseData.length > 0 || settings.verify.mode === 'per_segment_crc32'
      ? { kind: 'download', index: 0, count: segs.length }
      : null);
    let report: FlashReportDto;
    if (demo) {
      const res = await simulateFlash(summary, (p) => flashRuntime.pushProgress(block.id, p), { token });
      if (res.cancelled) {
        const err: FlashErrorDto = { ...cancelledError('transfer', res.segmentIndex, res.address, res.segmentsCompleted), bytesDone: res.bytesDone };
        return failOutcome(block.id, err, null, log);
      }
      report = res.report;
    } else {
      if (dto === null) throw new Error(t('flash.err.notConnected'));
      try {
        report = await backend.download(dto, handle.imageId, settings.download, (p) => flashRuntime.pushProgress(block.id, p));
      } catch (e) {
        const fe = e instanceof FlashCallError ? e : null;
        return failOutcome(block.id, fe?.flash ?? null, errText(e), log);
      }
    }
    log(t('flash.log.ok', { bytes: report.totalBytes, ms: Math.round(report.durationMs) }));

    // ── 3. Verify per segment (optional) ────────────────────────────────────
    if (settings.verify.mode === 'per_segment_crc32') {
      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        if (token.cancelled) return failOutcome(block.id, cancelledError('done', i, sg.address, segs.length), null, log);
        flashRuntime.setStage(block.id, { kind: 'verify', index: i + 1, count: segs.length });
        const where = { i: i + 1, n: segs.length, addr: formatAddress(sg.address), crc: formatCrc32(sg.crc32) };
        log(t('flash.log.verify', { ...where, rid: settings.verify.routineId.toString(16).toUpperCase().padStart(4, '0') }));
        let pdu: number[];
        try {
          pdu = await transport.request(0x31, verifyRequestData(sg, settings.verify), { timeoutMs: settings.verify.timeoutMs });
        } catch (e) {
          return failOutcome(block.id, null, t('flash.verify.fail', { ...where, msg: errText(e) }), log);
        }
        const status = pdu[4];
        if (status === undefined) return failOutcome(block.id, null, t('flash.verify.noStatus', where), log);
        if (status !== settings.verify.expectedStatus) {
          return failOutcome(block.id, null, t('flash.verify.badStatus', {
            ...where,
            got: hexNrc(status).slice(2),
            exp: hexNrc(settings.verify.expectedStatus).slice(2),
          }), log);
        }
      }
      log(t('flash.log.verifyOk', { n: segs.length }));
    }

    flashRuntime.finishRun(block.id, { status: 'done', report });
    return successOutcome(summary, report);
  } catch (e) {
    const fe = e instanceof FlashCallError ? e : null;
    return failOutcome(block.id, fe?.flash ?? null, errText(e), log);
  } finally {
    activeRuns.delete(block.id);
  }
}

function failOutcome(
  blockId: string,
  error: FlashErrorDto | null,
  text: string | null,
  log: (msg: string) => void,
): FlashOutcome {
  const cancelled = error?.kind === 'cancelled';
  const message = error !== null ? flashErrorSummary(error) : (text ?? t('flash.err.unknown'));
  flashRuntime.finishRun(blockId, { status: cancelled ? 'cancelled' : 'error', error, errorText: error === null ? message : null });
  log(t(cancelled ? 'flash.log.cancelled' : 'flash.log.fail', { msg: message }));
  return { message, result: error ?? undefined, failed: true, nextPort: 'fail_out', outputs: {} };
}
