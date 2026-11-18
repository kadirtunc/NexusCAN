/**
 * NexusCAN Workspace Diffing, Hashing & Section Merging Utilities
 *
 * Industrial telemetry and workspace synchronization module:
 * - Deterministic semantic hashing (ignoring volatile runtime fields)
 * - 5-section structural diffing (metadata, databases, connections, transmitList, plotter)
 * - Fine-grained section merging (Local vs Cloud staged picks)
 * - Cloud workspace payload validation and normalization
 * - AGENTS.md Rule #4 Safety enforcement (forcing Listen-Only and paused TX on pulled workspaces)
 */

import type { NexusProjectFileV1 } from '../store/projectStore';
import type { SavedConnectionProfile } from '../store/connectionStore';
import type { DriverFamilyId } from '../types/hal';
import type { TxEntryMode, TxListEntry } from '../store/transmitStore';
import type { CustomDbFileRecord } from '../store/databaseStore';
import type { PlotLayoutMode, PlotYScaleMode, SavedPlotSignalSpec } from '../store/plotStore';
import type {
  SimulationGeneratorSpecDto,
  SimulationPanelDto,
  SimulationWidgetDto,
} from '../types/simulation';
import { normalizeEnabledToolpacks } from '../types/toolpacks';

export interface CloudProjectBindingV1 {
  cloudBaseUrl: string;
  orgId: string;
  orgName?: string;
  orgSlug?: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  projectCode: string;
  baseRevisionNumber: number;
  lastSyncedAt: string;
  lastSyncedHash: string;
}

export type WorkspaceSectionKey =
  | 'metadata'
  | 'databases'
  | 'connections'
  | 'transmitList'
  | 'plotter'
  | 'simulationPanels';

export type SectionStatus = 'identical' | 'modified' | 'added' | 'removed';

export interface WorkspaceDiffRow {
  label: string;
  localSummary: string;
  cloudSummary: string;
  changeKind: 'identical' | 'different' | 'localOnly' | 'cloudOnly';
}

export interface WorkspaceSectionDiff {
  key: WorkspaceSectionKey;
  title: string;
  status: SectionStatus;
  rows: WorkspaceDiffRow[];
}

export interface WorkspaceDiffReport {
  hasDifferences: boolean;
  localHash: string;
  cloudHash: string;
  sections: Record<WorkspaceSectionKey, WorkspaceSectionDiff>;
  summaryText: string;
}

/**
 * 32-bit FNV-1a Hash function producing deterministic 8-character hex strings
 */
function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Computes a deterministic semantic hash for a `NexusProjectFileV1`.
 * Volatile and runtime fields (timestamps, active tab, active connected bus IDs, expanded keys)
 * are excluded so that simply navigating tabs does NOT cause false diffs.
 */
export function computeWorkspaceSemanticHash(proj: NexusProjectFileV1 | null): string {
  if (!proj) return '00000000';

  const normalizedDbCustomFiles = (proj.databases?.customFiles ?? [])
    .map((f) => ({
      name: f.fileName,
      len: f.contentBase64 ? f.contentBase64.length : 0,
      head: f.contentBase64 ? f.contentBase64.slice(0, 64) : '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const normalizedProfiles = (proj.connections?.profiles ?? [])
    .map((p) => ({
      id: p.id,
      name: p.name,
      busId: p.busId,
      driverFamily: p.driverFamily,
      deviceId: p.deviceId,
      adapterChannel: p.adapterChannel,
      bitrate: p.bitrate,
      dataBitrate: p.dataBitrate,
      enableFd: p.enableFd,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const normalizedTxEntries = (proj.transmitList?.entries ?? [])
    .map((e) => ({
      id: e.id,
      symbolName: e.symbolName,
      busId: e.busId,
      arbId: e.arbId,
      isExtended: e.isExtended,
      isFd: e.isFd,
      dlc: e.dlc,
      cycleTimeMs: e.cycleTimeMs,
      mode: e.mode,
      rawBytes: e.rawBytes,
      signalValues: e.signalValues,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const normalizedWatchedSignals = (proj.plotter?.watchedSignals ?? [])
    .map((s) => ({
      signalId: s.signalId,
      signalName: s.signalName,
      unit: s.unit,
      busId: s.busId,
      colorHex: s.colorHex,
    }))
    .sort((a, b) => a.signalId - b.signalId);

  const semanticPayload = {
    name: proj.name.trim(),
    notes: (proj.notes ?? '').trim(),
    databases: {
      usePresetDb: Boolean(proj.databases?.usePresetDb),
      customFiles: normalizedDbCustomFiles,
    },
    connections: {
      profiles: normalizedProfiles,
    },
    transmitList: {
      entries: normalizedTxEntries,
    },
    plotter: {
      watchedSignals: normalizedWatchedSignals,
      layoutMode: proj.plotter?.layoutMode ?? 'combined',
      yScaleMode: proj.plotter?.yScaleMode ?? 'multiAxis',
      timeWindowSec: proj.plotter?.timeWindowSec ?? 30,
    },
    simulationPanels: (proj.simulationPanels ?? [])
      .map((p) => ({
        id: p.id,
        name: p.name.trim(),
        widgets: (p.widgets ?? [])
          .map((w) => ({
            id: w.id,
            kind: w.kind,
            title: w.title,
            col: w.layout.col,
            row: w.layout.row,
            w: w.layout.w,
            h: w.layout.h,
            sig: w.binding
              ? `${w.binding.busId}:${w.binding.messageKey}:${w.binding.signalName}`
              : '',
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        generators: (p.generators ?? [])
          .map((g) => ({
            id: g.id,
            enabled: g.enabled,
            waveform: g.waveform,
            min: g.min,
            max: g.max,
            freq: g.frequencyHz,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    workspace: {
      traceMaxBufferRows: proj.workspace?.traceMaxBufferRows ?? 100000,
      theme: proj.workspace?.theme ?? 'dark',
      enabledToolpacks: normalizeEnabledToolpacks(proj.workspace?.enabledToolpacks),
    },
  };

  return fnv1a32Hex(JSON.stringify(semanticPayload));
}

/**
 * Computes deep differences between a local workspace and a cloud remote workspace
 * across 5 primary structural sections.
 */
export function computeWorkspaceDiff(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceDiffReport {
  const localHash = computeWorkspaceSemanticHash(localProj);
  const cloudHash = computeWorkspaceSemanticHash(cloudProj);

  const sections: Record<WorkspaceSectionKey, WorkspaceSectionDiff> = {
    metadata: diffMetadataSection(localProj, cloudProj),
    databases: diffDatabasesSection(localProj, cloudProj),
    connections: diffConnectionsSection(localProj, cloudProj),
    transmitList: diffTransmitListSection(localProj, cloudProj),
    plotter: diffPlotterSection(localProj, cloudProj),
    simulationPanels: diffSimulationPanelsSection(localProj, cloudProj),
  };

  const hasDifferences = Object.values(sections).some((s) => s.status !== 'identical');

  let summaryText = 'Local ve Cloud çalışma alanları birebir eşittir.';
  if (!localProj && cloudProj) {
    summaryText = 'Masaüstünde açık proje yok; Cloud şablonu yüklenebilir.';
  } else if (localProj && !cloudProj) {
    summaryText = 'Cloud projesinde henüz bir şablon yok; yerel proje gönderilebilir.';
  } else if (hasDifferences) {
    const diffNames = Object.values(sections)
      .filter((s) => s.status !== 'identical')
      .map((s) => s.title)
      .join(', ');
    summaryText = `Değişiklik tespit edildi: ${diffNames}`;
  }

  return {
    hasDifferences,
    localHash,
    cloudHash,
    sections,
    summaryText,
  };
}

function diffMetadataSection(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceSectionDiff {
  const rows: WorkspaceDiffRow[] = [];

  const localName = localProj?.name ?? '';
  const cloudName = cloudProj?.name ?? '';
  rows.push({
    label: 'Proje Adı',
    localSummary: localName || '(Yok)',
    cloudSummary: cloudName || '(Yok)',
    changeKind:
      localName === cloudName
        ? 'identical'
        : localName && cloudName
          ? 'different'
          : localName
            ? 'localOnly'
            : 'cloudOnly',
  });

  const localNotes = localProj?.notes ?? '';
  const cloudNotes = cloudProj?.notes ?? '';
  rows.push({
    label: 'Açıklama / Notlar',
    localSummary: localNotes
      ? localNotes.length > 40
        ? `${localNotes.slice(0, 40)}...`
        : localNotes
      : '(Boş)',
    cloudSummary: cloudNotes
      ? cloudNotes.length > 40
        ? `${cloudNotes.slice(0, 40)}...`
        : cloudNotes
      : '(Boş)',
    changeKind:
      localNotes === cloudNotes
        ? 'identical'
        : localNotes && cloudNotes
          ? 'different'
          : localNotes
            ? 'localOnly'
            : 'cloudOnly',
  });

  const localBuf = localProj?.workspace?.traceMaxBufferRows ?? 100000;
  const cloudBuf = cloudProj?.workspace?.traceMaxBufferRows ?? 100000;
  rows.push({
    label: 'Trace Tampon Satırı',
    localSummary: `${localBuf.toLocaleString('en-US')} satır`,
    cloudSummary: `${cloudBuf.toLocaleString('en-US')} satır`,
    changeKind: localBuf === cloudBuf ? 'identical' : 'different',
  });

  const localTheme = localProj?.workspace?.theme ?? 'dark';
  const cloudTheme = cloudProj?.workspace?.theme ?? 'dark';
  rows.push({
    label: 'UI Teması',
    localSummary: localTheme.toUpperCase(),
    cloudSummary: cloudTheme.toUpperCase(),
    changeKind: localTheme === cloudTheme ? 'identical' : 'different',
  });

  const anyDiff = rows.some((r) => r.changeKind !== 'identical');
  return {
    key: 'metadata',
    title: 'Proje Bilgileri & Workspace',
    status: anyDiff ? 'modified' : 'identical',
    rows,
  };
}

function diffDatabasesSection(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceSectionDiff {
  const rows: WorkspaceDiffRow[] = [];

  const localFiles = localProj?.databases?.customFiles ?? [];
  const cloudFiles = cloudProj?.databases?.customFiles ?? [];
  const localFileNames = localFiles.map((f) => f.fileName).sort().join(', ');
  const cloudFileNames = cloudFiles.map((f) => f.fileName).sort().join(', ');

  rows.push({
    label: 'Veritabanı Dosyaları (.dbc / .kcd)',
    localSummary: localFiles.length > 0 ? `${localFiles.length} dosya (${localFileNames})` : 'Yok',
    cloudSummary: cloudFiles.length > 0 ? `${cloudFiles.length} dosya (${cloudFileNames})` : 'Yok',
    changeKind:
      localFileNames === cloudFileNames
        ? 'identical'
        : localFiles.length > 0 && cloudFiles.length > 0
          ? 'different'
          : localFiles.length > 0
            ? 'localOnly'
            : 'cloudOnly',
  });

  const anyDiff = rows.some((r) => r.changeKind !== 'identical');
  return {
    key: 'databases',
    title: 'Veritabanları (.dbc / .kcd)',
    status: anyDiff ? 'modified' : 'identical',
    rows,
  };
}

function diffConnectionsSection(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceSectionDiff {
  const rows: WorkspaceDiffRow[] = [];

  const localProfiles = localProj?.connections?.profiles ?? [];
  const cloudProfiles = cloudProj?.connections?.profiles ?? [];

  const localProfSummary = localProfiles
    .map((p) => `Bus ${p.busId + 1}:${p.adapterChannel || p.name} (${p.enableFd ? 'FD' : 'CC'})`)
    .join('; ');
  const cloudProfSummary = cloudProfiles
    .map((p) => `Bus ${p.busId + 1}:${p.adapterChannel || p.name} (${p.enableFd ? 'FD' : 'CC'})`)
    .join('; ');

  rows.push({
    label: 'Tanımlı CAN Kanalları',
    localSummary: localProfiles.length > 0 ? `${localProfiles.length} profil: ${localProfSummary}` : 'Yok',
    cloudSummary: cloudProfiles.length > 0 ? `${cloudProfiles.length} profil: ${cloudProfSummary}` : 'Yok',
    changeKind:
      localProfSummary === cloudProfSummary
        ? 'identical'
        : localProfiles.length > 0 && cloudProfiles.length > 0
          ? 'different'
          : localProfiles.length > 0
            ? 'localOnly'
            : 'cloudOnly',
  });

  const anyDiff = rows.some((r) => r.changeKind !== 'identical');
  return {
    key: 'connections',
    title: 'CAN Bağlantı Profilleri',
    status: anyDiff ? 'modified' : 'identical',
    rows,
  };
}

function diffTransmitListSection(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceSectionDiff {
  const rows: WorkspaceDiffRow[] = [];

  const localEntries = localProj?.transmitList?.entries ?? [];
  const cloudEntries = cloudProj?.transmitList?.entries ?? [];

  const localSummary = localEntries
    .map((e) => `0x${e.arbId.toString(16).toUpperCase()}:${e.symbolName || e.id}`)
    .join(', ');
  const cloudSummary = cloudEntries
    .map((e) => `0x${e.arbId.toString(16).toUpperCase()}:${e.symbolName || e.id}`)
    .join(', ');

  rows.push({
    label: 'TX Mesaj Şablonları',
    localSummary: localEntries.length > 0 ? `${localEntries.length} mesaj (${localSummary})` : 'Yok',
    cloudSummary: cloudEntries.length > 0 ? `${cloudEntries.length} mesaj (${cloudSummary})` : 'Yok',
    changeKind:
      localSummary === cloudSummary
        ? 'identical'
        : localEntries.length > 0 && cloudEntries.length > 0
          ? 'different'
          : localEntries.length > 0
            ? 'localOnly'
            : 'cloudOnly',
  });

  const anyDiff = rows.some((r) => r.changeKind !== 'identical');
  return {
    key: 'transmitList',
    title: 'TX Mesaj Şablonları',
    status: anyDiff ? 'modified' : 'identical',
    rows,
  };
}

function diffPlotterSection(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceSectionDiff {
  const rows: WorkspaceDiffRow[] = [];

  const localSignals = localProj?.plotter?.watchedSignals ?? [];
  const cloudSignals = cloudProj?.plotter?.watchedSignals ?? [];

  const localSignalSummary = localSignals.map((s) => s.signalName).join(', ');
  const cloudSignalSummary = cloudSignals.map((s) => s.signalName).join(', ');

  rows.push({
    label: 'Grafik Sinyal Listesi',
    localSummary: localSignals.length > 0 ? `${localSignals.length} sinyal (${localSignalSummary})` : 'Yok',
    cloudSummary: cloudSignals.length > 0 ? `${cloudSignals.length} sinyal (${cloudSignalSummary})` : 'Yok',
    changeKind:
      localSignalSummary === cloudSignalSummary
        ? 'identical'
        : localSignals.length > 0 && cloudSignals.length > 0
          ? 'different'
          : localSignals.length > 0
            ? 'localOnly'
            : 'cloudOnly',
  });

  const localLayout = localProj?.plotter?.layoutMode ?? 'combined';
  const cloudLayout = cloudProj?.plotter?.layoutMode ?? 'combined';
  rows.push({
    label: 'Grafik Yerleşimi',
    localSummary: localLayout,
    cloudSummary: cloudLayout,
    changeKind: localLayout === cloudLayout ? 'identical' : 'different',
  });

  const anyDiff = rows.some((r) => r.changeKind !== 'identical');
  return {
    key: 'plotter',
    title: 'Plotter & Osiloskop Sinyalleri',
    status: anyDiff ? 'modified' : 'identical',
    rows,
  };
}

function diffSimulationPanelsSection(
  localProj: NexusProjectFileV1 | null,
  cloudProj: NexusProjectFileV1 | null,
): WorkspaceSectionDiff {
  const rows: WorkspaceDiffRow[] = [];

  const localPanels = localProj?.simulationPanels ?? [];
  const cloudPanels = cloudProj?.simulationPanels ?? [];

  const localPanelNames = localPanels.map((p) => p.name).join(', ');
  const cloudPanelNames = cloudPanels.map((p) => p.name).join(', ');

  const localTotalWidgets = localPanels.reduce((sum, p) => sum + (p.widgets?.length ?? 0), 0);
  const cloudTotalWidgets = cloudPanels.reduce((sum, p) => sum + (p.widgets?.length ?? 0), 0);

  rows.push({
    label: 'Enstrüman Panelleri',
    localSummary: localPanels.length > 0 ? `${localPanels.length} panel (${localPanelNames})` : 'Yok',
    cloudSummary: cloudPanels.length > 0 ? `${cloudPanels.length} panel (${cloudPanelNames})` : 'Yok',
    changeKind:
      localPanelNames === cloudPanelNames
        ? 'identical'
        : localPanels.length > 0 && cloudPanels.length > 0
          ? 'different'
          : localPanels.length > 0
            ? 'localOnly'
            : 'cloudOnly',
  });

  rows.push({
    label: 'Toplam Enstrüman & Kontrol Sayısı',
    localSummary: `${localTotalWidgets} widget`,
    cloudSummary: `${cloudTotalWidgets} widget`,
    changeKind: localTotalWidgets === cloudTotalWidgets ? 'identical' : 'different',
  });

  const anyDiff = rows.some((r) => r.changeKind !== 'identical');
  return {
    key: 'simulationPanels',
    title: 'Sanal Enstrüman & Simülasyon Panelleri',
    status: anyDiff ? 'modified' : 'identical',
    rows,
  };
}

/**
 * Merges sections between local and cloud projects according to per-section user picks.
 */
export function mergeWorkspaceSections(
  base: NexusProjectFileV1,
  localProj: NexusProjectFileV1,
  cloudProj: NexusProjectFileV1,
  picks: Record<WorkspaceSectionKey, 'local' | 'cloud'>,
): NexusProjectFileV1 {
  const metaSource = picks.metadata === 'local' ? localProj : cloudProj;
  const dbSource = picks.databases === 'local' ? localProj : cloudProj;
  const connSource = picks.connections === 'local' ? localProj : cloudProj;
  const txSource = picks.transmitList === 'local' ? localProj : cloudProj;
  const plotSource = picks.plotter === 'local' ? localProj : cloudProj;
  const panelSource = picks.simulationPanels === 'local' ? localProj : cloudProj;

  return {
    version: 1,
    name: metaSource.name,
    fileStem: metaSource.fileStem,
    createdAt: base.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: metaSource.notes ?? '',
    databases: {
      usePresetDb: Boolean(dbSource.databases?.usePresetDb),
      customFiles: (dbSource.databases?.customFiles ?? []).map((f) => ({ ...f })),
    },
    connections: {
      profiles: (connSource.connections?.profiles ?? []).map((p) => ({ ...p })),
      activeConnectedProfileIds: [],
      quickBarState: {
        selectedDeviceId: connSource.connections?.quickBarState?.selectedDeviceId ?? '',
        bitrateProfileId: connSource.connections?.quickBarState?.bitrateProfileId ?? 'fd_500k_2m',
        mockFpsPreset: connSource.connections?.quickBarState?.mockFpsPreset ?? null,
        listenOnly: true,
      },
    },
    transmitList: {
      entries: (txSource.transmitList?.entries ?? []).map((e) => ({
        ...e,
        rawBytes: [...e.rawBytes],
        signalValues: { ...e.signalValues },
        periodicEnabled: false,
        backendJobId: null,
        manualSentCount: 0,
        periodicSentCount: 0,
      })),
    },
    plotter: {
      watchedSignals: (plotSource.plotter?.watchedSignals ?? []).map((s) => ({ ...s })),
      layoutMode: plotSource.plotter?.layoutMode ?? 'combined',
      yScaleMode: plotSource.plotter?.yScaleMode ?? 'multiAxis',
      timeWindowSec: plotSource.plotter?.timeWindowSec ?? 30,
      splitRowHeight: plotSource.plotter?.splitRowHeight,
    },
    simulationPanels: (panelSource.simulationPanels ?? []).map((p) => ({
      ...p,
      widgets: (p.widgets ?? []).map((w) => ({
        ...w,
        layout: { ...w.layout },
        config: { ...w.config },
        binding: w.binding ? { ...w.binding } : null,
      })),
      generators: (p.generators ?? []).map((g) => ({
        ...g,
        binding: { ...g.binding },
      })),
    })),
    workspace: {
      traceMaxBufferRows: metaSource.workspace?.traceMaxBufferRows ?? 100000,
      activeDocTab: metaSource.workspace?.activeDocTab ?? 'rxtx',
      theme: metaSource.workspace?.theme ?? 'dark',
      expandedRxKeys: [...(metaSource.workspace?.expandedRxKeys ?? [])],
    },
    cloudBinding: base.cloudBinding ?? null,
  };
}

/**
 * Validates and normalizes raw JSON payload into a strict `NexusProjectFileV1`.
 * Ensures required arrays and fallback fields are present without crashing.
 */
export function validateAndNormalizeWorkspaceJson(
  raw: unknown,
  fallbackName = 'Cloud Project',
): { ok: true; project: NexusProjectFileV1 } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'JSON kök nesnesi geçersiz (beklenen: object).' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== undefined && obj.version !== 1) {
    return {
      ok: false,
      error: `Desteklenmeyen şablon versiyonu: ${String(obj.version)} (beklenen: 1).`,
    };
  }

  const name =
    typeof obj.name === 'string' && obj.name.trim().length > 0
      ? obj.name.trim()
      : fallbackName;
  const fileStem =
    typeof obj.fileStem === 'string' && obj.fileStem.trim().length > 0
      ? obj.fileStem.trim()
      : name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .slice(0, 64) || 'nexus-project';

  const notes = typeof obj.notes === 'string' ? obj.notes : '';
  const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString();
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString();

  // Databases
  const rawDb = (obj.databases && typeof obj.databases === 'object' ? obj.databases : {}) as Record<
    string,
    unknown
  >;
  const usePresetDb = Boolean(rawDb.usePresetDb);
  const customFiles: CustomDbFileRecord[] = Array.isArray(rawDb.customFiles)
    ? rawDb.customFiles
        .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === 'object'))
        .map((f) => ({
          fileName: String(f.fileName ?? 'custom.dbc'),
          contentBase64: String(f.contentBase64 ?? ''),
        }))
    : [];

  // Connections
  const rawConn = (obj.connections && typeof obj.connections === 'object'
    ? obj.connections
    : {}) as Record<string, unknown>;
  const profiles: SavedConnectionProfile[] = Array.isArray(rawConn.profiles)
    ? rawConn.profiles
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
        .map((p, idx) => {
          const rawFam = String(p.driverFamily ?? 'socketcan');
          const driverFamily: DriverFamilyId =
            rawFam === 'gs_usb' ||
            rawFam === 'slcan' ||
            rawFam === 'pcan' ||
            rawFam === 'kvaser' ||
            rawFam === 'vector_xl' ||
            rawFam === 'mock'
              ? rawFam
              : 'socketcan';

          return {
            id: String(p.id ?? `prof-${idx}`),
            name: String(p.name ?? `CAN Bus ${idx + 1}`),
            busId: typeof p.busId === 'number' ? Math.max(0, Math.min(7, p.busId)) : idx,
            driverFamily,
            deviceId: String(p.deviceId ?? p.channelName ?? 'vcan0'),
            adapterChannel: String(p.adapterChannel ?? p.channelName ?? 'vcan0'),
            serialPort: String(p.serialPort ?? ''),
            serialBaudRate: typeof p.serialBaudRate === 'number' ? p.serialBaudRate : 115200,
            serialDtrRts: Boolean(p.serialDtrRts),
            bitrateProfileId: String(p.bitrateProfileId ?? 'fd_500k_2m'),
            bitrate: typeof p.bitrate === 'number' ? p.bitrate : 500000,
            enableFd: Boolean(p.enableFd),
            dataBitrate: typeof p.dataBitrate === 'number' ? p.dataBitrate : 2000000,
            listenOnly: p.listenOnly !== undefined ? Boolean(p.listenOnly) : true,
            mockFpsPreset: typeof p.mockFpsPreset === 'number' ? p.mockFpsPreset : null,
            autoConnectOnProjectLoad: Boolean(p.autoConnectOnProjectLoad),
            notes: String(p.notes ?? ''),
            // Cloud's Zod schema may strip unknown keys: if absent, bind every catalog file (legacy migration).
            databaseIds: Array.isArray(p.databaseIds)
              ? p.databaseIds.filter((x): x is string => typeof x === 'string')
              : customFiles.map((f) => `db:${f.fileName.trim().toLowerCase()}`),
          };
        })
    : [];

  const rawQb = (rawConn.quickBarState && typeof rawConn.quickBarState === 'object'
    ? rawConn.quickBarState
    : {}) as Record<string, unknown>;

  // TransmitList
  const rawTx = (obj.transmitList && typeof obj.transmitList === 'object'
    ? obj.transmitList
    : {}) as Record<string, unknown>;
  const entries: TxListEntry[] = Array.isArray(rawTx.entries)
    ? rawTx.entries
        .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
        .map((e, idx) => {
          const mode: TxEntryMode = e.mode === 'symbolic' ? 'symbolic' : 'raw';
          const cycleTimeMs =
            typeof e.cycleTimeMs === 'number'
              ? e.cycleTimeMs
              : typeof e.periodMs === 'number'
                ? e.periodMs
                : 100;

          return {
            id: String(e.id ?? `tx-${idx}`),
            busId: typeof e.busId === 'number' ? e.busId : 0,
            mode,
            messageKey: typeof e.messageKey === 'string' ? e.messageKey : null,
            arbId: typeof e.arbId === 'number' ? e.arbId : 0x100,
            isExtended: Boolean(e.isExtended),
            isFd: Boolean(e.isFd),
            isBrs: Boolean(e.isBrs),
            dlc: typeof e.dlc === 'number' ? Math.max(0, Math.min(64, e.dlc)) : 8,
            symbolName: String(e.symbolName ?? e.name ?? `Message ${idx + 1}`),
            rawBytes: Array.isArray(e.rawBytes)
              ? e.rawBytes.map(Number).slice(0, 64)
              : [0, 0, 0, 0, 0, 0, 0, 0],
            signalValues:
              e.signalValues && typeof e.signalValues === 'object'
                ? (e.signalValues as Record<number, number>)
                : {},
            cycleTimeMs,
            periodicEnabled: false,
            backendJobId: null,
            manualSentCount: 0,
            periodicSentCount: 0,
            creator: String(e.creator ?? 'cloud'),
            comment: String(e.comment ?? ''),
          };
        })
    : [];

  // Plotter
  const rawPlot = (obj.plotter && typeof obj.plotter === 'object' ? obj.plotter : {}) as Record<
    string,
    unknown
  >;
  const rawSignals = Array.isArray(rawPlot.watchedSignals)
    ? rawPlot.watchedSignals
    : Array.isArray(rawPlot.series)
      ? rawPlot.series
      : [];

  const watchedSignals: SavedPlotSignalSpec[] = rawSignals
    .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
    .map((s, idx) => ({
      busId: typeof s.busId === 'number' ? s.busId : 0,
      signalId: typeof s.signalId === 'number' ? s.signalId : idx,
      messageKey: String(s.messageKey ?? ''),
      signalName: String(s.signalName ?? `Signal ${idx}`),
      unit: String(s.unit ?? ''),
      schemaMin: typeof s.schemaMin === 'number' ? s.schemaMin : 0,
      schemaMax: typeof s.schemaMax === 'number' ? s.schemaMax : 100,
      colorHex: String(s.colorHex ?? s.color ?? '#38BDF8'),
      visible: s.visible !== undefined ? Boolean(s.visible) : true,
      autoScale: s.autoScale !== undefined ? Boolean(s.autoScale) : true,
      customYMin: typeof s.customYMin === 'number' ? s.customYMin : 0,
      customYMax: typeof s.customYMax === 'number' ? s.customYMax : 100,
    }));

  const layoutMode: PlotLayoutMode =
    rawPlot.layoutMode === 'split'
      ? 'split'
      : rawPlot.layoutMode === 'compactSplit'
        ? 'compactSplit'
        : 'combined';
  const yScaleMode: PlotYScaleMode =
    rawPlot.yScaleMode === 'normalized'
      ? 'normalized'
      : rawPlot.yScaleMode === 'shared'
        ? 'shared'
        : 'multiAxis';
  const timeWindowSec =
    typeof rawPlot.timeWindowSec === 'number'
      ? rawPlot.timeWindowSec
      : typeof rawPlot.viewSpanSec === 'number'
        ? rawPlot.viewSpanSec
        : 30;

  // Simulation Panels
  const simulationPanels: SimulationPanelDto[] = Array.isArray(obj.simulationPanels)
    ? obj.simulationPanels
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
        .map((p, pIdx) => {
          const widgets: SimulationWidgetDto[] = Array.isArray(p.widgets)
            ? p.widgets
                .filter((w): w is Record<string, unknown> => Boolean(w && typeof w === 'object'))
                .map((w, wIdx) => {
                  const rawLayout = (w.layout && typeof w.layout === 'object'
                    ? w.layout
                    : {}) as Record<string, unknown>;
                  const rawConfig = (w.config && typeof w.config === 'object'
                    ? w.config
                    : {}) as Record<string, unknown>;
                  const rawBinding = (w.binding && typeof w.binding === 'object'
                    ? w.binding
                    : null) as Record<string, unknown> | null;

                  return {
                    id: String(w.id ?? `widget-${pIdx}-${wIdx}`),
                    kind: (w.kind as SimulationWidgetDto['kind']) ?? 'numeric',
                    title: String(w.title ?? 'Instrument'),
                    accentColor: (w.accentColor as SimulationWidgetDto['accentColor']) ?? 'cyan',
                    layout: {
                      col: typeof rawLayout.col === 'number' ? rawLayout.col : 0,
                      row: typeof rawLayout.row === 'number' ? rawLayout.row : 0,
                      w: typeof rawLayout.w === 'number' ? rawLayout.w : 4,
                      h: typeof rawLayout.h === 'number' ? rawLayout.h : 2,
                    },
                    binding: rawBinding
                      ? {
                          busId: typeof rawBinding.busId === 'number' ? rawBinding.busId : 0,
                          messageKey: String(rawBinding.messageKey ?? ''),
                          messageName: String(rawBinding.messageName ?? ''),
                          arbId: typeof rawBinding.arbId === 'number' ? rawBinding.arbId : 0,
                          isExtended: Boolean(rawBinding.isExtended),
                          signalName: String(rawBinding.signalName ?? ''),
                          unit: String(rawBinding.unit ?? ''),
                          min: typeof rawBinding.min === 'number' ? rawBinding.min : 0,
                          max: typeof rawBinding.max === 'number' ? rawBinding.max : 100,
                          factor: typeof rawBinding.factor === 'number' ? rawBinding.factor : 1,
                          offset: typeof rawBinding.offset === 'number' ? rawBinding.offset : 0,
                          decimals:
                            typeof rawBinding.decimals === 'number' ? rawBinding.decimals : 0,
                          color: String(rawBinding.color ?? '#06B6D4'),
                        }
                      : null,
                    config: rawConfig as SimulationWidgetDto['config'],
                  };
                })
            : [];

          const generators: SimulationGeneratorSpecDto[] = Array.isArray(p.generators)
            ? p.generators
                .filter((g): g is Record<string, unknown> => Boolean(g && typeof g === 'object'))
                .map((g, gIdx) => {
                  const rawBinding = (g.binding && typeof g.binding === 'object'
                    ? g.binding
                    : {}) as Record<string, unknown>;
                  return {
                    id: String(g.id ?? `gen-${pIdx}-${gIdx}`),
                    enabled: Boolean(g.enabled),
                    waveform: (g.waveform as SimulationGeneratorSpecDto['waveform']) ?? 'sine',
                    min: typeof g.min === 'number' ? g.min : 0,
                    max: typeof g.max === 'number' ? g.max : 100,
                    constantValue:
                      typeof g.constantValue === 'number' ? g.constantValue : 0,
                    frequencyHz:
                      typeof g.frequencyHz === 'number' ? g.frequencyHz : 1,
                    binding: {
                      busId: typeof rawBinding.busId === 'number' ? rawBinding.busId : 0,
                      messageKey: String(rawBinding.messageKey ?? ''),
                      messageName: String(rawBinding.messageName ?? ''),
                      arbId: typeof rawBinding.arbId === 'number' ? rawBinding.arbId : 0,
                      isExtended: Boolean(rawBinding.isExtended),
                      signalName: String(rawBinding.signalName ?? ''),
                      unit: String(rawBinding.unit ?? ''),
                      min: typeof rawBinding.min === 'number' ? rawBinding.min : 0,
                      max: typeof rawBinding.max === 'number' ? rawBinding.max : 100,
                      factor: typeof rawBinding.factor === 'number' ? rawBinding.factor : 1,
                      offset: typeof rawBinding.offset === 'number' ? rawBinding.offset : 0,
                      decimals:
                        typeof rawBinding.decimals === 'number' ? rawBinding.decimals : 0,
                      color: String(rawBinding.color ?? '#06B6D4'),
                    },
                  };
                })
            : [];

          return {
            id: String(p.id ?? `panel-${pIdx}`),
            projectId: typeof p.projectId === 'string' ? p.projectId : undefined,
            name: String(p.name ?? `Instruments Panel ${pIdx + 1}`),
            description: String(p.description ?? ''),
            gridCols: typeof p.gridCols === 'number' ? p.gridCols : 24,
            rowHeightPx: typeof p.rowHeightPx === 'number' ? p.rowHeightPx : 42,
            targetDatabaseId:
              typeof p.targetDatabaseId === 'string' ? p.targetDatabaseId : null,
            widgets,
            generators,
            createdAt:
              typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
            updatedAt:
              typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
          };
        })
    : [];

  // Workspace
  const rawWs = (obj.workspace && typeof obj.workspace === 'object' ? obj.workspace : {}) as Record<
    string,
    unknown
  >;

  const project: NexusProjectFileV1 = {
    version: 1,
    name,
    fileStem,
    createdAt,
    updatedAt,
    notes,
    databases: {
      usePresetDb,
      customFiles,
    },
    connections: {
      profiles,
      activeConnectedProfileIds: [],
      quickBarState: {
        selectedDeviceId: typeof rawQb.selectedDeviceId === 'string' ? rawQb.selectedDeviceId : '',
        bitrateProfileId: typeof rawQb.bitrateProfileId === 'string' ? rawQb.bitrateProfileId : 'fd_500k_2m',
        mockFpsPreset: typeof rawQb.mockFpsPreset === 'number' ? rawQb.mockFpsPreset : null,
        listenOnly: true,
      },
    },
    transmitList: {
      entries,
    },
    plotter: {
      watchedSignals,
      layoutMode,
      yScaleMode,
      timeWindowSec,
    },
    simulationPanels,
    workspace: {
      traceMaxBufferRows:
        typeof rawWs.traceMaxBufferRows === 'number' ? rawWs.traceMaxBufferRows : 100000,
      activeDocTab:
        rawWs.activeDocTab === 'rxtx' ||
        rawWs.activeDocTab === 'connections' ||
        rawWs.activeDocTab === 'plotter' ||
        rawWs.activeDocTab === 'trace' ||
        rawWs.activeDocTab === 'symbols' ||
        rawWs.activeDocTab === 'panels' ||
        rawWs.activeDocTab === 'cloud'
          ? rawWs.activeDocTab
          : 'rxtx',
      theme: rawWs.theme === 'light' ? 'light' : 'dark',
      expandedRxKeys: Array.isArray(rawWs.expandedRxKeys) ? rawWs.expandedRxKeys.map(String) : [],
      enabledToolpacks: normalizeEnabledToolpacks(
        Array.isArray(rawWs.enabledToolpacks)
          ? (rawWs.enabledToolpacks as readonly string[])
          : undefined,
      ),
    },
  };

  return { ok: true, project };
}

/**
 * Enforces Field Safety Invariants (AGENTS.md Rule #4):
 * Pulling a remote workspace must NEVER transmit packets or actively ACK physical CAN buses
 * until explicitly armed by the test engineer on the bench.
 */
export function sanitizeCloudWorkspaceForLocalApply(
  proj: NexusProjectFileV1,
  binding: CloudProjectBindingV1,
): NexusProjectFileV1 {
  const safeProfiles: SavedConnectionProfile[] = (proj.connections?.profiles ?? []).map((p) => ({
    ...p,
    listenOnly: true,
    autoConnectOnProjectLoad: false,
  }));

  const safeTxEntries: TxListEntry[] = (proj.transmitList?.entries ?? []).map((e) => ({
    ...e,
    rawBytes: [...e.rawBytes],
    signalValues: { ...e.signalValues },
    periodicEnabled: false,
    backendJobId: null,
    manualSentCount: 0,
    periodicSentCount: 0,
  }));

  return {
    ...proj,
    connections: {
      ...proj.connections,
      profiles: safeProfiles,
      activeConnectedProfileIds: [],
      quickBarState: {
        ...proj.connections.quickBarState,
        listenOnly: true,
      },
    },
    transmitList: {
      entries: safeTxEntries,
    },
    simulationPanels: (proj.simulationPanels ?? []).map((p) => ({
      ...p,
      widgets: (p.widgets ?? []).map((w) => ({
        ...w,
        layout: { ...w.layout },
        config: { ...w.config },
        binding: w.binding ? { ...w.binding } : null,
      })),
      generators: (p.generators ?? []).map((g) => ({
        ...g,
        binding: { ...g.binding },
      })),
    })),
    workspace: {
      ...proj.workspace,
      enabledToolpacks: normalizeEnabledToolpacks(proj.workspace?.enabledToolpacks),
    },
    cloudBinding: binding,
  };
}
