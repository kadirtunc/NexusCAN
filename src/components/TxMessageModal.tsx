import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useDatabaseStore } from '../store/databaseStore';
import { MAX_BUS_ID, useConnectionStore } from '../store/connectionStore';
import type { TxEntryMode, TxListEntry } from '../store/transmitStore';
import type { MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import {
  formatByteHex,
  formatPcanIdHex,
  previewPackSymbolicBytes,
} from '../utils/formatters';
import { resolveMuxChainFromSignalValues } from '../utils/muxFormat';

interface TxMessageModalProps {
  initialEntry: TxListEntry | null;
  defaultBusId?: number;
  onClose: () => void;
  onSave: (entry: TxListEntry) => void;
}

const CAN_FD_DLCS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
const CC_DLCS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export const TxMessageModal: React.FC<TxMessageModalProps> = ({
  initialEntry,
  defaultBusId,
  onClose,
  onSave,
}) => {
  const dbState = useDatabaseStore();
  const [busId, setBusId] = useState<number>(initialEntry?.busId ?? defaultBusId ?? 0);

  // Symbols come ONLY from the databases bound to the selected bus (no global "active" database)
  const busLookup = dbState.busSchemas.get(busId);
  const messages = useMemo(() => busLookup?.schema.messages ?? [], [busLookup]);
  const messagesByKey = useMemo(
    () => busLookup?.messagesByKey ?? new Map<string, MessageSchemaDto>(),
    [busLookup],
  );
  const signalsById: readonly (SignalSchemaDto | undefined)[] = useMemo(
    () => busLookup?.signalsById ?? [],
    [busLookup],
  );

  const connState = useConnectionStore();
  const busOptions = useMemo(() => {
    let maxBus = Math.max(7, busId);
    for (const p of connState.profiles) {
      if (p.busId > maxBus) maxBus = p.busId;
    }
    for (const b of dbState.busSchemas.keys()) {
      if (b > maxBus) maxBus = b;
    }
    const maxBusId = Math.min(MAX_BUS_ID, maxBus);

    const out: { busId: number; label: string }[] = [];
    for (let b = 0; b <= maxBusId; b++) {
      const prof = connState.profiles.find((p) => p.busId === b);
      const dbCount = dbState.busSchemas.get(b) ? ' · DB' : '';
      out.push({
        busId: b,
        label: prof ? `${b + 1} · ${prof.name}${dbCount}` : `${b + 1} (Bus ${b})`,
      });
    }
    return out;
  }, [connState.profiles, dbState.busSchemas, busId]);

  const [mode, setMode] = useState<TxEntryMode>(() => {
    if (initialEntry) return initialEntry.mode;
    return messages.length > 0 ? 'symbolic' : 'raw';
  });

  const [selectedMsgKey, setSelectedMsgKey] = useState<string>(() => {
    if (initialEntry?.messageKey && messagesByKey.has(initialEntry.messageKey)) {
      return initialEntry.messageKey;
    }
    return messages[0]?.messageKey ?? '';
  });

  // Raw frame state
  const [arbIdHex, setArbIdHex] = useState<string>(() =>
    initialEntry ? formatPcanIdHex(initialEntry.arbId, initialEntry.isExtended) : '100',
  );
  const [isExtended, setIsExtended] = useState<boolean>(initialEntry?.isExtended ?? false);
  const [isFd, setIsFd] = useState<boolean>(initialEntry?.isFd ?? false);
  const [isBrs, setIsBrs] = useState<boolean>(initialEntry?.isBrs ?? false);
  const [dlc, setDlc] = useState<number>(initialEntry?.dlc ?? 8);
  const [rawByteInputs, setRawByteInputs] = useState<string[]>(() => {
    const base = initialEntry?.rawBytes ?? new Array<number>(8).fill(0);
    return Array.from({ length: 64 }, (_, idx) => formatByteHex(base[idx] ?? 0));
  });

  // Symbolic signal values state
  const [signalDrafts, setSignalDrafts] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    if (initialEntry) {
      for (const [k, v] of Object.entries(initialEntry.signalValues)) {
        out[Number(k)] = String(v);
      }
    }
    return out;
  });

  const [cycleTimeStr, setCycleTimeStr] = useState<string>(
    String(initialEntry?.cycleTimeMs ?? 0),
  );
  const [comment, setComment] = useState<string>(initialEntry?.comment ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyCapture = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    return () => window.removeEventListener('keydown', onKeyCapture, true);
  }, [onClose]);

  const selectedMessage: MessageSchemaDto | undefined = useMemo(() => {
    if (!selectedMsgKey) return messages[0];
    return messagesByKey.get(selectedMsgKey) ?? messages[0];
  }, [selectedMsgKey, messagesByKey, messages]);

  // Re-target the message picker when the user switches the destination bus
  useEffect(() => {
    if (selectedMsgKey && messagesByKey.has(selectedMsgKey)) return;
    setSelectedMsgKey(messages[0]?.messageKey ?? '');
  }, [messages, messagesByKey, selectedMsgKey]);

  // Populate default signal values when switching symbolic message
  useEffect(() => {
    if (mode !== 'symbolic' || !selectedMessage) return;
    setSignalDrafts((prev) => {
      const next: Record<number, string> = { ...prev };
      for (const sigId of selectedMessage.signalIds) {
        if (next[sigId] === undefined) {
          const sig = signalsById[sigId];
          if (sig) {
            const def =
              sig.initialValue !== null && Number.isFinite(sig.initialValue)
                ? sig.initialValue
                : sig.max > sig.min
                  ? Math.max(sig.min, Math.min(sig.max, 0))
                  : 0;
            next[sigId] = String(def);
          }
        }
      }
      return next;
    });
  }, [mode, selectedMessage, signalsById]);

  const numericSignalMap = useMemo(() => {
    const map: Record<number, number> = {};
    for (const [k, str] of Object.entries(signalDrafts)) {
      const n = Number(str);
      map[Number(k)] = Number.isFinite(n) ? n : 0;
    }
    return map;
  }, [signalDrafts]);

  const muxResolution = useMemo(() => {
    if (!selectedMessage) return null;
    return resolveMuxChainFromSignalValues(selectedMessage, signalsById, numericSignalMap);
  }, [selectedMessage, signalsById, numericSignalMap]);

  // Determine active mux branch signals for symbolic mode using recursive cascaded mux engine
  const activeSymbolicSignals: readonly SignalSchemaDto[] = useMemo(() => {
    if (!selectedMessage || !muxResolution) return [];
    const result: SignalSchemaDto[] = [];
    for (const sigId of selectedMessage.signalIds) {
      if (muxResolution.activeSignalIds.has(sigId)) {
        const s = signalsById[sigId];
        if (s) {
          result.push(s);
        }
      }
    }
    return result;
  }, [selectedMessage, muxResolution, signalsById]);

  const symbolicPreviewBytes = useMemo(() => {
    if (!selectedMessage) return [];
    return previewPackSymbolicBytes(
      selectedMessage,
      signalsById,
      numericSignalMap,
    );
  }, [selectedMessage, signalsById, numericSignalMap]);

  const handleSubmit = (ev: React.FormEvent): void => {
    ev.preventDefault();
    setValidationError(null);

    const parsedCycle = Math.max(0, Math.round(Number(cycleTimeStr) || 0));
    const entryId =
      initialEntry?.id ?? `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    if (mode === 'symbolic') {
      if (!selectedMessage) {
        setValidationError(`Bus ${busId + 1} has no .dbc/.kcd bound. Switch to Raw Mode or bind a database in Connections / Databases.`);
        return;
      }

      const msgIsFd =
        selectedMessage.protocol.toUpperCase().includes('FD') || selectedMessage.dlc > 8;

      const saved: TxListEntry = {
        id: entryId,
        busId,
        mode: 'symbolic',
        messageKey: selectedMessage.messageKey,
        arbId: selectedMessage.arbId,
        isExtended: selectedMessage.isExtended,
        isFd: msgIsFd,
        isBrs: msgIsFd,
        dlc: selectedMessage.dlc,
        symbolName: muxResolution ? muxResolution.formatted.fullSymbol : selectedMessage.name,
        rawBytes: symbolicPreviewBytes,
        signalValues: numericSignalMap,
        cycleTimeMs: parsedCycle,
        periodicEnabled: initialEntry?.periodicEnabled ?? false,
        backendJobId: initialEntry?.backendJobId ?? null,
        manualSentCount: initialEntry?.manualSentCount ?? 0,
        periodicSentCount: initialEntry?.periodicSentCount ?? 0,
        creator: 'User',
        comment: comment.trim(),
      };
      onSave(saved);
      return;
    }

    // Raw mode validation
    const cleanHex = arbIdHex.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{1,8}$/.test(cleanHex)) {
      setValidationError('Invalid CAN-ID hex (enter e.g. 101 or 18FF50E5).');
      return;
    }
    const parsedArbId = parseInt(cleanHex, 16);
    const maxArb = isExtended ? 0x1fffffff : 0x7ff;
    if (parsedArbId > maxArb) {
      setValidationError(
        isExtended
          ? 'Extended 29-bit CAN-ID cannot exceed 1FFFFFFF.'
          : 'Standard 11-bit CAN-ID cannot exceed 7FF (check Extended 29-bit for larger IDs).',
      );
      return;
    }

    const effectiveDlc = isFd ? dlc : Math.min(8, dlc);
    const bytes: number[] = [];
    for (let i = 0; i < effectiveDlc; i++) {
      const bStr = (rawByteInputs[i] ?? '00').trim();
      const bVal = /^[0-9a-fA-F]{1,2}$/.test(bStr) ? parseInt(bStr, 16) : 0;
      bytes.push(bVal & 0xff);
    }

    const matchedDbMsg = messages.find(
      (m) => m.arbId === parsedArbId && m.isExtended === isExtended,
    );

    const saved: TxListEntry = {
      id: entryId,
      busId,
      mode: 'raw',
      messageKey: matchedDbMsg?.messageKey ?? null,
      arbId: parsedArbId,
      isExtended,
      isFd,
      isBrs: isFd && isBrs,
      dlc: effectiveDlc,
      symbolName: matchedDbMsg?.name ?? '',
      rawBytes: bytes,
      signalValues: {},
      cycleTimeMs: parsedCycle,
      periodicEnabled: initialEntry?.periodicEnabled ?? false,
      backendJobId: initialEntry?.backendJobId ?? null,
      manualSentCount: initialEntry?.manualSentCount ?? 0,
      periodicSentCount: initialEntry?.periodicSentCount ?? 0,
      creator: 'User',
      comment: comment.trim(),
    };
    onSave(saved);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
        className="w-full max-w-[680px] border shadow-xl flex flex-col max-h-[88vh]"
      >
        {/* Dialog Titlebar */}
        <div
          style={{
            backgroundColor: 'var(--bg-header)',
            borderBottom: '1px solid var(--border-strong)',
          }}
          className="h-[30px] px-3 flex items-center justify-between select-none"
        >
          <span className="font-semibold text-[12px]">
            {initialEntry ? 'Edit Transmit Message' : 'New Transmit Message'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher Tabs */}
        <div
          style={{
            backgroundColor: 'var(--bg-toolbar)',
            borderBottom: '1px solid var(--border-grid)',
          }}
          className="px-3 py-1.5 flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => setMode('symbolic')}
            style={{
              backgroundColor: mode === 'symbolic' ? 'var(--bg-panel)' : 'transparent',
              borderColor:
                mode === 'symbolic' ? 'var(--border-strong)' : 'transparent',
            }}
            className="px-2.5 py-1 border text-[11px] font-semibold cursor-pointer disabled:opacity-40"
          >
            Symbolic Message (.dbc / .kcd)
          </button>
          <button
            type="button"
            onClick={() => setMode('raw')}
            style={{
              backgroundColor: mode === 'raw' ? 'var(--bg-panel)' : 'transparent',
              borderColor: mode === 'raw' ? 'var(--border-strong)' : 'transparent',
            }}
            className="px-2.5 py-1 border text-[11px] font-semibold cursor-pointer"
          >
            Raw CAN / CAN-FD Frame
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="p-3 space-y-3 overflow-y-auto flex-1 min-h-0">
            {validationError && (
              <div className="px-2.5 py-1.5 border border-red-500 bg-red-500/15 text-red-400 text-[11px]">
                {validationError}
              </div>
            )}

            {mode === 'symbolic' ? (
              <div className="space-y-3">
                <div className="grid grid-cols-12 gap-2">
                  <div className="col-span-3">
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                      Bus
                    </label>
                    <select
                      value={busId}
                      onChange={(e) => setBusId(Number(e.target.value))}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="w-full h-[26px] px-2 border text-[12px] font-mono tabular-nums"
                    >
                      {busOptions.map((o) => (
                        <option key={o.busId} value={o.busId}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-9">
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                      Symbol (Database Message)
                    </label>
                    <select
                      value={selectedMessage?.messageKey ?? ''}
                      onChange={(e) => setSelectedMsgKey(e.target.value)}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="w-full h-[26px] px-2 border text-[12px] font-mono"
                    >
                      {messages.map((m) => (
                        <option key={m.messageKey} value={m.messageKey}>
                          {formatPcanIdHex(m.arbId, m.isExtended)}h — {m.name} ({m.dlc}B)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {selectedMessage && selectedMessage.isMultiplexed && muxResolution && (
                  <div
                    style={{
                      backgroundColor: 'var(--bg-toolbar)',
                      borderColor: 'var(--border-strong)',
                    }}
                    className="flex items-center gap-2 px-2.5 py-1.5 border text-[11px]"
                  >
                    <span className="text-[var(--text-secondary)] font-sans">Active Multiplexer Path:</span>
                    <span className="font-mono tabular-nums font-semibold" style={{ color: '#E6EDF3' }}>
                      {muxResolution.formatted.baseName}
                    </span>
                    {muxResolution.formatted.muxSuffix !== null && (
                      <span
                        className="font-mono tabular-nums font-semibold"
                        style={{ color: '#79C0FF' }}
                      >
                        .{muxResolution.formatted.muxSuffix}
                      </span>
                    )}
                  </div>
                )}

                {messages.length === 0 && (
                  <div
                    className="px-2.5 py-2 border text-[11px] leading-relaxed"
                    style={{ borderColor: 'var(--status-warn)', color: 'var(--status-warn)' }}
                  >
                    Bus {busId + 1} bağlantısına atanmış bir .dbc / .kcd veritabanı yok — Raw Hex
                    gönderebilir veya Bağlantılar / Databases sekmesinden bu hatta veritabanı
                    bağlayabilirsiniz.
                  </div>
                )}

                {/* Symbolic Signals Table */}
                {selectedMessage && (
                  <div
                    style={{ borderColor: 'var(--border-strong)' }}
                    className="border max-h-[240px] overflow-y-auto"
                  >
                    <table className="pcan-grid">
                      <thead>
                        <tr>
                          <th>Signal Name</th>
                          <th className="w-48">Physical / Enum Value</th>
                          <th className="w-16">Unit</th>
                          <th className="w-32">Range [Min..Max]</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeSymbolicSignals.map((sig) => {
                          const enumEntries = Object.entries(sig.enumTable);
                          const valStr = signalDrafts[sig.signalId] ?? '0';
                          const numVal = Number(valStr);
                          const currentRaw =
                            sig.factor !== 0 && Number.isFinite(numVal)
                              ? Math.round((numVal - sig.offset) / sig.factor)
                              : Math.round(numVal || 0);

                          return (
                            <tr key={sig.signalId}>
                              <td className="font-mono text-[11px]">
                                {sig.name}
                                {sig.muxRole === 'masterSwitch' ? ' (Mux)' : ''}
                              </td>
                              <td>
                                {enumEntries.length > 0 ? (
                                  <select
                                    value={
                                      sig.enumTable[String(currentRaw)] !== undefined
                                        ? String(currentRaw)
                                        : ''
                                    }
                                    onChange={(e) => {
                                      if (e.target.value === '') return;
                                      const rawInt = Number(e.target.value);
                                      const phys = rawInt * sig.factor + sig.offset;
                                      setSignalDrafts((prev) => ({
                                        ...prev,
                                        [sig.signalId]: String(phys),
                                      }));
                                    }}
                                    style={{
                                      backgroundColor: 'var(--bg-input)',
                                      borderColor: 'var(--border-grid)',
                                    }}
                                    className="w-full h-[20px] px-1 border font-mono text-[11px]"
                                  >
                                    <option value="">Raw ({currentRaw})</option>
                                    {enumEntries.map(([rk, lbl]) => (
                                      <option key={rk} value={rk}>
                                        {lbl} ({rk})
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type="number"
                                    step="any"
                                    value={valStr}
                                    onChange={(e) =>
                                      setSignalDrafts((prev) => ({
                                        ...prev,
                                        [sig.signalId]: e.target.value,
                                      }))
                                    }
                                    style={{
                                      backgroundColor: 'var(--bg-input)',
                                      borderColor: 'var(--border-grid)',
                                    }}
                                    className="w-full h-[20px] px-1.5 border font-mono tabular-nums text-[11px]"
                                  />
                                )}
                              </td>
                              <td className="font-mono text-[11px] text-[var(--text-secondary)]">
                                {sig.unit || '—'}
                              </td>
                              <td className="font-mono tabular-nums text-[11px] text-[var(--text-muted)]">
                                [{sig.min}..{sig.max}]
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Packed Hex Preview */}
                <div>
                  <div className="text-[11px] text-[var(--text-secondary)] mb-1">
                    Packed Data Preview (Hex):
                  </div>
                  <div
                    style={{
                      backgroundColor: 'var(--bg-input)',
                      borderColor: 'var(--border-grid)',
                    }}
                    className="px-2 py-1.5 border font-mono tabular-nums text-[11px] break-all"
                  >
                    {symbolicPreviewBytes.map((b) => formatByteHex(b)).join(' ')}
                  </div>
                </div>
              </div>
            ) : (
              /* RAW CAN / CAN-FD MODE */
              <div className="space-y-3">
                <div className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-2">
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                      Bus
                    </label>
                    <select
                      value={busId}
                      onChange={(e) => setBusId(Number(e.target.value))}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="w-full h-[26px] px-1.5 border font-mono tabular-nums text-[12px]"
                    >
                      {busOptions.map((o) => (
                        <option key={o.busId} value={o.busId}>
                          {o.busId + 1}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-3">
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                      CAN-ID (Hex)
                    </label>
                    <input
                      type="text"
                      value={arbIdHex}
                      onChange={(e) => setArbIdHex(e.target.value.toUpperCase())}
                      placeholder="101"
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="w-full h-[26px] px-2 border font-mono tabular-nums text-[12px]"
                    />
                  </div>

                  <div className="col-span-3">
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                      ID Format
                    </label>
                    <select
                      value={isExtended ? 'ext' : 'std'}
                      onChange={(e) => setIsExtended(e.target.value === 'ext')}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="w-full h-[26px] px-1.5 border text-[11px]"
                    >
                      <option value="std">Standard (11-bit)</option>
                      <option value="ext">Extended (29-bit)</option>
                    </select>
                  </div>

                  <div className="col-span-2">
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                      Length
                    </label>
                    <select
                      value={isFd ? dlc : Math.min(8, dlc)}
                      onChange={(e) => setDlc(Number(e.target.value))}
                      style={{
                        backgroundColor: 'var(--bg-input)',
                        borderColor: 'var(--border-strong)',
                      }}
                      className="w-full h-[26px] px-1.5 border font-mono tabular-nums text-[12px]"
                    >
                      {(isFd ? CAN_FD_DLCS : CC_DLCS).map((len) => (
                        <option key={len} value={len}>
                          {len}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="col-span-2 flex items-center gap-2 h-[26px]">
                    <label className="flex items-center gap-1 text-[11px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isFd}
                        onChange={(e) => {
                          setIsFd(e.target.checked);
                          if (!e.target.checked && dlc > 8) setDlc(8);
                        }}
                      />
                      <span>FD</span>
                    </label>
                    {isFd && (
                      <label className="flex items-center gap-1 text-[11px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isBrs}
                          onChange={(e) => setIsBrs(e.target.checked)}
                        />
                        <span>BRS</span>
                      </label>
                    )}
                  </div>
                </div>

                {/* Hex Byte Grid B0..DLC-1 */}
                <div>
                  <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                    Data Bytes (Hex 00..FF)
                  </label>
                  <div className="grid grid-cols-8 gap-1.5 max-h-[190px] overflow-y-auto p-2 border border-[var(--border-grid)] bg-[var(--bg-row-alt)]">
                    {Array.from(
                      { length: isFd ? dlc : Math.min(8, dlc) },
                      (_, byteIdx) => (
                        <div key={byteIdx} className="flex items-center gap-1">
                          <span className="text-[10px] font-mono text-[var(--text-muted)] w-4 text-right">
                            {byteIdx}
                          </span>
                          <input
                            type="text"
                            maxLength={2}
                            value={rawByteInputs[byteIdx] ?? '00'}
                            onChange={(e) => {
                              const v = e.target.value
                                .replace(/[^0-9a-fA-F]/g, '')
                                .toUpperCase();
                              setRawByteInputs((prev) => {
                                const copy = [...prev];
                                copy[byteIdx] = v;
                                return copy;
                              });
                            }}
                            style={{
                              backgroundColor: 'var(--bg-input)',
                              borderColor: 'var(--border-strong)',
                            }}
                            className="w-9 h-[22px] text-center border font-mono tabular-nums text-[11px]"
                          />
                        </div>
                      ),
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Timing & Comment Row */}
            <div className="grid grid-cols-12 gap-2 pt-1 border-t border-[var(--border-grid)]">
              <div className="col-span-4">
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                  Cycle Time (ms) — 0 = Wait
                </label>
                <input
                  type="number"
                  min={0}
                  max={60000}
                  value={cycleTimeStr}
                  onChange={(e) => setCycleTimeStr(e.target.value)}
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[26px] px-2 border font-mono tabular-nums text-[12px]"
                />
              </div>

              <div className="col-span-8">
                <label className="block text-[11px] text-[var(--text-secondary)] mb-1">
                  Comment
                </label>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional engineering note"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    borderColor: 'var(--border-strong)',
                  }}
                  className="w-full h-[26px] px-2 border text-[12px]"
                />
              </div>
            </div>
          </div>

          {/* Dialog Footer */}
          <div
            style={{
              backgroundColor: 'var(--bg-toolbar)',
              borderTop: '1px solid var(--border-strong)',
            }}
            className="px-3 py-2 flex items-center justify-end gap-2"
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                backgroundColor: 'var(--bg-panel)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-secondary)',
              }}
              className="h-[25px] px-3 border text-[11px] hover:text-[var(--text-primary)] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                backgroundColor: 'var(--bg-header)',
                borderColor: 'var(--text-secondary)',
                color: 'var(--text-primary)',
              }}
              className="h-[25px] px-4 border text-[11px] font-semibold hover:opacity-90 cursor-pointer"
            >
              OK
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
