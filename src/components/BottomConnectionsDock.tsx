import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Unplug } from 'lucide-react';
import { BusStateBadge } from './BusStateBadge';
import { describeTxError } from '../store/busTxControl';
import { useI18n } from '../i18n';
import {
  apiArmActiveBus,
  apiConnectBus,
  apiDisconnectAllBuses,
  apiDisconnectBus,
  apiSetBusMode,
} from '../services/ipcClient';
import {
  type SavedConnectionProfile,
  buildChannelConfigForProfile,
  connectionStore,
  useConnectionStore,
} from '../store/connectionStore';
import { telemetryStore, useTelemetryHeader } from '../store/telemetryStore';
import { workbenchStore, useWorkbenchStore } from '../store/workbenchStore';
import { ensureMockPresetDatabasesLoaded, syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';
import type { BusHealthDto, DeviceDescriptorDto } from '../types/hal';
import type { StatusBanner } from './TopBar';

// ============================================================================
// Interactive Multi-Bus Connections Dock & Classic Desktop Status Footer
// ============================================================================

export interface BottomConnectionsDockProps {
  devices: readonly DeviceDescriptorDto[];
  statusBanner: StatusBanner | null;
  onStatusMessage: (msg: StatusBanner) => void;
}

export const BottomConnectionsDock: React.FC<BottomConnectionsDockProps> = ({
  onStatusMessage,
}) => {
  const { t } = useI18n();
  const header = useTelemetryHeader();
  const connState = useConnectionStore();
  const workbench = useWorkbenchStore();

  const [busyBusIds, setBusyBusIds] = useState<Set<number>>(() => new Set());

  const connectedBusMap = useMemo(() => {
    const map = new Map<number, BusHealthDto>();
    for (const b of header.buses) {
      if (b.connected) {
        map.set(b.busId, b);
      }
    }
    return map;
  }, [header.buses]);

  interface ConnectionRowItem {
    key: string;
    busId: number;
    profile: SavedConnectionProfile | null;
    busHealth: BusHealthDto | null;
    isConnected: boolean;
  }

  const allRows: ConnectionRowItem[] = useMemo(() => {
    const list: ConnectionRowItem[] = connState.profiles.map((prof) => ({
      key: `prof-${prof.id}`,
      busId: prof.busId,
      profile: prof,
      busHealth: connectedBusMap.get(prof.busId) ?? null,
      isConnected: connectedBusMap.has(prof.busId),
    }));

    for (const [busId, busHealth] of connectedBusMap) {
      if (!list.some((r) => r.busId === busId)) {
        list.push({
          key: `bus-${busId}`,
          busId,
          profile: null,
          busHealth,
          isConnected: true,
        });
      }
    }
    list.sort((a, b) => a.busId - b.busId);
    return list;
  }, [connState.profiles, connectedBusMap]);

  const connectedCount = connectedBusMap.size;

  const handleDisconnectBus = async (busId: number): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(busId));
    try {
      await apiDisconnectBus(busId);
      telemetryStore.removeBusHealth(busId);
      onStatusMessage({
        kind: 'info',
        message: t('rxtx.dock.busDisconnected', { bus: busId + 1 }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('rxtx.dock.disconnectError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(busId);
        return next;
      });
    }
  };

  const handleConnectProfile = async (prof: SavedConnectionProfile): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(prof.busId));
    try {
      let effectiveProfile = prof;
      if (prof.driverFamily === 'mock' && prof.databaseIds.length === 0) {
        const presetIds = await ensureMockPresetDatabasesLoaded();
        connectionStore.setProfileDatabases(prof.id, presetIds);
        effectiveProfile = { ...prof, databaseIds: presetIds };
        await syncAllBusDatabasesWithBackend();
      }

      const { deviceId, config } = buildChannelConfigForProfile(effectiveProfile);
      const health = await apiConnectBus(deviceId, config);
      telemetryStore.upsertBusHealth(health);
      onStatusMessage({
        kind: 'success',
        message: t('rxtx.dock.busConnected', {
          bus: prof.busId + 1,
          channel: health.channelName,
          mode: health.listenOnly ? 'Listen-Only' : 'Active CAN',
        }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('rxtx.dock.connectError', {
          name: prof.name,
          error: describeTxError(err),
        }),
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(prof.busId);
        return next;
      });
    }
  };

  const handleDisconnectAll = async (): Promise<void> => {
    try {
      const count = await apiDisconnectAllBuses();
      telemetryStore.clearAllBuses();
      onStatusMessage({
        kind: 'info',
        message: t('rxtx.dock.allBusesDisconnected', { count }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('rxtx.dock.disconnectAllError', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  };

  const handleToggleArmTx = async (busId: number, currentArmed: boolean): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(busId));
    try {
      const updated = await apiArmActiveBus(busId, !currentArmed);
      telemetryStore.upsertBusHealth(updated);
      onStatusMessage({
        kind: !currentArmed ? 'success' : 'info',
        message: !currentArmed
          ? t('rxtx.dock.txArmedMsg', { bus: busId + 1, channel: updated.channelName })
          : t('rxtx.dock.txDisarmedMsg', { bus: busId + 1, channel: updated.channelName }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('rxtx.dock.armTxError', {
          error: describeTxError(err),
        }),
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(busId);
        return next;
      });
    }
  };

  const handleSwitchToActiveTx = async (busId: number): Promise<void> => {
    setBusyBusIds((prev) => new Set(prev).add(busId));
    try {
      const armed = await apiSetBusMode(busId, false, true);
      telemetryStore.upsertBusHealth(armed);
      const prof = connState.profiles.find((p) => p.busId === busId);
      if (prof) {
        connectionStore.upsertProfile({ ...prof, listenOnly: false });
      }
      onStatusMessage({
        kind: 'success',
        message: t('rxtx.dock.switchedActiveTx', { bus: busId + 1, channel: armed.channelName }),
      });
    } catch (err) {
      onStatusMessage({
        kind: 'error',
        message: t('rxtx.dock.switchToActiveTxError', {
          error: describeTxError(err),
        }),
      });
    } finally {
      setBusyBusIds((prev) => {
        const next = new Set(prev);
        next.delete(busId);
        return next;
      });
    }
  };

  // If collapsed, render slim 28px bar
  if (workbench.bottomConnectionsCollapsed) {
    return (
      <footer
        data-tour="connections.dock"
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderTop: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
        className="shrink-0 h-[28px] px-2.5 flex items-center justify-between text-[12px] font-sans select-none"
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => workbenchStore.toggleBottomConnectionsCollapsed()}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            title={t('rxtx.dock.expandTooltip')}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <span
            className={`w-2 h-2 rounded-full ${
              connectedCount > 0 ? 'bg-nominal' : 'bg-muted'
            }`}
          />
          <span className="font-semibold text-[var(--text-primary)]">
            {t('rxtx.dock.titleWithCount', { online: connectedCount, total: allRows.length })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => workbenchStore.setNewConnectionModalOpen(true)}
            className="h-[22px] px-2.5 border border-[var(--border-strong)] bg-[var(--bg-panel)] text-[11px] hover:border-[var(--text-secondary)] cursor-pointer rounded-[2px]"
          >
            {t('rxtx.dock.addConn')}
          </button>
        </div>
      </footer>
    );
  }

  // Expanded Industrial Connections Dock
  return (
    <footer
      data-tour="connections.dock"
      style={{
        backgroundColor: 'var(--bg-panel)',
        borderTop: '1px solid var(--border-strong)',
      }}
      className="shrink-0 select-none flex"
    >
      {/* Left 26px Rotated "Connections" Strip */}
      <div className="pcan-side-strip">
        <span className="pcan-side-strip-label">{t('rxtx.section.connections')}</span>
      </div>

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Upper 34px Toolbar */}
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="min-h-[34px] py-1 px-2.5 flex items-center justify-between text-[12px] flex-wrap gap-2"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => workbenchStore.toggleBottomConnectionsCollapsed()}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              title={t('rxtx.dock.collapseTooltip')}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            <span
              className={`w-2 h-2 rounded-full ${
                connectedCount > 0
                  ? 'bg-nominal shadow-[0_0_6px_var(--status-nominal-border)]'
                  : 'bg-muted'
              }`}
            />
            <span className="font-semibold text-[var(--text-primary)]">
              {t('rxtx.dock.titleWithCount', { online: connectedCount, total: allRows.length })}
            </span>

            <button
              type="button"
              onClick={() => workbenchStore.setNewConnectionModalOpen(true)}
              className="h-[24px] px-2 border border-[var(--status-nominal-border)] bg-[var(--status-nominal-bg)] text-nominal hover:bg-[var(--status-nominal-bg)] text-[11.5px] font-semibold flex items-center gap-1 cursor-pointer rounded-[2px]"
            >
              <Plus className="w-3 h-3" />
              <span>{t('rxtx.dock.addConn')}</span>
            </button>

            {connectedCount > 0 && (
              <button
                type="button"
                onClick={() => void handleDisconnectAll()}
                className="h-[24px] px-2 border border-[var(--status-critical-border)] bg-[var(--status-critical-bg)] text-critical hover:bg-[var(--status-critical-bg)] text-[11.5px] font-medium flex items-center gap-1 cursor-pointer rounded-[2px]"
                title={t('rxtx.dock.disconnectAllTooltip')}
              >
                <Unplug className="w-3 h-3" />
                <span>{t('rxtx.dock.disconnectAll')}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] font-mono">
            <span>{t('rxtx.dock.inspectHint')}</span>
          </div>
        </div>

        {/* Multi-Bus Connections Grid (max-h-[150px] overflow-y-auto) */}
        <div className="max-h-[150px] overflow-y-auto">
          <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
            <colgroup>
              <col style={{ width: '36px' }} />
              <col style={{ width: '56px' }} />
              <col style={{ width: '150px' }} />
              <col />
              <col style={{ width: '120px' }} />
              {/* Databases / Mode / Status sized for their widest content (TR header "Veritabanları",
                  "Switch to TX" button, "ERR-PASSIVE 128/127" badge) incl. the 2×8 px cell padding */}
              <col style={{ width: '104px' }} />
              <col style={{ width: '112px' }} />
              <col style={{ width: '160px' }} />
              <col style={{ width: '50px' }} />
              <col style={{ width: '120px' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="text-center font-sans" title="On / Off">
                  {t('rxtx.dock.colOn')}
                </th>
                <th>{t('rxtx.dock.colBus')}</th>
                <th className="font-sans">{t('rxtx.dock.colName')}</th>
                <th className="font-sans">{t('rxtx.dock.colHardware')}</th>
                <th className="font-sans">{t('rxtx.dock.colBitRate')}</th>
                <th className="font-sans text-center">{t('rxtx.dock.colDatabases')}</th>
                <th className="font-sans">{t('rxtx.dock.colMode')}</th>
                <th className="font-sans">{t('rxtx.dock.colStatus')}</th>
                <th className="text-right">{t('rxtx.dock.colOvr')}</th>
                <th className="font-sans">{t('rxtx.dock.colBusLoad')}</th>
              </tr>
            </thead>
            <tbody>
              {allRows.map((row) => {
                const isBusy = busyBusIds.has(row.busId);
                const prof = row.profile;
                const bus = row.busHealth;
                const isMock =
                  prof?.driverFamily === 'mock' ||
                  bus?.channelName.toLowerCase().includes('mock');

                const bitRateLabel = isMock
                  ? prof?.mockFpsPreset === null
                    ? '500k/2M FD · 16 msg/s'
                    : `500k/2M FD · ${prof?.mockFpsPreset} msg/s`
                  : prof?.enableFd
                    ? `${Math.round((prof.bitrate ?? 500000) / 1000)}k/${Math.round((prof.dataBitrate ?? 2000000) / 1000000)}M FD`
                    : `${Math.round((prof?.bitrate ?? 500000) / 1000)}k CC`;

                const hardwareLabel = prof
                  ? `${prof.driverFamily.toUpperCase()} · ${prof.adapterChannel || prof.serialPort || 'Ch0'}`
                  : bus?.channelName ?? 'CAN Channel';

                const busLoadPct = row.isConnected ? header.estimatedBusLoadPct : 0;
                const dbCount = prof?.databaseIds.length ?? 0;

                return (
                  <tr
                    key={row.key}
                    onClick={() => {
                      if (prof) {
                        connectionStore.selectProfile(prof.id);
                        workbenchStore.setSelection({ kind: 'connection', profileId: prof.id });
                      }
                    }}
                    className={`hover:!bg-[var(--bg-row-hover)] cursor-pointer text-[11px] ${
                      row.isConnected ? '' : 'opacity-70'
                    }`}
                  >
                    {/* 1. On / Off Checkbox */}
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="pcan-cell pcan-cell-center">
                        <input
                          type="checkbox"
                          checked={row.isConnected}
                          disabled={isBusy || (!row.isConnected && !prof)}
                          onChange={() => {
                            if (row.isConnected) {
                              void handleDisconnectBus(row.busId);
                            } else if (prof) {
                              void handleConnectProfile(prof);
                            }
                          }}
                          className="accent-nominal cursor-pointer"
                          title={
                            row.isConnected
                              ? t('rxtx.dock.connectedTooltip', { bus: row.busId + 1 })
                              : t('rxtx.dock.offlineTooltip', {
                                  bus: row.busId + 1,
                                  name: prof?.name ?? '',
                                })
                          }
                        />
                      </div>
                    </td>

                    {/* 2. Bus ID */}
                    <td>
                      <div className="pcan-cell font-semibold text-[var(--text-primary)]">
                        Bus {row.busId + 1}
                      </div>
                    </td>

                    {/* 3. Name */}
                    <td>
                      <div className="pcan-cell font-sans font-medium truncate" title={prof?.name ?? bus?.channelName}>
                        {prof?.name ?? bus?.channelName ?? `Bus ${row.busId + 1}`}
                      </div>
                    </td>

                    {/* 4. Net / Hardware */}
                    <td>
                      <div className="pcan-cell text-[10px] text-[var(--text-secondary)] truncate" title={hardwareLabel}>
                        {hardwareLabel}
                      </div>
                    </td>

                    {/* 5. Bit Rate */}
                    <td>
                      <div className="pcan-cell text-[10px]">
                        <span className="truncate">{bitRateLabel}</span>
                      </div>
                    </td>

                    {/* 6. Databases Badge */}
                    <td
                      onClick={(e) => {
                        e.stopPropagation();
                        if (prof) {
                          connectionStore.selectProfile(prof.id);
                          workbenchStore.setSelection({ kind: 'connection', profileId: prof.id });
                        }
                      }}
                    >
                      <div className="pcan-cell pcan-cell-center font-sans">
                        <span
                          className={`px-1.5 rounded text-[10px] font-mono cursor-pointer whitespace-nowrap hover:opacity-80 ${
                            dbCount > 0
                              ? 'bg-[var(--status-focus-bg)] border border-[var(--status-focus-border)] text-focus'
                              : 'bg-panel border border-strong text-muted'
                          }`}
                          title={t('rxtx.dock.dbBadgeTooltip', { count: dbCount })}
                        >
                          {dbCount} DBC
                        </span>
                      </div>
                    </td>

                    {/* 7. Mode */}
                    <td>
                      <div className="pcan-cell font-sans" onClick={(e) => e.stopPropagation()}>
                        {row.isConnected && bus ? (
                          bus.listenOnly ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleSwitchToActiveTx(bus.busId)}
                              style={{
                                backgroundColor: 'var(--status-warn-bg)',
                                borderColor: 'var(--status-warn-border)',
                                color: 'var(--status-warn)',
                              }}
                              className="h-[18px] max-w-full truncate px-1.5 border text-[10px] font-semibold hover:border-warn cursor-pointer rounded-[1px]"
                              title="Click to Switch to Active TX Armed"
                            >
                              {t('rxtx.dock.switchToTx')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleToggleArmTx(bus.busId, Boolean(bus.txArmed))}
                              style={{
                                backgroundColor: bus.txArmed
                                  ? 'var(--status-warn-bg)'
                                  : 'var(--bg-panel)',
                                borderColor: bus.txArmed ? 'var(--status-warn)' : 'var(--border-strong)',
                                color: bus.txArmed ? 'var(--status-warn)' : 'var(--text-muted)',
                              }}
                              className="h-[18px] max-w-full truncate px-1.5 border text-[10px] font-semibold cursor-pointer rounded-[1px]"
                              title="Click to toggle TX Armed / Disarmed"
                            >
                              {bus.txArmed ? t('rxtx.dock.txArmed') : t('rxtx.dock.txDisarmed')}
                            </button>
                          )
                        ) : (
                          <span className="text-[10px] text-[var(--text-muted)] font-mono">
                            {prof?.listenOnly ? t('rxtx.dock.listen') : t('rxtx.dock.active')}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* 8. Status */}
                    <td>
                      <div className="pcan-cell">
                        {row.isConnected && bus ? (
                          <BusStateBadge
                            busState={bus.busState}
                            connected={bus.connected}
                            txErrorCount={bus.txErrorCount}
                            rxErrorCount={bus.rxErrorCount}
                            showTecRec
                            compact
                            className="max-w-full min-w-0 overflow-hidden"
                          />
                        ) : (
                          <span className="text-[10px] text-[var(--text-muted)] font-mono">
                            {t('rxtx.dock.offline')}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* 9. Overruns */}
                    <td>
                      <div
                        className={`pcan-cell pcan-cell-right ${
                          row.isConnected && header.droppedFrames > 0
                            ? 'text-critical font-bold'
                            : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {row.isConnected ? header.droppedFrames : '—'}
                      </div>
                    </td>

                    {/* 10. Bus Load Bar (pcanex7.png style) */}
                    <td>
                      <div className="pcan-cell">
                        {row.isConnected ? (
                          <div className="flex items-center gap-1.5 w-full pr-1 font-mono text-[10px] tabular-nums">
                            <div className="flex-1 h-[7px] bg-elevated border border-strong rounded-[1px] overflow-hidden">
                              <div
                                style={{ width: `${Math.min(100, Math.max(0, busLoadPct))}%` }}
                                className={`h-full ${
                                  busLoadPct > 80
                                    ? 'bg-critical'
                                    : busLoadPct > 50
                                      ? 'bg-warn'
                                      : 'bg-nominal'
                                }`}
                              />
                            </div>
                            <span className="inline-block w-[6ch] text-right font-mono tabular-nums text-[10px] text-[var(--text-secondary)] shrink-0">
                              {busLoadPct.toFixed(1)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-[var(--text-muted)] font-mono">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </footer>
  );
};
