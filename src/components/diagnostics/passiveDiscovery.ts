/**
 * Passive discovery helpers: pair -> graph-input mapping, ordering and display tones. Pure (no React,
 * no store). The graph merge itself stays in `ecu-graph/graphModel.ts` (`mergeDiscovery`).
 */
import type {
  DiscoveredEcuDto,
  EcuDiscoveryResultDto,
  PassiveConfidence,
  PassiveEcuPairDto,
} from '../../types/udsClient';
import type { DiagTone } from './diagUi';

/**
 * A passively observed pair becomes the same `DiscoveredEcuDto` an active scan yields. The response
 * content is NOT decoded passively, so `positive: true` only means "this id answered": status / NRC /
 * identity stay empty (the graph merge keeps richer data of already-known nodes: `passive` option).
 */
export function pairToEcu(pair: PassiveEcuPairDto): DiscoveredEcuDto {
  return {
    responseId: pair.responseId,
    requestId: pair.requestId,
    isExtendedId: pair.isExtendedId,
    positive: true,
    nrc: null,
    nrcName: null,
    pending: false,
    raw: [],
    multiFrame: false,
    firstResponseUs: 0,
    responseCount: pair.evidenceCount,
    vin: null,
    serialNumber: null,
    partNumber: null,
    identifyError: null,
  };
}

export function pairsToEcus(pairs: readonly PassiveEcuPairDto[]): DiscoveredEcuDto[] {
  return pairs.map(pairToEcu);
}

/**
 * `mergeDiscovery` takes ONE addressing width per result: split a mixed list into one result per width
 * (11-bit first, like the graph's own ordering).
 */
export function ecusToResults(ecus: readonly DiscoveredEcuDto[]): EcuDiscoveryResultDto[] {
  const out: EcuDiscoveryResultDto[] = [];
  for (const extended of [false, true]) {
    const group = ecus.filter((e) => e.isExtendedId === extended);
    if (group.length === 0) continue;
    out.push({
      requestBytes: [],
      functionalId: 0,
      isExtendedId: extended,
      windowMs: 0,
      txTimestampUs: 0,
      ecus: group,
      ignoredFrames: 0,
      truncated: false,
      droppedEcus: 0,
    });
  }
  return out;
}

const CONFIDENCE_RANK: Record<PassiveConfidence, number> = { high: 2, medium: 1, low: 0 };

/** "Color only for abnormal / attention": high is the expected good case (neutral), low needs attention. */
export function confidenceTone(c: PassiveConfidence): DiagTone {
  return c === 'low' ? 'warn' : 'neutral';
}

/** Highest confidence first, then most evidence, then lowest response id (stable, deterministic). */
export function sortPairs(pairs: readonly PassiveEcuPairDto[]): PassiveEcuPairDto[] {
  return [...pairs].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      b.evidenceCount - a.evidenceCount ||
      Number(a.isExtendedId) - Number(b.isExtendedId) ||
      a.responseId - b.responseId,
  );
}

/** Seconds from scan start to the pair's last evidence (HAL clock, comparable within one snapshot); never negative. */
export function lastSeenSinceStartS(pair: PassiveEcuPairDto, startedAtUs: number): number {
  return Math.max(0, pair.lastSeenUs - startedAtUs) / 1e6;
}
