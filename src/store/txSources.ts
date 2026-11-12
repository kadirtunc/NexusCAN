/**
 * TX source registry (WP-4 / CRIT-05.1).
 *
 * Anything that can put a frame on a bus on its own schedule (periodic jobs, stimulus, polling
 * loops, flows, replay with hardware TX, TesterPresent, ...) MUST register a `stop` callback here.
 * `performPanicStop()` invokes every registered callback, so a new TX source can never be missed
 * by the global "STOP ALL TX" button / Ctrl+Shift+Space.
 *
 * `stop` must be idempotent, synchronous and must not throw (errors are swallowed per source so one
 * faulty source cannot prevent the others from stopping).
 */
const sources = new Map<string, () => void>();

/** Registers (or replaces) a TX source. Returns an unregister function. */
export function registerTxSource(id: string, stop: () => void): () => void {
  sources.set(id, stop);
  return () => {
    if (sources.get(id) === stop) sources.delete(id);
  };
}

/** Calls every registered stop callback. Returns the ids that were stopped (diagnostics/tests). */
export function stopAllTxSources(): string[] {
  const ids: string[] = [];
  for (const [id, stop] of [...sources]) {
    ids.push(id);
    try {
      stop();
    } catch {
      // Panic must always continue to the next source.
    }
  }
  return ids;
}

export function listTxSourceIds(): string[] {
  return [...sources.keys()];
}
