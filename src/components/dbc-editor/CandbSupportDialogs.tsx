'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Plus, Trash2 } from 'lucide-react';
import type {
  DatabaseSchemaDto,
  EcuNodeDto,
  ReusableValueTableDto,
  SignalSchemaDto,
} from './contracts';
import { useDbcStudioI18n } from './i18n/dbcStudio';
import { CandbModalShell, type CandbModalTabItem } from './CandbModalShell';
import { formatHexArbId, type EcuDialogTab } from './dbcEditorUtils';

// ============================================================================
// 1. ECU NODE DIALOG (BU_)
// ============================================================================

interface CandbEcuDialogProps {
  mode?: 'create' | 'edit';
  ecu: EcuNodeDto;
  schema: DatabaseSchemaDto;
  initialTab?: EcuDialogTab;
  stagedTxMessageKeys?: readonly string[];
  stagedRxSignalIds?: readonly number[];
  canMutate: boolean;
  onUpdateEcu: (
    oldName: string,
    patch: { name?: string; comment?: string | null }
  ) => void;
  onCreateEcu?: (finalName: string) => void;
  onDeleteEcu: (ecuName: string) => void;
  onToggleMessageTx: (messageKey: string, ecuName: string) => void;
  onToggleSignalRx: (signalId: number, ecuName: string) => void;
  onOpenMessageDialog: (messageKey: string) => void;
  onOpenSignalDialog: (signalId: number) => void;
  onClose: () => void;
}

export function CandbEcuDialog({
  mode = 'edit',
  ecu,
  schema,
  initialTab = 'definition',
  stagedTxMessageKeys,
  stagedRxSignalIds,
  canMutate,
  onUpdateEcu,
  onCreateEcu,
  onDeleteEcu,
  onToggleMessageTx,
  onToggleSignalRx,
  onOpenMessageDialog,
  onOpenSignalDialog,
  onClose,
}: CandbEcuDialogProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [activeTab, setActiveTab] = useState<EcuDialogTab>(initialTab);
  const [nameDraft, setNameDraft] = useState<string>(ecu.name);
  const [showAllRxCandidates, setShowAllRxCandidates] = useState<boolean>(
    mode === 'create'
  );

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setNameDraft(ecu.name);
  }, [ecu.name]);

  const msgByKey = useMemo(
    () => new Map(schema.messages.map((m) => [m.messageKey, m])),
    [schema.messages]
  );

  const mappedRxSignals = useMemo(
    () =>
      mode === 'create'
        ? schema.signals.filter((s) =>
            (stagedRxSignalIds ?? []).includes(s.signalId)
          )
        : schema.signals.filter((s) => s.receivers.includes(ecu.name)),
    [ecu.name, mode, schema.signals, stagedRxSignalIds]
  );

  const displayedRxSignals: readonly SignalSchemaDto[] = showAllRxCandidates
    ? schema.signals
    : mappedRxSignals;

  const cleanCandidateName = nameDraft.trim();
  const ecuCollision = schema.ecus.some(
    (e) =>
      e.name.toLowerCase() === cleanCandidateName.toLowerCase() &&
      (mode === 'create' || e.name !== ecu.name)
  );

  const commitName = () => {
    if (mode === 'create') return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== ecu.name && !ecuCollision) {
      onUpdateEcu(ecu.name, { name: trimmed });
    } else {
      setNameDraft(ecu.name);
    }
  };

  const txCount =
    mode === 'create'
      ? (stagedTxMessageKeys?.length ?? 0)
      : ecu.txMessageKeys.length;
  const rxCount = mappedRxSignals.length;

  const tabs: ReadonlyArray<CandbModalTabItem<EcuDialogTab>> = [
    { id: 'definition', label: t('ecuDialog.tab.definition') },
    {
      id: 'txMessages',
      label: t('ecuDialog.tab.txMessages'),
      count: txCount,
    },
    {
      id: 'rxSignals',
      label: t('ecuDialog.tab.rxSignals'),
      count: rxCount,
    },
  ];

  return (
    <CandbModalShell<EcuDialogTab>
      badge={
        mode === 'create' ? t('ecuDialog.badgeCreate') : t('ecuDialog.badgeEdit')
      }
      title={
        mode === 'create'
          ? t('ecuDialog.titleCreate', {
              name: cleanCandidateName || t('ecuDialog.untitledEcu'),
            })
          : t('ecuDialog.titleEdit', { name: ecu.name })
      }
      subtitle={t('ecuDialog.subtitle', { tx: txCount, rx: rxCount })}
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={() => {
        if (mode === 'edit') {
          commitName();
        }
        onClose();
      }}
      footer={
        mode === 'create' ? (
          <>
            <span className="text-[11px] text-muted">
              {t('ecuDialog.cancelDraftHint')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-surface px-3 text-xs text-ink transition-colors hover:border-strong"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!canMutate || !cleanCandidateName || ecuCollision}
                onClick={() => onCreateEcu?.(cleanCandidateName)}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                style={{ backgroundColor: 'var(--status-nominal)' }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('ecuDialog.createBtn')}</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              {canMutate && (
                <button
                  type="button"
                  onClick={() => {
                    onDeleteEcu(ecu.name);
                    onClose();
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-critical transition-colors hover:border-critical"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('ecuDialog.deleteBtn')}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                commitName();
                onClose();
              }}
              className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
            >
              {t('common.ok')}
            </button>
          </>
        )
      }
    >
      {/* TAB 1: DEFINITION */}
      {activeTab === 'definition' && (
        <div className="p-5 space-y-4 text-xs">
          <div className="space-y-1.5">
            <label className="block font-medium text-muted">
              {t('ecuDialog.fieldName')}
            </label>
            <input
              type="text"
              disabled={!canMutate}
              value={nameDraft}
              placeholder={t('ecuDialog.placeholderName')}
              onChange={(e) => {
                setNameDraft(e.target.value);
                if (mode === 'create') {
                  onUpdateEcu(ecu.name, { name: e.target.value });
                }
              }}
              onBlur={commitName}
              className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
            />
            {!cleanCandidateName && (
              <p className="font-mono text-[11px] text-critical">
                {t('ecuDialog.emptyNameError')}
              </p>
            )}
            {ecuCollision && (
              <p className="font-mono text-[11px] text-critical">
                {t('ecuDialog.duplicateNameError', {
                  name: cleanCandidateName,
                })}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block font-medium text-muted">
              {t('ecuDialog.fieldComment')}
            </label>
            <textarea
              rows={5}
              disabled={!canMutate}
              value={ecu.comment ?? ''}
              placeholder={t('ecuDialog.placeholderComment')}
              onChange={(e) =>
                onUpdateEcu(ecu.name, {
                  comment: e.target.value.length > 0 ? e.target.value : null,
                })
              }
              className="w-full rounded-[2px] border border-hairline bg-canvas p-3 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
            />
          </div>
        </div>
      )}

      {/* TAB 2: TX MESSAGES */}
      {activeTab === 'txMessages' && (
        <div className="flex flex-col text-xs">
          <div className="border-b border-hairline bg-elevated/60 px-4 py-2.5 text-muted">
            {t('ecuDialog.txTabHint')}
          </div>

          {schema.messages.length === 0 ? (
            <div className="p-8 text-center text-muted">
              {t('ecuDialog.emptyMessages')}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs select-none">
              <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                <tr>
                  <th className="w-12 py-2 px-4 text-center">TX</th>
                  <th className="py-2 px-3">{t('list.col.messageNameBo')}</th>
                  <th className="py-2 px-3">{t('list.col.idHex')}</th>
                  <th className="py-2 px-3 text-right">
                    {t('list.col.dlcBytes')}
                  </th>
                  <th className="py-2 px-4 text-right">
                    {t('list.col.cycleTimeMs')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-surface">
                {schema.messages.map((msg) => {
                  const isTx =
                    mode === 'create'
                      ? (stagedTxMessageKeys ?? []).includes(msg.messageKey)
                      : msg.transmitters.includes(ecu.name);
                  return (
                    <tr
                      key={msg.messageKey}
                      onDoubleClick={() => {
                        if (mode === 'edit') {
                          onOpenMessageDialog(msg.messageKey);
                        }
                      }}
                      className="cursor-pointer hover:bg-elevated/50"
                    >
                      <td className="py-2 px-4 text-center">
                        <input
                          type="checkbox"
                          disabled={!canMutate}
                          checked={isTx}
                          onChange={() =>
                            onToggleMessageTx(msg.messageKey, ecu.name)
                          }
                          className="accent-focus"
                        />
                      </td>
                      <td className="py-2 px-3 font-semibold text-ink">
                        {msg.name}
                      </td>
                      <td className="py-2 px-3 font-mono font-semibold tabular-nums text-focus">
                        {formatHexArbId(msg.arbId, msg.isExtended)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                        {msg.dlc}
                      </td>
                      <td className="py-2 px-4 text-right font-mono tabular-nums text-muted">
                        {msg.expectedCycleMs ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* TAB 3: RX SIGNALS */}
      {activeTab === 'rxSignals' && (
        <div className="flex flex-col text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-4 py-2">
            <span className="text-muted">
              {showAllRxCandidates
                ? t('ecuDialog.rxShowingAllHint')
                : t('ecuDialog.rxShowingMappedHint', {
                    count: mappedRxSignals.length,
                  })}
            </span>
            <button
              type="button"
              onClick={() => setShowAllRxCandidates((prev) => !prev)}
              className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink hover:border-strong"
            >
              {showAllRxCandidates
                ? t('ecuDialog.rxMappedOnlyBtn', {
                    count: mappedRxSignals.length,
                  })
                : t('ecuDialog.rxShowAllBtn', {
                    count: schema.signals.length,
                  })}
            </button>
          </div>

          {displayedRxSignals.length === 0 ? (
            <div className="p-8 text-center text-muted">
              {t('ecuDialog.rxEmptyPrefix')}
              <strong className="text-ink">
                {t('ecuDialog.rxEmptyActionLabel')}
              </strong>
              {t('ecuDialog.rxEmptySuffix')}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs select-none">
              <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                <tr>
                  <th className="w-12 py-2 px-4 text-center">RX</th>
                  <th className="py-2 px-3">{t('list.col.signalNameSg')}</th>
                  <th className="py-2 px-3">{t('list.col.sourceMessageBo')}</th>
                  <th className="py-2 px-3 text-right">
                    {t('list.col.startPipeBit')}
                  </th>
                  <th className="py-2 px-4">{t('list.col.unit')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-surface">
                {displayedRxSignals.map((sig) => {
                  const isRx =
                    mode === 'create'
                      ? (stagedRxSignalIds ?? []).includes(sig.signalId)
                      : sig.receivers.includes(ecu.name);
                  const parentMsg = msgByKey.get(sig.messageKey);
                  return (
                    <tr
                      key={sig.signalId}
                      onDoubleClick={() => {
                        if (mode === 'edit') {
                          onOpenSignalDialog(sig.signalId);
                        }
                      }}
                      className="cursor-pointer hover:bg-elevated/50"
                    >
                      <td className="py-2 px-4 text-center">
                        <input
                          type="checkbox"
                          disabled={!canMutate}
                          checked={isRx}
                          onChange={() =>
                            onToggleSignalRx(sig.signalId, ecu.name)
                          }
                          className="accent-focus"
                        />
                      </td>
                      <td className="py-2 px-3 font-mono font-semibold text-ink">
                        {sig.name}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] tabular-nums text-focus">
                        {parentMsg
                          ? `${parentMsg.name} (${formatHexArbId(parentMsg.arbId, parentMsg.isExtended)})`
                          : sig.messageKey}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                        {sig.startBit} | {sig.bitLength}
                      </td>
                      <td className="py-2 px-4 font-mono text-muted">
                        {sig.unit || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </CandbModalShell>
  );
}

// ============================================================================
// 2. VALUE TABLE DIALOG (VAL_TABLE_)
// ============================================================================

type ValueTableTab = 'entries';

interface CandbValueTableDialogProps {
  mode?: 'create' | 'edit';
  valueTable: ReusableValueTableDto;
  tableIndex: number;
  schema: DatabaseSchemaDto;
  canMutate: boolean;
  onUpdateValueTable: (index: number, next: ReusableValueTableDto) => void;
  onCreateValueTable?: () => void;
  onDeleteValueTable: (index: number) => void;
  onApplyToSignal: (signalId: number, entries: Record<string, string>) => void;
  onClose: () => void;
}

export function CandbValueTableDialog({
  mode = 'edit',
  valueTable,
  tableIndex,
  schema,
  canMutate,
  onUpdateValueTable,
  onCreateValueTable,
  onDeleteValueTable,
  onApplyToSignal,
  onClose,
}: CandbValueTableDialogProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [newKey, setNewKey] = useState<string>('0');
  const [newDesc, setNewDesc] = useState<string>('');
  const [targetSignalId, setTargetSignalId] = useState<string>(
    schema.signals[0] ? String(schema.signals[0].signalId) : ''
  );
  const [appliedFlash, setAppliedFlash] = useState<boolean>(false);

  const msgByKey = useMemo(
    () => new Map(schema.messages.map((m) => [m.messageKey, m])),
    [schema.messages]
  );

  const sortedEntries = useMemo(
    () =>
      Object.entries(valueTable.entries).sort(
        ([a], [b]) => Number(a) - Number(b)
      ),
    [valueTable.entries]
  );

  const handleAddEntry = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMutate) return;
    const kNum = Math.trunc(Number(newKey));
    if (!Number.isFinite(kNum) || !newDesc.trim()) return;
    onUpdateValueTable(tableIndex, {
      ...valueTable,
      entries: {
        ...valueTable.entries,
        [String(kNum)]: newDesc.trim(),
      },
    });
    setNewKey(String(kNum + 1));
    setNewDesc('');
  };

  const handleApply = () => {
    if (!canMutate || targetSignalId === '') return;
    const sigId = Number.parseInt(targetSignalId, 10);
    if (!Number.isFinite(sigId)) return;
    onApplyToSignal(sigId, { ...valueTable.entries });
    setAppliedFlash(true);
    window.setTimeout(() => setAppliedFlash(false), 1800);
  };

  const tabs: ReadonlyArray<CandbModalTabItem<ValueTableTab>> = [
    {
      id: 'entries',
      label: t('vtDialog.tab.entries'),
      count: sortedEntries.length,
    },
  ];

  const isNameEmpty = valueTable.name.trim().length === 0;

  return (
    <CandbModalShell<ValueTableTab>
      badge={
        mode === 'create' ? t('vtDialog.badgeCreate') : t('vtDialog.badgeEdit')
      }
      title={
        mode === 'create'
          ? t('vtDialog.titleCreate', {
              name: valueTable.name.trim() || t('vtDialog.untitledTable'),
            })
          : t('vtDialog.titleEdit', { name: valueTable.name })
      }
      subtitle={t('vtDialog.subtitle', { count: sortedEntries.length })}
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      tabs={tabs}
      activeTab="entries"
      onTabChange={() => undefined}
      onClose={onClose}
      footer={
        mode === 'create' ? (
          <>
            <span className="text-[11px] text-muted">
              {t('vtDialog.cancelDraftHint')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-surface px-3 text-xs text-ink transition-colors hover:border-strong"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!canMutate || isNameEmpty}
                onClick={() => onCreateValueTable?.()}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                style={{ backgroundColor: 'var(--status-nominal)' }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('vtDialog.createBtn')}</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              {canMutate && (
                <button
                  type="button"
                  onClick={() => {
                    onDeleteValueTable(tableIndex);
                    onClose();
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-critical transition-colors hover:border-critical"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('vtDialog.deleteBtn')}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
            >
              {t('common.ok')}
            </button>
          </>
        )
      }
    >
      <div className="p-5 space-y-4 text-xs">
        <div className="space-y-1.5">
          <label className="block font-medium text-muted">
            {t('vtDialog.fieldName')}
          </label>
          <input
            type="text"
            disabled={!canMutate}
            value={valueTable.name}
            placeholder={t('vtDialog.placeholderName')}
            onChange={(e) =>
              onUpdateValueTable(tableIndex, {
                ...valueTable,
                name: e.target.value,
              })
            }
            className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
          />
          {isNameEmpty && (
            <p className="font-mono text-[11px] text-critical">
              {t('vtDialog.emptyNameError')}
            </p>
          )}
        </div>

        {/* Entries Table */}
        <div className="overflow-hidden rounded-[2px] border border-hairline bg-canvas">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
              <tr>
                <th className="w-28 py-2 px-3">{t('sigDialog.colIntValue')}</th>
                <th className="py-2 px-3">{t('vtDialog.colStateLabel')}</th>
                {canMutate && <th className="w-12 py-2 px-3 text-right" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline bg-surface">
              {sortedEntries.length === 0 ? (
                <tr>
                  <td
                    colSpan={canMutate ? 3 : 2}
                    className="py-6 text-center text-muted"
                  >
                    {t('vtDialog.emptyEntries')}
                  </td>
                </tr>
              ) : (
                sortedEntries.map(([k, desc]) => (
                  <tr key={k}>
                    <td className="py-1.5 px-3 font-mono font-semibold tabular-nums text-focus">
                      {k}
                    </td>
                    <td className="py-1.5 px-3">
                      <input
                        type="text"
                        disabled={!canMutate}
                        value={desc}
                        onChange={(e) =>
                          onUpdateValueTable(tableIndex, {
                            ...valueTable,
                            entries: {
                              ...valueTable.entries,
                              [k]: e.target.value,
                            },
                          })
                        }
                        className="h-7 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                      />
                    </td>
                    {canMutate && (
                      <td className="py-1.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            const copy = { ...valueTable.entries };
                            delete copy[k];
                            onUpdateValueTable(tableIndex, {
                              ...valueTable,
                              entries: copy,
                            });
                          }}
                          aria-label={t('sigDialog.deleteValEntryAria', {
                            key: k,
                          })}
                          className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-critical"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {canMutate && (
          <form onSubmit={handleAddEntry} className="flex items-center gap-2">
            <input
              type="number"
              step={1}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder={t('sigDialog.placeholderEnumVal')}
              className="h-8 w-28 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none"
            />
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder={t('vtDialog.placeholderDesc')}
              className="h-8 flex-1 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none"
            />
            <button
              type="submit"
              className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-3 text-xs font-medium text-ink hover:border-strong"
            >
              <Plus className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
              <span>{t('common.add')}</span>
            </button>
          </form>
        )}

        {/* Apply to Signal Helper */}
        {mode === 'edit' && canMutate && schema.signals.length > 0 && (
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-[2px] border border-hairline bg-canvas p-3.5">
            <div className="flex-1 min-w-[200px] space-y-1">
              <label className="block text-[11px] font-medium text-muted">
                {t('vtDialog.applyToSignalLabel')}
              </label>
              <select
                value={targetSignalId}
                onChange={(e) => setTargetSignalId(e.target.value)}
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink"
              >
                {schema.signals.map((s) => {
                  const m = msgByKey.get(s.messageKey);
                  return (
                    <option key={s.signalId} value={String(s.signalId)}>
                      {s.name} —{' '}
                      {m ? formatHexArbId(m.arbId, m.isExtended) : s.messageKey}
                    </option>
                  );
                })}
              </select>
            </div>

            <button
              type="button"
              onClick={handleApply}
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-3 text-xs font-semibold text-ink hover:border-strong"
            >
              {appliedFlash ? (
                <>
                  <Check
                    className="h-3.5 w-3.5 text-nominal"
                    aria-hidden="true"
                  />
                  <span className="text-nominal">
                    {t('vtDialog.appliedToSignalFlash')}
                  </span>
                </>
              ) : (
                <>
                  <span>{t('vtDialog.applyToSignalBtn')}</span>
                  <ArrowRight
                    className="h-3.5 w-3.5 text-focus"
                    aria-hidden="true"
                  />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </CandbModalShell>
  );
}

// ============================================================================
// 3. NETWORK / DATABASE PROPERTIES DIALOG
// ============================================================================

interface CandbNetworkDialogProps {
  databaseName: string;
  onChangeDatabaseName: (name: string) => void;
  dbcVersionString: string;
  onChangeDbcVersionString: (ver: string) => void;
  currentVersionBadge: string;
  networkComment: string;
  onChangeNetworkComment: (comment: string) => void;
  canMutate: boolean;
  onClose: () => void;
}

export function CandbNetworkDialog({
  databaseName,
  onChangeDatabaseName,
  dbcVersionString,
  onChangeDbcVersionString,
  currentVersionBadge,
  networkComment,
  onChangeNetworkComment,
  canMutate,
  onClose,
}: CandbNetworkDialogProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();

  return (
    <CandbModalShell
      badge={t('netDialog.badge')}
      title={t('netDialog.title')}
      subtitle={databaseName}
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      onClose={onClose}
      footer={
        <>
          <span className="text-[11px] text-muted">
            {t('netDialog.footerHint')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            {t('common.ok')}
          </button>
        </>
      }
    >
      <div className="p-5 space-y-4 text-xs">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

          {/* Database Name */}
          <div className="space-y-1.5">
            <label className="block font-medium text-muted">
              {t('netDialog.fieldDbName')}
            </label>
            <input
              type="text"
              disabled={!canMutate}
              value={databaseName}
              onChange={(e) => onChangeDatabaseName(e.target.value)}
              className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold text-ink focus:border-focus focus:outline-none disabled:opacity-60"
            />
          </div>


          {/* DBC Version String */}
          <div className="space-y-1.5">
            <label className="block font-medium text-muted">
              {t('netDialog.fieldDbcVersion')}
            </label>
            <input
              type="text"
              disabled={!canMutate}
              value={dbcVersionString}
              placeholder="1.0.0"
              onChange={(e) => onChangeDbcVersionString(e.target.value)}
              className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs tabular-nums text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
            />
          </div>

          {/* Current / Base Cloud Version Status */}
          <div className="space-y-1.5">
            <label className="block font-medium text-muted">
              {t('netDialog.fieldCloudStatus')}
            </label>
            <div className="flex h-8 w-full items-center rounded-[2px] border border-hairline bg-elevated/60 px-3 font-mono text-xs font-semibold tabular-nums text-nominal">
              {currentVersionBadge}
            </div>
          </div>


          {/* Network Comment */}
          <div className="sm:col-span-2 space-y-1.5">
            <label className="block font-medium text-muted">
              {t('netDialog.fieldComment')}
            </label>
            <textarea
              rows={4}
              disabled={!canMutate}
              value={networkComment}
              placeholder={t('netDialog.placeholderComment')}
              onChange={(e) => onChangeNetworkComment(e.target.value)}
              className="w-full rounded-[2px] border border-hairline bg-canvas p-3 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
            />
          </div>
        </div>
      </div>
    </CandbModalShell>
  );
}
