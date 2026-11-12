import { t } from '../i18n';
import {
  apiClearPanicLatch,
  apiSetBusMode,
  isPanicLatchedError,
  isTxInFlightTimeoutError,
} from '../services/ipcClient';
import type { BusHealthDto } from '../types/hal';
import { connectionStore } from './connectionStore';
import { telemetryStore } from './telemetryStore';

/**
 * Single source of truth for switching a physical bus between Listen-Only (passive) and active TX.
 * Used by the global TopBar TX control and the Connections view. Errors propagate to the caller.
 * Arming while the Panic latch is set fails (`PANIC_LATCHED:`); the operator must clear it explicitly.
 */
export async function setBusTxArmed(busId: number, armed: boolean): Promise<BusHealthDto> {
  let updated: BusHealthDto;
  try {
    updated = await apiSetBusMode(busId, !armed, armed);
  } catch (err) {
    // Disarm path: the bus IS disarmed, only a driver write may still be pending. Reflect the
    // passive state locally (the 60 Hz snapshot confirms it) and still surface the warning.
    if (!armed && isTxInFlightTimeoutError(err)) {
      const cur = telemetryStore.getHeaderSlice().buses.find((b) => b.busId === busId);
      if (cur) telemetryStore.upsertBusHealth({ ...cur, listenOnly: true, txArmed: false });
      const prof = connectionStore.getState().profiles.find((p) => p.busId === busId);
      if (prof) connectionStore.upsertProfile({ ...prof, listenOnly: true });
    }
    throw err;
  }
  telemetryStore.upsertBusHealth(updated);

  const matching = connectionStore.getState().profiles.find((p) => p.busId === busId);
  if (matching) {
    connectionStore.upsertProfile({ ...matching, listenOnly: !armed });
  }
  return updated;
}

/** Disarms every connected bus that is currently armed. Rejects with the first error after trying all. */
export async function disarmAllBuses(): Promise<void> {
  const armed = telemetryStore
    .getHeaderSlice()
    .buses.filter((b) => b.connected && b.txArmed);
  const results = await Promise.allSettled(armed.map((b) => setBusTxArmed(b.busId, false)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }
}

/** Explicit operator action: clears the global Panic latch (never arms anything). */
export async function clearPanicLatch(): Promise<void> {
  await apiClearPanicLatch();
  telemetryStore.markPanicCleared();
}

/** Human-readable text for a bus mode / arm error (maps `PANIC_LATCHED:` to the clear-latch hint). */
export function describeTxError(err: unknown): string {
  if (isPanicLatchedError(err)) return t('sec.tx.clearLatchFirst');
  if (isTxInFlightTimeoutError(err)) return t('sec.tx.inFlightDisarmed');
  return err instanceof Error ? err.message : String(err);
}
