/**
 * RE series binary codec (re-toolkit-v1 §6.3). Pure, little-endian, bounds-checked.
 * Header 16 B: "NRS1" | seriesCount u8 | reserved u8 | pointsMax u16 | fromUs u64.
 * Series: kind u8 (0 candidate, 1 reference) | index u8 | reserved u16 | pointCount u32
 *         | pointCount x { tUsRel u32, min f64, max f64 }   (20 B per point; min/max = decimation bucket).
 * NaN values pass through untouched. Errors are `ReCodecError` (badMagic / truncated / badField / trailing).
 */
import type { RePoints, ReSeries, ReSeriesEntry } from '../types/re';
import { ReCodecError } from './reSnapshotCodec';

export const RE_SERIES_HEADER_BYTES = 16;
export const RE_SERIES_ENTRY_BYTES = 8;
export const RE_SERIES_POINT_BYTES = 20;

const MAGIC = [0x4e, 0x52, 0x53, 0x31]; // "NRS1"

export function decodeReSeries(buf: ArrayBuffer): ReSeries {
  const len = buf.byteLength;
  if (len < RE_SERIES_HEADER_BYTES) {
    throw new ReCodecError('truncated', `series header needs ${RE_SERIES_HEADER_BYTES} bytes, got ${len}`);
  }
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 4; i += 1) {
    if (u8[i] !== MAGIC[i]) throw new ReCodecError('badMagic', 'bad RE series magic');
  }
  const dv = new DataView(buf);
  const seriesCount = u8[4];
  const pointsMax = dv.getUint16(6, true);
  const fromUs = dv.getUint32(12, true) * 4294967296 + dv.getUint32(8, true);

  const series: ReSeriesEntry[] = [];
  let off = RE_SERIES_HEADER_BYTES;
  for (let s = 0; s < seriesCount; s += 1) {
    if (off + RE_SERIES_ENTRY_BYTES > len) throw new ReCodecError('truncated', `series ${s} header past end`);
    const kindRaw = u8[off];
    if (kindRaw > 1) throw new ReCodecError('badField', `series ${s}: unknown kind ${kindRaw}`);
    const index = u8[off + 1];
    const count = dv.getUint32(off + 4, true);
    off += RE_SERIES_ENTRY_BYTES;
    // check before allocating: a corrupt count must not trigger a huge allocation
    if (count > (len - off) / RE_SERIES_POINT_BYTES) throw new ReCodecError('truncated', `series ${s} points past end`);
    const points: RePoints = {
      tUsRel: new Float64Array(count),
      min: new Float64Array(count),
      max: new Float64Array(count),
    };
    for (let i = 0; i < count; i += 1) {
      points.tUsRel[i] = dv.getUint32(off, true);
      points.min[i] = dv.getFloat64(off + 4, true);
      points.max[i] = dv.getFloat64(off + 12, true);
      off += RE_SERIES_POINT_BYTES;
    }
    series.push({ kind: kindRaw === 0 ? 'candidate' : 'reference', index, points });
  }
  if (off !== len) throw new ReCodecError('trailing', `${len - off} trailing bytes after last series`);
  return { seriesCount, pointsMax, fromUs, series };
}

/** Test/demo helper: encodes a series into the §6.3 layout (mirror of the Rust encoder). */
export function encodeReSeriesForTest(s: ReSeries): ArrayBuffer {
  let size = RE_SERIES_HEADER_BYTES;
  for (const e of s.series) size += RE_SERIES_ENTRY_BYTES + e.points.tUsRel.length * RE_SERIES_POINT_BYTES;
  const buf = new ArrayBuffer(size);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  u8.set(MAGIC, 0);
  u8[4] = s.series.length;
  dv.setUint16(6, s.pointsMax, true);
  dv.setUint32(8, s.fromUs % 4294967296 >>> 0, true);
  dv.setUint32(12, Math.floor(s.fromUs / 4294967296) >>> 0, true);
  let off = RE_SERIES_HEADER_BYTES;
  for (const e of s.series) {
    u8[off] = e.kind === 'candidate' ? 0 : 1;
    u8[off + 1] = e.index;
    dv.setUint32(off + 4, e.points.tUsRel.length, true);
    off += RE_SERIES_ENTRY_BYTES;
    for (let i = 0; i < e.points.tUsRel.length; i += 1) {
      dv.setUint32(off, e.points.tUsRel[i] >>> 0, true);
      dv.setFloat64(off + 4, e.points.min[i], true);
      dv.setFloat64(off + 12, e.points.max[i], true);
      off += RE_SERIES_POINT_BYTES;
    }
  }
  return buf;
}
