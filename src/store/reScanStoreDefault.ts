/** App singleton of the Value Scan store (wired to reClient + Debug console). Kept apart so `reScanStore` stays import-pure. */
import { useSyncExternalStore } from 'react';
import * as client from '../services/reClient';
import { reDebugLogger } from './reDebugLog';
import { createReScanStore, type ReScanStore, type ReScanStoreState } from './reScanStore';
import { reStore } from './reStore';

export const reScanStore: ReScanStore = createReScanStore(
  {
    first: client.reScanFirst,
    next: client.reScanNext,
    undo: client.reScanUndo,
    reset: client.reScanReset,
    status: client.reScanStatus,
    results: client.reScanResults,
  },
  reDebugLogger,
);

// Source switch invalidates the scan (different engine / backend).
reStore.onSourceChange(() => reScanStore.invalidate());

export function useReScanState(): ReScanStoreState {
  return useSyncExternalStore(reScanStore.subscribe, reScanStore.getState, reScanStore.getState);
}
