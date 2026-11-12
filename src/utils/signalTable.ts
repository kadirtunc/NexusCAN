import type { SignalSchemaDto } from '../types/netdb';

/** Dense `signalId -> schema` arrays are only allocated up to this id (WP-6, HIGH-08). */
export const DENSE_SIGNAL_TABLE_MAX_ID = 65535;

const CANONICAL_INDEX_RE = /^(0|[1-9][0-9]*)$/;

/**
 * O(1) `signalId -> SignalSchemaDto` lookup indexable like an array (`table[id]`).
 *
 * - `maxSignalId <= 65535`: dense array (fastest, the normal case: backend ids are sequential).
 * - otherwise: a `Map`-backed read-only view. Indexing works, `length` is 0 so nothing can ever
 *   iterate or allocate `maxSignalId + 1` slots from an untrusted/corrupt schema.
 */
export function buildSignalTable(
  signals: readonly SignalSchemaDto[],
): readonly (SignalSchemaDto | undefined)[] {
  let maxSignalId = -1;
  for (const sig of signals) {
    if (sig.signalId > maxSignalId) maxSignalId = sig.signalId;
  }
  if (maxSignalId < 0) return [];

  if (maxSignalId <= DENSE_SIGNAL_TABLE_MAX_ID) {
    const dense = new Array<SignalSchemaDto | undefined>(maxSignalId + 1);
    for (const sig of signals) {
      if (Number.isInteger(sig.signalId) && sig.signalId >= 0) dense[sig.signalId] = sig;
    }
    return dense;
  }

  const sparse = new Map<number, SignalSchemaDto>();
  for (const sig of signals) sparse.set(sig.signalId, sig);
  return new Proxy<(SignalSchemaDto | undefined)[]>([], {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && CANONICAL_INDEX_RE.test(prop)) {
        return sparse.get(Number(prop));
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop): boolean {
      if (typeof prop === 'string' && CANONICAL_INDEX_RE.test(prop)) {
        return sparse.has(Number(prop));
      }
      return Reflect.has(target, prop);
    },
    set(): boolean {
      return false;
    },
  });
}
