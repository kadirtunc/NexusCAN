import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  Database,
  Layers,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import type {
  MessageSchemaDto,
  NetworkDatabaseSummaryDto,
  SimulationGeneratorSpecDto,
  SimulationWidgetDto,
} from './contracts';
import {
  formatDatabaseShortBus,
  formatDraftPanelPreviewSummary,
  inferBusIdFromAssignment,
  makeCompositeMessageKey,
  planDraftPanelFromSelectedDatabases,
  type LoadedSimulationDatabaseEntry,
} from './virtualCanPacking';

export interface GenerateFromDbcConfirmPayload {
  name: string;
  description: string;
  targetDatabaseId: string | null;
  widgets: SimulationWidgetDto[];
  generators: SimulationGeneratorSpecDto[];
}

export interface SimulationGenerateFromDbcModalProps {
  open: boolean;
  mode?: 'create_new' | 'populate_current';
  currentPanelName?: string;
  databases: readonly NetworkDatabaseSummaryDto[];
  loadedDbEntries: readonly LoadedSimulationDatabaseEntry[];
  loadingSchemas: boolean;
  saving: boolean;
  onClose: () => void;
  onConfirmGenerate: (payload: GenerateFromDbcConfirmPayload) => void;
}

interface SelectableMessageRow {
  compositeKey: string;
  db: NetworkDatabaseSummaryDto;
  msg: MessageSchemaDto;
  signalCount: number;
  hexId: string;
}

export function SimulationGenerateFromDbcModal({
  open,
  mode = 'create_new',
  currentPanelName,
  databases,
  loadedDbEntries,
  loadingSchemas,
  saving,
  onClose,
  onConfirmGenerate,
}: SimulationGenerateFromDbcModalProps): React.JSX.Element | null {
  const { t } = useI18n();

  const suggestPanelName = useCallback(
    (selectedDbs: readonly NetworkDatabaseSummaryDto[]): string => {
      if (selectedDbs.length === 0) {
        return t('simPal.genModal.defaultDraftPanelName');
      }
      if (selectedDbs.length === 1) {
        return t('simPal.genModal.singleDbDraftPanelName', {
          name: selectedDbs[0]!.name,
        });
      }
      if (selectedDbs.length === 2) {
        return t('simPal.genModal.twoDbDraftPanelName', {
          name1: selectedDbs[0]!.name,
          name2: selectedDbs[1]!.name,
        });
      }
      return t('simPal.genModal.multiDbDraftPanelName', {
        name: selectedDbs[0]!.name,
        count: selectedDbs.length - 1,
      });
    },
    [t]
  );

  const suggestPanelDescription = useCallback(
    (
      selectedDbs: readonly NetworkDatabaseSummaryDto[],
      selectedMsgCount: number,
      selectedSigCount: number
    ): string => {
      if (selectedDbs.length === 0) {
        return '';
      }
      const dbList = selectedDbs.map((d) => `${d.name}.${d.format}`).join(', ');
      return t('simPal.genModal.suggestedDesc', {
        dbList,
        msgCount: selectedMsgCount,
        sigCount: selectedSigCount,
      });
    },
    [t]
  );

  const [selectedDbIds, setSelectedDbIds] = useState<Set<string>>(new Set());
  const [useAllMessages, setUseAllMessages] = useState<boolean>(true);
  const [selectedMsgKeys, setSelectedMsgKeys] = useState<Set<string>>(
    new Set()
  );
  const [msgQuery, setMsgQuery] = useState<string>('');
  const [panelName, setPanelName] = useState<string>('');
  const [hasCustomName, setHasCustomName] = useState<boolean>(false);
  const [panelDescription, setPanelDescription] = useState<string>('');
  const [hasCustomDescription, setHasCustomDescription] =
    useState<boolean>(false);

  // Reset modal state cleanly whenever opened
  useEffect(() => {
    if (!open) return;
    const initialDbSet =
      databases.length === 1 && databases[0]
        ? new Set<string>([databases[0].id])
        : new Set<string>();
    setSelectedDbIds(initialDbSet);
    setUseAllMessages(true);
    setSelectedMsgKeys(new Set());
    setMsgQuery('');
    setHasCustomName(false);
    setHasCustomDescription(false);

    const initialChosenDbs = databases.filter((d) => initialDbSet.has(d.id));
    setPanelName(suggestPanelName(initialChosenDbs));
    setPanelDescription('');
  }, [databases, open, suggestPanelName]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, saving]);

  const entryByDbId = useMemo(() => {
    const map = new Map<string, LoadedSimulationDatabaseEntry>();
    for (const entry of loadedDbEntries) {
      map.set(entry.db.id, entry);
    }
    return map;
  }, [loadedDbEntries]);

  const selectedDatabases = useMemo(
    () => databases.filter((db) => selectedDbIds.has(db.id)),
    [databases, selectedDbIds]
  );

  // Update auto-suggested name if user hasn't manually typed one
  useEffect(() => {
    if (!open || hasCustomName) return;
    setPanelName(suggestPanelName(selectedDatabases));
  }, [hasCustomName, open, selectedDatabases, suggestPanelName]);

  const availableMessages = useMemo<SelectableMessageRow[]>(() => {
    const rows: SelectableMessageRow[] = [];
    for (const db of selectedDatabases) {
      const entry = entryByDbId.get(db.id);
      if (!entry) continue;
      const sigCountByMsg = new Map<string, number>();
      for (const sig of entry.schema.signals) {
        sigCountByMsg.set(
          sig.messageKey,
          (sigCountByMsg.get(sig.messageKey) ?? 0) + 1
        );
      }
      for (const msg of entry.schema.messages) {
        rows.push({
          compositeKey: makeCompositeMessageKey(db.id, msg.messageKey),
          db,
          msg,
          signalCount: sigCountByMsg.get(msg.messageKey) ?? msg.signalIds.length,
          hexId: `0x${msg.arbId.toString(16).toUpperCase()}`,
        });
      }
    }
    return rows;
  }, [entryByDbId, selectedDatabases]);

  const filteredMessages = useMemo<SelectableMessageRow[]>(() => {
    const q = msgQuery.trim().toLowerCase();
    if (!q) return availableMessages;
    return availableMessages.filter(
      (row) =>
        row.msg.name.toLowerCase().includes(q) ||
        row.hexId.toLowerCase().includes(q) ||
        row.db.name.toLowerCase().includes(q) ||
        row.msg.messageKey.toLowerCase().includes(q)
    );
  }, [availableMessages, msgQuery]);

  const effectiveMsgFilterSet = useMemo<ReadonlySet<string> | null>(() => {
    if (useAllMessages) return null;
    return selectedMsgKeys;
  }, [selectedMsgKeys, useAllMessages]);

  const draftPlan = useMemo(
    () =>
      planDraftPanelFromSelectedDatabases(
        loadedDbEntries,
        selectedDbIds,
        effectiveMsgFilterSet
      ),
    [effectiveMsgFilterSet, loadedDbEntries, selectedDbIds]
  );

  const previewText = useMemo(
    () => formatDraftPanelPreviewSummary(draftPlan.counts),
    [draftPlan.counts]
  );

  if (!open) return null;

  const toggleDatabase = (dbId: string) => {
    setSelectedDbIds((prev) => {
      const next = new Set(prev);
      if (next.has(dbId)) {
        next.delete(dbId);
      } else {
        next.add(dbId);
      }
      return next;
    });
  };

  const handleSelectAllDatabases = () => {
    setSelectedDbIds(new Set(databases.map((d) => d.id)));
  };

  const handleClearDatabases = () => {
    setSelectedDbIds(new Set());
  };

  const handleToggleAllMessagesMode = (checked: boolean) => {
    if (checked) {
      setUseAllMessages(true);
    } else {
      setUseAllMessages(false);
      setSelectedMsgKeys(
        new Set(availableMessages.map((m) => m.compositeKey))
      );
    }
  };

  const handleToggleSingleMessage = (compositeKey: string) => {
    if (useAllMessages) {
      const allExceptThis = new Set(
        availableMessages
          .map((m) => m.compositeKey)
          .filter((k) => k !== compositeKey)
      );
      setUseAllMessages(false);
      setSelectedMsgKeys(allExceptThis);
      return;
    }

    setSelectedMsgKeys((prev) => {
      const next = new Set(prev);
      if (next.has(compositeKey)) {
        next.delete(compositeKey);
      } else {
        next.add(compositeKey);
      }
      return next;
    });
  };

  const canSubmit =
    !saving &&
    !loadingSchemas &&
    selectedDbIds.size > 0 &&
    draftPlan.counts.totalInstruments > 0 &&
    (mode === 'populate_current' || panelName.trim().length > 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const finalDesc = hasCustomDescription
      ? panelDescription.trim()
      : suggestPanelDescription(
          selectedDatabases,
          draftPlan.counts.selectedMessageCount,
          draftPlan.counts.selectedSignalCount
        );

    const singleDbId =
      selectedDbIds.size === 1 ? (Array.from(selectedDbIds)[0] ?? null) : null;

    onConfirmGenerate({
      name:
        mode === 'populate_current'
          ? (currentPanelName ?? panelName.trim())
          : panelName.trim(),
      description: finalDesc,
      targetDatabaseId: singleDbId,
      widgets: draftPlan.widgets,
      generators: draftPlan.generators,
    });
  };

  const checkedMsgCount = useAllMessages
    ? availableMessages.length
    : availableMessages.filter((m) => selectedMsgKeys.has(m.compositeKey))
        .length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-scrim)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sim-generate-dbc-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-[2px] border border-strong bg-surface">
        {/* Modal Header */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline bg-elevated px-4">
          <div className="flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
            <h2
              id="sim-generate-dbc-modal-title"
              className="font-mono text-xs font-bold uppercase tracking-wider text-ink"
            >
              {mode === 'populate_current'
                ? t('simPal.genModal.titlePopulate')
                : t('simPal.genModal.titleCreate')}
            </h2>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            aria-label={t('simPal.genModal.closeAria')}
            className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-ink focus-visible:outline-1 focus-visible:outline-focus"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {/* Top Clear 1-Line Explanation */}
            <div className="rounded-[2px] border border-hairline bg-canvas p-3 text-xs leading-relaxed text-ink">
              {mode === 'populate_current' ? (
                <p>
                  {t('simPal.genModal.explainPopulate', {
                    name: currentPanelName ?? '',
                  })}
                </p>
              ) : (
                <p>
                  {t('simPal.genModal.explainCreate')}
                </p>
              )}
            </div>

            {/* Step 1: Panel Name & Optional Description (Create Mode) */}
            {mode === 'create_new' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {t('simPal.genModal.panelNameLabel')}
                  </span>
                  <input
                    type="text"
                    required
                    value={panelName}
                    onChange={(e) => {
                      setPanelName(e.target.value);
                      setHasCustomName(true);
                    }}
                    placeholder={t('simPal.genModal.panelNamePlaceholder')}
                    className="h-[32px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-[12.5px] text-ink focus-visible:border-focus focus-visible:outline-none"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">
                    {t('simPal.genModal.descriptionLabel')}
                  </span>
                  <input
                    type="text"
                    value={panelDescription}
                    onChange={(e) => {
                      setPanelDescription(e.target.value);
                      setHasCustomDescription(true);
                    }}
                    placeholder={t('simPal.genModal.descriptionPlaceholder')}
                    className="h-[32px] w-full rounded-[2px] border border-hairline bg-canvas px-2.5 text-[12.5px] text-ink focus-visible:border-focus focus-visible:outline-none"
                  />
                </label>
              </div>
            )}

            {/* Step 2: Explicit Source Database Selection (Mandatory — User Chooses!) */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {t('simPal.genModal.stepSourceDb', {
                    step: mode === 'create_new' ? '2.' : '1.',
                  })}
                </span>
                {databases.length > 1 && (
                  <div className="flex items-center gap-1.5 font-mono text-[10px]">
                    <button
                      type="button"
                      onClick={handleSelectAllDatabases}
                      className="cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2 py-0.5 font-semibold uppercase text-focus hover:border-strong"
                    >
                      {t('simPal.genModal.selectAllDbs', {
                        count: databases.length,
                      })}
                    </button>
                    <button
                      type="button"
                      onClick={handleClearDatabases}
                      className="cursor-pointer rounded-[2px] border border-hairline bg-canvas px-2 py-0.5 uppercase text-muted hover:border-strong hover:text-ink"
                    >
                      {t('simPal.genModal.clearDbs')}
                    </button>
                  </div>
                )}
              </div>

              {loadingSchemas ? (
                <div className="rounded-[2px] border border-hairline bg-canvas px-4 py-6 text-center font-mono text-xs uppercase text-muted">
                  {t('simPal.genModal.loadingSchemas')}
                </div>
              ) : (
                <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-[2px] border border-hairline bg-canvas p-2">
                  {databases.map((db) => {
                    const checked = selectedDbIds.has(db.id);
                    const entry = entryByDbId.get(db.id);
                    const msgCount =
                      entry?.schema.messages.length ??
                      db.latestVersion.messageCount;
                    const sigCount =
                      entry?.schema.signals.length ??
                      db.latestVersion.signalCount;
                    const shortBus = formatDatabaseShortBus(db);
                    const busIdx = inferBusIdFromAssignment(db.busAssignment);

                    return (
                      <label
                        key={db.id}
                        className={`flex cursor-pointer items-center justify-between gap-3 rounded-[2px] border px-3 py-2 transition-colors ${
                          checked
                            ? 'border-focus bg-elevated'
                            : 'border-hairline bg-surface hover:border-strong'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDatabase(db.id)}
                            className="h-3.5 w-3.5 shrink-0 rounded-[2px] accent-[var(--status-focus)]"
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                              <span className="truncate font-bold text-ink">
                                {db.name}
                              </span>
                              <span className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 text-[9px] font-semibold uppercase text-focus">
                                .{db.format.toUpperCase()}
                              </span>
                              <span className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 text-[9px] tabular-nums text-muted">
                                {db.busAssignment || shortBus} (BUS {busIdx})
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
                          {t('simPal.genModal.msgAndSigCount', {
                            msgCount,
                            sigCount,
                          })}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {selectedDbIds.size === 0 && !loadingSchemas && (
                <p className="font-mono text-[10px] text-warn">
                  {t('simPal.genModal.warnSelectDb')}
                </p>
              )}
            </div>

            {/* Step 3: Optional CAN Message Filter */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {t('simPal.genModal.stepMsgFilter', {
                    step: mode === 'create_new' ? '3.' : '2.',
                  })}
                </span>

                {availableMessages.length > 0 && (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tabular-nums text-ink">
                    <input
                      type="checkbox"
                      checked={useAllMessages}
                      onChange={(e) =>
                        handleToggleAllMessagesMode(e.target.checked)
                      }
                      className="h-3.5 w-3.5 rounded-[2px] accent-[var(--status-focus)]"
                    />
                    <span>
                      {t('simPal.genModal.allMessagesCheck', {
                        checked: checkedMsgCount,
                        total: availableMessages.length,
                      })}
                    </span>
                  </label>
                )}
              </div>

              {selectedDbIds.size === 0 ? (
                <div className="rounded-[2px] border border-hairline bg-canvas px-3 py-4 text-center font-mono text-[11px] text-subtle">
                  {t('simPal.genModal.emptyDbSelectHint')}
                </div>
              ) : availableMessages.length === 0 ? (
                <div className="rounded-[2px] border border-hairline bg-canvas px-3 py-4 text-center font-mono text-[11px] text-muted">
                  {t('simPal.genModal.emptyMessages')}
                </div>
              ) : (
                <div className="space-y-1.5 rounded-[2px] border border-hairline bg-canvas p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="relative min-w-[200px] flex-1">
                      <Search
                        className="pointer-events-none absolute top-1.5 left-2 h-3 w-3 text-subtle"
                        aria-hidden="true"
                      />
                      <input
                        type="text"
                        value={msgQuery}
                        onChange={(e) => setMsgQuery(e.target.value)}
                        placeholder={t('simPal.genModal.filterMsgPlaceholder')}
                        aria-label={t('simPal.genModal.filterMsgAria')}
                        className="h-6 w-full rounded-[2px] border border-hairline bg-surface pr-2 pl-6 font-mono text-[10px] text-ink placeholder:text-subtle"
                      />
                    </div>

                    <div className="flex items-center gap-1 font-mono text-[9px]">
                      <button
                        type="button"
                        onClick={() => setUseAllMessages(true)}
                        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 font-semibold uppercase text-focus hover:border-strong"
                      >
                        <CheckSquare className="h-2.5 w-2.5" aria-hidden="true" />
                        {t('simPal.genModal.filterAll')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setUseAllMessages(false);
                          setSelectedMsgKeys(new Set());
                        }}
                        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 uppercase text-muted hover:border-strong hover:text-ink"
                      >
                        <Square className="h-2.5 w-2.5" aria-hidden="true" />
                        {t('simPal.genModal.filterNone')}
                      </button>
                    </div>
                  </div>

                  <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto pt-1 sm:grid-cols-2">
                    {filteredMessages.map((row) => {
                      const isChecked =
                        useAllMessages ||
                        selectedMsgKeys.has(row.compositeKey);
                      return (
                        <label
                          key={row.compositeKey}
                          className={`flex cursor-pointer items-center justify-between gap-2 rounded-[2px] border px-2 py-1 font-mono text-[10px] tabular-nums ${
                            isChecked
                              ? 'border-strong bg-surface text-ink'
                              : 'border-hairline bg-canvas text-muted opacity-75'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() =>
                                handleToggleSingleMessage(row.compositeKey)
                              }
                              className="h-3 w-3 shrink-0 rounded-[2px] accent-[var(--status-focus)]"
                            />
                            {selectedDbIds.size > 1 && (
                              <span className="shrink-0 rounded-[1px] border border-hairline bg-elevated px-1 text-[9px] text-muted">
                                [{row.db.name}]
                              </span>
                            )}
                            <span className="shrink-0 font-bold text-focus">
                              {row.hexId}
                            </span>
                            <span className="truncate">{row.msg.name}</span>
                          </span>
                          <span className="shrink-0 text-[9px] text-subtle">
                            {t('simPal.genModal.sigShort', {
                              count: row.signalCount,
                            })}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Live Preview Summary Card */}
            <div className="rounded-[2px] border border-strong bg-elevated p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider tabular-nums">
                <span className="inline-flex items-center gap-1.5 font-bold text-ink">
                  <Sparkles
                    className="h-3.5 w-3.5 text-nominal"
                    aria-hidden="true"
                  />
                  {t('simPal.genModal.previewTitle')}
                </span>
                <span className="text-muted">
                  {t('simPal.genModal.previewStats', {
                    dbCount: draftPlan.counts.sourceDatabaseCount,
                    msgCount: draftPlan.counts.selectedMessageCount,
                    sigCount: draftPlan.counts.selectedSignalCount,
                  })}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[11px] tabular-nums text-ink">
                {previewText}
              </p>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline bg-elevated px-4 py-3">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-muted">
              <Layers className="h-3 w-3 text-focus" aria-hidden="true" />
              {t('simPal.genModal.footerNote')}
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={onClose}
                className="h-8 cursor-pointer rounded-[2px] border border-hairline bg-surface px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:border-strong"
              >
                {t('simPal.genModal.cancelBtn')}
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="h-8 cursor-pointer rounded-[2px] px-4 font-mono text-[11px] font-bold uppercase text-white disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: 'var(--status-focus)' }}
              >
                {saving
                  ? t('simPal.genModal.generatingBtn')
                  : mode === 'populate_current'
                    ? t('simPal.genModal.populateBtn')
                    : t('simPal.genModal.createBtn')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
