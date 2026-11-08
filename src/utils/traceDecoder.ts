import type { MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import { formatMuxRanges, formatPhysicalValue, formatRawHex } from './formatters';
import {
  type FormattedMuxSymbol,
  formatMultiplexedSymbol,
} from './muxFormat';

export interface DecodedTraceSignal {
  signal: SignalSchemaDto;
  rawInt: number;
  rawHex: string;
  physicalValue: number;
  formattedValue: string;
  enumLabel: string | null;
  outOfRange: boolean;
  isSubSwitch: boolean;
}

interface CompiledSignalBits {
  signalId: number;
  byteIndices: Uint8Array;
  bitInBytes: Uint8Array;
  signalBitIndices: Uint8Array;
}

interface CompiledMessagePlan {
  bitsBySignalId: Map<number, CompiledSignalBits>;
  subSwitchIds: Set<number>;
}

const compiledPlanCache = new WeakMap<MessageSchemaDto, CompiledMessagePlan>();
const sharedFloatBuf = new ArrayBuffer(8);
const sharedFloatView = new DataView(sharedFloatBuf);

function getCompiledPlan(
  msgSchema: MessageSchemaDto,
  signalsById: readonly (SignalSchemaDto | undefined)[],
): CompiledMessagePlan {
  const cached = compiledPlanCache.get(msgSchema);
  if (cached) return cached;

  const grouped = new Map<
    number,
    { bytes: number[]; bits: number[]; sigBits: number[] }
  >();

  for (let i = 0; i < msgSchema.bitLayout.length; i++) {
    const cell = msgSchema.bitLayout[i];
    let bucket = grouped.get(cell.signalId);
    if (!bucket) {
      bucket = { bytes: [], bits: [], sigBits: [] };
      grouped.set(cell.signalId, bucket);
    }
    bucket.bytes.push(cell.byteIndex);
    bucket.bits.push(cell.bitInByte);
    bucket.sigBits.push(cell.signalBitIndex);
  }

  const bitsBySignalId = new Map<number, CompiledSignalBits>();
  for (const [signalId, b] of grouped.entries()) {
    bitsBySignalId.set(signalId, {
      signalId,
      byteIndices: Uint8Array.from(b.bytes),
      bitInBytes: Uint8Array.from(b.bits),
      signalBitIndices: Uint8Array.from(b.sigBits),
    });
  }

  const subSwitchIds = new Set<number>();
  for (const sigId of msgSchema.signalIds) {
    const sig = signalsById[sigId];
    if (sig && sig.switchSignalId !== null) {
      subSwitchIds.add(sig.switchSignalId);
    }
  }
  if (msgSchema.masterSwitchId !== null) {
    subSwitchIds.delete(msgSchema.masterSwitchId);
  }

  const plan: CompiledMessagePlan = { bitsBySignalId, subSwitchIds };
  compiledPlanCache.set(msgSchema, plan);
  return plan;
}

/**
 * Extracts canonical unsigned `BigInt` (`0 .. (1n << bitLength) - 1n`) from `rawBytes` (`0..64` bytes).
 * Uses pre-compiled `BitCellDto` coordinates when present, with exact Intel (`@1`) and
 * Motorola Sawtooth (`@0` MSB-first) fallback across the full `0..511` CAN-FD bit space.
 */
function extractUnsignedRawBits(
  rawBytes: readonly number[],
  sig: SignalSchemaDto,
  compiledBits: CompiledSignalBits | undefined,
): bigint {
  const payloadLen = rawBytes.length;
  let acc = 0n;

  if (compiledBits && compiledBits.byteIndices.length > 0) {
    const n = compiledBits.byteIndices.length;
    for (let i = 0; i < n; i++) {
      const bIdx = compiledBits.byteIndices[i];
      if (bIdx >= payloadLen) continue;
      const bitVal = (rawBytes[bIdx] >>> compiledBits.bitInBytes[i]) & 1;
      if (bitVal === 1) {
        acc |= 1n << BigInt(compiledBits.signalBitIndices[i]);
      }
    }
    return acc;
  }

  // Fallback direct bit extraction (Intel little-endian & Motorola @0 sawtooth)
  const bitLen = Math.max(1, Math.min(64, sig.bitLength));
  if (sig.byteOrder === 'littleEndian') {
    for (let i = 0; i < bitLen; i++) {
      const globalBit = sig.startBit + i;
      const byteIdx = globalBit >>> 3;
      const bitInByte = globalBit & 7;
      if (byteIdx < payloadLen && ((rawBytes[byteIdx] >>> bitInByte) & 1) === 1) {
        acc |= 1n << BigInt(i);
      }
    }
    return acc;
  }

  // Motorola (@0): `startBit` is MSB (`signalBitIndex = bitLen - 1`), stepping toward LSB
  let byteIdx = sig.startBit >>> 3;
  let bitInByte = sig.startBit & 7;
  for (let sigBit = bitLen - 1; sigBit >= 0; sigBit--) {
    if (byteIdx < payloadLen && ((rawBytes[byteIdx] >>> bitInByte) & 1) === 1) {
      acc |= 1n << BigInt(sigBit);
    }
    if (bitInByte > 0) {
      bitInByte -= 1;
    } else {
      byteIdx += 1;
      bitInByte = 7;
    }
  }
  return acc;
}

function convertRawBitsToNumeric(rawUnsigned: bigint, sig: SignalSchemaDto): number {
  const bitLen = Math.max(1, Math.min(64, sig.bitLength));

  if (sig.valueType === 'float32' && bitLen === 32) {
    sharedFloatView.setUint32(0, Number(rawUnsigned & 0xffffffffn), true);
    return sharedFloatView.getFloat32(0, true);
  }

  if (sig.valueType === 'float64' && bitLen === 64) {
    sharedFloatView.setBigUint64(0, rawUnsigned, true);
    return sharedFloatView.getFloat64(0, true);
  }

  if (sig.valueType === 'signed') {
    return Number(BigInt.asIntN(bitLen, rawUnsigned));
  }

  return Number(BigInt.asUintN(bitLen, rawUnsigned));
}

function rangeMatches(ranges: readonly [number, number][], swVal: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    if (swVal >= start && swVal <= end) return true;
  }
  return false;
}

/**
 * Pure, deterministic per-frame signal decoder for historical `Trace` rows (`0..64` byte CAN / CAN-FD).
 * Decodes static, master-switch, cascaded sub-switch (`SG_MUL_VAL_`), and active multiplexed branch
 * signals strictly from that frame's own `rawBytes` payload!
 */
export function decodeTraceFrame(
  rawBytes: readonly number[],
  msgSchema: MessageSchemaDto | undefined,
  signalsById: readonly (SignalSchemaDto | undefined)[],
): DecodedTraceSignal[] {
  if (!msgSchema || msgSchema.signalIds.length === 0) {
    return [];
  }

  const plan = getCompiledPlan(msgSchema, signalsById);

  // Cache raw integer values per signal within this single frame for O(1) cascaded switch checks
  const rawNumericCache = new Map<number, number>();
  const getSignalRawNumeric = (sig: SignalSchemaDto): number => {
    const existing = rawNumericCache.get(sig.signalId);
    if (existing !== undefined) return existing;
    const rawUnsigned = extractUnsignedRawBits(
      rawBytes,
      sig,
      plan.bitsBySignalId.get(sig.signalId),
    );
    const num = convertRawBitsToNumeric(rawUnsigned, sig);
    rawNumericCache.set(sig.signalId, num);
    return num;
  };

  const activeCache = new Map<number, boolean>();
  const isSignalActiveInThisFrame = (sig: SignalSchemaDto, depth: number): boolean => {
    if (depth > 12) return false;
    const memo = activeCache.get(sig.signalId);
    if (memo !== undefined) return memo;

    let active = true;
    if (sig.muxRole === 'multiplexed' && sig.switchSignalId !== null) {
      const parentSw: SignalSchemaDto | undefined = signalsById[sig.switchSignalId];
      if (!parentSw || !isSignalActiveInThisFrame(parentSw, depth + 1)) {
        active = false;
      } else {
        const swRawInt = Math.trunc(getSignalRawNumeric(parentSw));
        active = rangeMatches(sig.muxRanges, swRawInt);
      }
    }

    activeCache.set(sig.signalId, active);
    return active;
  };

  const results: DecodedTraceSignal[] = [];

  for (let i = 0; i < msgSchema.signalIds.length; i++) {
    const sigId = msgSchema.signalIds[i];
    const sig = signalsById[sigId];
    if (!sig) continue;
    if (!isSignalActiveInThisFrame(sig, 0)) continue;

    const rawNum = getSignalRawNumeric(sig);
    const rawInt = Math.trunc(rawNum);
    const physicalValue = rawNum * sig.factor + sig.offset;
    const enumLabel = sig.enumTable[String(rawInt)] ?? null;
    const outOfRange =
      sig.max > sig.min &&
      Number.isFinite(physicalValue) &&
      (physicalValue < sig.min - 1e-6 || physicalValue > sig.max + 1e-6);

    const formattedValue = enumLabel
      ? `${enumLabel}(${rawInt})`
      : `${formatPhysicalValue(physicalValue, sig)}${sig.unit ? ` ${sig.unit}` : ''}`;

    results.push({
      signal: sig,
      rawInt,
      rawHex: formatRawHex(rawInt, sig.bitLength),
      physicalValue,
      formattedValue,
      enumLabel,
      outOfRange,
      isSubSwitch: plan.subSwitchIds.has(sig.signalId),
    });
  }

  return results;
}

/**
 * Formats decoded signals into a single-line summary for the `Decoded Signals` Trace column.
 */
export function formatDecodedTraceInline(
  decoded: readonly DecodedTraceSignal[],
): string {
  if (decoded.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < decoded.length; i++) {
    const d = decoded[i];
    const prefix =
      d.signal.muxRole === 'masterSwitch'
        ? '[M] '
        : d.isSubSwitch
          ? `[m${formatMuxRanges(d.signal.muxRanges)}·M] `
          : '';
    parts.push(`${prefix}${d.signal.name}=${d.formattedValue}`);
  }
  return parts.join(' · ');
}

/**
 * Resolves the formatted symbol (`BaseMessage.OuterMux.InnerMux`)
 * for a chronological raw Trace frame by evaluating the active cascaded multiplexer
 * switch chain directly from its `rawBytes`.
 */
export function resolveTraceFrameSymbol(
  rawBytes: readonly number[],
  msgSchema: MessageSchemaDto | undefined,
  signalsById: readonly (SignalSchemaDto | undefined)[],
): FormattedMuxSymbol {
  if (!msgSchema) {
    return { fullSymbol: '—', baseName: '—', muxSuffix: null };
  }
  if (!msgSchema.isMultiplexed) {
    return { fullSymbol: msgSchema.name, baseName: msgSchema.name, muxSuffix: null };
  }

  const plan = getCompiledPlan(msgSchema, signalsById);
  const activeMuxSwitches: Record<string, number> = {};
  const visited = new Set<number>();

  const getSigRawInt = (sig: SignalSchemaDto): number => {
    const rawUnsigned = extractUnsignedRawBits(
      rawBytes,
      sig,
      plan.bitsBySignalId.get(sig.signalId),
    );
    const num = convertRawBitsToNumeric(rawUnsigned, sig);
    return Math.trunc(num);
  };

  const rootSwitchId =
    msgSchema.masterSwitchId ??
    msgSchema.signalIds.find((id) => signalsById[id]?.muxRole === 'masterSwitch');

  if (rootSwitchId === null || rootSwitchId === undefined) {
    return formatMultiplexedSymbol(msgSchema, signalsById, activeMuxSwitches);
  }

  const rootSig = signalsById[rootSwitchId];
  if (!rootSig) {
    return formatMultiplexedSymbol(msgSchema, signalsById, activeMuxSwitches);
  }

  const allSwitchIds = new Set<number>();
  if (msgSchema.masterSwitchId !== null) {
    allSwitchIds.add(msgSchema.masterSwitchId);
  }
  for (let i = 0; i < msgSchema.signalIds.length; i++) {
    const s = signalsById[msgSchema.signalIds[i]];
    if (s) {
      if (s.muxRole === 'masterSwitch') allSwitchIds.add(s.signalId);
      if (s.switchSignalId !== null) allSwitchIds.add(s.switchSignalId);
    }
  }

  const evaluateSwitch = (swSig: SignalSchemaDto, depth: number): void => {
    if (depth > 12 || visited.has(swSig.signalId)) return;
    visited.add(swSig.signalId);

    const rawInt = getSigRawInt(swSig);
    activeMuxSwitches[swSig.name] = rawInt;

    for (let i = 0; i < msgSchema.signalIds.length; i++) {
      const childId = msgSchema.signalIds[i];
      const childSig = signalsById[childId];
      if (!childSig) continue;

      if (
        childSig.switchSignalId === swSig.signalId &&
        rangeMatches(childSig.muxRanges, rawInt)
      ) {
        if (allSwitchIds.has(childSig.signalId)) {
          evaluateSwitch(childSig, depth + 1);
        }
      }
    }
  };

  evaluateSwitch(rootSig, 0);

  return formatMultiplexedSymbol(msgSchema, signalsById, activeMuxSwitches);
}
