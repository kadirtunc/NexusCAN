import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
  Unlock,
  Usb,
} from 'lucide-react';
import {
  apiConnectBus,
  apiDisconnectAllBuses,
  apiDisconnectBus,
  apiProbeDrivers,
  apiSetBusMode,
} from '../services/ipcClient';
import {
  DATA_BITRATES_FD,
  KVASER_ADAPTER_CHANNELS,
  MAX_BUS_ID,
  NOMINAL_BITRATES,
  PCAN_ADAPTER_CHANNELS,
  SERIAL_BAUD_RATES,
  type SavedConnectionProfile,
  buildChannelConfigForProfile,
  clampBusId,
  connectionStore,
  findNextFreeBusId,
  resolveDeviceIdForProfile,
  useConnectionStore,
} from '../store/connectionStore';
import { ensureMockPresetDatabasesLoaded, syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';
import { telemetryStore, useTelemetryHeader } from '../store/telemetryStore';
import { transmitStore } from '../store/transmitStore';
import { useI18n, type TranslationKey } from '../i18n';
import type {
  DeviceDescriptorDto,
  DriverFamilyId,
  DriverFamilyStatusDto,
} from '../types/hal';
import { BusStateBadge } from './BusStateBadge';
import type { StatusBanner } from './TopBar';
import { DatabaseBindingPicker } from './DatabaseBindingPicker';
import { useDatabaseStore } from '../store/databaseStore';

interface ConnectionsViewProps {
  devices: readonly DeviceDescriptorDto[];
  onRefreshDevices: () => Promise<void>;
  onStatusMessage: (msg: StatusBanner) => void;
}

const DRIVER_FAMILY_OPTIONS: readonly {
  id: DriverFamilyId;
  labelKey: TranslationKey;
  shortTag: string;
}[] = [
  { id: 'socketcan', labelKey: 'conn.driver.socketcan', shortTag: 'SOCKETCAN' },
  {
    id: 'gs_usb',
    labelKey: 'conn.driver.gs_usb',
    shortTag: 'GS_USB',
  },
  {
    id: 'slcan',
    labelKey: 'conn.driver.slcan',
    shortTag: 'SLCAN',
  },
  { id: 'pcan', labelKey: 'conn.driver.pcan', shortTag: 'PCAN' },
  { id: 'kvaser', labelKey: 'conn.driver.kvaser', shortTag: 'KVASER' },
  { id: 'mock', labelKey: 'conn.driver.mock', shortTag: 'MOCK' },
];

function createBlankProfile(
  nextBusId: number,
  devices?: readonly DeviceDescriptorDto[],
  isLinux?: boolean,
): SavedConnectionProfile {
  const detectedSocketCan = devices?.find((d) => d.driverId === 'socketcan');
  const useSocketCan = Boolean(detectedSocketCan) || Boolean(isLinux);

  if (useSocketCan) {
    const channel = detectedSocketCan?.channelName || 'vcan0';
    return {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `SocketCAN (${channel})`,
      busId: Math.max(0, Math.min(7, nextBusId)),
      driverFamily: 'socketcan',
      deviceId: `socketcan:${channel}`,
      adapterChannel: channel,
      serialPort: '',
      serialBaudRate: 1_000_000,
      serialDtrRts: true,
      bitrateProfileId: 'fd_500k_2m',
      bitrate: 500_000,
      enableFd: true,
      dataBitrate: 2_000_000,
      listenOnly: true,
      mockFpsPreset: null,
      autoConnectOnProjectLoad: false,
      notes: 'Linux Native SocketCAN (can / vcan)',
      databaseIds: [],
    };
  }

  return {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `New Bus ${nextBusId + 1} (SLCAN)`,
    busId: Math.max(0, Math.min(7, nextBusId)),
    driverFamily: 'slcan',
    deviceId: 'slcan:COM3',
    adapterChannel: 'slcan0',
    serialPort: 'COM3',
    serialBaudRate: 1_000_000,
    serialDtrRts: true,
    bitrateProfileId: 'can_500k',
    bitrate: 500_000,
    enableFd: false,
    dataBitrate: 500_000,
    listenOnly: true,
    mockFpsPreset: null,
    autoConnectOnProjectLoad: false,
    notes: '',
    databaseIds: [],
  };
}

function createMockProfile(nextBusId: number): SavedConnectionProfile {
  return {
    id: `conn-mock-${Date.now()}`,
    name: 'EV Powertrain + BMS Sim (mock0)',
    busId: Math.max(0, Math.min(7, nextBusId)),
    driverFamily: 'mock',
    deviceId: 'mock:mock0',
    adapterChannel: 'mock0',
    serialPort: '',
    serialBaudRate: 1_000_000,
    serialDtrRts: true,
    bitrateProfileId: 'fd_500k_2m',
    bitrate: 500_000,
    enableFd: true,
    dataBitrate: 2_000_000,
    listenOnly: true,
    mockFpsPreset: null,
    autoConnectOnProjectLoad: false,
    notes: 'Synthetic multi-mux EV/BMS generator [Test Only]',
    databaseIds: [],
  };
}

function formatBitrateShort(bps: number): string {
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(bps % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  return `${Math.round(bps / 1_000)}k`;
}

export const ConnectionsView: React.FC<ConnectionsViewProps> = ({
  devices,
  onRefreshDevices,
  onStatusMessage,
}) => {
  const { t } = useI18n();
  const connState = useConnectionStore();
  const header = useTelemetryHeader();

  const [probing, setProbing] = useState<boolean>(false);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [driverDetailsOpen, setDriverDetailsOpen] = useState<boolean>(false);

  const selectedStoredProfile = useMemo(
    () =>
      connState.profiles.find((p) => p.id === connState.selectedProfileId) ??
      connState.profiles[0] ??
      null,
    [connState.profiles, connState.selectedProfileId],
  );

  const dbCatalog = useDatabaseStore().databases;

  const [draft, setDraft] = useState<SavedConnectionProfile>(() =>
    selectedStoredProfile ? { ...selectedStoredProfile } : createBlankProfile(0),
  );

  useEffect(() => {
    if (selectedStoredProfile) {
      setDraft({ ...selectedStoredProfile });
    }
  }, [selectedStoredProfile]);

  const runDriverProbe = useCallback(
    async (silent = false): Promise<void> => {
      setProbing(true);
      try {
        const [report] = await Promise.all([apiProbeDrivers(), onRefreshDevices()]);
        connectionStore.setProbeReport(report);
        if (!silent) {
          const installedCnt = report.families.filter((f) => f.installed).length;
          onStatusMessage({
            kind: 'info',
            message: t('conn.status.driverCheckComplete', {
              hostOs: report.hostOs,
              ready: installedCnt,
              total: report.families.length,
              serialCount: report.serialPorts.length,
            }),
          });
        }
      } catch (err) {
        if (!silent) {
          onStatusMessage({
            kind: 'error',
            message: t('conn.status.driverProbeFailed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          });
        }
      } finally {
        setProbing(false);
      }
    },
    [onRefreshDevices, onStatusMessage, t],
  );

  useEffect(() => {
    void runDriverProbe(true);
  }, [runDriverProbe]);

  const familyStatusMap = useMemo(() => {
    const map = new Map<string, DriverFamilyStatusDto>();
    if (!connState.probeReport) return map;
    for (const fam of connState.probeReport.families) {
      map.set(fam.familyId.toLowerCase(), fam);
    }
    return map;
  }, [connState.probeReport]);

  const draftDriverStatus = familyStatusMap.get(draft.driverFamily);

  const maxUsedBusId = useMemo(
    () => connState.profiles.reduce((max, p) => Math.max(max, p.busId), 0),
    [connState.profiles],
  );

  const handleSelectDriverFamily = (family: DriverFamilyId): void => {
    setDraft((prev) => {
      let adapterChannel = prev.adapterChannel;
      let serialPort = prev.serialPort;
      let enableFd = prev.enableFd;

      if (family === 'mock') {
        adapterChannel = 'mock0';
      } else if (family === 'pcan') {
        adapterChannel = PCAN_ADAPTER_CHANNELS[0];
      } else if (family === 'kvaser') {
        adapterChannel = '0';
      } else if (family === 'socketcan') {
        adapterChannel = 'vcan0';
      } else if (family === 'gs_usb') {
        adapterChannel = '0';
      } else if (family === 'slcan') {
        const firstDetected = connState.probeReport?.serialPorts[0]?.portName;
        serialPort = prev.serialPort.trim() || firstDetected || 'COM3';
        adapterChannel = 'slcan0';
        enableFd = false;
      }

      const updated: SavedConnectionProfile = {
        ...prev,
        driverFamily: family,
        adapterChannel,
        serialPort,
        enableFd,
      };
      updated.deviceId = resolveDeviceIdForProfile(updated);
      return updated;
    });
  };

  const handleSaveDraft = (): SavedConnectionProfile | null => {
    if (draft.driverFamily === 'slcan' && draft.serialPort.trim().length === 0) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.slcanPortRequired'),
      });
      return null;
    }

    const normalized: SavedConnectionProfile = {
      ...draft,
      name: draft.name.trim() || `Bus ${draft.busId + 1} (${draft.driverFamily})`,
      serialPort: draft.serialPort.trim(),
      adapterChannel: draft.adapterChannel.trim(),
      deviceId: resolveDeviceIdForProfile(draft),
    };
    connectionStore.upsertProfile(normalized);
    setDraft(normalized);
    onStatusMessage({
      kind: 'success',
      message: t('conn.status.savedProfile', {
        name: normalized.name,
        bus: normalized.busId + 1,
      }),
    });
    return normalized;
  };

  const handleConnectOrDisconnectProfile = async (
    profile: SavedConnectionProfile,
  ): Promise<void> => {
    const liveBus = header.buses.find(
      (b) => b.busId === profile.busId && b.connected,
    );
    setBusyProfileId(profile.id);
    try {
      if (liveBus) {
        await apiDisconnectBus(profile.busId);
        telemetryStore.removeBusHealth(profile.busId);
        onStatusMessage({
          kind: 'info',
          message: t('conn.status.disconnectedBus', {
            bus: profile.busId + 1,
            channel: liveBus.channelName,
          }),
        });
      } else {
        if (
          profile.driverFamily === 'slcan' &&
          profile.serialPort.trim().length === 0
        ) {
          onStatusMessage({
            kind: 'error',
            message: t('conn.status.serialPortEmpty', { name: profile.name }),
          });
          return;
        }

        let effectiveProfile = profile;
        if (profile.driverFamily === 'mock' && profile.databaseIds.length === 0) {
          const presetIds = await ensureMockPresetDatabasesLoaded();
          connectionStore.setProfileDatabases(profile.id, presetIds);
          effectiveProfile = { ...profile, databaseIds: presetIds };
          await syncAllBusDatabasesWithBackend();
        }

        const { deviceId, config } = buildChannelConfigForProfile(effectiveProfile);
        const health = await apiConnectBus(deviceId, config);
        telemetryStore.upsertBusHealth(health);
        onStatusMessage({
          kind: 'success',
          message: t('conn.status.connectedBus', {
            bus: profile.busId + 1,
            channel: health.channelName,
            mode: health.listenOnly ? 'Listen-Only' : 'Active CAN',
          }),
        });
      }
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.connFailed', {
          name: profile.name,
          err: err instanceof Error ? err.message : String(err),
        }),
      });
    } finally {
      setBusyProfileId(null);
    }
  };

  const handleSaveAndConnect = async (): Promise<void> => {
    const saved = handleSaveDraft();
    if (!saved) return;
    const liveBus = header.buses.find((b) => b.busId === saved.busId && b.connected);
    if (liveBus) {
      await apiDisconnectBus(saved.busId).catch(() => null);
      telemetryStore.removeBusHealth(saved.busId);
    }
    await handleConnectOrDisconnectProfile(saved);
  };

  const handleToggleArmOnBus = async (busId: number, currentArmed: boolean): Promise<void> => {
    try {
      const willArm = !currentArmed;
      const updated = await apiSetBusMode(busId, !willArm, willArm);
      telemetryStore.upsertBusHealth(updated);

      const matching = connState.profiles.find((p) => p.busId === busId);
      if (matching) {
        connectionStore.upsertProfile({ ...matching, listenOnly: !willArm });
      }

      onStatusMessage({
        kind: willArm ? 'success' : 'info',
        message: willArm
          ? t('conn.status.txArmed', { bus: busId + 1, channel: updated.channelName })
          : t('conn.status.txDisarmed', { bus: busId + 1, channel: updated.channelName }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.setModeError', {
          err: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleDisconnectAll = async (): Promise<void> => {
    try {
      const count = await apiDisconnectAllBuses();
      telemetryStore.clearAllBuses();
      transmitStore.markAllPaused();
      onStatusMessage({
        kind: 'info',
        message: t('conn.status.disconnectedAll', { count }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('conn.status.disconnectAllError', {
          err: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleCreateNewProfile = (): void => {
    const freeBus = findNextFreeBusId(connState.profiles);
    const isLinux = connState.probeReport?.hostOs === 'linux';
    const fresh = createBlankProfile(freeBus, devices, isLinux);
    connectionStore.upsertProfile(fresh);
    setDraft(fresh);
  };

  const handleAddMockProfile = async (): Promise<void> => {
    const freeBus = findNextFreeBusId(connState.profiles);
    const presetIds = await ensureMockPresetDatabasesLoaded();
    const fresh = createMockProfile(freeBus);
    fresh.databaseIds = presetIds;
    connectionStore.upsertProfile(fresh);
    void syncAllBusDatabasesWithBackend();
    setDraft(fresh);
    onStatusMessage({
      kind: 'info',
      message: t('conn.status.mockAdded', { name: fresh.name, bus: fresh.busId + 1 }),
    });
  };

  const handleDuplicateProfile = (prof: SavedConnectionProfile): void => {
    const copy: SavedConnectionProfile = {
      ...prof,
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${prof.name} (Copy)`,
      busId: Math.min(7, prof.busId + 1),
    };
    connectionStore.upsertProfile(copy);
    setDraft(copy);
  };

  const serialPorts = connState.probeReport?.serialPorts ?? [];

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col flex-1 min-h-0 overflow-hidden select-none"
    >
      {/* ==================================================================== */}
      {/* 1. COMPACT 28PX DRIVER STATUS STRIP + COLLAPSIBLE DETAILS DRAWER     */}
      {/* ==================================================================== */}
      <section
        style={{ borderBottom: '1px solid var(--border-strong)' }}
        className="shrink-0"
      >
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom:
              driverDetailsOpen || serialPorts.length > 0
                ? '1px solid var(--border-grid)'
                : 'none',
          }}
          className="min-h-[38px] py-1.5 px-3 flex items-center justify-between gap-2 text-[12px] flex-wrap"
        >
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <Cpu className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
            <span className="font-semibold text-[var(--text-secondary)] shrink-0">
              {t('conn.bar.drivers')}
            </span>

            {(connState.probeReport?.families ?? []).length === 0 ? (
              <span className="text-[var(--text-muted)] truncate">
                {probing ? t('conn.bar.scanningDrivers') : t('conn.bar.notScanned')}
              </span>
            ) : (
              <div className="flex items-center gap-2.5 font-mono text-[12px] shrink-0 flex-wrap">
                {connState.probeReport?.families.map((fam, idx) => (
                  <React.Fragment key={fam.familyId}>
                    {idx > 0 && (
                      <span className="text-[var(--text-muted)]">·</span>
                    )}
                    <span
                      title={
                        fam.installed
                          ? `${fam.displayName}: ${fam.detectedLibraryOrModule ?? t('conn.status.ready')}`
                          : `${fam.displayName}: ${fam.installHint}`
                      }
                      className={
                        fam.installed
                          ? 'text-[var(--text-primary)]'
                          : 'text-[var(--text-muted)]'
                      }
                    >
                      {fam.familyId}{' '}
                      <span
                        className={
                          fam.installed
                            ? 'text-emerald-500 font-semibold'
                            : 'text-[var(--text-muted)]'
                        }
                      >
                        {fam.installed ? '✓' : '—'}
                      </span>
                    </span>
                  </React.Fragment>
                ))}
              </div>
            )}

            {connState.probeReport && (
              <span className="hidden lg:inline font-mono text-[11px] text-[var(--text-muted)] ml-1 shrink-0">
                ({connState.probeReport.hostOs} · {devices.length} ch)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setDriverDetailsOpen((v) => !v)}
              style={{
                backgroundColor: driverDetailsOpen
                  ? 'var(--bg-header)'
                  : 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-secondary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] font-medium hover:text-[var(--text-primary)] cursor-pointer"
            >
              {driverDetailsOpen ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              <span>{t('conn.bar.driverDetails')}</span>
            </button>

            <button
              type="button"
              disabled={probing}
              onClick={() => void runDriverProbe(false)}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[28px] px-2.5 border flex items-center gap-1.5 text-[12px] font-medium hover:border-[var(--text-secondary)] cursor-pointer"
              title={t('conn.bar.rescanTitle')}
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[var(--text-secondary)] ${
                  probing ? 'animate-spin' : ''
                }`}
              />
              <span>{t('conn.bar.rescan')}</span>
            </button>
          </div>
        </div>

        {driverDetailsOpen && (
          <div className="max-h-[180px] overflow-y-auto">
            <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums text-[12px]">
              <colgroup>
                <col style={{ width: '220px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '220px' }} />
                <col style={{ width: '230px' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th className="font-sans">{t('conn.table.thDriverFamily')}</th>
                  <th className="font-sans">{t('conn.table.thStatus')}</th>
                  <th>{t('conn.table.thLibrary')}</th>
                  <th>{t('conn.table.thDetectedChannels')}</th>
                  <th className="font-sans">{t('conn.table.thInstallHint')}</th>
                </tr>
              </thead>
              <tbody>
                {(connState.probeReport?.families ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="pcan-cell font-sans text-[var(--text-muted)] text-[12px]">
                        {probing ? t('conn.bar.scanningDrivers') : t('conn.table.clickRescan')}
                      </div>
                    </td>
                  </tr>
                ) : (
                  connState.probeReport?.families.map((fam) => (
                    <tr key={fam.familyId}>
                      <td>
                        <div className="pcan-cell font-sans font-semibold text-[12px]">
                          <span className="truncate">{fam.displayName}</span>
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell font-sans text-[12px]">
                          {fam.installed ? (
                            <span className="inline-flex items-center gap-1 text-emerald-500 font-medium text-[12px]">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{fam.statusLabel || t('conn.status.ready')}</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[var(--text-muted)] text-[12px]">
                              <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">
                                {fam.statusLabel || t('conn.status.notInstalled')}
                              </span>
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div
                          className="pcan-cell text-[12px] text-[var(--text-secondary)]"
                          title={
                            fam.searchedPaths.length > 0
                              ? `Searched paths:\n${fam.searchedPaths.join('\n')}`
                              : undefined
                          }
                        >
                          <span className="truncate">
                            {fam.detectedLibraryOrModule ?? '—'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div
                          className="pcan-cell text-[12px]"
                          title={fam.detectedChannels.join(', ')}
                        >
                          <span className="truncate">
                            {fam.detectedChannels.length > 0
                              ? fam.detectedChannels.join(', ')
                              : '—'}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div
                          className="pcan-cell font-sans text-[12px] text-[var(--text-secondary)]"
                          title={fam.installHint}
                        >
                          <span className="truncate">{fam.installHint}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Detected USB / Serial Ports Quick Strip */}
        {serialPorts.length > 0 && (
          <div
            style={{
              backgroundColor: 'var(--bg-row-alt)',
              borderTop: driverDetailsOpen ? '1px solid var(--border-grid)' : 'none',
            }}
            className="min-h-[36px] px-3 py-1.5 flex flex-wrap items-center gap-2 text-[12px]"
          >
            <span className="font-semibold text-[var(--text-secondary)] flex items-center gap-1.5">
              <Usb className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('conn.bar.serialPorts')}</span>
            </span>
            {serialPorts.map((sp) => (
              <button
                key={sp.portName}
                type="button"
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    driverFamily: 'slcan',
                    serialPort: sp.portName,
                    enableFd: false,
                    deviceId: `slcan:${sp.portName}`,
                  }))
                }
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                }}
                className="h-[28px] px-2.5 border font-mono text-[12px] hover:border-[var(--text-secondary)] cursor-pointer flex items-center gap-1"
                title={t('conn.bar.selectPortTitle', { port: sp.portName })}
              >
                <span className="font-semibold text-[var(--text-primary)]">{sp.portName}</span>
                {sp.product ? ` · ${sp.product}` : ''}
                {sp.vidPid ? ` [${sp.vidPid}]` : ''}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ==================================================================== */}
      {/* 2. MAIN WORKSPACE: SAVED PROFILES TABLE (LEFT) + EDITOR (RIGHT)      */}
      {/* ==================================================================== */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* LEFT: Saved Connection Profiles */}
        <div
          style={{ borderRight: '1px solid var(--border-strong)' }}
          className="flex flex-col flex-1 min-w-0 min-h-0"
        >
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderBottom: '1px solid var(--border-strong)',
            }}
            className="shrink-0 min-h-[38px] px-3 py-1 flex items-center justify-between gap-2 text-[12px] flex-wrap"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleCreateNewProfile}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium text-[12px] hover:border-[var(--text-secondary)] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('conn.btn.newProfile')}</span>
              </button>

              <button
                type="button"
                disabled={!header.buses.some((b) => b.connected)}
                onClick={() => void handleDisconnectAll()}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1.5 font-medium text-[12px] hover:border-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
              >
                <PlugZap className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>{t('conn.btn.disconnectAll')}</span>
              </button>
              <button
                type="button"
                onClick={handleAddMockProfile}
                style={{
                  backgroundColor: 'var(--bg-panel)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-secondary)',
                }}
                className="h-[28px] px-2.5 border flex items-center gap-1 text-[11.5px] font-mono hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer"
                title={t('conn.btn.addSimulatorTitle')}
              >
                <span>{t('conn.btn.addSimulator')}</span>
              </button>
            </div>

            <span className="text-[var(--text-muted)] text-[12px]">
              {t('conn.bar.profilesCount', { count: connState.profiles.length })}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
              <colgroup>
                <col style={{ width: '36px' }} />
                <col style={{ width: '54px' }} />
                <col />
                <col style={{ width: '82px' }} />
                <col style={{ width: '132px' }} />
                <col style={{ width: '104px' }} />
                <col style={{ width: '92px' }} />
                <col style={{ width: '82px' }} />
                <col style={{ width: '88px' }} />
                <col style={{ width: '164px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="text-center font-sans" title={t('conn.th.onTitle')}>{t('conn.th.on')}</th>
                  <th>{t('conn.th.bus')}</th>
                  <th className="font-sans">{t('conn.th.profileName')}</th>
                  <th className="font-sans">{t('conn.th.driver')}</th>
                  <th>{t('conn.th.portChannel')}</th>
                  <th>{t('conn.th.bitrateFd')}</th>
                  <th className="font-sans">{t('conn.th.safety')}</th>
                  <th className="font-sans">{t('conn.th.hostLib')}</th>
                  <th className="font-sans">{t('conn.th.liveStatus')}</th>
                  <th className="font-sans">{t('conn.th.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {connState.profiles.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-0">
                      <div className="p-8 flex flex-col items-center justify-center text-center gap-3 bg-[var(--bg-panel)]">
                        <div className="w-12 h-12 rounded border border-[var(--border-strong)] bg-[var(--bg-toolbar)] flex items-center justify-center text-cyan-400">
                          <Cpu className="w-6 h-6" />
                        </div>
                        <div>
                          <div className="font-semibold text-[14px] text-[var(--text-primary)] font-sans">
                            {t('conn.empty.title')}
                          </div>
                          <div className="text-[12px] text-[var(--text-secondary)] mt-1.5 max-w-md font-sans leading-relaxed">
                            {t('conn.empty.desc')}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2.5 mt-2.5">
                          <button
                            type="button"
                            onClick={handleCreateNewProfile}
                            className="h-[30px] px-3.5 border border-emerald-500/60 bg-emerald-950/40 text-emerald-300 rounded font-medium text-[12px] hover:bg-emerald-900/50 cursor-pointer flex items-center gap-1.5"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>{t('conn.empty.addConnBtn')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleAddMockProfile}
                            className="h-[30px] px-3.5 border border-cyan-500/40 bg-cyan-950/30 text-cyan-300 rounded text-[12px] hover:bg-cyan-900/40 cursor-pointer flex items-center gap-1.5"
                            title={t('conn.btn.addSimulatorTitle')}
                          >
                            <Cpu className="w-3.5 h-3.5" />
                            <span>{t('conn.empty.addSimBtn')}</span>
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  connState.profiles.map((prof) => {
                    const isSelected = prof.id === connState.selectedProfileId;
                    const famStatus = familyStatusMap.get(prof.driverFamily);
                    const liveBus = header.buses.find(
                      (b) => b.busId === prof.busId && b.connected,
                    );
                    const portOrChan =
                      prof.driverFamily === 'slcan'
                        ? `${prof.serialPort || 'Unset'} @${Math.round(prof.serialBaudRate / 1000)}k`
                        : prof.adapterChannel || prof.deviceId;
                    const timingLabel =
                      prof.enableFd && prof.driverFamily !== 'slcan'
                        ? `${formatBitrateShort(prof.bitrate)}/${formatBitrateShort(prof.dataBitrate)} FD`
                        : `${formatBitrateShort(prof.bitrate)} CC`;

                    return (
                      <tr
                        key={prof.id}
                        onClick={() => connectionStore.selectProfile(prof.id)}
                        style={{
                          backgroundColor: isSelected
                            ? 'var(--bg-row-selected)'
                            : 'var(--bg-panel)',
                        }}
                        className="hover:!bg-[var(--bg-row-hover)] cursor-pointer text-[12px]"
                      >
                        {/* Checkbox toggle connection */}
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="pcan-cell pcan-cell-center">
                            <input
                              type="checkbox"
                              checked={Boolean(liveBus)}
                              disabled={busyProfileId === prof.id}
                              onChange={() => void handleConnectOrDisconnectProfile(prof)}
                              className="accent-emerald-600 cursor-pointer h-4 w-4"
                              title={
                                Boolean(liveBus)
                                  ? t('conn.row.connectedTooltip', { bus: prof.busId + 1 })
                                  : t('conn.row.disconnectedTooltip', { bus: prof.busId + 1 })
                              }
                            />
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell font-semibold text-[12px]">
                            Bus {prof.busId + 1}
                          </div>
                        </td>

                        <td>
                          <div
                            className="pcan-cell font-sans font-medium text-[12px]"
                            title={prof.notes || prof.name}
                          >
                            <span className="truncate">{prof.name}</span>
                            {(() => {
                              const bound = prof.databaseIds
                                .map((id) => dbCatalog.find((d) => d.id === id)?.fileName)
                                .filter((n): n is string => Boolean(n));
                              return (
                                <span
                                  className="ml-1.5 shrink-0 truncate max-w-[180px] border px-1.5 py-0.5 font-mono text-[11px]"
                                  style={{
                                    borderColor: bound.length > 0 ? 'var(--border-strong)' : 'var(--status-warn)',
                                    color: bound.length > 0 ? 'var(--text-secondary)' : 'var(--status-warn)',
                                  }}
                                  title={bound.length > 0 ? bound.join(', ') : t('conn.row.rawHexTooltip')}
                                >
                                  {bound.length === 0
                                    ? t('conn.row.rawHexBadge')
                                    : bound.length === 1
                                      ? bound[0]
                                      : t('conn.row.dbCountBadge', { count: bound.length })}
                                </span>
                              );
                            })()}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell font-mono text-[12px] uppercase text-[var(--text-secondary)]">
                            {prof.driverFamily}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell text-[12px]" title={portOrChan}>
                            <span className="truncate">{portOrChan}</span>
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell text-[12px]">{timingLabel}</div>
                        </td>

                        <td>
                          <div className="pcan-cell font-sans text-[12px]">
                            {prof.listenOnly ? (
                              <span className="text-emerald-500 font-medium">{t('conn.row.listenOnly')}</span>
                            ) : (
                              <span className="text-amber-500 font-semibold">
                                {t('conn.row.activeCan')}
                              </span>
                            )}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell font-sans text-[12px]">
                            {famStatus === undefined ? (
                              <span className="text-[var(--text-muted)]">—</span>
                            ) : famStatus.installed ? (
                              <span className="text-emerald-500 font-semibold">{t('conn.status.ready')}</span>
                            ) : (
                              <span
                                className="text-amber-500 font-semibold"
                                title={famStatus.installHint}
                              >
                                {t('conn.row.missing')}
                              </span>
                            )}
                          </div>
                        </td>

                        <td>
                          <div className="pcan-cell">
                            <BusStateBadge
                              busState={liveBus?.busState ?? 'offline'}
                              connected={Boolean(liveBus?.connected)}
                              listenOnly={liveBus?.listenOnly}
                              txArmed={liveBus?.txArmed}
                              txErrorCount={liveBus?.txErrorCount ?? 0}
                              rxErrorCount={liveBus?.rxErrorCount ?? 0}
                              compact
                            />
                          </div>
                        </td>

                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="pcan-cell gap-1.5 font-sans">
                            <button
                              type="button"
                              disabled={busyProfileId === prof.id}
                              onClick={() => void handleConnectOrDisconnectProfile(prof)}
                              style={{
                                backgroundColor: liveBus
                                  ? 'rgba(220, 38, 38, 0.14)'
                                  : 'rgba(16, 185, 129, 0.16)',
                                borderColor: liveBus ? '#dc2626' : '#10b981',
                              }}
                              className="h-[26px] px-2.5 border text-[11.5px] font-semibold cursor-pointer"
                            >
                              {liveBus ? t('conn.btn.disconnect') : t('conn.btn.connect')}
                            </button>

                            {liveBus && !liveBus.listenOnly && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleToggleArmOnBus(prof.busId, liveBus.txArmed)
                                }
                                style={{
                                  backgroundColor: liveBus.txArmed
                                    ? 'rgba(245, 158, 11, 0.2)'
                                    : 'var(--bg-toolbar)',
                                  borderColor: liveBus.txArmed
                                    ? '#f59e0b'
                                    : 'var(--border-strong)',
                                }}
                                className="h-[26px] px-2 border text-[11.5px] cursor-pointer"
                                title={t('conn.btn.armDisarmTitle')}
                              >
                                <Unlock className="w-3 h-3 inline text-amber-500" />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => handleDuplicateProfile(prof)}
                              style={{
                                backgroundColor: 'var(--bg-toolbar)',
                                borderColor: 'var(--border-strong)',
                              }}
                              className="h-[26px] px-2 border text-[11.5px] cursor-pointer"
                              title={t('conn.btn.duplicateTitle')}
                            >
                              <Copy className="w-3 h-3" />
                            </button>

                            {connState.profiles.length > 0 && (
                              <button
                                type="button"
                                onClick={() => connectionStore.removeProfile(prof.id)}
                                style={{
                                  backgroundColor: 'var(--bg-toolbar)',
                                  borderColor: 'var(--border-strong)',
                                }}
                                className="h-[26px] px-2 border text-[11.5px] text-[var(--text-secondary)] hover:text-red-400 cursor-pointer"
                                title={t('conn.btn.deleteTitle')}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT: Connection Profile Editor */}
        <aside className="w-[380px] lg:w-[420px] xl:w-[460px] shrink-0 flex flex-col min-h-0 overflow-hidden">
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderBottom: '1px solid var(--border-strong)',
            }}
            className="shrink-0 min-h-[38px] px-3 py-1 flex items-center justify-between text-[12px] flex-wrap gap-2"
          >
            <span className="font-semibold text-[var(--text-primary)]">
              {t('conn.editor.title')}
            </span>
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              {resolveDeviceIdForProfile(draft)}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-[12px]">
            {/* Profile Name & Target Bus */}
            <div className="grid grid-cols-[1fr_100px] gap-2.5">
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.profileName')}
                </label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.busSlot')}
                </label>
                <div className="flex items-center gap-1.5">
                  <select
                    aria-label={t('conn.editor.busSlot')}
                    value={draft.busId}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, busId: clampBusId(Number(e.target.value)) }))
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 min-w-0 h-[30px] px-1.5 border font-mono tabular-nums text-[12px]"
                  >
                    {Array.from(
                      {
                        length:
                          Math.min(
                            MAX_BUS_ID,
                            Math.max(15, maxUsedBusId + 4, draft.busId + 2),
                          ) + 1,
                      },
                      (_, idx) => (
                        <option key={idx} value={idx}>
                          Bus {idx + 1}
                        </option>
                      ),
                    )}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={MAX_BUS_ID + 1}
                    value={draft.busId + 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (Number.isFinite(val)) {
                        setDraft((p) => ({ ...p, busId: clampBusId(val - 1) }));
                      }
                    }}
                    title="Direct Bus Number (1..256)"
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-14 h-[30px] px-1 border font-mono text-center text-[12px] focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Hardware Driver Family */}
            <div>
              <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                {t('conn.editor.driverFamily')}
              </label>
              <select
                aria-label={t('conn.editor.driverFamily')}
                value={draft.driverFamily}
                onChange={(e) =>
                  handleSelectDriverFamily(e.target.value as DriverFamilyId)
                }
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[30px] px-2 border text-[12px]"
              >
                {DRIVER_FAMILY_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            {/* Live Driver Readiness for Selected Family */}
            {draftDriverStatus &&
              (draftDriverStatus.installed ? (
                <div className="flex items-center justify-between text-[12px] text-[var(--text-secondary)] font-mono">
                  <span>
                    <span className="text-emerald-500 mr-1.5 font-bold">✓</span>
                    {draftDriverStatus.detectedLibraryOrModule ??
                      draftDriverStatus.displayName}
                  </span>
                </div>
              ) : (
                <div
                  style={{
                    backgroundColor: 'var(--bg-row-alt)',
                    borderColor: 'rgba(217, 155, 38, 0.55)',
                  }}
                  className="p-2.5 border text-[12px] space-y-1"
                >
                  <div className="font-semibold text-amber-400">
                    {t('conn.editor.driverNotInstalled', { name: draftDriverStatus.displayName })}
                  </div>
                  <div className="text-[var(--text-secondary)] leading-snug text-[11.5px]">
                    {draftDriverStatus.installHint}
                  </div>
                </div>
              ))}

            {/* ============================================================== */}
            {/* DRIVER-SPECIFIC HARDWARE FIELDS                                */}
            {/* ============================================================== */}
            {draft.driverFamily === 'slcan' && (
              <div
                style={{
                  backgroundColor: 'var(--bg-row-alt)',
                  borderColor: 'var(--border-strong)',
                }}
                className="p-2.5 border space-y-2.5"
              >
                <div className="font-semibold text-sky-500 flex items-center gap-1.5 text-[12px]">
                  <Usb className="w-4 h-4" />
                  <span>{t('conn.editor.slcanConfig')}</span>
                </div>

                {serialPorts.length > 0 && (
                  <div>
                    <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                      {t('conn.editor.detectedPorts')}
                    </label>
                    <select
                      aria-label={t('conn.editor.detectedPorts')}
                      value={
                        serialPorts.some((s) => s.portName === draft.serialPort)
                          ? draft.serialPort
                          : ''
                      }
                      onChange={(e) => {
                        if (e.target.value) {
                          setDraft((p) => ({ ...p, serialPort: e.target.value }));
                        }
                      }}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2 border font-mono text-[12px]"
                    >
                      <option value="">{t('conn.editor.chooseDetectedPort')}</option>
                      {serialPorts.map((sp) => (
                        <option key={sp.portName} value={sp.portName}>
                          {sp.portName}
                          {sp.product ? ` — ${sp.product}` : ''}
                          {sp.vidPid ? ` (${sp.vidPid})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                      {t('conn.editor.serialPortLabel')}
                    </label>
                    <input
                      type="text"
                      value={draft.serialPort}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, serialPort: e.target.value }))
                      }
                      placeholder="COM3 or /dev/ttyUSB0"
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor:
                          draft.serialPort.trim().length === 0
                            ? '#ef4444'
                            : 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2.5 border font-mono text-[12px] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                      {t('conn.editor.uartBaudRate')}
                    </label>
                    <select
                      aria-label={t('conn.editor.uartBaudRate')}
                      value={draft.serialBaudRate}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          serialBaudRate: Number(e.target.value),
                        }))
                      }
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                        color: 'var(--text-primary)',
                      }}
                      className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                    >
                      {SERIAL_BAUD_RATES.map((baud) => (
                        <option key={baud} value={baud}>
                          {baud.toLocaleString('en-US')} bps
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer text-[12px]">
                  <input
                    type="checkbox"
                    checked={draft.serialDtrRts}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, serialDtrRts: e.target.checked }))
                    }
                    className="accent-emerald-600 h-4 w-4"
                  />
                  <span>{t('conn.editor.assertDtrRts')}</span>
                </label>
              </div>
            )}

            {draft.driverFamily === 'pcan' && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.pcanChannel')}
                </label>
                <select
                  aria-label={t('conn.editor.pcanChannel')}
                  value={draft.adapterChannel}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, adapterChannel: e.target.value }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono text-[12px]"
                >
                  {PCAN_ADAPTER_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      {ch}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {draft.driverFamily === 'kvaser' && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.kvaserChannel')}
                </label>
                <select
                  aria-label={t('conn.editor.kvaserChannel')}
                  value={draft.adapterChannel}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, adapterChannel: e.target.value }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                >
                  {KVASER_ADAPTER_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      Kvaser Channel {ch}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(draft.driverFamily === 'socketcan' ||
              draft.driverFamily === 'gs_usb') && (
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {draft.driverFamily === 'socketcan'
                    ? t('conn.editor.socketcanInterface')
                    : t('conn.editor.gsUsbDeviceIndex')}
                </label>
                <input
                  type="text"
                  value={draft.adapterChannel}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, adapterChannel: e.target.value }))
                  }
                  placeholder={draft.driverFamily === 'socketcan' ? 'vcan0' : '0'}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2.5 border font-mono text-[12px] focus:outline-none"
                />
              </div>
            )}

            {draft.driverFamily === 'mock' && (
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                    {t('conn.editor.virtualChannel')}
                  </label>
                  <select
                    aria-label={t('conn.editor.virtualChannel')}
                    value={draft.adapterChannel || 'mock0'}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, adapterChannel: e.target.value }))
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[30px] px-2 border font-mono text-[12px]"
                  >
                    <option value="mock0">{t('conn.editor.mock0Primary')}</option>
                    <option value="mock1">{t('conn.editor.mock1Aux')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                    {t('conn.editor.trafficPacing')}
                  </label>
                  <select
                    aria-label={t('conn.editor.trafficPacing')}
                    value={
                      draft.mockFpsPreset === null
                        ? 'calm'
                        : String(draft.mockFpsPreset)
                    }
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p,
                        mockFpsPreset:
                          e.target.value === 'calm' ? null : Number(e.target.value),
                      }))
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                  >
                    <option value="calm">{t('conn.editor.pacingCalm')}</option>
                    <option value="475">{t('conn.editor.pacingNominal')}</option>
                    <option value="1000">{t('conn.editor.pacingBench1k')}</option>
                    <option value="10000">{t('conn.editor.pacingStress10k')}</option>
                    <option value="25000">{t('conn.editor.pacingStress25k')}</option>
                    <option value="50000">{t('conn.editor.pacingStress50k')}</option>
                  </select>
                </div>
              </div>
            )}

            {/* CAN / CAN-FD Bit Timing */}
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.nominalBitrate')}
                </label>
                <select
                  aria-label={t('conn.editor.nominalBitrate')}
                  value={draft.bitrate}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, bitrate: Number(e.target.value) }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px]"
                >
                  {NOMINAL_BITRATES.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                  {t('conn.editor.fdDataBitrate')}
                </label>
                <select
                  aria-label={t('conn.editor.fdDataBitrate')}
                  disabled={!draft.enableFd || draft.driverFamily === 'slcan'}
                  value={draft.dataBitrate}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, dataBitrate: Number(e.target.value) }))
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[30px] px-2 border font-mono tabular-nums text-[12px] disabled:opacity-50"
                >
                  {DATA_BITRATES_FD.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {draft.driverFamily !== 'slcan' && (
              <label className="flex items-center gap-2 cursor-pointer text-[12px]">
                <input
                  type="checkbox"
                  checked={draft.enableFd}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, enableFd: e.target.checked }))
                  }
                  className="accent-sky-600 h-4 w-4"
                />
                <span>{t('conn.editor.enableCanFd')}</span>
              </label>
            )}

            {/* Safety & Project Auto-Connect */}
            <div
              style={{
                backgroundColor: 'var(--bg-row-alt)',
                borderColor: 'var(--border-grid)',
              }}
              className="p-2.5 border space-y-2 text-[12px]"
            >
              <label className="flex items-center gap-2 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={draft.listenOnly}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, listenOnly: e.target.checked }))
                  }
                  className="accent-emerald-600 h-4 w-4"
                />
                <span>{t('conn.editor.listenOnlySafe')}</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={draft.autoConnectOnProjectLoad}
                  onChange={(e) =>
                    setDraft((p) => ({
                      ...p,
                      autoConnectOnProjectLoad: e.target.checked,
                    }))
                  }
                  className="accent-sky-600 h-4 w-4"
                />
                <span>{t('conn.editor.autoConnect')}</span>
              </label>
            </div>

            {/* Bound signal databases (0..N per connection, applied live) */}
            <div>
              <DatabaseBindingPicker
                selectedIds={draft.databaseIds}
                onChange={(nextIds) => {
                  setDraft((p) => ({ ...p, databaseIds: nextIds }));
                  if (connState.profiles.some((p) => p.id === draft.id)) {
                    connectionStore.setProfileDatabases(draft.id, nextIds);
                  }
                }}
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-[var(--text-secondary)] mb-1 font-medium">
                {t('conn.editor.notes')}
              </label>
              <input
                type="text"
                value={draft.notes}
                onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                placeholder={t('conn.editor.notesPlaceholder')}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[30px] px-2.5 border text-[12px] focus:outline-none"
              />
            </div>
          </div>

          {/* Editor Action Footer */}
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderTop: '1px solid var(--border-strong)',
            }}
            className="shrink-0 p-2.5 flex items-center justify-end gap-2.5"
          >
            <button
              type="button"
              onClick={() => {
                handleSaveDraft();
              }}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[30px] px-3.5 border flex items-center gap-1.5 text-[12px] font-medium hover:border-[var(--text-secondary)] cursor-pointer"
            >
              <Save className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{t('conn.editor.saveProfile')}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleSaveAndConnect()}
              style={{
                backgroundColor: 'rgba(63, 185, 128, 0.16)',
                borderColor: 'rgba(63, 185, 128, 0.65)',
                color: 'var(--text-primary)',
              }}
              className="h-[30px] px-3.5 border flex items-center gap-1.5 text-[12px] font-semibold hover:opacity-90 cursor-pointer"
            >
              <Plug className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t('conn.editor.saveAndConnect')}</span>
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
};
