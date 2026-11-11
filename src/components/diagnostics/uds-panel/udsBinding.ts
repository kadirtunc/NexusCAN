/**
 * Pure UDS panel binding helpers: synthetic runtime-bus keys, value decode / encode, request
 * grouping (one request per DID / memory address no matter how many widgets read it) and the
 * [min, max] write clamp.
 */
import type { SimulationSignalBindingDto } from '../../../types/simulation';
import type {
  UdsByteLen,
  UdsReadBinding,
  UdsWidgetDto,
  UdsWriteBinding,
} from '../../../types/uds';
import { ACCENT_HEX_MAP, makeSignalBusKey } from '../../simulation/virtualCanPacking';

export const UDS_MIN_POLL_MS = 50;

// ─── Hex helpers ─────────────────────────────────────────────────────────────

export function sanitizeHex(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 8);
}

export function parseHexId(raw: string): number | null {
  const clean = sanitizeHex(raw);
  if (clean.length === 0) return null;
  const n = Number.parseInt(clean, 16);
  return Number.isFinite(n) ? n : null;
}

function toHex(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

function bigEndianBytes(value: number, len: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (let i = 0; i < len; i += 1) {
    out.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return out;
}

// ─── Synthetic runtime-bus keys (never collide with DBC `makeBindingSignalKey`) ─

function readIdTag(r: UdsReadBinding): string {
  return r.service === 'read_did'
    ? `DID:${sanitizeHex(r.did)}`
    : `MEM:${sanitizeHex(r.address)}`;
}

function readSignalName(r: UdsReadBinding, textLen: number | null): string {
  return `${r.byteOffset}:${r.byteLen}:${r.signed ? 's' : 'u'}:${r.factor}:${r.offset}${
    textLen !== null ? `:t${textLen}` : ''
  }`;
}

/**
 * Bus key of a read binding: `UDS:<DID|MEM>:<id>::<byteOffset>:<byteLen>:<u|s>:<factor>:<offset>`.
 * Textbox widgets append `:t<textByteLen>` so differently sized text reads never share a key.
 */
export function udsReadBusKey(r: UdsReadBinding, textLen: number | null = null): string {
  return makeSignalBusKey(`UDS:${readIdTag(r)}`, readSignalName(r, textLen));
}

/** Text read length of a textbox widget (0 = rest of the response); null for non-textbox widgets. */
export function udsTextLenOf(w: Pick<UdsWidgetDto, 'kind' | 'config'>): number | null {
  if (w.kind !== 'textbox') return null;
  const n = Math.floor(w.config.textByteLen ?? 0);
  return Math.max(0, Math.min(255, Number.isFinite(n) ? n : 0));
}

export function udsWidgetReadKey(
  w: Pick<UdsWidgetDto, 'kind' | 'udsRead' | 'config'>
): string | null {
  return w.udsRead ? udsReadBusKey(w.udsRead, udsTextLenOf(w)) : null;
}

function writeIdTag(wr: UdsWriteBinding): string {
  return wr.service === 'write_mem'
    ? `MEM:${sanitizeHex(wr.address)}`
    : `DID:${sanitizeHex(wr.did)}`;
}

/** Hidden service id / label used in tags and tooltips. */
export function udsServiceLabel(service: UdsReadBinding['service'] | UdsWriteBinding['service']): string {
  switch (service) {
    case 'read_did':
      return '0x22';
    case 'read_mem':
      return '0x23';
    case 'write_did':
      return '0x2E';
    case 'write_mem':
      return '0x3D';
    case 'io_control':
      return '0x2F';
  }
}

// ─── Write range / clamp ─────────────────────────────────────────────────────

function rawMaxFor(byteLen: UdsByteLen): number {
  return 256 ** byteLen - 1;
}

/** Effective physical [min, max] a write may carry (explicit range ∩ encodable range). */
export function resolveWriteRange(
  w: Pick<UdsWidgetDto, 'udsRead' | 'udsWrite' | 'config'>
): { min: number; max: number } {
  const wr = w.udsWrite;
  if (!wr) return { min: 0, max: 0 };
  const a = wr.offset;
  const b = rawMaxFor(wr.byteLen) * wr.factor + wr.offset;
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);

  const explicitMin = wr.min ?? w.config.min ?? w.udsRead?.min;
  const explicitMax = wr.max ?? w.config.max ?? w.udsRead?.max;
  if (typeof explicitMin === 'number' && Number.isFinite(explicitMin)) {
    lo = Math.max(lo, explicitMin);
  }
  if (typeof explicitMax === 'number' && Number.isFinite(explicitMax)) {
    hi = Math.min(hi, explicitMax);
  }
  if (lo > hi) hi = lo;
  return { min: lo, max: hi };
}

export function clampToRange(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.max(range.min, Math.min(range.max, value));
}

// ─── Derived Simulation binding ──────────────────────────────────────────────

/**
 * Derives the `SimulationSignalBindingDto` that the shared Simulation widget renderers expect.
 * Read binding wins (value = polled DID); write-only widgets get a private `UDSW:` key.
 */
export function deriveSimulationBinding(
  w: Pick<UdsWidgetDto, 'kind' | 'udsRead' | 'udsWrite' | 'accentColor' | 'config'>
): SimulationSignalBindingDto | null {
  if (w.kind === 'group') return null;
  const color = ACCENT_HEX_MAP[w.accentColor];

  if (w.udsRead) {
    const r = w.udsRead;
    return {
      busId: 0,
      messageKey: `UDS:${readIdTag(r)}`,
      messageName: `UDS ${udsServiceLabel(r.service)} ${readIdTag(r).split(':')[1] ?? ''}`,
      arbId: 0,
      isExtended: false,
      signalName: readSignalName(r, udsTextLenOf(w)),
      unit: r.unit,
      min: r.min,
      max: r.max,
      factor: r.factor,
      offset: r.offset,
      decimals: r.decimals,
      color,
    };
  }

  if (w.udsWrite) {
    const wr = w.udsWrite;
    const range = resolveWriteRange(w);
    return {
      busId: 0,
      messageKey: `UDSW:${writeIdTag(wr)}`,
      messageName: `UDS ${udsServiceLabel(wr.service)} ${writeIdTag(wr).split(':')[1] ?? ''}`,
      arbId: 0,
      isExtended: false,
      signalName: `${wr.byteOffset}:${wr.byteLen}:w:${wr.factor}:${wr.offset}:${wr.ioOption}`,
      unit: '',
      min: range.min,
      max: range.max,
      factor: wr.factor,
      offset: wr.offset,
      decimals: 0,
      color,
    };
  }
  return null;
}

/** Rebuilds `binding` after any edit of kind / accent / UDS bindings. */
export function withDerivedBinding(w: UdsWidgetDto): UdsWidgetDto {
  return { ...w, binding: deriveSimulationBinding(w) };
}

// ─── Read decode ─────────────────────────────────────────────────────────────

/** Decodes the physical value out of the response data payload; null if payload is too short. */
export function decodeReadValue(r: UdsReadBinding, data: readonly number[]): number | null {
  const end = r.byteOffset + r.byteLen;
  if (r.byteOffset < 0 || data.length < end) return null;
  let raw = 0;
  for (let i = r.byteOffset; i < end; i += 1) {
    raw = raw * 256 + (data[i] ?? 0);
  }
  if (r.signed) {
    const full = 256 ** r.byteLen;
    if (raw >= full / 2) raw -= full;
  }
  return raw * r.factor + r.offset;
}

// ─── Read request grouping (DID-level dedupe) ────────────────────────────────

export interface UdsReadConsumer {
  key: string;
  read: UdsReadBinding;
  /** Textbox consumers also receive the raw bytes; `len` 0 = rest of the response. */
  textLen: number | null;
}

/** Bytes assumed for a memory read whose textbox length is "rest of response". */
export const UDS_MEM_TEXT_DEFAULT_LEN = 64;

export interface UdsReadRequest {
  /** Dedupe id, e.g. `DID:F105` or `MEM:20004800`. */
  id: string;
  service: UdsReadBinding['service'];
  did: number | null;
  address: number | null;
  /** Bytes needed from the payload (max over consumers of byteOffset + byteLen). */
  size: number;
  intervalMs: number;
  consumers: UdsReadConsumer[];
}

export interface UdsInvalidConsumer {
  key: string;
}

export function buildReadRequests(
  widgets: readonly UdsWidgetDto[],
  defaultPollMs: number
): { requests: UdsReadRequest[]; invalid: UdsInvalidConsumer[] } {
  const byId = new Map<string, UdsReadRequest>();
  const invalid: UdsInvalidConsumer[] = [];

  for (const w of widgets) {
    const r = w.udsRead;
    if (!r) continue;
    const key = udsWidgetReadKey(w) ?? udsReadBusKey(r);
    const textLen = udsTextLenOf(w);
    const idValue =
      r.service === 'read_did' ? parseHexId(r.did) : parseHexId(r.address);
    if (idValue === null || (r.service === 'read_did' && idValue > 0xffff)) {
      invalid.push({ key });
      continue;
    }
    const tag = readIdTag(r);
    const interval = Math.max(
      UDS_MIN_POLL_MS,
      r.pollMs > 0 ? r.pollMs : defaultPollMs
    );
    let req = byId.get(tag);
    if (!req) {
      req = {
        id: tag,
        service: r.service,
        did: r.service === 'read_did' ? idValue : null,
        address: r.service === 'read_mem' ? idValue : null,
        size: 0,
        intervalMs: interval,
        consumers: [],
      };
      byId.set(tag, req);
    }
    req.intervalMs = Math.min(req.intervalMs, interval);
    const textSpan = textLen === null ? 0 : textLen > 0 ? textLen : r.service === 'read_mem' ? UDS_MEM_TEXT_DEFAULT_LEN : 1;
    req.size = Math.max(req.size, r.byteOffset + Math.max(r.byteLen, textSpan));
    if (!req.consumers.some((c) => c.key === key)) {
      req.consumers.push({ key, read: r, textLen });
    }
  }
  return { requests: [...byId.values()], invalid };
}

// ─── Write request encoding ──────────────────────────────────────────────────

export type UdsWriteEncodeError = 'invalidId' | 'offsetUnsupported' | 'tooLong';

export interface UdsEncodedWrite {
  sid: number;
  data: number[];
  /** Physical value after clamping to [min, max] (numeric writes only; NaN for byte writes). */
  clampedValue: number;
  rawValue: number;
  wasClamped: boolean;
  label: string;
  /** Human readable target (service + id) for confirmation dialogs. */
  target: string;
}

type AssembleResult =
  | { ok: true; sid: number; data: number[]; label: string; target: string }
  | { ok: false; error: UdsWriteEncodeError };

const MAX_WRITE_BYTES = 4000;

/** Builds the raw UDS request for any write service from the already encoded value bytes. */
function assembleWrite(wr: UdsWriteBinding, valueBytes: readonly number[]): AssembleResult {
  if (wr.byteOffset !== 0) return { ok: false, error: 'offsetUnsupported' };
  if (valueBytes.length > MAX_WRITE_BYTES) return { ok: false, error: 'tooLong' };

  if (wr.service === 'write_mem') {
    const addr = parseHexId(wr.address);
    if (addr === null) return { ok: false, error: 'invalidId' };
    // addressAndLengthFormatIdentifier: high nibble = size length, low nibble = address length
    const sizeLen = valueBytes.length > 255 ? 2 : 1;
    const fmt = (sizeLen << 4) | 4;
    return {
      ok: true,
      sid: 0x3d,
      data: [fmt, ...bigEndianBytes(addr, 4), ...bigEndianBytes(valueBytes.length, sizeLen), ...valueBytes],
      label: `WriteMemoryByAddress 0x${toHex(addr, 8)}`,
      target: `0x3D @0x${toHex(addr, 8)}`,
    };
  }

  const did = parseHexId(wr.did);
  if (did === null || did > 0xffff) return { ok: false, error: 'invalidId' };
  const didBytes = bigEndianBytes(did, 2);

  if (wr.service === 'io_control') {
    const io = Number.parseInt(wr.ioOption, 16);
    // returnControlToECU / resetToDefault / freezeCurrentState carry no controlState bytes
    const state = wr.ioOption === '03' ? valueBytes : [];
    return {
      ok: true,
      sid: 0x2f,
      data: [...didBytes, io, ...state],
      label: `InputOutputControl 0x${toHex(did, 4)} [${wr.ioOption}]`,
      target: `0x2F DID 0x${toHex(did, 4)} [${wr.ioOption}]`,
    };
  }

  return {
    ok: true,
    sid: 0x2e,
    data: [...didBytes, ...valueBytes],
    label: `WriteDataByIdentifier 0x${toHex(did, 4)}`,
    target: `0x2E DID 0x${toHex(did, 4)}`,
  };
}

export function encodeWriteRequest(
  w: Pick<UdsWidgetDto, 'udsRead' | 'udsWrite' | 'config'>,
  physicalValue: number
): { ok: true; request: UdsEncodedWrite } | { ok: false; error: UdsWriteEncodeError } {
  const wr = w.udsWrite;
  if (!wr) return { ok: false, error: 'invalidId' };

  const range = resolveWriteRange(w);
  const clamped = clampToRange(physicalValue, range);
  const factor = wr.factor === 0 ? 1 : wr.factor;
  const rawMax = rawMaxFor(wr.byteLen);
  const rawValue = Math.max(0, Math.min(rawMax, Math.round((clamped - wr.offset) / factor)));
  const assembled = assembleWrite(wr, bigEndianBytes(rawValue, wr.byteLen));
  if (!assembled.ok) return assembled;
  return {
    ok: true,
    request: {
      sid: assembled.sid,
      data: assembled.data,
      clampedValue: clamped,
      rawValue,
      wasClamped: Math.abs(clamped - physicalValue) > 1e-9,
      label: assembled.label,
      target: assembled.target,
    },
  };
}

/** Raw byte payload write (textbox ascii / hex). No numeric clamp applies; length rules are checked by the caller. */
export function encodeWriteBytesRequest(
  w: Pick<UdsWidgetDto, 'udsWrite'>,
  bytes: Uint8Array
): { ok: true; request: UdsEncodedWrite } | { ok: false; error: UdsWriteEncodeError } {
  const wr = w.udsWrite;
  if (!wr) return { ok: false, error: 'invalidId' };
  const assembled = assembleWrite(wr, Array.from(bytes));
  if (!assembled.ok) return assembled;
  return {
    ok: true,
    request: {
      sid: assembled.sid,
      data: assembled.data,
      clampedValue: Number.NaN,
      rawValue: Number.NaN,
      wasClamped: false,
      label: assembled.label,
      target: assembled.target,
    },
  };
}
