/**
 * Diagnostics Traffic Dock: pure data model (no React, no store import).
 *
 * - Transactions: a Request/KeepaliveSent event joined with its pending / final events and with the
 *   ISO-TP frames whose `requestSeq` points at it. All joins use the key `(epoch, seq)` because the
 *   backend seq restarts when a session is reopened.
 * - Timeline: conversation events and frames in one list ordered by HAL `timestampUs`.
 *
 * `TrafficModel.update()` is incremental: it only processes entries with a uid it has not seen yet
 * (O(new) for the join + O(log n) per timeline insert); eviction is a front trim. Snapshots are
 * immutable (transactions are replaced copy-on-write), so a frozen view stays truthful.
 */
import type { ConversationEventDto, DiagOrigin, UdsAddressing } from '../../../types/udsClient';
import type { IsoTpFrameEntry } from '../../../types/diagnostics';
import { UDS_SERVICES } from '../../../types/diagnostics';
import { interpretUdsResponse, OBD_MODE01_NAME, udsNrcName } from '../../../services/udsDecode';

// ─── Input shapes (structurally compatible with the store's `ConversationEntry`) ──────────────

export interface TrafficConversationEntry {
  uid: number;
  epoch: number;
  event: ConversationEventDto | null;
  note: 'gap' | 'reopened' | null;
}

export type TxStatus =
  | 'pending'
  | 'ok'
  | 'nrc'
  | 'timeout'
  | 'tx_blocked'
  | 'transport_error'
  | 'suppressed'
  | 'keepalive'
  | 'closed'
  | 'dropped';

/** Statuses counted by the "errors only" filter. */
export function isErrorStatus(status: TxStatus): boolean {
  return status === 'nrc' || status === 'timeout' || status === 'tx_blocked' || status === 'transport_error';
}

export interface Transaction {
  /** `${epoch}:${seq}` (seq = request seq, or the orphan event's own seq). */
  key: string;
  epoch: number;
  seq: number;
  firstUid: number;
  /** Request timestamp (or the orphan event's timestamp), HAL µs. */
  startUs: number;
  request: ConversationEventDto | null;
  final: ConversationEventDto | null;
  /** Number of NRC 0x78 `response_pending` events. */
  pendingCount: number;
  /** HAL timestamp of the first `response_pending` (null when none). */
  firstPendingUs: number | null;
  staleDrops: number;
  origin: DiagOrigin;
  addressing: UdsAddressing;
  /** Request SID (or the orphan event's SID). */
  sid: number | null;
  status: TxStatus;
  /** Request -> final (backend `elapsedUs` when present, else timestamp delta); null while pending. */
  elapsedUs: number | null;
  /** ISO-TP frames belonging to this transaction, in arrival order. */
  frames: readonly IsoTpFrameEntry[];
}

export interface NoteItem {
  uid: number;
  note: 'gap' | 'reopened';
}

export interface TrafficEvent {
  kind: 'event';
  uid: number;
  epoch: number;
  event: ConversationEventDto;
}

export interface TrafficFrame {
  kind: 'frame';
  uid: number;
  frame: IsoTpFrameEntry;
}

export type TimelineItem = TrafficEvent | TrafficFrame;

export interface TrafficCounters {
  total: number;
  nrc: number;
  timeout: number;
  /** nrc + timeout + tx_blocked + transport_error */
  errors: number;
  pending: number;
  frames: number;
  unmatchedFrames: number;
}

export interface TrafficSnapshot {
  version: number;
  /** Chronological by first event. */
  txs: readonly Transaction[];
  notes: readonly NoteItem[];
  /** Events + frames ordered by (timestampUs, rank, epoch, seq). */
  timeline: readonly TimelineItem[];
  /** Frames in store (arrival) order. */
  frames: readonly IsoTpFrameEntry[];
  counters: TrafficCounters;
  /** Smallest HAL timestamp present (base for relative-time display of monotonic clocks). */
  baseUs: number;
  /** Monotonic count of events + frames ever ingested (for "+N new" while frozen). */
  ingested: number;
  lastTx: Transaction | null;
  findTx(epoch: number, seq: number): Transaction | undefined;
}

export function txKey(epoch: number, seq: number): string {
  return `${epoch}:${seq}`;
}

// ─── Status / labels ──────────────────────────────────────────────────────────────────────────

function finalStatus(e: ConversationEventDto): TxStatus {
  switch (e.kind) {
    case 'response':
      if (e.nrc !== null) return 'nrc';
      return e.bytes.length === 0 ? 'suppressed' : 'ok';
    case 'timeout':
      return 'timeout';
    case 'tx_blocked':
      return 'tx_blocked';
    case 'transport_error':
      return 'transport_error';
    case 'session_closed':
      return 'closed';
    case 'stale_response_dropped':
      return 'dropped';
    case 'keepalive_sent':
      return 'keepalive';
    case 'request':
    case 'response_pending':
      return 'pending';
  }
}

const OBD_SERVICE_NAMES: Readonly<Record<number, string>> = {
  0x01: OBD_MODE01_NAME,
  0x41: OBD_MODE01_NAME,
  0x02: 'OBD Mode 02',
  0x03: 'OBD Mode 03',
  0x04: 'OBD Mode 04',
  0x07: 'OBD Mode 07',
  0x09: 'OBD Mode 09',
  0x0a: 'OBD Mode 0A',
};

export function sidName(sid: number): string {
  const uds = UDS_SERVICES.find((s) => s.sid === sid);
  if (uds) return uds.name;
  const obd = OBD_SERVICE_NAMES[sid];
  if (obd) return obd;
  if (sid >= 0x40 && sid < 0xbf) {
    const base = sidName(sid - 0x40);
    if (!base.startsWith('0x')) return `${base} +`;
  }
  if (sid === 0x7f) return 'NegativeResponse';
  return `0x${sid.toString(16).toUpperCase().padStart(2, '0')}`;
}

// ─── Transaction construction / update (pure, copy-on-write) ──────────────────────────────────

function withStatus(tx: Transaction): Transaction {
  const status: TxStatus = tx.final
    ? finalStatus(tx.final)
    : tx.request?.kind === 'keepalive_sent'
      ? 'keepalive'
      : 'pending';
  const elapsedUs = tx.final
    ? (tx.final.elapsedUs ?? Math.max(0, tx.final.timestampUs - tx.startUs))
    : null;
  return { ...tx, status, elapsedUs };
}

function newRequestTx(entry: TrafficEvent, frames: readonly IsoTpFrameEntry[]): Transaction {
  const e = entry.event;
  return withStatus({
    key: txKey(entry.epoch, e.seq),
    epoch: entry.epoch,
    seq: e.seq,
    firstUid: entry.uid,
    startUs: e.timestampUs,
    request: e,
    final: null,
    pendingCount: 0,
    firstPendingUs: null,
    staleDrops: 0,
    origin: e.origin,
    addressing: e.addressing,
    sid: e.sid ?? (e.bytes.length > 0 ? e.bytes[0] : null),
    status: 'pending',
    elapsedUs: null,
    frames,
  });
}

function newOrphanTx(entry: TrafficEvent): Transaction {
  const e = entry.event;
  return withStatus({
    key: txKey(entry.epoch, e.seq),
    epoch: entry.epoch,
    seq: e.seq,
    firstUid: entry.uid,
    startUs: e.timestampUs,
    request: null,
    final: e,
    pendingCount: 0,
    firstPendingUs: null,
    staleDrops: 0,
    origin: e.origin,
    addressing: e.addressing,
    sid: e.sid,
    status: 'pending',
    elapsedUs: null,
    frames: [],
  });
}

// ─── Ordering ─────────────────────────────────────────────────────────────────────────────────

/**
 * Tie-break at equal timestamps: request / keepalive events first, then frames (a frame precedes the
 * event that completes it), then every other event. Then epoch, then seq.
 */
function rank(item: TimelineItem): number {
  if (item.kind === 'frame') return 1;
  return item.event.kind === 'request' || item.event.kind === 'keepalive_sent' ? 0 : 2;
}

function itemTs(item: TimelineItem): number {
  return item.kind === 'frame' ? item.frame.timestampUs ?? item.frame.timestampMs * 1000 : item.event.timestampUs;
}

function itemEpoch(item: TimelineItem): number {
  return item.kind === 'frame' ? item.frame.epoch : item.epoch;
}

function itemSeq(item: TimelineItem): number {
  return item.kind === 'frame' ? item.frame.seq : item.event.seq;
}

export function compareTimeline(a: TimelineItem, b: TimelineItem): number {
  const dt = itemTs(a) - itemTs(b);
  if (dt !== 0) return dt;
  const dr = rank(a) - rank(b);
  if (dr !== 0) return dr;
  const de = itemEpoch(a) - itemEpoch(b);
  if (de !== 0) return de;
  const ds = itemSeq(a) - itemSeq(b);
  if (ds !== 0) return ds;
  return a.uid - b.uid;
}

/** First index in an array sorted by `compareTimeline` whose element is strictly greater than `item`. */
function upperBound(arr: readonly TimelineItem[], item: TimelineItem): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareTimeline(arr[mid], item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundUid<T extends { uid: number }>(arr: readonly T[], uid: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].uid < uid) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index of a `firstUid`-sorted transaction list whose `firstUid >= uid`. */
function lowerBoundFirstUid(arr: readonly Transaction[], uid: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].firstUid < uid) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─── Incremental model ────────────────────────────────────────────────────────────────────────

export class TrafficModel {
  private txs: Transaction[] = [];
  private txMap = new Map<string, Transaction>();
  private notes: NoteItem[] = [];
  private timeline: TimelineItem[] = [];
  private frames: readonly IsoTpFrameEntry[] = [];
  /** Frames whose transaction is not known (yet): key -> frames. */
  private orphanFrames = new Map<string, IsoTpFrameEntry[]>();

  private lastEventUid = 0;
  private lastFrameUid = 0;
  private oldestEventUid = 0;
  private oldestFrameUid = 0;
  private ingested = 0;
  private version = 0;
  private cached: TrafficSnapshot | null = null;
  private cachedAt = -1;

  /** Feed the full (capped, chronological) store arrays; only entries not seen before are processed. */
  update(conv: readonly TrafficConversationEntry[], frames: readonly IsoTpFrameEntry[]): TrafficSnapshot {
    let changed = false;

    // 1. New conversation entries.
    const cStart = lowerBoundUid(conv, this.lastEventUid + 1);
    for (let i = cStart; i < conv.length; i += 1) {
      const entry = conv[i];
      this.lastEventUid = entry.uid;
      changed = true;
      if (entry.event === null) {
        if (entry.note !== null) this.notes.push({ uid: entry.uid, note: entry.note });
        continue;
      }
      this.ingested += 1;
      this.ingestEvent({ kind: 'event', uid: entry.uid, epoch: entry.epoch, event: entry.event });
    }

    // 2. New frames (after events, so their transactions already exist).
    const fStart = lowerBoundUid(frames, this.lastFrameUid + 1);
    for (let i = fStart; i < frames.length; i += 1) {
      const frame = frames[i];
      this.lastFrameUid = frame.uid;
      changed = true;
      this.ingested += 1;
      this.ingestFrame(frame);
    }
    this.frames = frames;

    // 3. Eviction (store caps / clear): trim from the front by uid (uids are monotonic and never reused).
    const oldestEvent = conv.length > 0 ? conv[0].uid : this.lastEventUid + 1;
    const oldestFrame = frames.length > 0 ? frames[0].uid : this.lastFrameUid + 1;
    const evictEvents = oldestEvent > this.oldestEventUid;
    const evictFrames = oldestFrame > this.oldestFrameUid;
    this.oldestEventUid = oldestEvent;
    this.oldestFrameUid = oldestFrame;
    if (evictEvents) {
      changed = true;
      let drop = 0;
      while (drop < this.txs.length && this.txs[drop].firstUid < oldestEvent) {
        this.txMap.delete(this.txs[drop].key);
        drop += 1;
      }
      if (drop > 0) this.txs.splice(0, drop);
      const noteDrop = lowerBoundUid(this.notes, oldestEvent);
      if (noteDrop > 0) this.notes.splice(0, noteDrop);
    }
    if (evictEvents || evictFrames) {
      changed = true;
      this.timeline = this.timeline.filter((it) =>
        it.kind === 'event' ? it.uid >= oldestEvent : it.uid >= oldestFrame,
      );
      for (const [key, list] of this.orphanFrames) {
        const kept = list.filter((f) => f.uid >= oldestFrame);
        if (kept.length === 0) this.orphanFrames.delete(key);
        else if (kept.length !== list.length) this.orphanFrames.set(key, kept);
      }
    }

    if (changed || this.cached === null) {
      this.version += 1;
      this.cached = null;
    }
    return this.snapshot();
  }

  private insertTimeline(item: TimelineItem): void {
    const n = this.timeline.length;
    if (n === 0 || compareTimeline(this.timeline[n - 1], item) <= 0) {
      this.timeline.push(item);
      return;
    }
    this.timeline.splice(upperBound(this.timeline, item), 0, item);
  }

  private replaceTx(next: Transaction): void {
    const idx = lowerBoundFirstUid(this.txs, next.firstUid);
    if (idx < this.txs.length && this.txs[idx].key === next.key) this.txs[idx] = next;
    this.txMap.set(next.key, next);
  }

  private addTx(tx: Transaction): void {
    // Frames of a failed exchange are tagged with the seq of the error event itself and may have
    // been ingested before it (or in the same pass): attach them to the standalone row.
    const early = tx.request === null ? this.orphanFrames.get(tx.key) : undefined;
    if (early !== undefined) {
      this.orphanFrames.delete(tx.key);
      tx = { ...tx, frames: early };
    }
    this.txs.push(tx);
    this.txMap.set(tx.key, tx);
  }

  private ingestEvent(item: TrafficEvent): void {
    this.insertTimeline(item);
    const e = item.event;
    const lookup = e.requestSeq !== null ? this.txMap.get(txKey(item.epoch, e.requestSeq)) : undefined;
    switch (e.kind) {
      case 'request':
      case 'keepalive_sent': {
        const key = txKey(item.epoch, e.seq);
        if (this.txMap.has(key)) return; // duplicate delivery
        const early = this.orphanFrames.get(key) ?? [];
        this.orphanFrames.delete(key);
        this.addTx(newRequestTx(item, early));
        return;
      }
      case 'response_pending':
        if (lookup) {
          this.replaceTx({
            ...lookup,
            pendingCount: lookup.pendingCount + 1,
            firstPendingUs: lookup.firstPendingUs ?? e.timestampUs,
          });
        } else this.addTx(newOrphanTx(item));
        return;
      case 'stale_response_dropped':
        if (lookup) this.replaceTx({ ...lookup, staleDrops: lookup.staleDrops + 1 });
        else this.addTx(newOrphanTx(item));
        return;
      case 'response':
      case 'timeout':
      case 'transport_error':
      case 'tx_blocked':
      case 'session_closed':
        if (lookup && lookup.final === null && lookup.request?.kind === 'request') {
          this.replaceTx(withStatus({ ...lookup, final: e }));
        } else this.addTx(newOrphanTx(item));
        return;
    }
  }

  private ingestFrame(frame: IsoTpFrameEntry): void {
    this.insertTimeline({ kind: 'frame', uid: frame.uid, frame });
    if (frame.requestSeq === null) return;
    const key = txKey(frame.epoch, frame.requestSeq);
    const tx = this.txMap.get(key);
    if (tx) {
      this.replaceTx({ ...tx, frames: tx.frames.concat(frame) });
      return;
    }
    const list = this.orphanFrames.get(key);
    if (list) list.push(frame);
    else this.orphanFrames.set(key, [frame]);
  }

  private snapshot(): TrafficSnapshot {
    if (this.cached !== null && this.cachedAt === this.version) return this.cached;
    const txs = this.txs.slice();
    const counters: TrafficCounters = {
      total: txs.length,
      nrc: 0,
      timeout: 0,
      errors: 0,
      pending: 0,
      frames: this.frames.length,
      unmatchedFrames: 0,
    };
    for (const tx of txs) {
      if (tx.status === 'nrc') counters.nrc += 1;
      else if (tx.status === 'timeout') counters.timeout += 1;
      if (isErrorStatus(tx.status)) counters.errors += 1;
      if (tx.status === 'pending') counters.pending += 1;
    }
    for (const f of this.frames) if (f.requestSeq === null) counters.unmatchedFrames += 1;

    const timeline = this.timeline.slice();
    let baseUs = 0;
    if (timeline.length > 0) {
      baseUs = Number.POSITIVE_INFINITY;
      for (const it of timeline) baseUs = Math.min(baseUs, itemTs(it));
    }
    let map: Map<string, Transaction> | null = null;
    const frozenTxs = txs;
    const snap: TrafficSnapshot = {
      version: this.version,
      txs: frozenTxs,
      notes: this.notes.slice(),
      timeline,
      frames: this.frames,
      counters,
      baseUs,
      ingested: this.ingested,
      lastTx: frozenTxs.length > 0 ? frozenTxs[frozenTxs.length - 1] : null,
      findTx(epoch: number, seq: number): Transaction | undefined {
        if (map === null) {
          map = new Map<string, Transaction>();
          for (const tx of frozenTxs) map.set(tx.key, tx);
        }
        return map.get(txKey(epoch, seq));
      },
    };
    this.cached = snap;
    this.cachedAt = this.version;
    return snap;
  }
}

// ─── Row construction (pure; filters injected) ────────────────────────────────────────────────

export type TrafficViewMode = 'transactions' | 'interleaved' | 'frames';

/** Row order of the table: newest entries at the top (default) or appended at the bottom. */
export type TrafficOrder = 'newestFirst' | 'oldestFirst';

export type DockRow =
  | { type: 'tx'; key: string; tx: Transaction; expanded: boolean }
  | { type: 'txFrame'; key: string; tx: Transaction; frame: IsoTpFrameEntry; dtUs: number }
  | { type: 'note'; key: string; note: NoteItem }
  | { type: 'event'; key: string; item: TrafficEvent; tx: Transaction | undefined }
  | { type: 'frame'; key: string; frame: IsoTpFrameEntry; tx: Transaction | undefined; unmatched: boolean };

export interface RowPredicates {
  tx(tx: Transaction): boolean;
  event(item: TrafficEvent, tx: Transaction | undefined): boolean;
  frame(frame: IsoTpFrameEntry, tx: Transaction | undefined): boolean;
  /** True when no filter narrows the list (notes are then shown). */
  passthrough: boolean;
}

export function framePrimaryTs(f: IsoTpFrameEntry): number {
  return f.timestampUs ?? f.timestampMs * 1000;
}

/**
 * Reverse a chronological row list in O(n). In Transactions mode only the transaction groups (and
 * the session notes between them) are reversed: an expanded transaction's `txFrame` children stay
 * chronological directly under their parent `tx` row.
 */
export function orderRows(rows: DockRow[], order: TrafficOrder): DockRow[] {
  if (order === 'oldestFirst') return rows;
  const out: DockRow[] = [];
  let i = rows.length - 1;
  while (i >= 0) {
    if (rows[i].type === 'txFrame') {
      let k = i;
      while (k > 0 && rows[k].type === 'txFrame') k -= 1;
      // rows[k] is the parent tx row (children are always emitted right after it).
      for (let j = k; j <= i; j += 1) out.push(rows[j]);
      i = k - 1;
    } else {
      out.push(rows[i]);
      i -= 1;
    }
  }
  return out;
}

export function buildRows(
  snap: TrafficSnapshot,
  mode: TrafficViewMode,
  pred: RowPredicates,
  expanded: ReadonlySet<string>,
  order: TrafficOrder = 'oldestFirst',
): DockRow[] {
  return orderRows(buildRowsChronological(snap, mode, pred, expanded), order);
}

function buildRowsChronological(
  snap: TrafficSnapshot,
  mode: TrafficViewMode,
  pred: RowPredicates,
  expanded: ReadonlySet<string>,
): DockRow[] {
  const rows: DockRow[] = [];
  if (mode === 'transactions') {
    const noteList = pred.passthrough ? snap.notes : [];
    let ni = 0;
    for (const tx of snap.txs) {
      while (ni < noteList.length && noteList[ni].uid < tx.firstUid) {
        rows.push({ type: 'note', key: `n:${noteList[ni].uid}`, note: noteList[ni] });
        ni += 1;
      }
      if (!pred.tx(tx)) continue;
      const isOpen = expanded.has(tx.key) && tx.frames.length > 0;
      rows.push({ type: 'tx', key: `t:${tx.key}`, tx, expanded: isOpen });
      if (isOpen) {
        const t0 = txStartFrameUs(tx);
        for (const frame of tx.frames) {
          rows.push({
            type: 'txFrame',
            key: `t:${tx.key}:f:${frame.uid}`,
            tx,
            frame,
            dtUs: framePrimaryTs(frame) - t0,
          });
        }
      }
    }
    for (; ni < noteList.length; ni += 1) {
      rows.push({ type: 'note', key: `n:${noteList[ni].uid}`, note: noteList[ni] });
    }
    return rows;
  }

  if (mode === 'interleaved') {
    for (const it of snap.timeline) {
      if (it.kind === 'event') {
        const tx = txOfEvent(snap, it);
        if (!pred.event(it, tx)) continue;
        rows.push({ type: 'event', key: `e:${it.uid}`, item: it, tx });
      } else {
        const f = it.frame;
        const tx = f.requestSeq !== null ? snap.findTx(f.epoch, f.requestSeq) : undefined;
        if (!pred.frame(f, tx)) continue;
        rows.push({ type: 'frame', key: `f:${f.uid}`, frame: f, tx, unmatched: f.requestSeq === null });
      }
    }
    return rows;
  }

  for (const f of snap.frames) {
    const tx = f.requestSeq !== null ? snap.findTx(f.epoch, f.requestSeq) : undefined;
    if (!pred.frame(f, tx)) continue;
    rows.push({ type: 'frame', key: `f:${f.uid}`, frame: f, tx, unmatched: f.requestSeq === null });
  }
  return rows;
}

/** Δt origin for child frames: the request event time (frames are expressed relative to the request). */
export function txStartFrameUs(tx: Transaction): number {
  return tx.startUs;
}

export function txOfEvent(snap: TrafficSnapshot, item: TrafficEvent): Transaction | undefined {
  const e = item.event;
  if (e.requestSeq !== null) return snap.findTx(item.epoch, e.requestSeq) ?? snap.findTx(item.epoch, e.seq);
  return snap.findTx(item.epoch, e.seq);
}

// ─── Display helpers ──────────────────────────────────────────────────────────────────────────

const briefCache = new WeakMap<Transaction, string>();

/** One-line decoded summary of a transaction (cached per immutable transaction object). */
export function txBrief(tx: Transaction): string {
  const hit = briefCache.get(tx);
  if (hit !== undefined) return hit;
  let brief = '';
  const f = tx.final;
  if (f && f.kind === 'response' && f.bytes.length > 0) {
    const it = interpretUdsResponse(tx.request?.bytes ?? [], f.bytes);
    brief = it.kind === 'unknown' || it.kind === 'malformed' ? '' : it.brief;
  } else if (f && f.detail) {
    brief = f.detail;
  }
  briefCache.set(tx, brief);
  return brief;
}

/** NRC (code + name) of a transaction, or null. */
export function txNrc(tx: Transaction): { code: number; name: string | null } | null {
  const f = tx.final;
  if (!f || f.nrc === null) return null;
  return { code: f.nrc, name: udsNrcName(f.nrc) };
}
