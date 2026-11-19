/**
 * RE Toolkit -> Debug console bridge. Every RE failure is mirrored into the Debug console (category `RE`, source `ui`,
 * stable `action`). Repeated identical errors (same action + message) from polling loops are collapsed: at most one log
 * per `RE_LOG_RATE_LIMIT_MS`, and the next emitted one carries a "(xN repeated)" count. The emitter and clock are
 * injectable so stores can be unit-tested with a fake; stores default to `NOOP_RE_LOGGER`, only the app singletons wire
 * the real `logUiDebugEvent`.
 */
import { logUiDebugEvent } from './debugConsoleStore';
import type { AppendDebugEventInputDto } from '../types/hal';
import type { ReTargetDto } from '../types/re';

export const RE_LOG_RATE_LIMIT_MS = 5_000;

export type ReLogAction =
  | 're.series'
  | 're.correlate'
  | 're.focus_set'
  | 're.start'
  | 're.stop'
  | 're.reset'
  | 're.phase'
  | 're.mark'
  | 're.markers'
  | 're.row_detail'
  | 're.classify'
  | 're.subscribe'
  | 're.snapshot_decode'
  | 're.ws'
  | 're.source'
  | 're.dbc_generate'
  | 're.draft_apply'
  | 're.draft_export'
  | 're.draft_merge'
  | 're.drafts_load'
  | 're.scan_first'
  | 're.scan_next'
  | 're.scan_undo'
  | 're.scan_reset'
  | 're.scan_status'
  | 're.scan_results';

export interface ReLogger {
  /** error log; `ctx` = request args summary appended to the details */
  error(action: ReLogAction, title: string, err: unknown, ctx?: string): void;
  info(action: ReLogAction, title: string, details?: string): void;
}

export const NOOP_RE_LOGGER: ReLogger = {
  error: () => undefined,
  info: () => undefined,
};

export interface ReLoggerDeps {
  emit: (ev: AppendDebugEventInputDto) => void;
  nowMs: () => number;
  rateLimitMs?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createReLogger(deps: ReLoggerDeps): ReLogger {
  const limit = deps.rateLimitMs ?? RE_LOG_RATE_LIMIT_MS;
  const seen = new Map<string, { lastMs: number; suppressed: number }>();

  const prune = (now: number): void => {
    if (seen.size <= 64) return;
    for (const [k, v] of seen) if (now - v.lastMs >= limit && v.suppressed === 0) seen.delete(k);
  };

  return {
    error(action, title, err, ctx) {
      const message = messageOf(err);
      const now = deps.nowMs();
      const key = `${action}\u0000${message}`;
      const prev = seen.get(key);
      let repeated = 0;
      if (prev !== undefined) {
        if (now - prev.lastMs < limit) {
          prev.suppressed += 1;
          return;
        }
        repeated = prev.suppressed;
      }
      seen.set(key, { lastMs: now, suppressed: 0 });
      prune(now);
      deps.emit({
        severity: 'error',
        category: 'RE',
        source: 'ui',
        action,
        title: repeated > 0 ? `${title} (×${repeated} repeated)` : title,
        details: ctx === undefined || ctx === '' ? message : `${message} | ${ctx}`,
      });
    },
    info(action, title, details) {
      deps.emit({ severity: 'info', category: 'RE', source: 'ui', action, title, details: details ?? null });
    },
  };
}

/** App-wide logger writing to the Debug console. */
export const reDebugLogger: ReLogger = createReLogger({ emit: logUiDebugEvent, nowMs: () => Date.now() });

// ---- args summaries (details) -----------------------------------------------------------------------------------

export function fmtReTarget(t: ReTargetDto | null): string {
  return t === null ? 'target=none' : `target=bus${t.bus} id=0x${t.arbId.toString(16).toUpperCase()}${t.isExtended ? 'x' : ''}`;
}

export function fmtReWindow(fromUs: number | null, toUs: number | null, maxPoints?: number): string {
  const w = `window=[${fromUs === null ? 'auto' : fromUs}, ${toUs === null ? 'auto' : toUs}]`;
  return maxPoints === undefined ? w : `${w} maxPoints=${maxPoints}`;
}

export function fmtReBits(c: { startBit: number; bitLength: number; byteOrder: string }): string {
  return `bits=${c.startBit}+${c.bitLength}@${c.byteOrder}`;
}
