import { useSyncExternalStore } from 'react';
import type {
  ChannelConfigDto,
  DriverFamilyId,
  DriverProbeReportDto,
} from '../types/hal';

const STORAGE_KEY = 'nexuscan:connectionProfiles:v2';

export const MAX_BUS_ID = 255;

export function clampBusId(raw: number): number {
  return Math.max(0, Math.min(MAX_BUS_ID, Math.trunc(Number.isFinite(raw) ? raw : 0)));
}

export function findNextFreeBusId(
  profiles: readonly Pick<SavedConnectionProfile, 'busId'>[],
): number {
  const occupied = new Set<number>();
  for (let i = 0; i < profiles.length; i++) {
    occupied.add(clampBusId(profiles[i].busId));
  }
  for (let slot = 0; slot <= MAX_BUS_ID; slot++) {
    if (!occupied.has(slot)) {
      return slot;
    }
  }
  return 0;
}

export interface SavedConnectionProfile {
  id: string;
  name: string;
  busId: number; // 0..7 -> Bus 1..Bus 8
  driverFamily: DriverFamilyId;
  deviceId: string;
  adapterChannel: string;
  serialPort: string;
  serialBaudRate: number;
  serialDtrRts: boolean;
  bitrateProfileId: string;
  bitrate: number;
  enableFd: boolean;
  dataBitrate: number;
  listenOnly: boolean;
  mockFpsPreset: number | null;
  autoConnectOnProjectLoad: boolean;
  notes: string;
  databaseIds: string[];
}

export interface ConnectionStoreState {
  profiles: readonly SavedConnectionProfile[];
  selectedProfileId: string | null;
  probeReport: DriverProbeReportDto | null;
}

export const SERIAL_BAUD_RATES: readonly number[] = [
  115_200,
  230_400,
  460_800,
  921_600,
  1_000_000,
  2_000_000,
  3_000_000,
];

export const NOMINAL_BITRATES: readonly { value: number; label: string }[] = [
  { value: 10_000, label: '10 kbit/s' },
  { value: 20_000, label: '20 kbit/s' },
  { value: 50_000, label: '50 kbit/s' },
  { value: 100_000, label: '100 kbit/s' },
  { value: 125_000, label: '125 kbit/s (CANopen)' },
  { value: 250_000, label: '250 kbit/s (J1939)' },
  { value: 500_000, label: '500 kbit/s (Automotive Std)' },
  { value: 800_000, label: '800 kbit/s' },
  { value: 1_000_000, label: '1 Mbit/s' },
];

export const DATA_BITRATES_FD: readonly { value: number; label: string }[] = [
  { value: 1_000_000, label: '1 Mbit/s' },
  { value: 2_000_000, label: '2 Mbit/s (Automotive FD)' },
  { value: 4_000_000, label: '4 Mbit/s' },
  { value: 5_000_000, label: '5 Mbit/s' },
  { value: 8_000_000, label: '8 Mbit/s' },
];

export const PCAN_ADAPTER_CHANNELS: readonly string[] = [
  'PCAN_USBBUS1',
  'PCAN_USBBUS2',
  'PCAN_USBBUS3',
  'PCAN_USBBUS4',
  'PCAN_USBBUS5',
  'PCAN_USBBUS6',
  'PCAN_USBBUS7',
  'PCAN_USBBUS8',
  'PCAN_PCIBUS1',
  'PCAN_PCIBUS2',
  'PCAN_PCIBUS3',
  'PCAN_PCIBUS4',
];

export const KVASER_ADAPTER_CHANNELS: readonly string[] = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
];

export function createDefaultConnectionProfiles(): SavedConnectionProfile[] {
  // Empty by default: user adds their own hardware/vcan interfaces (mock is strictly opt-in)
  return [];
}

export function resolveDeviceIdForProfile(profile: SavedConnectionProfile): string {
  switch (profile.driverFamily) {
    case 'slcan': {
      const port = profile.serialPort.trim() || '/dev/ttyUSB0';
      return `slcan:${port}`;
    }
    case 'pcan': {
      const ch = profile.adapterChannel.trim() || 'PCAN_USBBUS1';
      return ch.startsWith('pcan:') ? ch : `pcan:${ch}`;
    }
    case 'kvaser': {
      const ch = profile.adapterChannel.trim() || '0';
      return ch.startsWith('kvaser:') ? ch : `kvaser:${ch}`;
    }
    case 'socketcan': {
      const iface = profile.adapterChannel.trim() || 'vcan0';
      return iface.startsWith('socketcan:') ? iface : `socketcan:${iface}`;
    }
    case 'gs_usb': {
      const ch = profile.adapterChannel.trim() || '0';
      return ch.startsWith('gs_usb:') ? ch : `gs_usb:${ch}`;
    }
    case 'mock':
    default: {
      const ch = profile.adapterChannel.trim() || 'mock0';
      return ch.startsWith('mock:') ? ch : `mock:${ch}`;
    }
  }
}

export function buildChannelConfigForProfile(
  profile: SavedConnectionProfile,
  overrideListenOnly?: boolean,
): { deviceId: string; config: ChannelConfigDto } {
  const deviceId = resolveDeviceIdForProfile(profile);
  const enableFd = profile.driverFamily === 'slcan' ? false : profile.enableFd;
  const listenOnly =
    overrideListenOnly !== undefined ? overrideListenOnly : profile.listenOnly;

  const config: ChannelConfigDto = {
    busId: clampBusId(profile.busId),
    bitrate: profile.bitrate,
    dataBitrate: enableFd ? profile.dataBitrate : profile.bitrate,
    enableFd,
    listenOnly,
    mockFpsPreset: profile.driverFamily === 'mock' ? profile.mockFpsPreset : null,
    driverFamily: profile.driverFamily,
    serialPort:
      profile.driverFamily === 'slcan' ? profile.serialPort.trim() || null : null,
    serialBaudRate:
      profile.driverFamily === 'slcan' ? profile.serialBaudRate : null,
    serialDtrRts: profile.driverFamily === 'slcan' ? profile.serialDtrRts : null,
    adapterChannel: profile.adapterChannel.trim() || null,
  };

  return { deviceId, config };
}

function loadInitialProfiles(): SavedConnectionProfile[] {
  if (typeof window === 'undefined') {
    return createDefaultConnectionProfiles();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultConnectionProfiles();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return (parsed as SavedConnectionProfile[]).map((p) => ({
        ...p,
        databaseIds: Array.isArray(p.databaseIds) ? p.databaseIds : [],
      }));
    }
  } catch {
    // Ignore corrupted storage
  }
  return createDefaultConnectionProfiles();
}

function persistProfilesToStorage(profiles: readonly SavedConnectionProfile[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // Ignore quota errors
  }
}

const initialProfiles = loadInitialProfiles();

let currentState: ConnectionStoreState = {
  profiles: initialProfiles,
  selectedProfileId: initialProfiles[0]?.id ?? null,
  probeReport: null,
};

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const fn of listeners) {
    fn();
  }
}

export const connectionStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  getState(): ConnectionStoreState {
    return currentState;
  },

  setProbeReport(report: DriverProbeReportDto | null): void {
    currentState = {
      ...currentState,
      probeReport: report,
    };
    emitChange();
  },

  selectProfile(id: string | null): void {
    if (currentState.selectedProfileId === id) return;
    currentState = {
      ...currentState,
      selectedProfileId: id,
    };
    emitChange();
  },

  upsertProfile(profile: SavedConnectionProfile): void {
    const resolved: SavedConnectionProfile = {
      ...profile,
      deviceId: resolveDeviceIdForProfile(profile),
      busId: clampBusId(profile.busId),
      databaseIds: Array.isArray(profile.databaseIds) ? [...profile.databaseIds] : [],
    };

    // Find all profiles other than the one being saved
    const others = currentState.profiles.filter((p) => p.id !== resolved.id);

    // Calculate which busIds are currently occupied by non-colliding others plus the new profile
    const occupiedBusIds = new Set<number>();
    occupiedBusIds.add(resolved.busId);
    for (const p of others) {
      if (p.busId !== resolved.busId) {
        occupiedBusIds.add(p.busId);
      }
    }

    let nextCandidateSlot = 0;
    const getNextFreeSlot = (): number => {
      while (nextCandidateSlot <= MAX_BUS_ID) {
        if (!occupiedBusIds.has(nextCandidateSlot)) {
          occupiedBusIds.add(nextCandidateSlot);
          return nextCandidateSlot;
        }
        nextCandidateSlot++;
      }
      return resolved.busId;
    };

    // Shift colliding other profiles to free slots so no two profiles share the same busId
    const shiftedOthers = others.map((p) => {
      if (p.busId === resolved.busId) {
        const nextSlot = getNextFreeSlot();
        return { ...p, busId: nextSlot };
      }
      return p;
    });

    const nextProfiles = [...shiftedOthers, resolved];

    persistProfilesToStorage(nextProfiles);
    currentState = {
      ...currentState,
      profiles: nextProfiles,
      selectedProfileId: resolved.id,
    };
    emitChange();
  },

  removeProfile(id: string): void {
    const nextProfiles = currentState.profiles.filter((p) => p.id !== id);
    persistProfilesToStorage(nextProfiles);
    currentState = {
      ...currentState,
      profiles: nextProfiles,
      selectedProfileId:
        currentState.selectedProfileId === id
          ? (nextProfiles[0]?.id ?? null)
          : currentState.selectedProfileId,
    };
    emitChange();
  },

  setProfiles(profiles: readonly SavedConnectionProfile[]): void {
    const normalized = profiles.map((p) => ({
      ...p,
      deviceId: resolveDeviceIdForProfile(p),
      databaseIds: Array.isArray(p.databaseIds) ? [...p.databaseIds] : [],
    }));
    persistProfilesToStorage(normalized);
    currentState = {
      ...currentState,
      profiles: normalized,
      selectedProfileId: normalized[0]?.id ?? null,
    };
    emitChange();
  },

  setProfileDatabases(profileId: string, databaseIds: readonly string[]): void {
    const nextProfiles = currentState.profiles.map((p) =>
      p.id === profileId ? { ...p, databaseIds: [...databaseIds] } : p
    );
    persistProfilesToStorage(nextProfiles);
    currentState = {
      ...currentState,
      profiles: nextProfiles,
    };
    emitChange();
  },

  resetToDefaults(): void {
    const defaults = createDefaultConnectionProfiles();
    connectionStore.setProfiles(defaults);
  },
};

export function useConnectionStore(): ConnectionStoreState {
  return useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getState,
    connectionStore.getState,
  );
}
