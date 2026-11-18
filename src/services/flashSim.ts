/**
 * DEMO-only local flash simulation (Diagnostics Demo switch). Nothing is parsed or transmitted: it
 * replays fake progress derived from the image summary sizes so the UI is demoable without the
 * backend. Never reachable in real mode.
 */
import type {
  FirmwareImageSummaryDto,
  FlashProgressDto,
  FlashReportDto,
  SegmentReportDto,
} from '../types/flash';

export interface SimCancelToken {
  cancelled: boolean;
}

export interface SimOptions {
  /** Total wall time of the simulated download (default 3000 ms). */
  durationMs?: number;
  /** Simulated negotiated TransferData payload size (default 1024 B). */
  blockLen?: number;
  token: SimCancelToken;
  /** Tick period (default 16 ms ≈ 60 Hz, like the backend throttle). */
  tickMs?: number;
}

export type SimResult =
  | { cancelled: false; report: FlashReportDto }
  | { cancelled: true; bytesDone: number; segmentsCompleted: number; segmentIndex: number; address: number };

const REQ_MS = 80;
const EXIT_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function simulateFlash(
  summary: FirmwareImageSummaryDto,
  onProgress: (p: FlashProgressDto) => void,
  opts: SimOptions,
): Promise<SimResult> {
  const duration = opts.durationMs ?? 3000;
  const blockLen = Math.max(1, opts.blockLen ?? 1024);
  const tick = opts.tickMs ?? 16;
  const segs = summary.segments;
  const count = segs.length;
  const overhead = count * (REQ_MS + EXIT_MS);
  const transferMs = Math.max(duration - overhead, count * 10);
  const total = Math.max(1, summary.totalBytes);
  const t0 = Date.now();
  const reports: SegmentReportDto[] = [];
  let doneBefore = 0;

  const cancelled = (i: number, bytes: number): SimResult => ({
    cancelled: true,
    bytesDone: doneBefore + bytes,
    segmentsCompleted: i,
    segmentIndex: i,
    address: segs[i]?.address ?? 0,
  });

  const emit = (i: number, bytesDone: number, phase: FlashProgressDto['phase']): void => {
    const seg = segs[i];
    onProgress({
      segmentIndex: i,
      segmentCount: count,
      segmentAddress: seg.address,
      bytesDone,
      bytesTotal: seg.length,
      blockCounter: bytesDone === 0 ? 0 : Math.ceil(bytesDone / blockLen) & 0xff,
      retries: 0,
      phase,
    });
  };

  for (let i = 0; i < count; i++) {
    const seg = segs[i];
    const segStart = Date.now();
    if (opts.token.cancelled) return cancelled(i, 0);
    emit(i, 0, 'requestDownload');
    await sleep(REQ_MS);

    const segMs = Math.max(10, (transferMs * seg.length) / total);
    const tStart = Date.now();
    let bytes = 0;
    while (bytes < seg.length) {
      if (opts.token.cancelled) return cancelled(i, bytes);
      await sleep(tick);
      const f = Math.min(1, (Date.now() - tStart) / segMs);
      bytes = f >= 1 ? seg.length : Math.floor(seg.length * f);
      emit(i, bytes, 'transfer');
    }

    if (opts.token.cancelled) return cancelled(i, bytes);
    emit(i, seg.length, 'exit');
    await sleep(EXIT_MS);

    const durationMs = Date.now() - segStart;
    reports.push({
      index: i,
      address: seg.address,
      bytes: seg.length,
      blocks: Math.ceil(seg.length / blockLen),
      retries: 0,
      ecuMaxBlockLen: blockLen + 2,
      blockLen,
      durationMs,
      throughputBytesPerSec: durationMs > 0 ? Math.round((seg.length * 1000) / durationMs) : 0,
      exitResponse: [],
    });
    doneBefore += seg.length;
  }

  if (count > 0) emit(count - 1, segs[count - 1].length, 'done');
  const durationMs = Date.now() - t0;
  return {
    cancelled: false,
    report: {
      segments: reports,
      totalBytes: doneBefore,
      totalBlocks: reports.reduce((a, r) => a + r.blocks, 0),
      totalRetries: 0,
      durationMs,
      throughputBytesPerSec: durationMs > 0 ? Math.round((doneBefore * 1000) / durationMs) : 0,
    },
  };
}
