/** Pure helpers for the RE views (no React, no DOM): bit geometry, formatting. Colours live in reTheme.ts. */
import type { ReFieldDto, ReFieldKind } from '../../types/re';

export const KIND_ORDER: readonly ReFieldKind[] = ['constant', 'counter', 'checksum', 'flag', 'physical', 'unknown'];

/** Bit positions (bit = byte*8 + k, k = LSB index) covered by a field. Motorola uses the sawtooth walk. */
export function fieldBits(f: Pick<ReFieldDto, 'startBit' | 'bitLength' | 'byteOrder'>, maxBits = 512): number[] {
  const out: number[] = [];
  let pos = f.startBit;
  for (let i = 0; i < f.bitLength; i += 1) {
    if (pos < 0 || pos >= maxBits) break;
    out.push(pos);
    if (f.byteOrder === 'intel') pos += 1;
    else pos = pos % 8 === 0 ? pos + 15 : pos - 1;
  }
  return out;
}

/** hex string (2 chars per byte) -> bytes; invalid pairs become 0. */
export function hexToBytes(hex: string): Uint8Array {
  const n = Math.floor(hex.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out[i] = Number.isNaN(v) ? 0 : v;
  }
  return out;
}

export function formatArbId(arbId: number, extended: boolean): string {
  return extended ? arbId.toString(16).toUpperCase().padStart(8, '0') : arbId.toString(16).toUpperCase().padStart(3, '0');
}

/** `mm:ss.t` from microseconds. */
export function formatElapsed(us: number): string {
  const total = Math.max(0, Math.floor(us / 100_000));
  const tenths = total % 10;
  const secs = Math.floor(total / 10) % 60;
  const mins = Math.floor(total / 600);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export function bitIsSet(mask: Uint8Array, bit: number): boolean {
  return ((mask[bit >> 3] ?? 0) >> (bit & 7) & 1) === 1;
}

/** Precomputed upper-case 2-digit hex strings for 0..255 (no per-cell string building in canvas hot loops). */
export const HEX2: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

/** Byte as `0x3F · 63 · 0011 1111` (tooltip). */
export function formatByteTriple(v: number): string {
  const b = (v & 0xff).toString(2).padStart(8, '0');
  return `0x${HEX2[v & 0xff]} · ${v & 0xff} · ${b.slice(0, 4)} ${b.slice(4)}`;
}
