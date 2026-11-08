/**
 * NexusCAN Local Workspace Persistence
 *
 * Two-tier offline storage engine with zero external dependencies:
 * - Tier 1: Synchronous session metadata via `localStorage` (0ms read during initial React mount, zero-flicker F5 reload)
 * - Tier 2: Full `NexusProjectFileV1` storage via `IndexedDB` (handles large multi-megabyte `.dbc` / `.kcd` databases without 5MB quota errors)
 */

import type { NexusProjectFileV1 } from '../store/projectStore';

export type ActiveDocumentTab =
  | 'start'
  | 'rxtx'
  | 'connections'
  | 'plotter'
  | 'trace'
  | 'symbols'
  | 'panels'
  | 'cloud';

export type UiTheme = 'dark' | 'light';

export const ACTIVE_SESSION_META_KEY = 'nexuscan:activeSessionMeta:v1';
export const LAST_ACTIVE_PROJECT_KEY = 'nexuscan:lastActiveProject:v1';

export interface ActiveSessionMeta {
  isOpen: boolean;
  fileStem: string;
  name: string;
  activeDocTab: ActiveDocumentTab;
  theme: UiTheme;
  updatedAt: string;
}

const DB_NAME = 'nexuscan_local_db';
const DB_VERSION = 1;
const STORE_NAME = 'workspace_kv';
const ACTIVE_PROJECT_KEY = 'active_project';

let dbPromise: Promise<IDBDatabase> | null = null;

// ============================================================================
// Tier 1: Synchronous Session Metadata (localStorage)
// ============================================================================

export function readActiveSessionMetaSync(): ActiveSessionMeta | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(ACTIVE_SESSION_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveSessionMeta>;
    if (
      parsed &&
      typeof parsed.isOpen === 'boolean' &&
      typeof parsed.fileStem === 'string' &&
      typeof parsed.name === 'string' &&
      typeof parsed.activeDocTab === 'string' &&
      typeof parsed.theme === 'string' &&
      typeof parsed.updatedAt === 'string'
    ) {
      return parsed as ActiveSessionMeta;
    }
  } catch {
    // Ignore corrupt JSON
  }
  return null;
}

export function writeActiveSessionMetaSync(meta: ActiveSessionMeta | null): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    if (meta === null) {
      window.localStorage.removeItem(ACTIVE_SESSION_META_KEY);
    } else {
      window.localStorage.setItem(ACTIVE_SESSION_META_KEY, JSON.stringify(meta));
    }
  } catch {
    // Ignore storage write quota exceptions
  }
}

// ============================================================================
// Tier 2: IndexedDB Full Project Storage (`nexuscan_local_db` / `workspace_kv`)
// ============================================================================

function openWorkspaceDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.reject(new Error('IndexedDB is not available in current environment'));
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Failed to open IndexedDB nexuscan_local_db'));
      };

      request.onblocked = () => {
        console.warn('[workspaceDb] IndexedDB open blocked by other connection');
      };
    } catch (err) {
      dbPromise = null;
      reject(err);
    }
  });

  return dbPromise;
}

export async function saveActiveProjectToLocalDb(project: NexusProjectFileV1): Promise<void> {
  // 1. IndexedDB primary save (unlimited quota for large symbol databases)
  try {
    const db = await openWorkspaceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(project, ACTIVE_PROJECT_KEY);

      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(req.error || new Error('Failed to put active_project in IndexedDB'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  } catch (err) {
    console.warn('[workspaceDb] saveActiveProjectToLocalDb IndexedDB error:', err);
  }

  // 2. localStorage secondary fast cache (best effort, ignore quota errors if large)
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, JSON.stringify(project));
    } catch {
      // Ignore quota error
    }
  }
}

export async function loadActiveProjectFromLocalDb(): Promise<NexusProjectFileV1 | null> {
  // 1. Try loading from IndexedDB first
  try {
    const db = await openWorkspaceDb();
    const result = await new Promise<NexusProjectFileV1 | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(ACTIVE_PROJECT_KEY);

      req.onsuccess = () => {
        const res = req.result as Partial<NexusProjectFileV1> | undefined;
        if (res && res.version === 1 && typeof res.name === 'string') {
          resolve(res as NexusProjectFileV1);
        } else {
          resolve(null);
        }
      };
      req.onerror = () =>
        reject(req.error || new Error('Failed to get active_project from IndexedDB'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });

    if (result) {
      return result;
    }
  } catch (err) {
    console.warn('[workspaceDb] loadActiveProjectFromLocalDb IndexedDB error:', err);
  }

  // 2. Fallback to localStorage cache
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(LAST_ACTIVE_PROJECT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<NexusProjectFileV1>;
        if (parsed && parsed.version === 1 && typeof parsed.name === 'string') {
          return parsed as NexusProjectFileV1;
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  return null;
}

export async function clearActiveProjectFromLocalDb(): Promise<void> {
  try {
    const db = await openWorkspaceDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(ACTIVE_PROJECT_KEY);

      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(req.error || new Error('Failed to delete active_project from IndexedDB'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    });
  } catch (err) {
    console.warn('[workspaceDb] clearActiveProjectFromLocalDb IndexedDB error:', err);
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(LAST_ACTIVE_PROJECT_KEY);
    } catch {
      // Ignore
    }
  }
}
