/**
 * UI scale (90 / 100 / 110 / 125 %). Persisted in localStorage.
 * Tauri: getCurrentWebview().setZoom(); browser (or if the zoom permission is
 * not granted in the capability file): document.documentElement.style.zoom.
 */
import { useSyncExternalStore } from 'react';
import { isTauri } from '../services/ipcClient';

export const UI_SCALE_OPTIONS = [90, 100, 110, 125] as const;
export type UiScalePct = (typeof UI_SCALE_OPTIONS)[number];

const STORAGE_KEY = 'nexuscan.uiScalePct';

function readStored(): UiScalePct {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY));
    const hit = UI_SCALE_OPTIONS.find((v) => v === raw);
    return hit ?? 100;
  } catch {
    return 100;
  }
}

let current: UiScalePct = readStored();
const listeners = new Set<() => void>();

async function apply(pct: UiScalePct): Promise<void> {
  const factor = pct / 100;
  if (isTauri) {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      await getCurrentWebview().setZoom(factor);
      document.documentElement.style.removeProperty('zoom');
      return;
    } catch {
      // Permission missing or unsupported: fall through to CSS zoom.
    }
  }
  if (pct === 100) document.documentElement.style.removeProperty('zoom');
  else document.documentElement.style.zoom = String(factor);
}

export const uiScaleStore = {
  get: (): UiScalePct => current,
  set(pct: UiScalePct): void {
    current = pct;
    try {
      localStorage.setItem(STORAGE_KEY, String(pct));
    } catch {
      // storage unavailable: keep in-memory only
    }
    void apply(pct);
    listeners.forEach((l) => l());
  },
  /** Re-apply the persisted value at startup. */
  init(): void {
    if (current !== 100) void apply(current);
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export function useUiScale(): UiScalePct {
  return useSyncExternalStore(uiScaleStore.subscribe, uiScaleStore.get, uiScaleStore.get);
}
