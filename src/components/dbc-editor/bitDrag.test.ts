/**
 * Dependency-free checks for the bit-matrix drag helpers.
 * Run: `npm run test:bitdrag` (esbuild bundle -> node; non-zero exit on failure).
 * Vectors marked [RUST] mirror crates/nexus-netdb/tests/pipeline_tests.rs and compiler/bit_plan.rs.
 */
import { computeDropStartBit, computeSignalFootprint } from './bitDrag';

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed += 1;
    console.error(`FAIL ${name}: got ${g} want ${w}`);
  }
}
const seq = (a: number, n: number): number[] => Array.from({ length: n }, (_, i) => a + i);

// [RUST] Intel 8|16@1: bytes 1..2, LSB = (1,0) = 8, MSB = (2,7) = 23.
eq('intel cross-byte', computeSignalFootprint(8, 16, 'littleEndian', 64), seq(8, 16));
// [RUST] Intel 0|12@1 (SigA): LSB (0,0), MSB (1,3) = 11.
eq('intel 12b', computeSignalFootprint(0, 12, 'littleEndian', 64), seq(0, 12));
// Intel in-byte 3|3.
eq('intel in-byte', computeSignalFootprint(3, 3, 'littleEndian', 64), [3, 4, 5]);
// [RUST] Motorola 7|16@0: MSB (0,7)=7 .. (0,0)=0, (1,7)=15 .. (1,0)=8 = LSB. LSB-first list:
eq('moto 7|16', computeSignalFootprint(7, 16, 'bigEndian', 64), [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7]);
// [RUST] Motorola 11|12@0: MSB (1,3)=11..8, then (2,7)..(2,0)=23..16 (LSB = 16). LSB-first list:
eq('moto 11|12', computeSignalFootprint(11, 12, 'bigEndian', 64), [16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11]);
// Motorola in-byte 5|3 -> bits 5,4,3 (MSB first) => LSB-first 3,4,5.
eq('moto in-byte', computeSignalFootprint(5, 3, 'bigEndian', 64), [3, 4, 5]);
// CAN-FD edge: Intel 504|8 ends at bit 511; 505|8 overflows.
eq('fd edge ok', computeSignalFootprint(504, 8, 'littleEndian', 512), seq(504, 8));
eq('fd edge intel overflow', computeSignalFootprint(505, 8, 'littleEndian', 512), null);
// [RUST] hostile_inputs: Motorola 511|64 overflows the payload.
eq('moto overflow', computeSignalFootprint(511, 64, 'bigEndian', 512), null);
eq('moto fd last bit', computeSignalFootprint(504, 1, 'bigEndian', 512), [504]);
eq('negative start', computeSignalFootprint(-1, 4, 'littleEndian', 64), null);

// Drop: Intel grabbed LSB lands on target.
eq('drop intel lsb', computeDropStartBit(0, 20, { startBit: 8, bitLength: 16, byteOrder: 'littleEndian' }, 64), 20);
// Intel grabbed bit 5 -> target 21 => start 16.
eq('drop intel k5', computeDropStartBit(5, 21, { startBit: 8, bitLength: 16, byteOrder: 'littleEndian' }, 64), 16);
// Motorola grabbed MSB (k=15) onto linear 23 => start 23.
eq('drop moto msb', computeDropStartBit(15, 23, { startBit: 7, bitLength: 16, byteOrder: 'bigEndian' }, 64), 23);
// Motorola grabbed LSB (k=0) onto linear 24 (byte3 bit0) => 16-bit MSB at 23.
eq('drop moto lsb', computeDropStartBit(0, 24, { startBit: 7, bitLength: 16, byteOrder: 'bigEndian' }, 64), 23);
// Out of range drops.
eq('drop oob intel', computeDropStartBit(0, 60, { startBit: 0, bitLength: 8, byteOrder: 'littleEndian' }, 64), null);
eq('drop oob moto', computeDropStartBit(15, 60, { startBit: 7, bitLength: 16, byteOrder: 'bigEndian' }, 64), null);
eq('drop negative start', computeDropStartBit(7, 2, { startBit: 0, bitLength: 8, byteOrder: 'littleEndian' }, 64), null);

// Round trip: grabbing any bit k and dropping it on its own cell keeps the footprint; moving then
// re-deriving keeps the grabbed bit on the target.
const sigs = [
  { startBit: 8, bitLength: 16, byteOrder: 'littleEndian' as const },
  { startBit: 7, bitLength: 16, byteOrder: 'bigEndian' as const },
  { startBit: 11, bitLength: 12, byteOrder: 'bigEndian' as const },
  { startBit: 5, bitLength: 3, byteOrder: 'bigEndian' as const },
  { startBit: 0, bitLength: 64, byteOrder: 'littleEndian' as const },
];
for (const s of sigs) {
  const fp = computeSignalFootprint(s.startBit, s.bitLength, s.byteOrder, 512);
  if (fp === null) {
    failed += 1;
    console.error('round-trip fixture out of range', JSON.stringify(s));
    continue;
  }
  for (let k = 0; k < fp.length; k += 1) {
    const ns = computeDropStartBit(k, fp[k], s, 512);
    eq(`round-trip ${s.byteOrder}/${s.startBit} k${k} identity`, ns, s.startBit);
    for (const target of [100, 257, 400]) {
      const moved = computeDropStartBit(k, target, s, 512);
      if (moved === null) continue;
      const nf = computeSignalFootprint(moved, s.bitLength, s.byteOrder, 512);
      eq(`moved ${s.byteOrder}/${s.startBit} k${k}->${target}`, nf === null ? null : nf[k], target);
    }
  }
}

if (failed > 0) {
  throw new Error(`bitdrag: ${failed} FAILED`);
}
console.log('bitdrag: PASS');
