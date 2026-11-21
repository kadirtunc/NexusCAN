import { useSyncExternalStore } from 'react';
import { isGuidePageId, type GuideDialogRequest, type GuidePageId } from '../onboarding/types';

export const ONBOARDING_STORAGE_KEY = 'nexuscan.onboarding.v1';

export interface OnboardingPersisted {
  schemaVersion: 1;
  seenPages: readonly GuidePageId[];
  txSafetyAcked: boolean;
  /** Workspace "Getting Started" panel closed with X; re-enabled from the Workspace info dialog. */
  startPanelHidden: boolean;
}

export interface OnboardingState extends OnboardingPersisted {
  dialog: GuideDialogRequest | null;
}

const DEFAULT_PERSISTED: OnboardingPersisted = {
  schemaVersion: 1,
  seenPages: [],
  txSafetyAcked: false,
  startPanelHidden: false,
};

/** Corrupt / foreign / wrong-version data always falls back to defaults; never throws. */
export function parsePersisted(raw: string | null): OnboardingPersisted {
  if (raw === null) return DEFAULT_PERSISTED;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return DEFAULT_PERSISTED;
    const rec = v as Record<string, unknown>;
    if (rec.schemaVersion !== 1) return DEFAULT_PERSISTED;
    const seen = Array.isArray(rec.seenPages)
      ? Array.from(new Set(rec.seenPages.filter(isGuidePageId)))
      : [];
    return {
      schemaVersion: 1,
      seenPages: seen,
      txSafetyAcked: rec.txSafetyAcked === true,
      startPanelHidden: rec.startPanelHidden === true,
    };
  } catch {
    return DEFAULT_PERSISTED;
  }
}

function load(): OnboardingPersisted {
  try {
    return parsePersisted(globalThis.localStorage?.getItem(ONBOARDING_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_PERSISTED;
  }
}

let state: OnboardingState = { ...load(), dialog: null };
const listeners = new Set<() => void>();

function commit(next: OnboardingState, persist: boolean): void {
  state = next;
  if (persist) {
    const data: OnboardingPersisted = {
      schemaVersion: 1,
      seenPages: next.seenPages,
      txSafetyAcked: next.txSafetyAcked,
      startPanelHidden: next.startPanelHidden,
    };
    try {
      globalThis.localStorage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable: keep in-memory state only */
    }
  }
  listeners.forEach((l) => l());
}

export const onboardingStore = {
  getState: (): OnboardingState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  isSeen: (id: GuidePageId): boolean => state.seenPages.includes(id),
  markSeen(id: GuidePageId): void {
    if (state.seenPages.includes(id)) return;
    commit({ ...state, seenPages: [...state.seenPages, id] }, true);
  },
  ackTxSafety(): void {
    if (state.txSafetyAcked) return;
    commit({ ...state, txSafetyAcked: true }, true);
  },
  setStartPanelHidden(hidden: boolean): void {
    if (state.startPanelHidden === hidden) return;
    commit({ ...state, startPanelHidden: hidden }, true);
  },
  /** Opens the info dialog. Purely informational: never touches TX / bus state. */
  openDialog(pageId: GuidePageId, sectionId: string | null = null): void {
    commit({ ...state, dialog: { pageId, sectionId } }, false);
  },
  closeDialog(): void {
    if (state.dialog === null) return;
    commit({ ...state, dialog: null }, false);
  },
};

export function useOnboardingStore(): OnboardingState {
  return useSyncExternalStore(onboardingStore.subscribe, onboardingStore.getState, onboardingStore.getState);
}
