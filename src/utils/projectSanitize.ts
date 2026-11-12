/**
 * Single normalize / validate entry point for every locally loaded `.nexusproj.json`
 * (WP-3 / CRIT-04). A project file is untrusted input: it must never be able to open a CAN
 * channel in normal (ACK-capable) mode or connect anything on its own.
 *
 * - `external` (open file / import / open saved): every profile is forced `listenOnly: true`,
 *   auto-connect and `activeConnectedProfileIds` are dropped; the caller shows a "N profiles want
 *   to connect" notice instead. `cloudBinding` is withheld until the user confirms.
 * - `own` (reload of the user's own last session): shape validation only.
 */
import type { NexusProjectFileV1 } from '../store/projectStore';
import type { SavedConnectionProfile } from '../store/connectionStore';
import type { DriverFamilyId } from '../types/hal';
import type { CloudProjectBindingV1 } from './workspaceDiff';

export const MAX_PROFILES = 64;
export const MAX_DB_FILES = 64;
export const MAX_TX_ENTRIES = 2048;
export const MAX_PANELS = 256;
export const MAX_STRING = 4096;
export const MAX_NOTES = 65536;
export const MAX_DB_BASE64 = 64 * 1024 * 1024;

export class ProjectValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProjectValidationError';
  }
}

export interface SanitizedProject {
  project: NexusProjectFileV1;
  /** Profiles that asked to connect (external mode). They are still Listen-Only. */
  connectCandidates: SavedConnectionProfile[];
  /** Withheld until the user confirms (external mode). */
  pendingCloudBinding: CloudProjectBindingV1 | null;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const DRIVER_FAMILIES: readonly DriverFamilyId[] = [
  'mock', 'socketcan', 'slcan', 'pcan', 'kvaser', 'gs_usb',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-copies JSON data into null-prototype dictionaries, dropping prototype-pollution keys. */
export function deepClean(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new ProjectValidationError('nesting too deep');
  if (Array.isArray(value)) return value.map((v) => deepClean(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      out[key] = deepClean(value[key], depth + 1);
    }
    return out;
  }
  return value;
}

function str(v: unknown, fallback: string, max = MAX_STRING): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}
function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
function arr(v: unknown, max: number, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ProjectValidationError(`${what} must be an array`);
  if (v.length > max) throw new ProjectValidationError(`${what} has too many entries (${v.length} > ${max})`);
  return v;
}

function sanitizeProfile(raw: unknown, mode: 'external' | 'own'): SavedConnectionProfile {
  if (!isRecord(raw)) throw new ProjectValidationError('connection profile must be an object');
  const fam = DRIVER_FAMILIES.find((f) => f === raw['driverFamily']);
  if (fam === undefined) throw new ProjectValidationError('unknown driver family');
  const ownMode = mode === 'own';
  return {
    id: str(raw['id'], '', 128),
    name: str(raw['name'], 'Connection', 256),
    busId: Math.trunc(num(raw['busId'], 0, 0, 255)),
    driverFamily: fam,
    deviceId: str(raw['deviceId'], '', 512),
    adapterChannel: str(raw['adapterChannel'], '', 512),
    serialPort: str(raw['serialPort'], '', 512),
    serialBaudRate: num(raw['serialBaudRate'], 115200, 1200, 10_000_000),
    serialDtrRts: raw['serialDtrRts'] === true,
    bitrateProfileId: str(raw['bitrateProfileId'], '', 128),
    bitrate: num(raw['bitrate'], 500_000, 1000, 10_000_000),
    enableFd: raw['enableFd'] === true,
    dataBitrate: num(raw['dataBitrate'], 2_000_000, 1000, 20_000_000),
    // Imported files can never switch a channel out of Listen-Only.
    listenOnly: ownMode ? raw['listenOnly'] !== false : true,
    mockFpsPreset: typeof raw['mockFpsPreset'] === 'number' ? num(raw['mockFpsPreset'], 0, 0, 1_000_000) : null,
    autoConnectOnProjectLoad: ownMode ? raw['autoConnectOnProjectLoad'] === true : false,
    notes: str(raw['notes'], '', MAX_NOTES),
    databaseIds: Array.isArray(raw['databaseIds'])
      ? (raw['databaseIds'] as unknown[]).slice(0, MAX_DB_FILES).filter((x): x is string => typeof x === 'string')
      : (undefined as unknown as string[]),
  };
}

function sanitizeBinding(raw: unknown): CloudProjectBindingV1 | null {
  if (!isRecord(raw) || typeof raw['projectId'] !== 'string') return null;
  return deepClean(raw) as unknown as CloudProjectBindingV1;
}

/**
 * Validates + normalizes a parsed project file. Throws `ProjectValidationError` on a bad shape.
 */
export function sanitizeProject(raw: unknown, mode: 'external' | 'own'): SanitizedProject {
  if (!isRecord(raw)) throw new ProjectValidationError('not an object');
  if (raw['version'] !== 1) throw new ProjectValidationError('unsupported version');
  const cleaned = deepClean(raw) as Record<string, unknown>;

  const databases = isRecord(cleaned['databases']) ? cleaned['databases'] : {};
  const customFiles = arr(databases['customFiles'], MAX_DB_FILES, 'databases.customFiles').map((f) => {
    if (!isRecord(f) || typeof f['fileName'] !== 'string' || typeof f['contentBase64'] !== 'string') {
      throw new ProjectValidationError('invalid database file entry');
    }
    if (f['contentBase64'].length > MAX_DB_BASE64) throw new ProjectValidationError('database file too large');
    return {
      fileName: f['fileName'].slice(0, 260),
      contentBase64: f['contentBase64'],
      ...(typeof f['sizeBytes'] === 'number' ? { sizeBytes: f['sizeBytes'] } : {}),
    };
  });

  const conns = isRecord(cleaned['connections']) ? cleaned['connections'] : {};
  const profiles = arr(conns['profiles'], MAX_PROFILES, 'connections.profiles').map((p) => sanitizeProfile(p, mode));
  const wantsConnect = profiles.length > 0
    ? (() => {
        const active = new Set(
          arr(conns['activeConnectedProfileIds'], MAX_PROFILES, 'activeConnectedProfileIds').filter(
            (x): x is string => typeof x === 'string',
          ),
        );
        const rawProfiles = arr(conns['profiles'], MAX_PROFILES, 'profiles');
        return profiles.filter((p, i) => {
          const r = rawProfiles[i];
          return active.has(p.id) || (isRecord(r) && r['autoConnectOnProjectLoad'] === true);
        });
      })()
    : [];

  const quick = isRecord(conns['quickBarState']) ? conns['quickBarState'] : {};
  const ownMode = mode === 'own';
  const txEntries = arr(isRecord(cleaned['transmitList']) ? cleaned['transmitList']['entries'] : [], MAX_TX_ENTRIES, 'transmitList.entries');
  const panels = arr(cleaned['simulationPanels'], MAX_PANELS, 'simulationPanels');
  const ws = isRecord(cleaned['workspace']) ? cleaned['workspace'] : undefined;
  if (cleaned['plotter'] !== undefined && cleaned['plotter'] !== null && !isRecord(cleaned['plotter'])) {
    throw new ProjectValidationError('plotter must be an object');
  }

  const binding = sanitizeBinding(cleaned['cloudBinding']);

  const project = {
    ...cleaned,
    version: 1,
    name: str(cleaned['name'], 'Imported Project', 256),
    fileStem: str(cleaned['fileStem'], '', 128),
    createdAt: str(cleaned['createdAt'], new Date().toISOString(), 64),
    updatedAt: str(cleaned['updatedAt'], new Date().toISOString(), 64),
    notes: str(cleaned['notes'], '', MAX_NOTES),
    databases: { usePresetDb: databases['usePresetDb'] === true, customFiles },
    connections: {
      profiles,
      activeConnectedProfileIds: ownMode ? profiles.filter((p) => wantsConnect.includes(p)).map((p) => p.id) : [],
      quickBarState: {
        selectedDeviceId: str(quick['selectedDeviceId'], '', 512),
        bitrateProfileId: str(quick['bitrateProfileId'], '', 128),
        mockFpsPreset: typeof quick['mockFpsPreset'] === 'number' ? quick['mockFpsPreset'] : null,
        listenOnly: ownMode ? quick['listenOnly'] !== false : true,
      },
    },
    transmitList: { entries: txEntries },
    simulationPanels: panels,
    workspace: ws,
    cloudBinding: ownMode ? binding : null,
  } as unknown as NexusProjectFileV1;

  return {
    project,
    connectCandidates: ownMode ? [] : wantsConnect,
    pendingCloudBinding: ownMode ? null : binding,
  };
}
