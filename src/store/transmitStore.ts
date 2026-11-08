import { useSyncExternalStore } from 'react';
import type { DatabaseSchemaDto, SignalSchemaDto } from '../types/netdb';
import type { PeriodicTxJobDto } from '../types/telemetry';
import { previewPackSymbolicBytes } from '../utils/formatters';

export type TxEntryMode = 'symbolic' | 'raw';

export interface TxListEntry {
  id: string;
  busId: number;
  mode: TxEntryMode;
  messageKey: string | null;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  isBrs: boolean;
  dlc: number;
  symbolName: string;
  rawBytes: number[];
  signalValues: Record<number, number>;
  /** `0` = Manual (`Wait`), `> 0` = Periodic interval in ms */
  cycleTimeMs: number;
  /** Whether `[x]` periodic transmission is currently running on the backend */
  periodicEnabled: boolean;
  backendJobId: number | null;
  manualSentCount: number;
  periodicSentCount: number;
  creator: string;
  comment: string;
}

export interface TransmitStoreState {
  entries: readonly TxListEntry[];
  selectedEntryId: string | null;
  /** Monotonic counter incremented only when persistent TX list configuration changes (ignores live counters/jobIds) */
  configRevision: number;
}

export function createDefaultPresetTxEntries(): TxListEntry[] {
  return [
    {
      id: 'preset-tx-101',
      busId: 0,
      mode: 'symbolic',
      messageKey: 'STD:0x101',
      arbId: 0x101,
      isExtended: false,
      isFd: false,
      isBrs: false,
      dlc: 8,
      symbolName: 'INV_MotorStatus',
      rawBytes: [0x00, 0x00, 0x30, 0x00, 0x06, 0x40, 0x03, 0x00],
      signalValues: {},
      cycleTimeMs: 0,
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
      creator: 'Preset',
      comment: 'Manual inverter status command (Space to send)',
    },
    {
      id: 'preset-tx-7df',
      busId: 0,
      mode: 'raw',
      messageKey: null,
      arbId: 0x7df,
      isExtended: false,
      isFd: false,
      isBrs: false,
      dlc: 8,
      symbolName: 'OBD_UDS_FunctionalReq',
      rawBytes: [0x02, 0x01, 0x0c, 0x55, 0x55, 0x55, 0x55, 0x55],
      signalValues: {},
      cycleTimeMs: 100,
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
      creator: 'Preset',
      comment: 'OBD-II PID 0x0C RPM query (check box for 100 ms periodic)',
    },
    {
      id: 'preset-tx-201-fd',
      busId: 0,
      mode: 'symbolic',
      messageKey: 'STD:0x201',
      arbId: 0x201,
      isExtended: false,
      isFd: true,
      isBrs: true,
      dlc: 64,
      symbolName: 'INV_FastTelemetryFD',
      rawBytes: new Array<number>(64).fill(0),
      signalValues: {},
      cycleTimeMs: 0,
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
      creator: 'Preset',
      comment: '64-byte CAN-FD frame template',
    },
  ];
}

let currentState: TransmitStoreState = {
  entries: [],
  selectedEntryId: null,
  configRevision: 0,
};

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const fn of listeners) {
    fn();
  }
}

function didPersistentEntryConfigChange(a: TxListEntry, b: TxListEntry): boolean {
  if (
    a.busId !== b.busId ||
    a.mode !== b.mode ||
    a.messageKey !== b.messageKey ||
    a.arbId !== b.arbId ||
    a.isExtended !== b.isExtended ||
    a.isFd !== b.isFd ||
    a.isBrs !== b.isBrs ||
    a.dlc !== b.dlc ||
    a.symbolName !== b.symbolName ||
    a.cycleTimeMs !== b.cycleTimeMs ||
    a.creator !== b.creator ||
    a.comment !== b.comment ||
    a.rawBytes.length !== b.rawBytes.length
  ) {
    return true;
  }
  for (let i = 0; i < a.rawBytes.length; i += 1) {
    if (a.rawBytes[i] !== b.rawBytes[i]) return true;
  }
  const aKeys = Object.keys(a.signalValues);
  const bKeys = Object.keys(b.signalValues);
  if (aKeys.length !== bKeys.length) return true;
  for (const k of aKeys) {
    const numKey = Number(k);
    if (a.signalValues[numKey] !== b.signalValues[numKey]) return true;
  }
  return false;
}

/** Either one schema for all buses (legacy) or a per-bus resolver (multi-DBC catalog). */
export type TxSchemaSource =
  | DatabaseSchemaDto
  | null
  | ((busId: number) => DatabaseSchemaDto | null);

function resolveTxSchema(src: TxSchemaSource, busId: number): DatabaseSchemaDto | null {
  return typeof src === 'function' ? src(busId) : src;
}

export const transmitStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): TransmitStoreState {
    return currentState;
  },

  selectEntry(id: string | null): void {
    if (currentState.selectedEntryId === id) return;
    currentState = {
      ...currentState,
      selectedEntryId: id,
    };
    emitChange();
  },

  addEntry(entry: TxListEntry): void {
    currentState = {
      entries: [...currentState.entries, entry],
      selectedEntryId: entry.id,
      configRevision: currentState.configRevision + 1,
    };
    emitChange();
  },

  updateEntry(id: string, updater: (prev: TxListEntry) => TxListEntry): void {
    let persistentChanged = false;
    const nextEntries = currentState.entries.map((item) => {
      if (item.id !== id) return item;
      const updated = updater(item);
      if (didPersistentEntryConfigChange(item, updated)) {
        persistentChanged = true;
      }
      return updated;
    });
    currentState = {
      ...currentState,
      entries: nextEntries,
      configRevision: persistentChanged
        ? currentState.configRevision + 1
        : currentState.configRevision,
    };
    emitChange();
  },

  removeEntry(id: string): void {
    const remaining = currentState.entries.filter((e) => e.id !== id);
    const nextSelected =
      currentState.selectedEntryId === id
        ? (remaining[0]?.id ?? null)
        : currentState.selectedEntryId;
    currentState = {
      entries: remaining,
      selectedEntryId: nextSelected,
      configRevision: currentState.configRevision + 1,
    };
    emitChange();
  },

  resetToPresets(): void {
    const presets = createDefaultPresetTxEntries();
    currentState = {
      entries: presets,
      selectedEntryId: presets[0]?.id ?? null,
      configRevision: currentState.configRevision + 1,
    };
    emitChange();
  },

  /**
   * Restores TX entries from a saved project file with hardware safety invariant enforced:
   * `periodicEnabled: false` and `backendJobId: null` so opening a project never blasts live CAN frames unprompted!
   */
  setEntriesFromProject(
    entries: readonly TxListEntry[],
    schema: TxSchemaSource,
  ): void {
    const sanitized: TxListEntry[] = entries.map((e) => ({
      ...e,
      rawBytes: [...e.rawBytes],
      signalValues: { ...e.signalValues },
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
    }));
    currentState = {
      entries: sanitized,
      selectedEntryId: sanitized[0]?.id ?? null,
      configRevision: currentState.configRevision + 1,
    };
    if (schema) {
      transmitStore.hydrateWithSchema(schema);
    } else {
      emitChange();
    }
  },

  /**
   * When a `.dbc` / `.kcd` schema loads, hydrate any symbolic TX entries matching by arbId/messageKey
   * with default signal engineering values and live packed preview bytes (without transmitting!).
   */
  hydrateWithSchema(schema: TxSchemaSource): void {
    if (!schema) return;
    const sigTableCache = new Map<DatabaseSchemaDto, (SignalSchemaDto | undefined)[]>();
    const sigTableFor = (sch: DatabaseSchemaDto): (SignalSchemaDto | undefined)[] => {
      const cached = sigTableCache.get(sch);
      if (cached) return cached;
      let maxSigId = -1;
      for (const sg of sch.signals) {
        if (sg.signalId > maxSigId) maxSigId = sg.signalId;
      }
      const table: (SignalSchemaDto | undefined)[] =
        maxSigId >= 0 ? new Array<SignalSchemaDto | undefined>(maxSigId + 1) : [];
      for (const sg of sch.signals) {
        table[sg.signalId] = sg;
      }
      sigTableCache.set(sch, table);
      return table;
    };

    const updated = currentState.entries.map((entry) => {
      if (entry.mode !== 'symbolic') return entry;
      const busSchema = resolveTxSchema(schema, entry.busId);
      if (!busSchema) return entry;
      const sigsById = sigTableFor(busSchema);
      const matchedMsg = busSchema.messages.find(
        (m) =>
          m.messageKey === entry.messageKey ||
          (m.arbId === entry.arbId && m.isExtended === entry.isExtended),
      );
      if (!matchedMsg) return entry;

      const nextSignalVals: Record<number, number> = { ...entry.signalValues };
      for (const sigId of matchedMsg.signalIds) {
        if (nextSignalVals[sigId] === undefined) {
          const sig = sigsById[sigId];
          if (sig) {
            const def =
              sig.initialValue !== null && Number.isFinite(sig.initialValue)
                ? sig.initialValue
                : sig.max > sig.min
                  ? Math.max(sig.min, Math.min(sig.max, 0))
                  : 0;
            nextSignalVals[sigId] = def;
          }
        }
      }

      const packedBytes = previewPackSymbolicBytes(matchedMsg, sigsById, nextSignalVals);
      return {
        ...entry,
        messageKey: matchedMsg.messageKey,
        symbolName: matchedMsg.name,
        dlc: matchedMsg.dlc,
        isFd: matchedMsg.protocol.toUpperCase().includes('FD') || matchedMsg.dlc > 8,
        signalValues: nextSignalVals,
        rawBytes: entry.periodicEnabled ? entry.rawBytes : packedBytes,
      };
    });

    currentState = {
      ...currentState,
      entries: updated,
      configRevision: currentState.configRevision + 1,
    };
    emitChange();
  },

  /**
   * Syncs live `sentCount` and active job statuses from backend `cmd_list_periodic_tx`,
   * AND reconciles/recovers any already-running backend periodic jobs after an F5 page reload
   * so active cycles remain checked (`[x]`) and never duplicate when clicked!
   */
  syncBackendPeriodicJobs(
    jobs: readonly PeriodicTxJobDto[],
    schema?: TxSchemaSource,
  ): void {
    const jobById = new Map<number, PeriodicTxJobDto>();
    for (const j of jobs) {
      jobById.set(j.jobId, j);
    }

    const claimedJobIds = new Set<number>();
    let mutated = false;
    let addedRecovered = false;

    // Pass 1: Sync entries that already hold a `backendJobId`
    const nextEntries: TxListEntry[] = currentState.entries.map((entry) => {
      if (entry.backendJobId === null) return entry;
      const backendJob = jobById.get(entry.backendJobId);
      if (!backendJob) {
        mutated = true;
        return {
          ...entry,
          periodicEnabled: false,
          backendJobId: null,
        };
      }
      claimedJobIds.add(backendJob.jobId);
      if (
        !entry.periodicEnabled ||
        entry.periodicSentCount !== backendJob.sentCount ||
        entry.cycleTimeMs !== backendJob.intervalMs
      ) {
        mutated = true;
        return {
          ...entry,
          periodicEnabled: true,
          cycleTimeMs: backendJob.intervalMs,
          periodicSentCount: backendJob.sentCount,
        };
      }
      return entry;
    });

    // Pass 2: Rebind or recover any unclaimed running backend periodic jobs (e.g. after F5 page reload)
    for (const job of jobs) {
      if (claimedJobIds.has(job.jobId)) continue;

      // Prefer exact (busId, arbId, isExtended) + matching label, otherwise first unbound entry with (busId, arbId, isExtended)
      let matchIdx = nextEntries.findIndex(
        (e) =>
          e.backendJobId === null &&
          e.busId === job.busId &&
          e.arbId === job.arbId &&
          e.isExtended === job.isExtended &&
          Boolean(job.label) &&
          e.symbolName === job.label,
      );
      if (matchIdx < 0) {
        matchIdx = nextEntries.findIndex(
          (e) =>
            e.backendJobId === null &&
            e.busId === job.busId &&
            e.arbId === job.arbId &&
            e.isExtended === job.isExtended,
        );
      }

      if (matchIdx >= 0) {
        const existing = nextEntries[matchIdx]!;
        nextEntries[matchIdx] = {
          ...existing,
          dlc: job.dlc,
          isFd: job.isFd,
          rawBytes: job.rawBytes.slice(0, job.dlc),
          cycleTimeMs: job.intervalMs,
          periodicEnabled: true,
          backendJobId: job.jobId,
          periodicSentCount: job.sentCount,
        };
        claimedJobIds.add(job.jobId);
        mutated = true;
      } else {
        // Synthesize a recovered TX entry so no running backend cycle is ever orphaned or invisible
        const matchedMsg = resolveTxSchema(schema ?? null, job.busId)?.messages.find(
          (m) =>
            m.messageKey === job.messageKey ||
            (m.arbId === job.arbId && m.isExtended === job.isExtended),
        );
        nextEntries.push({
          id: `recovered-tx-${job.busId}-${job.isExtended ? 'ext' : 'std'}-${job.arbId.toString(16)}`,
          busId: job.busId,
          mode: matchedMsg ? 'symbolic' : 'raw',
          messageKey: matchedMsg?.messageKey ?? job.messageKey,
          arbId: job.arbId,
          isExtended: job.isExtended,
          isFd: job.isFd,
          isBrs: false,
          dlc: job.dlc,
          symbolName: job.label || matchedMsg?.name || '',
          rawBytes: job.rawBytes.slice(0, job.dlc),
          signalValues: {},
          cycleTimeMs: job.intervalMs,
          periodicEnabled: true,
          backendJobId: job.jobId,
          manualSentCount: 0,
          periodicSentCount: job.sentCount,
          creator: 'Active Cycle',
          comment: 'Active periodic cycle preserved across reload',
        });
        claimedJobIds.add(job.jobId);
        mutated = true;
        addedRecovered = true;
      }
    }

    if (mutated) {
      currentState = {
        entries: nextEntries,
        selectedEntryId: currentState.selectedEntryId ?? nextEntries[0]?.id ?? null,
        configRevision: addedRecovered
          ? currentState.configRevision + 1
          : currentState.configRevision,
      };
      emitChange();
    }
  },

  /**
   * Immediately marks all periodic entries paused on Panic Stop.
   */
  markAllPaused(): void {
    currentState = {
      ...currentState,
      entries: currentState.entries.map((e) => ({
        ...e,
        periodicEnabled: false,
        backendJobId: null,
      })),
    };
    emitChange();
  },

  resetCounters(): void {
    currentState = {
      ...currentState,
      entries: currentState.entries.map((e) => ({
        ...e,
        manualSentCount: 0,
        periodicSentCount: 0,
      })),
    };
    emitChange();
  },

  clearAll(): void {
    currentState = {
      entries: [],
      selectedEntryId: null,
      configRevision: currentState.configRevision + 1,
    };
    emitChange();
  },

  clearAllEntries(): void {
    currentState = {
      entries: [],
      selectedEntryId: null,
      configRevision: currentState.configRevision + 1,
    };
    emitChange();
  },
};

export function useTransmitStore(): TransmitStoreState {
  return useSyncExternalStore(
    transmitStore.subscribe,
    transmitStore.getState,
    transmitStore.getState,
  );
}
