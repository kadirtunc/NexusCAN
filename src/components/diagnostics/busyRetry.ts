/** 0x21 busyRepeatRequest retry options of a UDS request (Console input parsing). Pure. */

export interface BusyRetryOptions {
  /** 1..10 (0 = off is represented as `null` by `parseBusyRetry`). */
  max: number;
  /** 10..5000 ms, `null` = backend default (50). */
  delayMs: number | null;
}

export const BUSY_RETRY_MAX = 10;
export const BUSY_RETRY_DELAY_MIN = 10;
export const BUSY_RETRY_DELAY_MAX = 5000;

export type BusyRetryParse =
  | { ok: true; value: BusyRetryOptions | null }
  | { ok: false; field: 'max' | 'delay' };

/** Empty / 0 retries = off (`value: null`). The delay is only validated while retries are on. */
export function parseBusyRetry(maxText: string, delayText: string): BusyRetryParse {
  const m = maxText.trim();
  if (m.length > 0 && !/^\d+$/.test(m)) return { ok: false, field: 'max' };
  const max = m.length === 0 ? 0 : parseInt(m, 10);
  if (max > BUSY_RETRY_MAX) return { ok: false, field: 'max' };
  if (max === 0) return { ok: true, value: null };
  const d = delayText.trim();
  if (d.length === 0) return { ok: true, value: { max, delayMs: null } };
  if (!/^\d+$/.test(d)) return { ok: false, field: 'delay' };
  const delay = parseInt(d, 10);
  if (delay < BUSY_RETRY_DELAY_MIN || delay > BUSY_RETRY_DELAY_MAX) return { ok: false, field: 'delay' };
  return { ok: true, value: { max, delayMs: delay } };
}

/** Additive `UdsRequestOptionsDto` fields (nothing at all when retries are off). */
export function busyRetryFields(r: BusyRetryOptions | null): { busyRetryMax?: number; busyRetryDelayMs?: number } {
  if (r === null || r.max <= 0) return {};
  return r.delayMs === null ? { busyRetryMax: r.max } : { busyRetryMax: r.max, busyRetryDelayMs: r.delayMs };
}
