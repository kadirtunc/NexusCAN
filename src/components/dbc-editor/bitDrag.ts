/**
 * Pure helpers for drag-to-move of signals in the DBC editor bit matrix.
 * Semantics mirror `crates/nexus-netdb/src/compiler/bit_plan.rs::trace_signal_bits`:
 * `BitCellDto.signalBitIndex` k = 0 is the signal LSB, k = bitLength-1 the MSB.
 * Intel: start = LSB, bit k at start + k. Motorola (Vector sawtooth): start = MSB
 * (linear = byte*8 + bitInByte), walking bit 7 -> 0 of each byte, then the next byte.
 */
import type { SignalSchemaDto } from '../../types/netdb';

export type ByteOrder = SignalSchemaDto['byteOrder'];

/** Sawtooth position of a linear bit (increases from MSB toward LSB of a Motorola signal). */
function toSaw(linear: number): number {
  return Math.floor(linear / 8) * 8 + (7 - (linear % 8));
}

/** Inverse of `toSaw` (the mapping is an involution on each byte). */
function fromSaw(saw: number): number {
  return Math.floor(saw / 8) * 8 + (7 - (saw % 8));
}

/** Linear bit indices (byte*8+bitInByte) occupied by the signal, ordered LSB -> MSB, or null if out of range. */
export function computeSignalFootprint(
  startBit: number,
  bitLength: number,
  byteOrder: ByteOrder,
  totalBits: number
): number[] | null {
  if (
    !Number.isInteger(startBit) ||
    !Number.isInteger(bitLength) ||
    !Number.isInteger(totalBits) ||
    startBit < 0 ||
    bitLength < 1 ||
    startBit >= totalBits
  ) {
    return null;
  }
  const out: number[] = [];
  if (byteOrder === 'littleEndian') {
    if (startBit + bitLength > totalBits) return null;
    for (let k = 0; k < bitLength; k += 1) out.push(startBit + k);
    return out;
  }
  const sawStart = toSaw(startBit);
  if (sawStart + bitLength > totalBits) return null;
  // MSB first in sawtooth order, then reversed so index 0 = LSB.
  for (let i = bitLength - 1; i >= 0; i -= 1) out.push(fromSaw(sawStart + i));
  return out;
}

/** New DBC startBit so that signal bit `grabbedSignalBitIndex` lands on `targetLinearBit`; null if out of range. */
export function computeDropStartBit(
  grabbedSignalBitIndex: number,
  targetLinearBit: number,
  sig: Pick<SignalSchemaDto, 'startBit' | 'bitLength' | 'byteOrder'>,
  totalBits: number
): number | null {
  if (
    !Number.isInteger(grabbedSignalBitIndex) ||
    !Number.isInteger(targetLinearBit) ||
    grabbedSignalBitIndex < 0 ||
    grabbedSignalBitIndex >= sig.bitLength ||
    targetLinearBit < 0 ||
    targetLinearBit >= totalBits
  ) {
    return null;
  }
  let start: number;
  if (sig.byteOrder === 'littleEndian') {
    start = targetLinearBit - grabbedSignalBitIndex;
  } else {
    const fromMsb = sig.bitLength - 1 - grabbedSignalBitIndex;
    const sawStart = toSaw(targetLinearBit) - fromMsb;
    if (sawStart < 0) return null;
    start = fromSaw(sawStart);
  }
  if (start < 0) return null;
  return computeSignalFootprint(start, sig.bitLength, sig.byteOrder, totalBits) === null
    ? null
    : start;
}
