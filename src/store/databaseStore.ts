import { useSyncExternalStore } from 'react';
import type {
  DatabaseSchemaDto,
  EcuNodeDto,
  MessageSchemaDto,
  SignalSchemaDto,
} from '../types/netdb';
import {
  type ActiveDocumentTab,
  type UiTheme,
  readActiveSessionMetaSync,
  writeActiveSessionMetaSync,
} from '../utils/workspaceDb';

export type { ActiveDocumentTab, UiTheme };
export type ExplorerSubTab = 'messages' | 'ecus' | 'diagnostics';

export interface CustomDbFileRecord {
  fileName: string;
  contentBase64: string;
  sizeBytes?: number;
}

export function makeCatalogDbId(fileName: string): string {
  return `db:${fileName.trim().toLowerCase()}`;
}

export interface ProjectDatabaseEntry {
  id: string; // e.g. makeCatalogDbId(fileName)
  name: string; // filename without extension or customizable display name
  fileName: string;
  format: 'dbc' | 'kcd';
  contentBase64: string;
  sizeBytes: number;
  uploadedAt: string;
  schema: DatabaseSchemaDto | null;
}

export interface BusSchemaLookup {
  schema: DatabaseSchemaDto;
  messagesByKey: ReadonlyMap<string, MessageSchemaDto>;
  messagesByArbKey: ReadonlyMap<string, MessageSchemaDto>;
  signalsById: readonly (SignalSchemaDto | undefined)[];
}

export interface DatabaseStoreState {
  databases: readonly ProjectDatabaseEntry[];
  inspectedDatabaseId: string | null;
  busSchemas: ReadonlyMap<number, BusSchemaLookup>;
  schema: DatabaseSchemaDto | null;
  messagesByKey: ReadonlyMap<string, MessageSchemaDto>;
  messagesByArbKey: ReadonlyMap<string, MessageSchemaDto>;
  signalsById: readonly (SignalSchemaDto | undefined)[];
  ecusByName: ReadonlyMap<string, EcuNodeDto>;
  selectedMessageKey: string | null;
  selectedSignalId: number | null;
  selectedSignalSeq: number;
  activeDocTab: ActiveDocumentTab;
  explorerSubTab: ExplorerSubTab;
  theme: UiTheme;
  usePresetDb: boolean;
  customDbFiles: readonly CustomDbFileRecord[];
  expandedRxKeys: readonly string[];
}

function makeArbLookupKey(arbId: number, isExtended: boolean): string {
  return `${isExtended ? 'EXT' : 'STD'}:${arbId >>> 0}`;
}

export function buildBusSchemaLookup(schema: DatabaseSchemaDto): BusSchemaLookup {
  const messagesByKey = new Map<string, MessageSchemaDto>();
  const messagesByArbKey = new Map<string, MessageSchemaDto>();
  for (const msg of schema.messages) {
    messagesByKey.set(msg.messageKey, msg);
    messagesByArbKey.set(makeArbLookupKey(msg.arbId, msg.isExtended), msg);
  }

  let maxSignalId = -1;
  for (const sig of schema.signals) {
    if (sig.signalId > maxSignalId) {
      maxSignalId = sig.signalId;
    }
  }
  const signalsById: (SignalSchemaDto | undefined)[] =
    maxSignalId >= 0 ? new Array<SignalSchemaDto | undefined>(maxSignalId + 1) : [];
  for (const sig of schema.signals) {
    signalsById[sig.signalId] = sig;
  }

  return {
    schema,
    messagesByKey,
    messagesByArbKey,
    signalsById,
  };
}

const initialMeta = typeof window !== 'undefined' ? readActiveSessionMetaSync() : null;
const initialTab: ActiveDocumentTab =
  initialMeta && initialMeta.isOpen && initialMeta.activeDocTab
    ? initialMeta.activeDocTab
    : 'start';
const initialTheme: UiTheme =
  initialMeta &&
  initialMeta.isOpen &&
  (initialMeta.theme === 'dark' || initialMeta.theme === 'light')
    ? initialMeta.theme
    : 'dark';

if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', initialTheme);
}

const EMPTY_SIGNALS: readonly (SignalSchemaDto | undefined)[] = [];

let currentState: DatabaseStoreState = {
  databases: [],
  inspectedDatabaseId: null,
  busSchemas: new Map<number, BusSchemaLookup>(),
  schema: null,
  messagesByKey: new Map<string, MessageSchemaDto>(),
  messagesByArbKey: new Map<string, MessageSchemaDto>(),
  signalsById: [],
  ecusByName: new Map<string, EcuNodeDto>(),
  selectedMessageKey: null,
  selectedSignalId: null,
  selectedSignalSeq: 0,
  activeDocTab: initialTab,
  explorerSubTab: 'messages',
  theme: initialTheme,
  usePresetDb: false,
  customDbFiles: [],
  expandedRxKeys: [],
};

const listeners = new Set<() => void>();
const schemaListeners = new Set<(schema: DatabaseSchemaDto | null) => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function emitSchemaChange(schema: DatabaseSchemaDto | null): void {
  for (const listener of schemaListeners) {
    try {
      listener(schema);
    } catch {
      // Isolate external bridge listeners from local database store
    }
  }
}

function deriveCustomFiles(entries: readonly ProjectDatabaseEntry[]): CustomDbFileRecord[] {
  return entries.map((e) => ({
    fileName: e.fileName,
    contentBase64: e.contentBase64,
    sizeBytes: e.sizeBytes,
  }));
}

function computeInspectorState(
  schema: DatabaseSchemaDto | null,
  currSelectedMessageKey: string | null,
): Pick<
  DatabaseStoreState,
  | 'schema'
  | 'messagesByKey'
  | 'messagesByArbKey'
  | 'signalsById'
  | 'ecusByName'
  | 'selectedMessageKey'
  | 'selectedSignalId'
> {
  if (!schema) {
    return {
      schema: null,
      messagesByKey: new Map<string, MessageSchemaDto>(),
      messagesByArbKey: new Map<string, MessageSchemaDto>(),
      signalsById: [],
      ecusByName: new Map<string, EcuNodeDto>(),
      selectedMessageKey: null,
      selectedSignalId: null,
    };
  }

  const lookup = buildBusSchemaLookup(schema);
  const ecusByName = new Map<string, EcuNodeDto>();
  for (const ecu of schema.ecus) {
    ecusByName.set(ecu.name, ecu);
  }

  const nextSelectedMsg =
    currSelectedMessageKey && lookup.messagesByKey.has(currSelectedMessageKey)
      ? currSelectedMessageKey
      : schema.messages.length > 0
        ? schema.messages[0].messageKey
        : null;

  return {
    schema,
    messagesByKey: lookup.messagesByKey,
    messagesByArbKey: lookup.messagesByArbKey,
    signalsById: lookup.signalsById,
    ecusByName,
    selectedMessageKey: nextSelectedMsg,
    selectedSignalId: null,
  };
}

export const databaseStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  subscribeSchemaChanges(listener: (schema: DatabaseSchemaDto | null) => void): () => void {
    schemaListeners.add(listener);
    return () => {
      schemaListeners.delete(listener);
    };
  },

  getState(): DatabaseStoreState {
    return currentState;
  },

  getSignal(signalId: number): SignalSchemaDto | undefined {
    return currentState.signalsById[signalId];
  },

  getMessage(
    messageKey: string,
    arbId?: number,
    isExtended?: boolean,
  ): MessageSchemaDto | undefined {
    const direct = currentState.messagesByKey.get(messageKey);
    if (direct) return direct;
    if (arbId !== undefined && isExtended !== undefined) {
      return currentState.messagesByArbKey.get(makeArbLookupKey(arbId, isExtended));
    }
    return undefined;
  },

  // --------------------------------------------------------------------------
  // Bus-based Database Lookups (Strict BusId Separation)
  // --------------------------------------------------------------------------

  getMessageForBus(
    busId: number,
    messageKey: string,
    arbId?: number,
    isExtended?: boolean,
  ): MessageSchemaDto | undefined {
    const lookup = currentState.busSchemas.get(busId);
    if (!lookup) return undefined;
    const direct = lookup.messagesByKey.get(messageKey);
    if (direct) return direct;
    if (arbId !== undefined && isExtended !== undefined) {
      return lookup.messagesByArbKey.get(makeArbLookupKey(arbId, isExtended));
    }
    return undefined;
  },

  getSignalForBus(busId: number, signalId: number): SignalSchemaDto | undefined {
    return currentState.busSchemas.get(busId)?.signalsById[signalId];
  },

  getBusSchema(busId: number): DatabaseSchemaDto | null {
    return currentState.busSchemas.get(busId)?.schema ?? null;
  },

  /** Dense `signalId -> SignalSchemaDto` table compiled exclusively for `busId` (empty if no DB bound). */
  getBusSignals(busId: number): readonly (SignalSchemaDto | undefined)[] {
    return currentState.busSchemas.get(busId)?.signalsById ?? EMPTY_SIGNALS;
  },

  /**
   * Schema streamed to NexusCANCloud live bridge (single-schema contract):
   * the lowest-numbered bus that has databases bound, falling back to any loaded catalog schema.
   */
  getPrimaryLiveSchema(): DatabaseSchemaDto | null {
    let best: number | null = null;
    for (const busId of currentState.busSchemas.keys()) {
      if (best === null || busId < best) best = busId;
    }
    if (best !== null) {
      const bound = currentState.busSchemas.get(best)?.schema ?? null;
      if (bound) return bound;
    }
    if (currentState.schema) {
      return currentState.schema;
    }
    const firstCatalogWithSchema = currentState.databases.find((d) => d.schema !== null);
    return firstCatalogWithSchema?.schema ?? null;
  },

  /** Finds the first bus (ascending) whose bound schema contains `messageKey`. */
  findBusForMessage(messageKey: string): number | null {
    for (const [busId, lookup] of currentState.busSchemas) {
      if (lookup.messagesByKey.has(messageKey)) return busId;
    }
    return null;
  },

  setBusSchema(busId: number, schema: DatabaseSchemaDto | null): void {
    const nextMap = new Map<number, BusSchemaLookup>(currentState.busSchemas);
    if (schema === null) {
      nextMap.delete(busId);
    } else {
      nextMap.set(busId, buildBusSchemaLookup(schema));
    }
    currentState = {
      ...currentState,
      busSchemas: nextMap,
    };
    emitChange();
    emitSchemaChange(databaseStore.getPrimaryLiveSchema());
  },

  clearAllBusSchemas(): void {
    currentState = {
      ...currentState,
      busSchemas: new Map<number, BusSchemaLookup>(),
    };
    emitChange();
    emitSchemaChange(null);
  },

  // --------------------------------------------------------------------------
  // Catalog Management
  // --------------------------------------------------------------------------

  upsertDatabaseEntry(entry: ProjectDatabaseEntry): void {
    const existingIdx = currentState.databases.findIndex((d) => d.id === entry.id);
    let nextDatabases: ProjectDatabaseEntry[];
    if (existingIdx >= 0) {
      nextDatabases = [...currentState.databases];
      nextDatabases[existingIdx] = entry;
    } else {
      nextDatabases = [...currentState.databases, entry];
    }

    const nextCustomFiles = deriveCustomFiles(nextDatabases);

    let inspectorUpdates = {};
    if (currentState.inspectedDatabaseId === entry.id || currentState.inspectedDatabaseId === null) {
      inspectorUpdates = computeInspectorState(entry.schema, currentState.selectedMessageKey);
    }

    currentState = {
      ...currentState,
      databases: nextDatabases,
      customDbFiles: nextCustomFiles,
      usePresetDb: false,
      ...inspectorUpdates,
    };

    emitChange();
    if (currentState.busSchemas.size === 0) {
      emitSchemaChange(databaseStore.getPrimaryLiveSchema());
    }
  },

  removeDatabaseEntry(dbId: string): void {
    const nextDatabases = currentState.databases.filter((d) => d.id !== dbId);
    const nextCustomFiles = deriveCustomFiles(nextDatabases);

    let nextInspectedId = currentState.inspectedDatabaseId;
    let nextSchema: DatabaseSchemaDto | null = currentState.schema;
    if (currentState.inspectedDatabaseId === dbId) {
      nextInspectedId = nextDatabases[0]?.id ?? null;
      nextSchema = nextDatabases[0]?.schema ?? null;
    }

    const inspectorUpdates = computeInspectorState(nextSchema, currentState.selectedMessageKey);

    currentState = {
      ...currentState,
      databases: nextDatabases,
      customDbFiles: nextCustomFiles,
      inspectedDatabaseId: nextInspectedId,
      ...inspectorUpdates,
    };

    emitChange();
  },

  renameDatabaseEntry(dbId: string, nextName: string): void {
    const nextDatabases = currentState.databases.map((d) =>
      d.id === dbId ? { ...d, name: nextName.trim() } : d
    );
    currentState = {
      ...currentState,
      databases: nextDatabases,
    };
    emitChange();
  },

  setDatabasesCatalog(entries: readonly ProjectDatabaseEntry[]): void {
    const nextCustomFiles = deriveCustomFiles(entries);
    const inspected = entries.find((e) => e.id === currentState.inspectedDatabaseId) ?? entries[0] ?? null;
    const inspectorUpdates = computeInspectorState(inspected?.schema ?? null, currentState.selectedMessageKey);

    currentState = {
      ...currentState,
      databases: [...entries],
      customDbFiles: nextCustomFiles,
      inspectedDatabaseId: inspected?.id ?? null,
      ...inspectorUpdates,
    };

    emitChange();
  },

  setInspectedDatabaseId(dbId: string | null): void {
    if (currentState.inspectedDatabaseId === dbId) return;

    if (dbId === null) {
      currentState = {
        ...currentState,
        inspectedDatabaseId: null,
      };
      emitChange();
      return;
    }

    const target = currentState.databases.find((d) => d.id === dbId);
    const schema = target?.schema ?? null;
    const inspectorUpdates = computeInspectorState(schema, null);

    currentState = {
      ...currentState,
      inspectedDatabaseId: dbId,
      ...inspectorUpdates,
    };

    emitChange();
  },

  // --------------------------------------------------------------------------
  // Legacy Single Schema Adapter (Kept for Inspector / Backwards-Compatibility)
  // --------------------------------------------------------------------------

  setSchema(schema: DatabaseSchemaDto | null): void {
    const inspectorUpdates = computeInspectorState(schema, currentState.selectedMessageKey);
    currentState = {
      ...currentState,
      ...inspectorUpdates,
    };
    emitChange();
  },

  markPresetDbLoaded(): void {
    currentState = {
      ...currentState,
      usePresetDb: true,
    };
    emitChange();
  },

  recordCustomDbFile(fileName: string, contentBase64: string, append: boolean): void {
    const id = makeCatalogDbId(fileName);
    const name = fileName.replace(/\.[^/.]+$/, '');
    const format = fileName.toLowerCase().endsWith('.kcd') ? 'kcd' : 'dbc';
    const entry: ProjectDatabaseEntry = {
      id,
      name,
      fileName,
      format,
      contentBase64,
      sizeBytes: Math.round((contentBase64.length * 3) / 4),
      uploadedAt: new Date().toISOString(),
      schema: null,
    };
    if (append) {
      databaseStore.upsertDatabaseEntry(entry);
    } else {
      databaseStore.setDatabasesCatalog([entry]);
    }
  },

  setDatabaseSources(
    usePresetDb: boolean,
    customDbFiles: readonly CustomDbFileRecord[],
  ): void {
    currentState = {
      ...currentState,
      usePresetDb,
      customDbFiles: [...customDbFiles],
    };
    emitChange();
  },

  clearAll(): void {
    currentState = {
      ...currentState,
      databases: [],
      inspectedDatabaseId: null,
      busSchemas: new Map<number, BusSchemaLookup>(),
      schema: null,
      messagesByKey: new Map<string, MessageSchemaDto>(),
      messagesByArbKey: new Map<string, MessageSchemaDto>(),
      signalsById: [],
      ecusByName: new Map<string, EcuNodeDto>(),
      selectedMessageKey: null,
      selectedSignalId: null,
      usePresetDb: false,
      customDbFiles: [],
    };
    emitChange();
  },

  setSelectedMessageKey(messageKey: string | null): void {
    if (currentState.selectedMessageKey === messageKey && currentState.selectedSignalId === null) {
      return;
    }
    currentState = {
      ...currentState,
      selectedMessageKey: messageKey,
      selectedSignalId: null,
    };
    emitChange();
  },

  selectMessageInSymbolsTab(messageKey: string, dbId?: string): void {
    let nextInspectedId = currentState.inspectedDatabaseId;
    if (dbId) {
      nextInspectedId = dbId;
    } else if (!nextInspectedId && currentState.databases.length > 0) {
      // Find which database contains this message
      const found = currentState.databases.find((d) =>
        d.schema?.messages.some((m) => m.messageKey === messageKey)
      );
      if (found) {
        nextInspectedId = found.id;
      }
    }

    let inspectorUpdates = {};
    if (nextInspectedId && nextInspectedId !== currentState.inspectedDatabaseId) {
      const target = currentState.databases.find((d) => d.id === nextInspectedId);
      inspectorUpdates = computeInspectorState(target?.schema ?? null, messageKey);
    }

    currentState = {
      ...currentState,
      inspectedDatabaseId: nextInspectedId,
      selectedMessageKey: messageKey,
      selectedSignalId: null,
      activeDocTab: 'symbols',
      ...inspectorUpdates,
    };
    emitChange();
  },

  selectSignalInSymbolsTab(messageKey: string, signalId: number, dbId?: string): void {
    let nextInspectedId = currentState.inspectedDatabaseId;
    if (dbId) {
      nextInspectedId = dbId;
    } else if (!nextInspectedId && currentState.databases.length > 0) {
      const found = currentState.databases.find((d) =>
        d.schema?.signals.some((s) => s.signalId === signalId)
      );
      if (found) {
        nextInspectedId = found.id;
      }
    }

    let inspectorUpdates = {};
    if (nextInspectedId && nextInspectedId !== currentState.inspectedDatabaseId) {
      const target = currentState.databases.find((d) => d.id === nextInspectedId);
      inspectorUpdates = computeInspectorState(target?.schema ?? null, messageKey);
    }

    currentState = {
      ...currentState,
      inspectedDatabaseId: nextInspectedId,
      selectedMessageKey: messageKey,
      selectedSignalId: signalId,
      selectedSignalSeq: currentState.selectedSignalSeq + 1,
      activeDocTab: 'symbols',
      ...inspectorUpdates,
    };
    emitChange();
  },

  openDiagnosticsPanel(): void {
    currentState = {
      ...currentState,
      activeDocTab: 'symbols',
      explorerSubTab: 'diagnostics',
    };
    emitChange();
  },

  setActiveDocTab(tab: ActiveDocumentTab): void {
    if (currentState.activeDocTab === tab) return;
    currentState = {
      ...currentState,
      activeDocTab: tab,
    };
    const currentMeta = readActiveSessionMetaSync();
    if (currentMeta?.isOpen) {
      writeActiveSessionMetaSync({
        ...currentMeta,
        activeDocTab: tab,
        updatedAt: new Date().toISOString(),
      });
    }
    emitChange();
  },

  setExplorerSubTab(subTab: ExplorerSubTab): void {
    if (currentState.explorerSubTab === subTab) return;
    currentState = {
      ...currentState,
      explorerSubTab: subTab,
    };
    emitChange();
  },

  setExpandedRxKeys(keys: readonly string[]): void {
    currentState = {
      ...currentState,
      expandedRxKeys: [...keys],
    };
    emitChange();
  },

  setTheme(theme: UiTheme): void {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    if (currentState.theme === theme) return;
    currentState = {
      ...currentState,
      theme,
    };
    const currentMeta = readActiveSessionMetaSync();
    if (currentMeta?.isOpen) {
      writeActiveSessionMetaSync({
        ...currentMeta,
        theme,
        updatedAt: new Date().toISOString(),
      });
    }
    emitChange();
  },

  toggleTheme(): void {
    const nextTheme: UiTheme = currentState.theme === 'dark' ? 'light' : 'dark';
    databaseStore.setTheme(nextTheme);
  },
};

export function useDatabaseStore(): DatabaseStoreState {
  return useSyncExternalStore(
    databaseStore.subscribe,
    databaseStore.getState,
    databaseStore.getState,
  );
}
