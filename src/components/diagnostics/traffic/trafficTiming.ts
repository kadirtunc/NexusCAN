/**
 * Timing analysis of one transaction (pure): P2 measured vs the session limit, and ISO-TP flow
 * control (BS / STmin) vs the measured Consecutive Frame gaps.
 */
import type { IsoTpFrameEntry } from '../../../types/diagnostics';
import { stMinToUs } from '../../../services/isoTpDecode';
import { framePrimaryTs, type Transaction } from './trafficModel';

export interface FlowControlInfo {
  frameUid: number;
  /** Who sent the FC (the CFs it governs travel the other way). */
  direction: 'tx' | 'rx';
  bs: number;
  stMinByte: number;
  stMinUs: number;
  /** Smallest gap between consecutive CFs governed by this FC (null: fewer than two CFs). */
  minCfGapUs: number | null;
  cfCount: number;
  /** minCfGapUs < stMinUs (only evaluated when STmin > 0 and a gap was measured). */
  violation: boolean;
}

export interface TxTiming {
  /** Request -> first response-side frame/event (an NRC 0x78 counts: it is the first answer). */
  p2MeasuredUs: number | null;
  p2Source: 'frames' | 'events' | null;
  /** p2ServerMs + p2MarginMs in µs; null when the session P2 is unknown. */
  p2LimitUs: number | null;
  /** True only when both values are known and measured > limit. */
  p2Violation: boolean;
  flowControls: readonly FlowControlInfo[];
  /** Smallest CF gap over the whole transaction. */
  minCfGapUs: number | null;
  stMinViolation: boolean;
  multiFrame: boolean;
}

function frameTs(f: IsoTpFrameEntry): number {
  return framePrimaryTs(f);
}

function isRequestStart(f: IsoTpFrameEntry): boolean {
  return f.direction === 'tx' && (f.frameType === 'SF' || f.frameType === 'FF');
}

/** Per-FC analysis: CFs of the opposite direction after the FC, until the next FC / FF / SF. */
export function analyzeFlowControl(frames: readonly IsoTpFrameEntry[]): FlowControlInfo[] {
  const out: FlowControlInfo[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const fc = frames[i];
    if (fc.frameType !== 'FC' || fc.direction === undefined) continue;
    const governedDir: 'tx' | 'rx' = fc.direction === 'tx' ? 'rx' : 'tx';
    const bs = fc.rawBytes.length > 1 ? fc.rawBytes[1] : 0;
    const stMinByte = fc.rawBytes.length > 2 ? fc.rawBytes[2] : 0;
    const stMinUs = stMinToUs(stMinByte);
    let prev: number | null = null;
    let minGap: number | null = null;
    let cfCount = 0;
    for (let j = i + 1; j < frames.length; j += 1) {
      const f = frames[j];
      if (f.frameType === 'FC' || f.frameType === 'FF' || f.frameType === 'SF') {
        if (f.direction === governedDir || f.frameType === 'FC') break;
        continue;
      }
      if (f.frameType === 'CF' && f.direction === governedDir) {
        cfCount += 1;
        const ts = frameTs(f);
        if (prev !== null) {
          const gap = ts - prev;
          if (minGap === null || gap < minGap) minGap = gap;
        }
        prev = ts;
      }
    }
    out.push({
      frameUid: fc.uid,
      direction: fc.direction,
      bs,
      stMinByte,
      stMinUs,
      minCfGapUs: minGap,
      cfCount,
      violation: stMinUs > 0 && minGap !== null && minGap < stMinUs,
    });
  }
  return out;
}

export function analyzeTiming(tx: Transaction, p2ServerMs: number | null, p2MarginMs: number): TxTiming {
  const frames = tx.frames;
  let p2MeasuredUs: number | null = null;
  let p2Source: TxTiming['p2Source'] = null;

  const reqFrame = frames.find(isRequestStart);
  const firstAnswer = frames.find((f) => f.direction === 'rx' && f.frameType !== 'FC');
  if (reqFrame && firstAnswer && frameTs(firstAnswer) >= frameTs(reqFrame)) {
    p2MeasuredUs = frameTs(firstAnswer) - frameTs(reqFrame);
    p2Source = 'frames';
  } else if (tx.request) {
    const firstUs = tx.firstPendingUs ?? tx.final?.timestampUs ?? null;
    if (firstUs !== null) {
      p2MeasuredUs = Math.max(0, firstUs - tx.request.timestampUs);
      p2Source = 'events';
    }
  }

  const p2LimitUs = p2ServerMs === null ? null : (p2ServerMs + p2MarginMs) * 1000;
  const flowControls = analyzeFlowControl(frames);
  let minCfGapUs: number | null = null;
  for (const fc of flowControls) {
    if (fc.minCfGapUs !== null && (minCfGapUs === null || fc.minCfGapUs < minCfGapUs)) minCfGapUs = fc.minCfGapUs;
  }
  return {
    p2MeasuredUs,
    p2Source,
    p2LimitUs,
    p2Violation: p2MeasuredUs !== null && p2LimitUs !== null && p2MeasuredUs > p2LimitUs,
    flowControls,
    minCfGapUs,
    stMinViolation: flowControls.some((f) => f.violation),
    multiFrame: frames.some((f) => f.frameType === 'FF' || f.frameType === 'CF'),
  };
}
