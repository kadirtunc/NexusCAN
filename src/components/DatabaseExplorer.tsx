import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { databaseStore, useDatabaseStore } from '../store/databaseStore';
import { transmitStore } from '../store/transmitStore';
import type {
  EcuNodeDto,
  MessageSchemaDto,
  ParseDiagnosticDto,
  SignalSchemaDto,
} from '../types/netdb';
import { formatPcanIdHex, previewPackSymbolicBytes } from '../utils/formatters';

function formatCompactMuxRanges(ranges: readonly [number, number][]): string {
  if (ranges.length === 0) return '';
  return ranges
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
}

export const DatabaseExplorer: React.FC = () => {
  const dbState = useDatabaseStore();
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const schema = dbState.schema;
  const q = searchQuery.trim().toLowerCase();

  // Identify cascaded sub-switches: any signal with muxRole === 'multiplexed'
  // that is referenced as another signal's `switchSignalId`.
  const cascadedSubSwitchIds: ReadonlySet<number> = useMemo(() => {
    const set = new Set<number>();
    if (!schema) return set;
    for (const sig of schema.signals) {
      if (sig.switchSignalId !== null) {
        const sw: SignalSchemaDto | undefined = dbState.signalsById[sig.switchSignalId];
        if (sw && sw.muxRole === 'multiplexed') {
          set.add(sw.signalId);
        }
      }
    }
    return set;
  }, [schema, dbState.signalsById]);

  const filteredMessages: readonly MessageSchemaDto[] = useMemo(() => {
    if (!schema) return [];
    if (q.length === 0) return schema.messages;

    return schema.messages.filter((msg) => {
      const idStr = formatPcanIdHex(msg.arbId, msg.isExtended).toLowerCase();
      const isMuxQuery = (q === 'mux' || q === 'multiplex') && msg.isMultiplexed;
      if (
        isMuxQuery ||
        idStr.includes(q) ||
        msg.name.toLowerCase().includes(q) ||
        msg.transmitters.some((tx) => tx.toLowerCase().includes(q))
      ) {
        return true;
      }
      for (const sigId of msg.signalIds) {
        const sig = dbState.signalsById[sigId];
        if (sig && sig.name.toLowerCase().includes(q)) {
          return true;
        }
      }
      return false;
    });
  }, [schema, dbState.signalsById, q]);

  const filteredEcus: readonly EcuNodeDto[] = useMemo(() => {
    if (!schema) return [];
    if (q.length === 0) return schema.ecus;
    return schema.ecus.filter((e) => e.name.toLowerCase().includes(q));
  }, [schema, q]);

  const handleAddSymbolToTxList = (msg: MessageSchemaDto): void => {
    const sigVals: Record<number, number> = {};
    for (const sigId of msg.signalIds) {
      const sig = dbState.signalsById[sigId];
      if (sig) {
        sigVals[sigId] =
          sig.initialValue !== null && Number.isFinite(sig.initialValue)
            ? sig.initialValue
            : sig.max > sig.min
              ? Math.max(sig.min, Math.min(sig.max, 0))
              : 0;
      }
    }
    const packed = previewPackSymbolicBytes(msg, dbState.signalsById, sigVals);
    const isFd = msg.protocol.toUpperCase().includes('FD') || msg.dlc > 8;

    transmitStore.addEntry({
      id: `tx-sym-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      busId: 0,
      mode: 'symbolic',
      messageKey: msg.messageKey,
      arbId: msg.arbId,
      isExtended: msg.isExtended,
      isFd,
      isBrs: isFd,
      dlc: msg.dlc,
      symbolName: msg.name,
      rawBytes: packed,
      signalValues: sigVals,
      cycleTimeMs: msg.expectedCycleMs ?? 0,
      periodicEnabled: false,
      backendJobId: null,
      manualSentCount: 0,
      periodicSentCount: 0,
      creator: 'User',
      comment: `Added from ${schema?.info.name ?? 'DB'}`,
    });
    databaseStore.setActiveDocTab('rxtx');
  };

  if (!schema) {
    return (
      <div
        style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-muted)' }}
        className="flex items-center justify-center h-full p-6 text-center text-[12px]"
      >
        No Symbol Database Loaded.
      </div>
    );
  }

  return (
    <div
      style={{ backgroundColor: 'var(--bg-panel)' }}
      className="flex flex-col h-full min-h-0 select-none"
    >
      {/* Slim 26px Item Navigator Header */}
      <div
        style={{
          backgroundColor: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-strong)',
        }}
        className="shrink-0 h-[26px] px-2 flex items-center justify-between gap-1.5 text-[11px]"
      >
        <div className="flex items-center gap-1">
          {(
            [
              { id: 'messages', label: `Symbols (${schema.messages.length})` },
              { id: 'ecus', label: `ECUs (${schema.ecus.length})` },
              {
                id: 'diagnostics',
                label: `Diagnostics (${schema.info.diagnostics.length})`,
              },
            ] as const
          ).map((t) => {
            const active = dbState.explorerSubTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => databaseStore.setExplorerSubTab(t.id)}
                style={{
                  backgroundColor: active ? 'var(--bg-panel)' : 'transparent',
                  borderColor: active ? 'var(--border-strong)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
                className="h-[20px] px-2 border font-medium cursor-pointer"
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {dbState.explorerSubTab !== 'diagnostics' && (
          <div className="relative flex items-center">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search ID, symbol, mux..."
              style={{
                backgroundColor: 'var(--bg-input)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
              className="h-[20px] w-36 px-1.5 pr-5 border text-[11px] focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1 text-[var(--text-muted)] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tree / List Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {dbState.explorerSubTab === 'messages' && (
          <table className="pcan-grid pcan-grid-fixed font-mono tabular-nums">
            <colgroup>
              <col style={{ width: '24px' }} />
              <col style={{ width: '74px' }} />
              <col />
              <col style={{ width: '38px' }} />
              <col style={{ width: '52px' }} />
              <col style={{ width: '50px' }} />
            </colgroup>
            <thead>
              <tr>
                <th />
                <th>ID</th>
                <th className="font-sans">Symbol</th>
                <th className="text-right">DLC</th>
                <th className="font-sans">ECU</th>
                <th className="text-center font-sans">TX</th>
              </tr>
            </thead>
            <tbody>
              {filteredMessages.map((msg) => {
                const isSelectedMsg =
                  dbState.selectedMessageKey === msg.messageKey &&
                  dbState.selectedSignalId === null;
                const isParentOfSelectedSig =
                  dbState.selectedMessageKey === msg.messageKey &&
                  dbState.selectedSignalId !== null;
                const isExpanded = expandedKeys.has(msg.messageKey) || q.length > 0;
                const hasCascadedMux =
                  msg.isMultiplexed &&
                  msg.signalIds.some((id) => cascadedSubSwitchIds.has(id));

                return (
                  <React.Fragment key={msg.messageKey}>
                    <tr
                      onClick={() => databaseStore.setSelectedMessageKey(msg.messageKey)}
                      style={{
                        backgroundColor: isSelectedMsg
                          ? 'var(--bg-row-selected)'
                          : isParentOfSelectedSig
                            ? 'var(--bg-row-hover)'
                            : 'var(--bg-panel)',
                      }}
                      className="hover:!bg-[var(--bg-row-hover)] cursor-pointer"
                    >
                      <td
                        className="px-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedKeys((prev) => {
                            const next = new Set(prev);
                            if (next.has(msg.messageKey)) next.delete(msg.messageKey);
                            else next.add(msg.messageKey);
                            return next;
                          });
                        }}
                      >
                        <div className="pcan-cell pcan-cell-center">
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                          )}
                        </div>
                      </td>

                      <td>
                        <div className="pcan-cell">
                          {formatPcanIdHex(msg.arbId, msg.isExtended)}h
                        </div>
                      </td>

                      <td>
                        <div
                          className="pcan-cell font-sans gap-1.5"
                          title={
                            msg.isMultiplexed
                              ? `${msg.name} — ${
                                  hasCascadedMux
                                    ? 'Cascaded Multi-Level Multiplexed Symbol'
                                    : 'Multiplexed Symbol'
                                }`
                              : msg.name
                          }
                        >
                          <span className="font-medium truncate">{msg.name}</span>
                          {msg.isMultiplexed && (
                            <span className="px-1 h-[15px] leading-[13px] text-[9px] font-mono font-bold border border-amber-500/50 bg-amber-500/15 text-amber-500 shrink-0">
                              {hasCascadedMux ? 'MUX²' : 'MUX'}
                            </span>
                          )}
                        </div>
                      </td>

                      <td>
                        <div className="pcan-cell pcan-cell-right">{msg.dlc}</div>
                      </td>

                      <td>
                        <div
                          className="pcan-cell font-sans text-[var(--text-secondary)]"
                          title={msg.transmitters.join(', ')}
                        >
                          <span className="truncate">{msg.transmitters.join(',')}</span>
                        </div>
                      </td>

                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="pcan-cell pcan-cell-center font-sans">
                          <button
                            type="button"
                            onClick={() => handleAddSymbolToTxList(msg)}
                            style={{
                              backgroundColor: 'var(--bg-toolbar)',
                              borderColor: 'var(--border-strong)',
                            }}
                            className="px-1.5 h-[17px] leading-none border text-[10px] inline-flex items-center gap-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)] cursor-pointer"
                            title="Add symbol to Transmit List"
                          >
                            <Plus className="w-2.5 h-2.5" />
                            <span>TX</span>
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isExpanded &&
                      msg.signalIds.map((sigId) => {
                        const sig = dbState.signalsById[sigId];
                        if (!sig) return null;
                        const isSigSelected = dbState.selectedSignalId === sig.signalId;
                        const isSubSwitch = cascadedSubSwitchIds.has(sig.signalId);
                        const parentSw =
                          sig.switchSignalId !== null
                            ? dbState.signalsById[sig.switchSignalId]
                            : undefined;

                        return (
                          <tr
                            key={sigId}
                            onClick={() =>
                              databaseStore.selectSignalInSymbolsTab(
                                msg.messageKey,
                                sig.signalId,
                              )
                            }
                            style={{
                              backgroundColor: isSigSelected
                                ? 'var(--bg-row-selected)'
                                : 'var(--bg-row-signal)',
                            }}
                            className="text-[11px] hover:!bg-[var(--bg-row-hover)] cursor-pointer"
                            title={
                              sig.muxRole === 'masterSwitch'
                                ? `${sig.name} — Master Multiplexer Switch [M] (${sig.startBit}|${sig.bitLength})`
                                : isSubSwitch
                                  ? `${sig.name} — Cascaded Sub-Switch [m${formatCompactMuxRanges(sig.muxRanges)} · M] gated by ${parentSw?.name ?? 'Switch'}`
                                  : sig.muxRole === 'multiplexed'
                                    ? `${sig.name} — Multiplexed Signal [m${formatCompactMuxRanges(sig.muxRanges)}] via ${parentSw?.name ?? 'Switch'} (Click to activate branch in Bit Layout)`
                                    : `${sig.name} — Static Signal (${sig.startBit}|${sig.bitLength})`
                            }
                          >
                            <td className="px-0">
                              <div className="pcan-cell" />
                            </td>

                            <td>
                              <div className="pcan-cell text-[var(--text-muted)]">
                                {sig.startBit}|{sig.bitLength}
                              </div>
                            </td>

                            <td colSpan={4}>
                              <div className="pcan-cell pl-2 border-l-2 border-emerald-500/40 font-sans justify-between gap-1.5">
                                <div className="flex items-center min-w-0">
                                  <span className="text-emerald-500 font-mono font-bold mr-1 shrink-0">
                                    ~
                                  </span>
                                  <span className="truncate font-medium">
                                    {sig.name}
                                  </span>
                                  {sig.unit && (
                                    <span className="ml-1 text-[var(--text-muted)] font-mono shrink-0">
                                      [{sig.unit}]
                                    </span>
                                  )}
                                </div>

                                {/* Multiplexer Role Badge */}
                                {sig.muxRole === 'masterSwitch' && (
                                  <span className="px-1 h-[15px] leading-[13px] text-[10px] font-mono font-bold border border-amber-500/60 bg-amber-500/15 text-amber-500 shrink-0">
                                    [M]
                                  </span>
                                )}
                                {sig.muxRole === 'multiplexed' && isSubSwitch && (
                                  <span className="px-1 h-[15px] leading-[13px] text-[10px] font-mono font-bold border border-amber-500/60 bg-violet-500/15 text-amber-400 shrink-0">
                                    [m{formatCompactMuxRanges(sig.muxRanges)} · M]
                                  </span>
                                )}
                                {sig.muxRole === 'multiplexed' && !isSubSwitch && (
                                  <span className="px-1 h-[15px] leading-[13px] text-[10px] font-mono border border-sky-500/50 bg-sky-500/10 text-sky-500 shrink-0">
                                    [m{formatCompactMuxRanges(sig.muxRanges)}]
                                  </span>
                                )}
                                {msg.isMultiplexed && sig.muxRole === 'static' && (
                                  <span className="px-1 h-[15px] leading-[13px] text-[9px] font-mono text-[var(--text-muted)] border border-[var(--border-grid)] shrink-0">
                                    Static
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {dbState.explorerSubTab === 'ecus' && (
          <table className="pcan-grid pcan-grid-fixed">
            <colgroup>
              <col style={{ width: '96px' }} />
              <col style={{ width: '64px' }} />
              <col style={{ width: '64px' }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>ECU Node</th>
                <th className="text-right">TX Msgs</th>
                <th className="text-right">RX Msgs</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {filteredEcus.map((ecu) => (
                <tr key={ecu.name}>
                  <td>
                    <div className="pcan-cell font-mono font-semibold">{ecu.name}</div>
                  </td>
                  <td>
                    <div className="pcan-cell pcan-cell-right font-mono tabular-nums">
                      {ecu.txMessageKeys.length}
                    </div>
                  </td>
                  <td>
                    <div className="pcan-cell pcan-cell-right font-mono tabular-nums">
                      {ecu.rxMessageKeys.length}
                    </div>
                  </td>
                  <td>
                    <div
                      className="pcan-cell text-[var(--text-secondary)]"
                      title={ecu.comment ?? undefined}
                    >
                      <span className="truncate">{ecu.comment ?? '—'}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {dbState.explorerSubTab === 'diagnostics' && (
          <DiagnosticsTable diagnostics={schema.info.diagnostics} />
        )}
      </div>
    </div>
  );
};

const DiagnosticsTable: React.FC<{ diagnostics: readonly ParseDiagnosticDto[] }> = ({
  diagnostics,
}) => {
  if (diagnostics.length === 0) {
    return (
      <div className="p-6 text-center text-[12px] text-emerald-500 font-medium">
        0 Parser Warnings / 0 Errors — Symbol Schema Verified Clean.
      </div>
    );
  }

  return (
    <table className="pcan-grid pcan-grid-fixed">
      <colgroup>
        <col style={{ width: '76px' }} />
        <col style={{ width: '96px' }} />
        <col style={{ width: '72px' }} />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Code</th>
          <th>Line</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {diagnostics.map((d, idx) => (
          <tr key={`${idx}-${d.code}`}>
            <td>
              <div
                className={`pcan-cell font-semibold uppercase ${
                  d.severity === 'error'
                    ? 'text-red-500'
                    : d.severity === 'warning'
                      ? 'text-amber-500'
                      : ''
                }`}
              >
                {d.severity}
              </div>
            </td>
            <td>
              <div className="pcan-cell font-mono">{d.code}</div>
            </td>
            <td>
              <div className="pcan-cell font-mono tabular-nums">
                {d.line !== null
                  ? `${d.line}${d.column !== null ? `:${d.column}` : ''}`
                  : '—'}
              </div>
            </td>
            <td>
              <div className="pcan-cell select-text" title={d.message}>
                <span className="truncate">{d.message}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
