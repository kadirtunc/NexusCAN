import React, { useMemo, useState } from 'react';
import { Plug, Save, X } from 'lucide-react';
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
import { apiArmActiveBus, apiConnectBus } from '../services/ipcClient';
import { telemetryStore } from '../store/telemetryStore';
import type { DeviceDescriptorDto, DriverFamilyId } from '../types/hal';
import type { StatusBanner } from './TopBar';
import { DatabaseBindingPicker } from './DatabaseBindingPicker';
import { databaseStore } from '../store/databaseStore';
import { ensureMockPresetDatabasesLoaded, syncAllBusDatabasesWithBackend } from '../utils/busDatabaseSync';

interface NewConnectionModalProps {
  devices: readonly DeviceDescriptorDto[];
  onClose: () => void;
  onStatusMessage?: (msg: StatusBanner) => void;
}

const DRIVER_OPTIONS: readonly { id: DriverFamilyId; label: string }[] = [
  { id: 'socketcan', label: 'Linux Native SocketCAN (can* / vcan*)' },
  { id: 'gs_usb', label: 'USB-CAN gs_usb / candleLight (CANable / CANtact)' },
  { id: 'slcan', label: 'Serial Lawicel SLCAN (USB-CDC / COM)' },
  { id: 'pcan', label: 'PEAK-System PCAN-Basic (PCAN_USBBUS1..8)' },
  { id: 'kvaser', label: 'Kvaser CANlib (0..7)' },
  { id: 'mock', label: 'Virtual Simulator (mock0 / mock1) [Test Only]' },
];

export const NewConnectionModal: React.FC<NewConnectionModalProps> = ({
  devices,
  onClose,
  onStatusMessage,
}) => {
  const connState = useConnectionStore();

  // Find next free busId (0..255)
  const usedBuses = useMemo(() => new Set(connState.profiles.map((p) => p.busId)), [connState.profiles]);
  const maxUsedBusId = useMemo(
    () => connState.profiles.reduce((max, p) => Math.max(max, p.busId), 0),
    [connState.profiles],
  );
  const initialBusId = findNextFreeBusId(connState.profiles);

  const detectedSocketCan = devices.find((d) => d.driverId === 'socketcan');
  const isLinux = connState.probeReport?.hostOs === 'linux';
  const hasSocketCan = Boolean(detectedSocketCan) || isLinux;
  const initialFamily: DriverFamilyId = hasSocketCan
    ? 'socketcan'
    : (connState.probeReport?.serialPorts?.length ?? 0) > 0
      ? 'slcan'
      : 'pcan';
  const initialChannel: string = hasSocketCan
    ? (detectedSocketCan?.channelName || 'vcan0')
    : initialFamily === 'slcan'
      ? 'slcan0'
      : PCAN_ADAPTER_CHANNELS[0];
  const initialName = hasSocketCan
    ? `SocketCAN (${initialChannel})`
    : `Bus ${initialBusId + 1} (${initialFamily})`;

  const [busId, setBusId] = useState<number>(initialBusId);
  const [name, setName] = useState<string>(initialName);
  const [driverFamily, setDriverFamily] = useState<DriverFamilyId>(initialFamily);
  const [adapterChannel, setAdapterChannel] = useState<string>(initialChannel);
  const [serialPort, setSerialPort] = useState<string>(
    connState.probeReport?.serialPorts[0]?.portName ?? 'COM3',
  );
  const [serialBaudRate, setSerialBaudRate] = useState<number>(1_000_000);
  const [bitrate, setBitrate] = useState<number>(500_000);
  const [enableFd, setEnableFd] = useState<boolean>(true);
  const [dataBitrate, setDataBitrate] = useState<number>(2_000_000);
  const [listenOnly, setListenOnly] = useState<boolean>(true);
  const [mockFpsPreset, setMockFpsPreset] = useState<number | null>(null);
  const [notes, setNotes] = useState<string>('');
  const [databaseIds, setDatabaseIds] = useState<string[]>(() =>
    databaseStore.getState().databases.map((d) => d.id),
  );
  const [busy, setBusy] = useState<boolean>(false);

  const handleFamilyChange = (fam: DriverFamilyId): void => {
    setDriverFamily(fam);
    if (fam === 'socketcan') {
      const ch = detectedSocketCan?.channelName || 'vcan0';
      setAdapterChannel(ch);
      setName(`SocketCAN (${ch})`);
      setEnableFd(true);
    } else if (fam === 'gs_usb') {
      setAdapterChannel('0');
      setName(`USB-CAN gs_usb (ch0)`);
      setEnableFd(true);
    } else if (fam === 'slcan') {
      setEnableFd(false);
      setAdapterChannel('slcan0');
      const firstPort = connState.probeReport?.serialPorts[0]?.portName ?? 'COM3';
      setSerialPort(firstPort);
      setName(`SLCAN (${firstPort})`);
    } else if (fam === 'pcan') {
      setAdapterChannel(PCAN_ADAPTER_CHANNELS[0]);
      setName(`PCAN (${PCAN_ADAPTER_CHANNELS[0]})`);
      setEnableFd(true);
    } else if (fam === 'kvaser') {
      setAdapterChannel('0');
      setName(`Kvaser CANlib (ch0)`);
      setEnableFd(false);
    } else if (fam === 'mock') {
      setAdapterChannel('mock0');
      setName(`Simulator (mock0)`);
      setEnableFd(true);
      void ensureMockPresetDatabasesLoaded().then((presetIds) => {
        setDatabaseIds((prev) => Array.from(new Set([...prev, ...presetIds])));
      });
    }
  };

  const buildProfile = (explicitDbIds?: string[]): SavedConnectionProfile => {
    const raw: SavedConnectionProfile = {
      id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || `Bus ${busId + 1} (${driverFamily})`,
      busId,
      driverFamily,
      deviceId: '',
      adapterChannel: adapterChannel.trim(),
      serialPort: serialPort.trim(),
      serialBaudRate,
      serialDtrRts: true,
      bitrateProfileId: enableFd ? 'fd_500k_2m' : 'can_500k',
      bitrate,
      enableFd: driverFamily === 'slcan' ? false : enableFd,
      dataBitrate,
      listenOnly,
      mockFpsPreset: driverFamily === 'mock' ? mockFpsPreset : null,
      autoConnectOnProjectLoad: false,
      notes: notes.trim(),
      databaseIds: explicitDbIds ? [...explicitDbIds] : [...databaseIds],
    };
    raw.deviceId = resolveDeviceIdForProfile(raw);
    return raw;
  };

  const handleSaveOnly = async (): Promise<void> => {
    let effectiveDbIds = [...databaseIds];
    if (driverFamily === 'mock' && effectiveDbIds.length === 0) {
      effectiveDbIds = await ensureMockPresetDatabasesLoaded();
    }
    const prof = buildProfile(effectiveDbIds);
    connectionStore.upsertProfile(prof);
    void syncAllBusDatabasesWithBackend();
    onStatusMessage?.({
      kind: 'success',
      message: `Created connection profile "${prof.name}" (Bus ${prof.busId + 1}).`,
    });
    onClose();
  };

  const handleSaveAndConnect = async (): Promise<void> => {
    setBusy(true);
    try {
      let effectiveDbIds = [...databaseIds];
      if (driverFamily === 'mock' && effectiveDbIds.length === 0) {
        effectiveDbIds = await ensureMockPresetDatabasesLoaded();
      }
      const prof = buildProfile(effectiveDbIds);
      connectionStore.upsertProfile(prof);
      await syncAllBusDatabasesWithBackend();
      const { deviceId, config } = buildChannelConfigForProfile(prof);
      const health = await apiConnectBus(deviceId, config);
      if (!prof.listenOnly) {
        const armed = await apiArmActiveBus(prof.busId, true);
        telemetryStore.upsertBusHealth(armed);
        onStatusMessage?.({
          kind: 'success',
          message: `Connected & Armed TX on Bus ${prof.busId + 1} (${armed.channelName}).`,
        });
      } else {
        telemetryStore.upsertBusHealth(health);
        onStatusMessage?.({
          kind: 'success',
          message: `Connected Bus ${prof.busId + 1} (${health.channelName}) in Listen-Only mode.`,
        });
      }
      onClose();
    } catch (err) {
      onStatusMessage?.({
        kind: 'error',
        message: `Failed to connect Bus ${busId + 1}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
        className="w-full max-w-[560px] border shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="h-[32px] px-3 flex items-center justify-between text-[12px] font-semibold"
        >
          <div className="flex items-center gap-2">
            <Plug className="w-3.5 h-3.5 text-emerald-500" />
            <span>New CAN / CAN-FD Connection</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-3.5 space-y-3 text-[12px]">
          {/* Row 1: Bus Slot + Profile Name */}
          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Bus Channel Slot
              </label>
              <div className="flex items-center gap-1.5">
                <select
                  value={busId}
                  onChange={(e) => {
                    const b = clampBusId(Number(e.target.value));
                    setBusId(b);
                    setName(`Bus ${b + 1} Connection`);
                  }}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="flex-1 min-w-0 h-[26px] px-2 border text-[11px] font-mono focus:outline-none"
                >
                  {Array.from(
                    {
                      length:
                        Math.min(
                          MAX_BUS_ID,
                          Math.max(15, maxUsedBusId + 4, busId + 2),
                        ) + 1,
                    },
                    (_, b) => (
                      <option key={b} value={b}>
                        Bus {b + 1} {usedBuses.has(b) ? '(Configured)' : '(Free)'}
                      </option>
                    ),
                  )}
                </select>
                <input
                  type="number"
                  min={1}
                  max={MAX_BUS_ID + 1}
                  value={busId + 1}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (Number.isFinite(val)) {
                      const b = clampBusId(val - 1);
                      setBusId(b);
                      setName(`Bus ${b + 1} Connection`);
                    }
                  }}
                  title="Direct Bus Number (1..256)"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-14 h-[26px] px-1.5 border text-[11px] font-mono text-center focus:outline-none"
                />
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Connection Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="EV Powertrain CAN"
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[26px] px-2 border text-[12px] focus:outline-none"
              />
            </div>
          </div>

          {/* Row 2: Driver Family & Port */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Driver Family
              </label>
              <select
                value={driverFamily}
                onChange={(e) => handleFamilyChange(e.target.value as DriverFamilyId)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[26px] px-2 border text-[11px] focus:outline-none"
              >
                {DRIVER_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                {driverFamily === 'slcan'
                  ? 'Serial Port (COMx / /dev/ttyUSBx)'
                  : driverFamily === 'pcan'
                    ? 'PCAN Channel'
                    : driverFamily === 'kvaser'
                      ? 'Kvaser Channel'
                      : driverFamily === 'socketcan'
                        ? 'Interface Name'
                        : 'Channel / Device'}
              </label>

              {driverFamily === 'slcan' ? (
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    placeholder="COM3 or /dev/ttyUSB0"
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="flex-1 h-[26px] px-2 border text-[11px] font-mono focus:outline-none"
                  />
                  <select
                    value={serialBaudRate}
                    onChange={(e) => setSerialBaudRate(Number(e.target.value))}
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="h-[26px] px-1 border text-[10px] font-mono focus:outline-none"
                  >
                    {SERIAL_BAUD_RATES.map((br) => (
                      <option key={br} value={br}>
                        {Math.round(br / 1000)}k
                      </option>
                    ))}
                  </select>
                </div>
              ) : driverFamily === 'pcan' ? (
                <select
                  value={adapterChannel}
                  onChange={(e) => setAdapterChannel(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[26px] px-2 border text-[11px] font-mono focus:outline-none"
                >
                  {PCAN_ADAPTER_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      {ch}
                    </option>
                  ))}
                </select>
              ) : driverFamily === 'kvaser' ? (
                <select
                  value={adapterChannel}
                  onChange={(e) => setAdapterChannel(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[26px] px-2 border text-[11px] font-mono focus:outline-none"
                >
                  {KVASER_ADAPTER_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      Channel {ch}
                    </option>
                  ))}
                </select>
              ) : (
                <div>
                  <input
                    type="text"
                    value={adapterChannel}
                    onChange={(e) => setAdapterChannel(e.target.value)}
                    placeholder={
                      driverFamily === 'socketcan'
                        ? 'vcan0 or can0'
                        : driverFamily === 'mock'
                          ? 'mock0'
                          : '0'
                    }
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--text-primary)',
                    }}
                    className="w-full h-[26px] px-2 border text-[11px] font-mono focus:outline-none"
                  />
                  {driverFamily === 'socketcan' && (
                    <div className="flex flex-wrap items-center gap-1 mt-1 text-[10px] font-mono">
                      <span className="text-[var(--text-muted)] text-[9px]">Quick:</span>
                      {Array.from(
                        new Set([
                          'vcan0',
                          'can0',
                          ...devices
                            .filter((d) => d.driverId === 'socketcan')
                            .map((d) => d.channelName),
                        ]),
                      ).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => {
                            setAdapterChannel(opt);
                            setName((prev) =>
                              prev.startsWith('SocketCAN') || prev.startsWith('Bus')
                                ? `SocketCAN (${opt})`
                                : prev,
                            );
                          }}
                          className={`px-1.5 py-0.2 border rounded cursor-pointer ${
                            adapterChannel === opt
                              ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300 font-bold'
                              : 'bg-[var(--bg-panel)] border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Row 3: Bitrate & CAN-FD settings */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Nominal Bitrate
              </label>
              <select
                value={bitrate}
                onChange={(e) => setBitrate(Number(e.target.value))}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                className="w-full h-[26px] px-2 border text-[11px] font-mono tabular-nums focus:outline-none"
              >
                {NOMINAL_BITRATES.map((nb) => (
                  <option key={nb.value} value={nb.value}>
                    {nb.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                FD Data Bitrate
              </label>
              <div className="flex items-center gap-1.5">
                <label className="inline-flex items-center gap-1 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableFd && driverFamily !== 'slcan'}
                    disabled={driverFamily === 'slcan'}
                    onChange={(e) => setEnableFd(e.target.checked)}
                    className="accent-emerald-600 cursor-pointer"
                  />
                  <span>FD</span>
                </label>
                <select
                  value={dataBitrate}
                  disabled={!enableFd || driverFamily === 'slcan'}
                  onChange={(e) => setDataBitrate(Number(e.target.value))}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="flex-1 h-[26px] px-2 border text-[11px] font-mono tabular-nums focus:outline-none disabled:opacity-50"
                >
                  {DATA_BITRATES_FD.map((db) => (
                    <option key={db.value} value={db.value}>
                      {db.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Row 4: Mock Pacing & Bus Mode (Listen-Only vs Active) */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                Safety Mode
              </label>
              <div
                style={{ borderColor: 'var(--border-strong)' }}
                className="h-[26px] border flex overflow-hidden rounded-sm"
              >
                <button
                  type="button"
                  onClick={() => setListenOnly(true)}
                  style={{
                    backgroundColor: listenOnly ? 'var(--bg-header)' : 'var(--bg-input)',
                    color: listenOnly ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                  className="flex-1 h-full text-[11px] font-medium cursor-pointer"
                >
                  Listen-Only (Safe)
                </button>
                <button
                  type="button"
                  onClick={() => setListenOnly(false)}
                  style={{
                    backgroundColor: !listenOnly
                      ? 'rgba(217, 155, 38, 0.20)'
                      : 'var(--bg-input)',
                    color: !listenOnly ? '#E3B341' : 'var(--text-muted)',
                    borderLeft: '1px solid var(--border-strong)',
                  }}
                  className="flex-1 h-full text-[11px] font-medium cursor-pointer"
                >
                  Active TX / ACK
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                {driverFamily === 'mock' ? 'Mock Traffic Pacing' : 'Notes'}
              </label>
              {driverFamily === 'mock' ? (
                <select
                  value={mockFpsPreset === null ? 'calm' : String(mockFpsPreset)}
                  onChange={(e) =>
                    setMockFpsPreset(
                      e.target.value === 'calm' ? null : Number(e.target.value),
                    )
                  }
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[26px] px-2 border text-[11px] font-mono tabular-nums focus:outline-none"
                >
                  <option value="calm">16 msg/s (Default Realistic)</option>
                  <option value="475">475 msg/s (Nominal Timers)</option>
                  <option value="1000">1k msg/s</option>
                  <option value="10000">10k msg/s</option>
                  <option value="25000">25k msg/s</option>
                  <option value="50000">50k msg/s (Stress)</option>
                </select>
              ) : (
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional channel notes..."
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-primary)',
                  }}
                  className="w-full h-[26px] px-2 border text-[11px] focus:outline-none"
                />
              )}
            </div>
          </div>

          <div className="mt-3">
            <DatabaseBindingPicker
              selectedIds={databaseIds}
              onChange={setDatabaseIds}
              disabled={busy}
            />
          </div>
        </div>

        {/* Footer Actions */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderTop: '1px solid var(--border-strong)',
          }}
          className="h-[42px] px-3.5 flex items-center justify-between"
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
            }}
            className="h-[26px] px-3 border text-[11px] hover:text-[var(--text-primary)] cursor-pointer"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleSaveOnly}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[26px] px-3 border flex items-center gap-1.5 text-[11px] font-medium hover:border-[var(--text-secondary)] cursor-pointer"
            >
              <Save className="w-3 h-3 text-[var(--text-secondary)]" />
              <span>Save Profile</span>
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSaveAndConnect()}
              style={{
                backgroundColor: 'rgba(63, 185, 128, 0.18)',
                borderColor: 'rgba(63, 185, 128, 0.65)',
                color: 'var(--text-primary)',
              }}
              className="h-[26px] px-3.5 border flex items-center gap-1.5 text-[11px] font-semibold hover:opacity-90 cursor-pointer"
            >
              <Plug className="w-3 h-3 text-emerald-500" />
              <span>Save & Connect</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
