import { apiSetBusMode } from '../services/ipcClient';
import type { BusHealthDto } from '../types/hal';
import { connectionStore } from './connectionStore';
import { telemetryStore } from './telemetryStore';

/**
 * Single source of truth for switching a physical bus between Listen-Only (passive) and active TX.
 * Used by the global TopBar TX control and the Connections view. Errors propagate to the caller.
 * Backend side effect: arming clears the Panic latch.
 */
export async function setBusTxArmed(busId: number, armed: boolean): Promise<BusHealthDto> {
  const updated = await apiSetBusMode(busId, !armed, armed);
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
