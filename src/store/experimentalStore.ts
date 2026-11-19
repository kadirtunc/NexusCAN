import { useSyncExternalStore } from 'react';

/**
 * Experimental feature flags.
 * `experimentalCloud` gates every NexusCloud (self-hosted) UI surface and the
 * cloud bridge lifecycle (no network access while the flag is off).
 *
 * NexusCloud is not part of the public release: the flag is compiled OFF, the View-menu toggle
 * is removed and a persisted value from older builds is ignored. Flip CLOUD_AVAILABLE to bring
 * the gated surfaces back during development.
 */
const CLOUD_AVAILABLE = false;
const STORAGE_KEY_CLOUD = 'nexuscan:experimental-cloud:v1';

function loadCloudFlag(): boolean {
  if (!CLOUD_AVAILABLE || typeof window === 'undefined') return false;
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
    if (!CLOUD_AVAILABLE) return;
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
