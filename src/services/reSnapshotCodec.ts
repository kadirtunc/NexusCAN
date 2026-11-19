/**
 * RE snapshot binary codec (re-toolkit-v1 §2.2). Pure, little-endian, bounds-checked: never reads past the end.
 * Header 24 B: "NRE2" | seq u32 | tsUs u64 | phase u8 | full u8 | rowCount u16 | totalRows u16 | reserved u16.
 * Row: bus u8 | flags u8 (b0 ext, b1 fd, b2 hasDiff, b3 new) | dlcBytes u8 | reserved u8 | arbId u32 | rxCount u32
 *      | heat[dlcBytes*8] | diff[dlcBytes] | constant[dlcBytes] | data[dlcBytes] (latest payload, byte 0 first).
 */
import type { RePhase, ReSnapshot, ReSnapshotRow } from '../types/re';

export const RE_HEADER_BYTES = 24;
export const RE_ROW_FIXED_BYTES = 12;
export const RE_MAX_DLC_BYTES = 64;

const MAGIC = [0x4e, 0x52, 0x45, 0x32]; // "NRE2"
const MAGIC_V1 = [0x4e, 0x52, 0x45, 0x31]; // "NRE1" (outdated backend, rejected)
const PHASES: readonly RePhase[] = ['idle', 'free', 'baseline', 'action'];

export type ReCodecErrorCode = 'badMagic' | 'truncated' | 'badField' | 'trailing';

export class ReCodecError extends Error {
  readonly code: ReCodecErrorCode;
  constructor(code: ReCodecErrorCode, message: string) {
    super(message);
    this.name = 'ReCodecError';
    this.code = code;
  }
}

export function decodeReSnapshot(buf: ArrayBuffer): ReSnapshot {
  const len = buf.byteLength;
  if (len < RE_HEADER_BYTES) {
    throw new ReCodecError('truncated', `header needs ${RE_HEADER_BYTES} bytes, got ${len}`);
  }
  const u8 = new Uint8Array(buf);
  let isV1 = true;
  for (let i = 0; i < 4; i += 1) if (u8[i] !== MAGIC_V1[i]) isV1 = false;
  if (isV1) {
    throw new ReCodecError('badMagic', 'RE snapshot v1 from an outdated backend — restart the backend');
  }
  for (let i = 0; i < 4; i += 1) {
    if (u8[i] !== MAGIC[i]) throw new ReCodecError('badMagic', 'bad RE snapshot magic');
  }
  const dv = new DataView(buf);
  const seq = dv.getUint32(4, true);
  const tsLo = dv.getUint32(8, true);
  const tsHi = dv.getUint32(12, true);
  const tsUs = tsHi * 4294967296 + tsLo; // exact up to 2^53
  const phaseRaw = u8[16];
  const phase = PHASES[phaseRaw];
  if (phase === undefined) throw new ReCodecError('badField', `unknown phase ${phaseRaw}`);
  const full = u8[17] === 1;
  const rowCount = dv.getUint16(18, true);
  const totalRows = dv.getUint16(20, true);

  const rows: ReSnapshotRow[] = [];
  let off = RE_HEADER_BYTES;
  for (let r = 0; r < rowCount; r += 1) {
    if (off + RE_ROW_FIXED_BYTES > len) {
      throw new ReCodecError('truncated', `row ${r} header past end`);
    }
    const bus = u8[off];
    const flags = u8[off + 1];
    const dlcBytes = u8[off + 2];
    if (dlcBytes > RE_MAX_DLC_BYTES) {
      throw new ReCodecError('badField', `dlcBytes ${dlcBytes} > ${RE_MAX_DLC_BYTES}`);
    }
    const arbId = dv.getUint32(off + 4, true);
    const rxCount = dv.getUint32(off + 8, true);
    const heatStart = off + RE_ROW_FIXED_BYTES;
    const heatEnd = heatStart + dlcBytes * 8;
    const diffEnd = heatEnd + dlcBytes;
    const constEnd = diffEnd + dlcBytes;
    const dataEnd = constEnd + dlcBytes;
    if (dataEnd > len) throw new ReCodecError('truncated', `row ${r} payload past end`);
    rows.push({
      bus,
      extended: (flags & 1) !== 0,
      fd: (flags & 2) !== 0,
      hasDiff: (flags & 4) !== 0,
      isNew: (flags & 8) !== 0,
      dlcBytes,
      arbId,
      rxCount,
      heat: u8.subarray(heatStart, heatEnd),
      diff: u8.subarray(heatEnd, diffEnd),
      constant: u8.subarray(diffEnd, constEnd),
      data: u8.subarray(constEnd, dataEnd),
    });
    off = dataEnd;
  }
  if (off !== len) {
    throw new ReCodecError('trailing', `${len - off} trailing bytes after last row`);
  }
  return { seq, tsUs, phase, full, rowCount, totalRows, rows };
}

/** Test/demo helper: encodes a snapshot into the §2.2 layout (mirror of the Rust encoder). */
export function encodeReSnapshotForTest(snap: ReSnapshot): ArrayBuffer {
  let size = RE_HEADER_BYTES;
  for (const r of snap.rows) size += RE_ROW_FIXED_BYTES + r.dlcBytes * 11;
  const buf = new ArrayBuffer(size);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8.set(MAGIC, 0);
  dv.setUint32(4, snap.seq >>> 0, true);
  dv.setUint32(8, snap.tsUs % 4294967296 >>> 0, true);
  dv.setUint32(12, Math.floor(snap.tsUs / 4294967296) >>> 0, true);
  u8[16] = Math.max(0, PHASES.indexOf(snap.phase));
  u8[17] = snap.full ? 1 : 0;
  dv.setUint16(18, snap.rows.length, true);
  dv.setUint16(20, snap.totalRows, true);
  let off = RE_HEADER_BYTES;
  for (const r of snap.rows) {
    u8[off] = r.bus;
    u8[off + 1] = (r.extended ? 1 : 0) | (r.fd ? 2 : 0) | (r.hasDiff ? 4 : 0) | (r.isNew ? 8 : 0);
    u8[off + 2] = r.dlcBytes;
    dv.setUint32(off + 4, r.arbId >>> 0, true);
    dv.setUint32(off + 8, r.rxCount >>> 0, true);
    off += RE_ROW_FIXED_BYTES;
    u8.set(r.heat.subarray(0, r.dlcBytes * 8), off);
    off += r.dlcBytes * 8;
    u8.set(r.diff.subarray(0, r.dlcBytes), off);
    off += r.dlcBytes;
    u8.set(r.constant.subarray(0, r.dlcBytes), off);
    off += r.dlcBytes;
    u8.set(r.data.subarray(0, r.dlcBytes), off);
    off += r.dlcBytes;
  }
  return buf;
}
