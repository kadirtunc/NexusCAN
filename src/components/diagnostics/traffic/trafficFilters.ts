/**
 * Traffic Dock filters (pure). `compileFilters` pre-parses once per filter change and returns the
 * row predicates used by `buildRows`.
 *
 * Semantics:
 * - origin: a transaction / event is hidden when its origin is switched off. Frames take the origin of
 *   their transaction; UNMATCHED frames (requestSeq === null or transaction no longer known) have no
 *   origin and always pass the origin filter.
 * - errors only: NRC / timeout / tx_blocked / transport_error. Unmatched frames are hidden.
 * - SID: request SID of the transaction (events and frames resolve it through their transaction).
 *   Unmatched frames are hidden while a SID filter is set.
 * - search: hex bytes (spaces / 0x / commas ignored, substring on the compact hex of a single PDU) OR
 *   case-insensitive text over service name, origin, decoded brief, NRC name, status and detail.
 */
import type { ConversationEventDto, DiagOrigin } from '../../../types/udsClient';
import { DIAG_ORIGINS } from '../../../types/udsClient';
import type { IsoTpFrameEntry } from '../../../types/diagnostics';
import {
  isErrorStatus,
  sidName,
  txBrief,
  txNrc,
  type RowPredicates,
  type Transaction,
  type TrafficEvent,
} from './trafficModel';

export interface TrafficFilters {
  /** Origins that are visible (all on by default). */
  origins: readonly DiagOrigin[];
  errorsOnly: boolean;
  /** Hex SID text ("22", "0x22"); empty = no SID filter. */
  sid: string;
  search: string;
}

export const DEFAULT_FILTERS: TrafficFilters = {
  origins: DIAG_ORIGINS,
  errorsOnly: false,
  sid: '',
  search: '',
};

/** "22" / "0x22" -> 0x22; empty or invalid -> null. */
export function parseSidFilter(text: string): number | null {
  const t = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,2}$/.test(t)) return null;
  return parseInt(t, 16);
}

/** Compact upper-case hex of a byte list (no separators). */
export function compactHex(bytes: readonly number[]): string {
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
  return out;
}

/** Search text -> compact hex needle when it is pure hex (possibly with spaces / 0x / commas), else null. */
export function hexNeedle(search: string): string | null {
  const cleaned = search.trim().replace(/0x/gi, '').replace(/[\s,;]+/g, '');
  if (cleaned.length === 0 || !/^[0-9a-fA-F]+$/.test(cleaned)) return null;
  return cleaned.toUpperCase();
}

const errorEventKinds: ReadonlySet<ConversationEventDto['kind']> = new Set([
  'timeout',
  'tx_blocked',
  'transport_error',
]);

export function isErrorEvent(e: ConversationEventDto): boolean {
  return errorEventKinds.has(e.kind) || e.nrc !== null;
}

const txHayCache = new WeakMap<Transaction, string>();

function txTextHay(tx: Transaction): string {
  const hit = txHayCache.get(tx);
  if (hit !== undefined) return hit;
  const nrc = txNrc(tx);
  const parts = [
    tx.sid === null ? '' : sidName(tx.sid),
    tx.origin,
    tx.status,
    txBrief(tx),
    nrc ? `${nrc.name ?? ''} nrc ${nrc.code.toString(16)}` : '',
    tx.final?.detail ?? '',
    tx.request?.detail ?? '',
  ];
  const hay = parts.join(' ').toLowerCase();
  txHayCache.set(tx, hay);
  return hay;
}

function txHexMatches(tx: Transaction, needle: string): boolean {
  if (tx.request && compactHex(tx.request.bytes).includes(needle)) return true;
  if (tx.final && compactHex(tx.final.bytes).includes(needle)) return true;
  return false;
}

export function compileFilters(f: TrafficFilters): RowPredicates {
  const enabled = new Set<DiagOrigin>(f.origins);
  const originAll = enabled.size === DIAG_ORIGINS.length;
  const sid = parseSidFilter(f.sid);
  const sidActive = f.sid.trim().length > 0;
  const text = f.search.trim().toLowerCase();
  const hex = hexNeedle(f.search);
  const searchActive = text.length > 0;
  const passthrough = originAll && !f.errorsOnly && !sidActive && !searchActive;

  const txOk = (tx: Transaction): boolean => {
    if (!enabled.has(tx.origin)) return false;
    if (f.errorsOnly && !isErrorStatus(tx.status)) return false;
    if (sidActive && (sid === null || tx.sid !== sid)) return false;
    if (searchActive) {
      if (!(txTextHay(tx).includes(text) || (hex !== null && txHexMatches(tx, hex)))) return false;
    }
    return true;
  };

  return {
    passthrough,
    tx: txOk,
    event(item: TrafficEvent, tx: Transaction | undefined): boolean {
      const e = item.event;
      if (!enabled.has(e.origin)) return false;
      if (f.errorsOnly && !isErrorEvent(e)) return false;
      if (sidActive) {
        const effective = tx?.sid ?? e.sid;
        if (sid === null || effective !== sid) return false;
      }
      if (searchActive) {
        const eventHay = `${e.kind} ${e.origin} ${e.detail ?? ''} ${e.sid === null ? '' : sidName(e.sid)}`.toLowerCase();
        const hit =
          eventHay.includes(text) ||
          (tx !== undefined && txTextHay(tx).includes(text)) ||
          (hex !== null && compactHex(e.bytes).includes(hex));
        if (!hit) return false;
      }
      return true;
    },
    frame(frame: IsoTpFrameEntry, tx: Transaction | undefined): boolean {
      if (tx !== undefined && !enabled.has(tx.origin)) return false;
      if (f.errorsOnly && (tx === undefined || !isErrorStatus(tx.status))) return false;
      if (sidActive && (sid === null || tx === undefined || tx.sid !== sid)) return false;
      if (searchActive) {
        const own =
          (hex !== null &&
            (compactHex(frame.rawBytes).includes(hex) ||
              (frame.assembledPayload !== undefined && compactHex(frame.assembledPayload).includes(hex)))) ||
          frame.description.toLowerCase().includes(text) ||
          frame.frameType.toLowerCase() === text;
        const viaTx = tx !== undefined && txTextHay(tx).includes(text);
        if (!own && !viaTx) return false;
      }
      return true;
    },
  };
}
