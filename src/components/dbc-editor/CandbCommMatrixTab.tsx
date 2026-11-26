'use client';

import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cpu,
  Plus,
} from 'lucide-react';
import type {
  DatabaseSchemaDto,
  MessageSchemaDto,
  SignalSchemaDto,
} from './contracts';
import { formatHexArbId } from './dbcEditorUtils';
import { useDbcStudioI18n } from './i18n/dbcStudio';

interface CandbCommMatrixTabProps {
  schema: DatabaseSchemaDto;
  canMutate: boolean;
  onAddEcu: () => void;
  onSelectMessage: (messageKey: string) => void;
  onSelectSignal: (messageKey: string, signalId: number) => void;
  onToggleMessageTx: (messageKey: string, ecuName: string) => void;
  onToggleSignalRx: (signalId: number, ecuName: string) => void;
}

export function CandbCommMatrixTab({
  schema,
  canMutate,
  onAddEcu,
  onSelectMessage,
  onSelectSignal,
  onToggleMessageTx,
  onToggleSignalRx,
}: CandbCommMatrixTabProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [expandedMsgKeys, setExpandedMsgKeys] = useState<
    Record<string, boolean>
  >(() => {
    const init: Record<string, boolean> = {};
    for (const m of schema.messages.slice(0, 4)) {
      init[m.messageKey] = true;
    }
    return init;
  });

  const signalsByMsgKey = useMemo(() => {
    const map = new Map<string, SignalSchemaDto[]>();
    for (const s of schema.signals) {
      const arr = map.get(s.messageKey);
      if (arr) {
        arr.push(s);
      } else {
        map.set(s.messageKey, [s]);
      }
    }
    return map;
  }, [schema.signals]);

  const toggleExpand = (messageKey: string) => {
    setExpandedMsgKeys((prev) => ({
      ...prev,
      [messageKey]: !prev[messageKey],
    }));
  };

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    for (const m of schema.messages) {
      next[m.messageKey] = true;
    }
    setExpandedMsgKeys(next);
  };

  const collapseAll = () => {
    setExpandedMsgKeys({});
  };

  if (schema.ecus.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Cpu className="h-7 w-7 text-muted" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
            {t('commMatrix.emptyTitle')}
          </p>
          <p className="text-xs text-muted">{t('commMatrix.emptySubtitle')}</p>
        </div>
        {canMutate && (
          <button
            type="button"
            onClick={onAddEcu}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3 font-mono text-[11px] font-semibold uppercase text-on-accent"
            style={{ backgroundColor: 'var(--status-nominal)' }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('commMatrix.addEcuNodeBtn')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <Cpu className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          <span className="font-semibold uppercase tracking-wider text-ink">
            {t('commMatrix.headerTitle')}
          </span>
          <span className="tabular-nums text-muted">
            {t('commMatrix.dimensions', {
              messages: schema.messages.length,
              ecus: schema.ecus.length,
            })}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[10px] text-muted">
            {t('commMatrix.hintPrefix')}
            <strong className="text-nominal">TX</strong>
            {t('commMatrix.hintMiddle')}
            <strong className="text-focus">RX</strong>
            {t('commMatrix.hintSuffix')}
          </span>

          <button
            type="button"
            onClick={expandAll}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 font-mono text-[10px] text-ink hover:border-strong"
          >
            <ChevronsUpDown className="h-3 w-3" aria-hidden="true" />
            {t('commMatrix.expandAll')}
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 font-mono text-[10px] text-ink hover:border-strong"
          >
            <ChevronsDownUp className="h-3 w-3" aria-hidden="true" />
            {t('commMatrix.collapseAll')}
          </button>
          {canMutate && (
            <button
              type="button"
              onClick={onAddEcu}
              className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] px-2 font-mono text-[10px] font-semibold uppercase text-on-accent"
              style={{ backgroundColor: 'var(--status-nominal)' }}
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              {t('commMatrix.addEcuShort')}
            </button>
          )}
        </div>
      </div>

      {/* Matrix Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-xs select-none">
          <thead className="sticky top-0 z-10 border-b border-hairline bg-elevated font-mono text-[10px] uppercase tracking-wider text-muted">
            <tr>
              <th className="min-w-[260px] border-r border-hairline py-2 px-3">
                {t('commMatrix.colMsgSig')}
              </th>
              <th className="w-20 border-r border-hairline py-2 px-2 text-right">
                {t('commMatrix.colDlcBit')}
              </th>
              {schema.ecus.map((ecu) => (
                <th
                  key={ecu.name}
                  className="min-w-[88px] border-r border-hairline py-2 px-2 text-center font-semibold text-ink"
                >
                  <div>{ecu.name}</div>
                  <div className="font-normal tabular-nums text-[9px] text-subtle">
                    {ecu.txMessageKeys.length}T/{ecu.rxMessageKeys.length}R
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-hairline bg-surface font-mono">
            {schema.messages.map((msg: MessageSchemaDto) => {
              const msgSignals = signalsByMsgKey.get(msg.messageKey) ?? [];
              const expanded = Boolean(expandedMsgKeys[msg.messageKey]);

              return (
                <React.Fragment key={msg.messageKey}>
                  {/* Message Row (Click cells -> Toggle TX) */}
                  <tr className="bg-elevated/45 hover:bg-elevated">
                    <td className="border-r border-hairline py-1.5 px-2.5">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggleExpand(msg.messageKey)}
                          aria-label={t('tree.toggleMsgSignalsAria', {
                            name: msg.name,
                          })}
                          className="cursor-pointer rounded-[1px] p-0.5 text-muted hover:text-ink"
                        >
                          {expanded ? (
                            <ChevronDown
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          ) : (
                            <ChevronRight
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectMessage(msg.messageKey)}
                          className="flex items-center gap-1.5 cursor-pointer text-left"
                        >
                          <span className="text-[11px] font-semibold tabular-nums text-focus">
                            {formatHexArbId(msg.arbId, msg.isExtended)}
                          </span>
                          <span className="text-[11px] font-semibold text-ink">
                            {msg.name}
                          </span>
                        </button>
                      </div>
                    </td>

                    <td className="border-r border-hairline py-1.5 px-2 text-right text-[10px] tabular-nums text-muted">
                      {msg.dlc}B · {msgSignals.length}SG
                    </td>

                    {schema.ecus.map((ecu) => {
                      const isTx = msg.transmitters.includes(ecu.name);
                      const isPrimaryTx = msg.transmitters[0] === ecu.name;
                      const rxChildCount = msgSignals.filter((s) =>
                        s.receivers.includes(ecu.name)
                      ).length;

                      return (
                        <td
                          key={ecu.name}
                          className="border-r border-hairline p-1 text-center"
                        >
                          <button
                            type="button"
                            disabled={!canMutate}
                            onClick={() =>
                              onToggleMessageTx(msg.messageKey, ecu.name)
                            }
                            title={t('commMatrix.toggleTxTitle', {
                              msg: msg.name,
                              ecu: ecu.name,
                            })}
                            className={`flex h-6 w-full cursor-pointer items-center justify-center gap-1 rounded-[2px] border text-[10px] font-semibold tabular-nums transition-colors disabled:cursor-default ${
                              isTx
                                ? 'border-strong bg-surface text-nominal'
                                : rxChildCount > 0
                                  ? 'border-hairline bg-canvas text-focus/80 hover:border-strong'
                                  : 'border-transparent text-subtle hover:border-hairline hover:bg-canvas'
                            }`}
                          >
                            {isTx ? (
                              <span>{isPrimaryTx ? 'TX' : 'TX+'}</span>
                            ) : rxChildCount > 0 ? (
                              <span className="text-[9px]">
                                rx({rxChildCount})
                              </span>
                            ) : (
                              <span>·</span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>

                  {/* Child Signal Rows (Click cells -> Toggle RX) */}
                  {expanded &&
                    msgSignals.map((sig) => (
                      <tr
                        key={sig.signalId}
                        className="bg-surface hover:bg-elevated/35"
                      >
                        <td className="border-r border-hairline py-1 pr-2.5 pl-8">
                          <button
                            type="button"
                            onClick={() =>
                              onSelectSignal(msg.messageKey, sig.signalId)
                            }
                            className="flex items-center gap-1.5 cursor-pointer text-left text-[11px] text-muted hover:text-ink"
                          >
                            <span className="text-[9px] text-subtle">SG_</span>
                            <span className="font-medium text-ink">
                              {sig.name}
                            </span>
                            {sig.unit && (
                              <span className="text-[9px] text-subtle">
                                [{sig.unit}]
                              </span>
                            )}
                          </button>
                        </td>

                        <td className="border-r border-hairline py-1 px-2 text-right text-[10px] tabular-nums text-subtle">
                          {sig.startBit}|{sig.bitLength}b
                        </td>

                        {schema.ecus.map((ecu) => {
                          const isRx = sig.receivers.includes(ecu.name);
                          return (
                            <td
                              key={ecu.name}
                              className="border-r border-hairline p-1 text-center"
                            >
                              <button
                                type="button"
                                disabled={!canMutate}
                                onClick={() =>
                                  onToggleSignalRx(sig.signalId, ecu.name)
                                }
                                title={t('commMatrix.toggleRxTitle', {
                                  sig: sig.name,
                                  ecu: ecu.name,
                                })}
                                className={`flex h-5 w-full cursor-pointer items-center justify-center rounded-[2px] border text-[10px] font-semibold transition-colors disabled:cursor-default ${
                                  isRx
                                    ? 'border-strong bg-elevated text-focus'
                                    : 'border-transparent text-subtle hover:border-hairline hover:bg-canvas'
                                }`}
                              >
                                {isRx ? 'RX' : '·'}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
