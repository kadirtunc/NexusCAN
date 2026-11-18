/**
 * Dependency-free checks for the ECU flashing helpers (chunked base64, `[flash]` error parsing,
 * progress normalisation, hex fields) and the DEMO simulator.
 * Run: `npm run test:flash` (esbuild bundle -> node; throws on the first failure).
 */
import {
  bytesToBase64,
  formatAddress,
  formatCrc32,
  overallProgress,
  parseFirmwareError,
  parseFlashError,
  parseHexNumber,
  resolveLoadFormat,
} from './flashCodec';
import { simulateFlash } from './flashSim';
import type { FirmwareImageSummaryDto, FlashProgressDto } from '../types/flash';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Independent reference encoder (RFC 4648), single pass over the whole array. */
function refBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < b.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < b.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// ── base64 ──
assert(bytesToBase64(new Uint8Array(0)) === '', 'empty base64');
for (const n of [1, 2, 3, 4, 24575, 24576, 24577, 49152 + 2]) {
  const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
  assert(bytesToBase64(b) === refBase64(b), `base64 length ${n}`);
}
const big = new Uint8Array(6 * 1024 * 1024);
for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
assert(bytesToBase64(big) === refBase64(big), 'base64 6 MiB (no stack overflow)');

// ── [flash] error parsing ──
const dto = {
  kind: 'negativeResponse', phase: 'transfer', segmentIndex: 1, address: 0x08010000, offset: 4096,
  blockCounter: 5, lastNrc: 0x73, lastNrcName: 'wrongBlockSequenceCounter', diagCode: 'E-73',
  bytesDone: 4096, segmentsCompleted: 1, message: 'ECU rejected block 5',
};
const parsed = parseFlashError(`[flash] ${JSON.stringify(dto)}`);
assert(parsed !== null && parsed.kind === 'negativeResponse' && parsed.lastNrc === 0x73, 'prefixed JSON');
assert(parsed !== null && parsed.address === 0x08010000 && parsed.lastNrcName === 'wrongBlockSequenceCounter', 'fields kept');
assert(parseFlashError(new Error(`ipc: [flash] ${JSON.stringify(dto)}`))?.segmentIndex === 1, 'Error with wrapper text');
assert(parseFlashError(JSON.stringify(dto))?.kind === 'negativeResponse', 'prefix-less JSON');
assert(parseFlashError(dto)?.blockCounter === 5, 'already-decoded object');
const sparse = parseFlashError('[flash] {"kind":"cancelled","message":"stopped"}');
assert(sparse !== null && sparse.phase === 'transfer' && sparse.segmentIndex === null && sparse.bytesDone === 0, 'missing fields defaulted');
assert(parseFlashError('[flash] {"kind":"nope"}') === null, 'unknown kind rejected');
assert(parseFlashError('[flash] not json {') === null, 'bad JSON -> null');
assert(parseFlashError('plain failure text') === null, 'plain string -> null');
assert(parseFlashError(42) === null && parseFlashError(null) === null, 'non-string -> null');
assert(parseFirmwareError('[firmware] bad checksum at line 3') === 'bad checksum at line 3', 'firmware prefix');
assert(parseFirmwareError('other') === null, 'firmware: no prefix');

// ── progress normalisation ──
const summary: FirmwareImageSummaryDto = {
  segments: [{ address: 0x1000, length: 100, crc32: 1 }, { address: 0x2000, length: 300, crc32: 2 }],
  totalBytes: 400,
  crc32: 3,
};
const base: FlashProgressDto = {
  segmentIndex: 1, segmentCount: 2, segmentAddress: 0x2000, bytesDone: 150, bytesTotal: 300,
  blockCounter: 3, retries: 0, phase: 'transfer',
};
const perSeg = overallProgress(base, summary);
assert(perSeg.done === 250 && perSeg.total === 400 && perSeg.percent === 62.5, 'per-segment progress re-based');
const overall = overallProgress({ ...base, bytesDone: 250, bytesTotal: 400 }, summary);
assert(overall.done === 250 && overall.percent === 62.5, 'overall progress kept');
assert(overallProgress(base, null).percent === 50, 'no summary: as reported');
assert(overallProgress({ ...base, bytesTotal: 0, bytesDone: 0 }, null).percent === 0, 'zero total');
assert(overallProgress({ ...base, phase: 'done' }, summary).percent === 100, 'done = 100%');

// ── fields ──
assert(parseHexNumber('0x08000000') === 0x08000000 && parseHexNumber('44') === 0x44, 'hex parse');
assert(parseHexNumber('') === null && parseHexNumber('zz') === null && parseHexNumber('FFFFFFFFFFFFFF') === null, 'hex invalid');
assert(formatAddress(0x1000) === '0x00001000' && formatCrc32(0xdeadbeef) === '0xDEADBEEF' && formatCrc32(-1) === '0xFFFFFFFF', 'formatting');
assert(resolveLoadFormat('auto', 'fw.BIN') === 'binary' && resolveLoadFormat('auto', 'fw.hex') === 'auto', 'auto format');
assert(resolveLoadFormat('srec', 'fw.bin') === 'srec', 'explicit format wins');

// ── DEMO simulator ──
const seen: FlashProgressDto[] = [];
const res = await simulateFlash(summary, (p) => seen.push(p), { durationMs: 80, tickMs: 4, token: { cancelled: false } });
assert(!res.cancelled, 'sim completes');
if (!res.cancelled) {
  assert(res.report.totalBytes === 400 && res.report.segments.length === 2, 'sim report totals');
  assert(res.report.totalBlocks === 1 + 1, 'sim blocks (1024 B blocks)');
}
assert(seen.length > 4 && seen[seen.length - 1].phase === 'done', 'sim emits progress ending with done');
assert(seen.every((p) => p.bytesDone <= p.bytesTotal), 'sim progress bounded');
const token = { cancelled: false };
const cancelled = simulateFlash(summary, (p) => { if (p.phase === 'transfer') token.cancelled = true; }, { durationMs: 400, tickMs: 4, token });
const cres = await cancelled;
assert(cres.cancelled, 'sim honours cancel');

console.log('flash tests passed');
