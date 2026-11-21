import { useSyncExternalStore } from 'react';
import { apiCheckForUpdate, apiGetAppVersion, isTauri, UPDATES_UNSUPPORTED } from '../services/ipcClient';
import { t } from '../i18n';
import type { AppVersionDto, UpdateCheckDto } from '../types/update';

export const UPDATES_STORAGE_KEY = 'nexuscan.updates.v1';
export const AUTO_CHECK_DELAY_MS = 5_000;
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdatesPersisted {
  autoCheck: boolean;
  /** Epoch ms of the last successful check; 0 = never. */
  lastCheckedAtMs: number;
  dismissedBuild: number | null;
  /** Newest release build seen by the last successful check; keeps the status-bar hint across restarts/offline. */
  knownLatestBuild: number | null;
}

export interface UpdatesState extends UpdatesPersisted {
  dialogOpen: boolean;
  /** Help > Changelog dialog (bundled CHANGELOG.md, works offline and in browser mode). */
  changelogOpen: boolean;
  checking: boolean;
  /** Installed version (status bar); null until loaded / browser mode. */
  appVersion: AppVersionDto | null;
  result: UpdateCheckDto | null;
  /** Localized message of the last MANUAL check failure (auto failures are silent). */
  error: string | null;
}

const DEFAULT_PERSISTED: UpdatesPersisted = { autoCheck: true, lastCheckedAtMs: 0, dismissedBuild: null, knownLatestBuild: null };

/** Corrupt / foreign data falls back to defaults field by field; never throws. */
export function parsePersisted(raw: string | null): UpdatesPersisted {
  if (raw === null) return DEFAULT_PERSISTED;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return DEFAULT_PERSISTED;
    const rec = v as Record<string, unknown>;
    const last = rec.lastCheckedAtMs;
    const dismissed = rec.dismissedBuild;
    const known = rec.knownLatestBuild;
    return {
      autoCheck: typeof rec.autoCheck === 'boolean' ? rec.autoCheck : true,
      lastCheckedAtMs: typeof last === 'number' && Number.isFinite(last) && last >= 0 ? last : 0,
      dismissedBuild:
        typeof dismissed === 'number' && Number.isInteger(dismissed) && dismissed >= 0 ? dismissed : null,
      knownLatestBuild: typeof known === 'number' && Number.isInteger(known) && known >= 0 ? known : null,
    };
  } catch {
    return DEFAULT_PERSISTED;
  }
}

/** Startup auto-check: enabled, and never checked / last check older than 24 h (future timestamps count as stale). */
export function shouldAutoCheck(p: UpdatesPersisted, nowMs: number): boolean {
  if (!p.autoCheck) return false;
  if (p.lastCheckedAtMs <= 0 || p.lastCheckedAtMs > nowMs) return true;
  return nowMs - p.lastCheckedAtMs > AUTO_CHECK_INTERVAL_MS;
}

/** Status-bar "new update" hint: release build only, newest known build is newer. Independent of card dismissal. */
export function newerBuildAvailable(current: AppVersionDto | null, knownLatestBuild: number | null): number | null {
  if (current === null || current.build === null || knownLatestBuild === null) return null;
  return knownLatestBuild > current.build ? knownLatestBuild : null;
}

/** Notice card: only for release builds with a newer build that the user has not dismissed. */
export function shouldShowNotice(result: UpdateCheckDto | null, dismissedBuild: number | null): boolean {
  if (result === null || result.currentBuild === null || !result.updateAvailable || result.latest === null) {
    return false;
  }
  return dismissedBuild === null || result.latest.build > dismissedBuild;
}

function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null) {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return String(e);
}

/** Maps a backend / transport error to a localized message (offline, rate limit, timeout). */
export function describeUpdateError(e: unknown): string {
  const raw = errorText(e);
  if (raw === UPDATES_UNSUPPORTED) return t('upd.err.unsupported');
  if (/rate.?limit|\b403\b/i.test(raw)) return t('upd.err.rateLimit');
  if (/time(d)?[ -]?out|zaman a/i.test(raw)) return t('upd.err.timeout');
  if (/offline|çevrimdışı|network|dns|connect|unreachable|resolve/i.test(raw)) return t('upd.err.offline');
  return t('upd.err.unknown', { detail: raw });
}

function load(): UpdatesPersisted {
  try {
    return parsePersisted(globalThis.localStorage?.getItem(UPDATES_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_PERSISTED;
  }
}

let state: UpdatesState = { ...load(), dialogOpen: false, changelogOpen: false, checking: false, appVersion: null, result: null, error: null };
const listeners = new Set<() => void>();

function commit(next: UpdatesState, persist: boolean): void {
  state = next;
  if (persist) {
    const data: UpdatesPersisted = {
      autoCheck: next.autoCheck,
      lastCheckedAtMs: next.lastCheckedAtMs,
      dismissedBuild: next.dismissedBuild,
      knownLatestBuild: next.knownLatestBuild,
    };
    try {
      globalThis.localStorage?.setItem(UPDATES_STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable: keep in-memory state only */
    }
  }
  listeners.forEach((l) => l());
}

export const updateStore = {
  getState: (): UpdatesState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Runs one check. Auto (manual=false) failures are silent (console.debug only); manual failures land in `error`. */
  async runCheck(manual: boolean): Promise<void> {
    if (state.checking) return;
    if (!isTauri) {
      if (manual) commit({ ...state, error: t('upd.err.unsupported') }, false);
      return;
    }
    commit({ ...state, checking: true, error: manual ? null : state.error }, false);
    try {
      const result = await apiCheckForUpdate();
      const knownLatestBuild = result.latest?.build ?? state.knownLatestBuild;
      commit({ ...state, checking: false, result, error: null, lastCheckedAtMs: Date.now(), knownLatestBuild }, true);
    } catch (e) {
      if (manual) {
        commit({ ...state, checking: false, error: describeUpdateError(e) }, false);
      } else {
        console.debug('[update-check] automatic check failed:', errorText(e));
        commit({ ...state, checking: false }, false);
      }
    }
  },
  /** Opens the release-notes dialog; `check` also starts an immediate manual check. */
  openDialog(check: boolean): void {
    commit({ ...state, dialogOpen: true, error: check ? null : state.error }, false);
    if (check) void updateStore.runCheck(true);
  },
  openChangelog(): void {
    commit({ ...state, changelogOpen: true }, false);
  },
  closeChangelog(): void {
    if (!state.changelogOpen) return;
    commit({ ...state, changelogOpen: false }, false);
  },
  closeDialog(): void {
    if (!state.dialogOpen) return;
    commit({ ...state, dialogOpen: false }, false);
  },
  setAutoCheck(on: boolean): void {
    if (state.autoCheck === on) return;
    commit({ ...state, autoCheck: on }, true);
  },
  /** Hides the notice for the currently announced build (a newer build shows it again). */
  dismissNotice(): void {
    const build = state.result?.latest?.build;
    if (build === undefined) return;
    commit({ ...state, dismissedBuild: build }, true);
  },
  /** Schedules the startup check (5 s delay). Returns the cleanup function. */
  startAutoCheck(): () => void {
    if (!isTauri) return () => undefined;
    apiGetAppVersion()
      .then((appVersion) => commit({ ...state, appVersion }, false))
      .catch((e: unknown) => console.debug('[update-check] version read failed:', errorText(e)));
    const id = setTimeout(() => {
      if (shouldAutoCheck(state, Date.now())) void updateStore.runCheck(false);
    }, AUTO_CHECK_DELAY_MS);
    return () => clearTimeout(id);
  },
};

export function useUpdateStore(): UpdatesState {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getState, updateStore.getState);
}
