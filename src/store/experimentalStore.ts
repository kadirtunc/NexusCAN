import { useSyncExternalStore } from 'react';

/**
 * Experimental feature flags (persisted, default OFF).
 * `experimentalCloud` gates every NexusCloud (self-hosted) UI surface and the
 * cloud bridge lifecycle (no network access while the flag is off).
 */
const STORAGE_KEY_CLOUD = 'nexuscan:experimental-cloud:v1';

function loadCloudFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY_CLOUD) === '1';
  } catch {
    return false;
  }
}

let experimentalCloud: boolean = loadCloudFlag();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const experimentalStore = {
  subscribe,
  isCloudEnabled(): boolean {
    return experimentalCloud;
  },
  setCloudEnabled(next: boolean): void {
    if (next === experimentalCloud) return;
    experimentalCloud = next;
    try {
      window.localStorage.setItem(STORAGE_KEY_CLOUD, next ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    for (const l of [...listeners]) l();
  },
};

export function isExperimentalCloudEnabled(): boolean {
  return experimentalCloud;
}

export function useExperimentalCloud(): boolean {
  return useSyncExternalStore(
    experimentalStore.subscribe,
    experimentalStore.isCloudEnabled,
    experimentalStore.isCloudEnabled,
  );
}
