'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Cpu,
  Edit3,
  Grid,
  Layers,
  ListTree,
  Network,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BitOverlapDiagnosticDto,
  DatabaseSchemaDto,
  MessageSchemaDto,
  ReusableValueTableDto,
  SignalSchemaDto,
} from './contracts';
import {
  formatHexArbId,
  formatMessageIdFormatLabel,
  formatMuxRangesText,
  getMessageIdFormat,
  getSignalColor,
  type CandbSelectedRow,
  type CandbViewTarget,
} from './dbcEditorUtils';
import { CandbNodeGraph } from './CandbNodeGraph';
import {
  useDbcStudioI18n,
  type DbcStudioShardKey,
} from './i18n/dbcStudio';

interface CandbListViewProps {
  databaseName: string;
  busAssignment: string;
  versionLabel: string;
  networkComment: string;
  schema: DatabaseSchemaDto;
  nodeGraphStorageKey?: string;
  valueTables: readonly ReusableValueTableDto[];
  bitOverlaps: readonly BitOverlapDiagnosticDto[];
  viewTarget: CandbViewTarget;
  selectedRow: CandbSelectedRow | null;
  canMutate: boolean;
  onSelectRow: (row: CandbSelectedRow | null) => void;
  onOpenNetworkDialog: () => void;
  onOpenEcuDialog: (ecuName: string) => void;
  onOpenMessageDialog: (messageKey: string, openLayoutTab?: boolean) => void;
  onOpenSignalDialog: (signalId: number, returnToMessageKey?: string) => void;
  onOpenValueTableDialog: (tableIndex: number) => void;
  onAddEcu: () => void;
  onDeleteEcu: (ecuName: string) => void;
  onAddMessage: () => void;
  onCloneMessage: (messageKey: string) => void;
  onDeleteMessage: (messageKey: string) => void;
  onAddSignal: (messageKey?: string) => void;
  onCloneSignal: (signalId: number) => void;
  onDeleteSignal: (signalId: number) => void;
  onAddValueTable: () => void;
  onCloneValueTable: (tableIndex: number) => void;
  onDeleteValueTable: (tableIndex: number) => void;
}

function getValueTypeShardKey(
  vt: SignalSchemaDto['valueType']
): DbcStudioShardKey {
  switch (vt) {
    case 'unsigned':
      return 'list.valueType.unsigned';
    case 'signed':
      return 'list.valueType.signed';
    case 'float32':
      return 'list.valueType.float32';
    case 'float64':
      return 'list.valueType.float64';
  }
}

export function CandbListView({
  databaseName,
  busAssignment,
  versionLabel,
  networkComment,
  schema,
  valueTables,
  bitOverlaps,
  viewTarget,
  selectedRow,
  canMutate,
  onSelectRow,
  onOpenNetworkDialog,
  onOpenEcuDialog,
  onOpenMessageDialog,
  onOpenSignalDialog,
  onOpenValueTableDialog,
  onAddEcu,
  onDeleteEcu,
  onAddMessage,
  onCloneMessage,
  onDeleteMessage,
  onAddSignal,
  onCloneSignal,
  onDeleteSignal,
  onAddValueTable,
  onCloneValueTable,
  onDeleteValueTable,
  nodeGraphStorageKey,
}: CandbListViewProps): React.JSX.Element {
  const { locale, t } = useDbcStudioI18n();
  const [filterText, setFilterText] = useState<string>('');
  const [ecuViewMode, setEcuViewMode] = useState<'table' | 'graph'>('table');
  const f = filterText.trim().toLowerCase();

  const formatMuxBadge = (sig: SignalSchemaDto): string => {
    if (sig.muxRole === 'masterSwitch') return t('common.switchMaster');
    if (sig.muxRole === 'multiplexed') {
      return `m (${formatMuxRangesText(sig.muxRanges)})`;
    }
    return t('common.static');
  };

  const msgByKey = useMemo(() => {
    const map = new Map<string, MessageSchemaDto>();
    for (const m of schema.messages) {
      map.set(m.messageKey, m);
    }
    return map;
  }, [schema.messages]);

  const signalsByMsg = useMemo(() => {
    const map = new Map<string, SignalSchemaDto[]>();
    for (const s of schema.signals) {
      const list = map.get(s.messageKey);
      if (list) {
        list.push(s);
      } else {
        map.set(s.messageKey, [s]);
      }
    }
    return map;
  }, [schema.signals]);

  const overlapMsgKeys = useMemo(() => {
    const set = new Set<string>();
    for (const ov of bitOverlaps) {
      set.add(ov.messageKey);
    }
    return set;
  }, [bitOverlaps]);

  const focusedMessage = useMemo(() => {
    if (viewTarget.kind !== 'messageSignals') return null;
    return msgByKey.get(viewTarget.messageKey) ?? null;
  }, [msgByKey, viewTarget]);

  const focusedEcu = useMemo(() => {
    if (viewTarget.kind !== 'ecuDetail') return null;
    return schema.ecus.find((e) => e.name === viewTarget.ecuName) ?? null;
  }, [schema.ecus, viewTarget]);

  // Filtered datasets for active view
  const ecusRows = useMemo(() => {
    if (!f) return schema.ecus;
    return schema.ecus.filter(
      (e) =>
        e.name.toLowerCase().includes(f) ||
        (e.comment?.toLowerCase().includes(f) ?? false)
    );
  }, [f, schema.ecus]);

  const messagesRows = useMemo(() => {
    const base =
      viewTarget.kind === 'ecuDetail' && focusedEcu
        ? schema.messages.filter((m) =>
            m.transmitters.includes(focusedEcu.name)
          )
        : schema.messages;
    if (!f) return base;
    return base.filter((m) => {
      const hex = formatHexArbId(m.arbId, m.isExtended).toLowerCase();
      return (
        m.name.toLowerCase().includes(f) ||
        hex.includes(f) ||
        String(m.arbId).includes(f) ||
        m.transmitters.some((t) => t.toLowerCase().includes(f)) ||
        (m.comment?.toLowerCase().includes(f) ?? false)
      );
    });
  }, [f, focusedEcu, schema.messages, viewTarget]);

  const signalsRows = useMemo(() => {
    let base: readonly SignalSchemaDto[] = schema.signals;
    if (viewTarget.kind === 'messageSignals') {
      base = signalsByMsg.get(viewTarget.messageKey) ?? [];
    } else if (viewTarget.kind === 'ecuDetail' && focusedEcu) {
      base = schema.signals.filter((s) =>
        s.receivers.includes(focusedEcu.name)
      );
    }
    if (!f) return base;
    return base.filter((s) => {
      const parent = msgByKey.get(s.messageKey);
      const parentName = parent?.name.toLowerCase() ?? '';
      const parentHex = parent
        ? formatHexArbId(parent.arbId, parent.isExtended).toLowerCase()
        : '';
      return (
        s.name.toLowerCase().includes(f) ||
        (s.longName?.toLowerCase().includes(f) ?? false) ||
        s.unit.toLowerCase().includes(f) ||
        parentName.includes(f) ||
        parentHex.includes(f) ||
        s.receivers.some((r) => r.toLowerCase().includes(f))
      );
    });
  }, [f, focusedEcu, msgByKey, schema.signals, signalsByMsg, viewTarget]);

  const valueTableRows = useMemo(() => {
    const indexed = valueTables.map((vt, idx) => ({ vt, idx }));
    if (!f) return indexed;
    return indexed.filter(
      ({ vt }) =>
        vt.name.toLowerCase().includes(f) ||
        Object.entries(vt.entries).some(
          ([k, v]) => k.includes(f) || v.toLowerCase().includes(f)
        )
    );
  }, [f, valueTables]);

  // Execute Edit / Clone / Delete on currently selected row
  const handleEditSelected = () => {
    if (!selectedRow) return;
    switch (selectedRow.kind) {
      case 'network':
        onOpenNetworkDialog();
        break;
      case 'ecu':
        onOpenEcuDialog(selectedRow.ecuName);
        break;
      case 'message':
        onOpenMessageDialog(selectedRow.messageKey, false);
        break;
      case 'signal':
        onOpenSignalDialog(selectedRow.signalId);
        break;
      case 'valueTable':
        onOpenValueTableDialog(selectedRow.tableIndex);
        break;
    }
  };

  const handleCloneSelected = () => {
    if (!canMutate || !selectedRow) return;
    if (selectedRow.kind === 'message') {
      onCloneMessage(selectedRow.messageKey);
    } else if (selectedRow.kind === 'signal') {
      onCloneSignal(selectedRow.signalId);
    } else if (selectedRow.kind === 'valueTable') {
      onCloneValueTable(selectedRow.tableIndex);
    }
  };

  const handleDeleteSelected = () => {
    if (!canMutate || !selectedRow) return;
    if (selectedRow.kind === 'ecu') {
      onDeleteEcu(selectedRow.ecuName);
    } else if (selectedRow.kind === 'message') {
      onDeleteMessage(selectedRow.messageKey);
    } else if (selectedRow.kind === 'signal') {
      onDeleteSignal(selectedRow.signalId);
    } else if (selectedRow.kind === 'valueTable') {
      onDeleteValueTable(selectedRow.tableIndex);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (targetTag === 'input' || targetTag === 'textarea') return;
    if (e.key === 'Enter' && selectedRow) {
      e.preventDefault();
      handleEditSelected();
    } else if (e.key === 'Delete' && selectedRow && canMutate) {
      e.preventDefault();
      handleDeleteSelected();
    }
  };

  // Determine active view metadata for toolbar
  const toolbarMeta = useMemo(() => {
    if (viewTarget.kind === 'messageSignals') {
      return {
        title: focusedMessage
          ? t('list.toolbar.messageSignalsWithName', {
              name: focusedMessage.name,
            })
          : t('list.toolbar.messageSignalsFallback'),
        count: signalsRows.length,
        addLabel: t('list.toolbar.addSignal'),
        onAdd: focusedMessage
          ? () => onAddSignal(focusedMessage.messageKey)
          : undefined,
      };
    }
    if (viewTarget.kind === 'ecuDetail') {
      return {
        title: focusedEcu
          ? t('list.toolbar.ecuDetailWithName', { name: focusedEcu.name })
          : t('list.toolbar.ecuDetailFallback'),
        count: messagesRows.length + signalsRows.length,
        addLabel: undefined,
        onAdd: undefined,
      };
    }
    switch (viewTarget.folder) {
      case 'networks':
        return {
          title: t('list.toolbar.networks'),
          count: 1,
          addLabel: undefined,
          onAdd: undefined,
        };
      case 'ecus':
        return {
          title: t('list.toolbar.ecus'),
          count: ecusRows.length,
          addLabel: t('list.toolbar.addEcu'),
          onAdd: onAddEcu,
        };
      case 'messages':
        return {
          title: t('list.toolbar.messages'),
          count: messagesRows.length,
          addLabel: t('list.toolbar.addMessage'),
          onAdd: onAddMessage,
        };
      case 'signals':
        return {
          title: t('list.toolbar.signals'),
          count: signalsRows.length,
          addLabel:
            schema.messages.length > 0
              ? t('list.toolbar.addSignal')
              : undefined,
          onAdd:
            schema.messages.length > 0 ? () => onAddSignal() : undefined,
        };
      case 'valueTables':
        return {
          title: t('list.toolbar.valueTables'),
          count: valueTableRows.length,
          addLabel: t('list.toolbar.addValueTable'),
          onAdd: onAddValueTable,
        };
    }
  }, [
    ecusRows.length,
    focusedEcu,
    focusedMessage,
    messagesRows.length,
    onAddEcu,
    onAddMessage,
    onAddSignal,
    onAddValueTable,
    schema.messages.length,
    signalsRows.length,
    t,
    valueTableRows.length,
    viewTarget,
  ]);

  const canCloneRow =
    canMutate &&
    selectedRow !== null &&
    (selectedRow.kind === 'message' ||
      selectedRow.kind === 'signal' ||
      selectedRow.kind === 'valueTable');

  const canDeleteRow =
    canMutate && selectedRow !== null && selectedRow.kind !== 'network';

  const layoutTargetMessageKey =
    selectedRow?.kind === 'message'
      ? selectedRow.messageKey
      : selectedRow?.kind === 'signal'
        ? selectedRow.messageKey
        : focusedMessage?.messageKey ?? null;

  return (
    <section
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas focus:outline-none"
    >
      {/* Contextual Summary Bar when a Message is single-clicked in Left Tree */}
      {viewTarget.kind === 'messageSignals' && focusedMessage && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <Layers className="h-4 w-4 text-focus" aria-hidden="true" />
            <span className="rounded-[2px] border border-hairline bg-canvas px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-focus">
              {formatHexArbId(focusedMessage.arbId, focusedMessage.isExtended)}
            </span>
            <span className="font-semibold text-ink">
              {focusedMessage.name}
            </span>
            <span className="text-subtle">·</span>
            <span className="font-mono text-[11px] text-muted">
              {formatMessageIdFormatLabel(
                getMessageIdFormat(focusedMessage),
                locale
              )}
            </span>
            <span className="text-subtle">·</span>
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {t('list.summary.dlcBits', {
                dlc: focusedMessage.dlc,
                bits: focusedMessage.dlc * 8,
              })}
            </span>
            <span className="text-subtle">·</span>
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {focusedMessage.expectedCycleMs
                ? `${focusedMessage.expectedCycleMs} ms`
                : t('common.async')}
            </span>
            <span className="text-subtle">·</span>
            <span className="font-mono text-[11px] text-muted">
              TX:{' '}
              <strong className="text-ink">
                {focusedMessage.transmitters.join(', ') ||
                  t('common.unassignedNode')}
              </strong>
            </span>
            {overlapMsgKeys.has(focusedMessage.messageKey) && (
              <button
                type="button"
                onClick={() =>
                  onOpenMessageDialog(focusedMessage.messageKey, true)
                }
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-[2px] border px-2 font-mono text-[10px] font-semibold"
                style={{
                  backgroundColor: 'var(--status-critical-bg)',
                  borderColor: 'var(--status-critical)',
                  color: 'var(--status-critical)',
                }}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                <span>{t('list.summary.bitOverlap')}</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                onOpenMessageDialog(focusedMessage.messageKey, false)
              }
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs font-medium text-ink transition-colors hover:border-strong"
            >
              <Edit3 className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              <span>{t('list.summary.editMessage')}</span>
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenMessageDialog(focusedMessage.messageKey, true)
              }
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs font-medium text-ink transition-colors hover:border-strong"
            >
              <Grid className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              <span>{t('list.summary.bitLayout')}</span>
            </button>
            {canMutate && (
              <button
                type="button"
                onClick={() => onAddSignal(focusedMessage.messageKey)}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] bg-focus px-2.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('list.summary.addSignalBtn')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Contextual Summary Bar when an ECU Leaf is single-clicked in Left Tree */}
      {viewTarget.kind === 'ecuDetail' && focusedEcu && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <Cpu className="h-4 w-4 text-focus" aria-hidden="true" />
            <span className="font-mono text-xs font-semibold text-ink">
              {focusedEcu.name}
            </span>
            <span className="text-subtle">·</span>
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {t('list.summary.ecuTxRxCounts', {
                tx: messagesRows.length,
                rx: signalsRows.length,
              })}
            </span>
            {focusedEcu.comment && (
              <>
                <span className="text-subtle">·</span>
                <span className="truncate text-muted">{focusedEcu.comment}</span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => onOpenEcuDialog(focusedEcu.name)}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs font-medium text-ink transition-colors hover:border-strong"
          >
            <Edit3 className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <span>{t('list.summary.editEcuProps')}</span>
          </button>
        </div>
      )}

      {/* List View Action & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-hairline bg-elevated/70 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xs font-semibold text-ink">{toolbarMeta.title}</h2>
          <span className="rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted">
            {t('list.toolbar.itemCount', { count: toolbarMeta.count })}
          </span>

          {viewTarget.kind === 'folder' && viewTarget.folder === 'ecus' && (
            <div
              role="group"
              aria-label={t('nodeGraph.toggle.aria')}
              className="inline-flex overflow-hidden rounded-[2px] border border-hairline"
            >
              {(['table', 'graph'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={ecuViewMode === mode}
                  onClick={() => setEcuViewMode(mode)}
                  className={`h-7 cursor-pointer px-2.5 text-xs transition-colors ${
                    ecuViewMode === mode
                      ? 'bg-focus font-semibold text-on-accent'
                      : 'bg-surface text-ink hover:bg-elevated'
                  }`}
                >
                  {t(mode === 'table' ? 'nodeGraph.toggle.table' : 'nodeGraph.toggle.graph')}
                </button>
              ))}
            </div>
          )}

          {/* Local Filter */}
          {!(viewTarget.kind === 'folder' && viewTarget.folder === 'networks') && (
            <div className="relative ml-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder={t('list.toolbar.filterPlaceholder')}
                aria-label={t('list.toolbar.filterAria')}
                className="h-7 w-44 rounded-[2px] border border-hairline bg-canvas pr-6 pl-6.5 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none"
              />
              {filterText && (
                <button
                  type="button"
                  onClick={() => setFilterText('')}
                  aria-label={t('list.toolbar.clearFilterAria')}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-muted hover:text-ink"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          <span className="hidden text-[11px] text-subtle xl:inline">
            {t('list.toolbar.doubleClickHint')}
          </span>
        </div>

        {/* Right Row Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {canMutate &&
            toolbarMeta.onAdd &&
            toolbarMeta.addLabel &&
            viewTarget.kind !== 'messageSignals' && (
              <button
                type="button"
                onClick={toolbarMeta.onAdd}
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] bg-focus px-2.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{toolbarMeta.addLabel.replace(/^\+\s*/, '')}</span>
              </button>
            )}

          <button
            type="button"
            disabled={!selectedRow}
            onClick={handleEditSelected}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink transition-colors hover:border-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Edit3 className="h-3 w-3 text-focus" aria-hidden="true" />
            <span>{t('common.edit')}</span>
          </button>

          {layoutTargetMessageKey &&
            (viewTarget.kind === 'messageSignals' ||
              (viewTarget.kind === 'folder' &&
                viewTarget.folder === 'messages')) && (
              <button
                type="button"
                onClick={() =>
                  onOpenMessageDialog(layoutTargetMessageKey, true)
                }
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink transition-colors hover:border-strong"
              >
                <Grid className="h-3 w-3 text-focus" aria-hidden="true" />
                <span>{t('common.layout')}</span>
              </button>
            )}

          <button
            type="button"
            disabled={!canCloneRow}
            onClick={handleCloneSelected}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink transition-colors hover:border-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Copy className="h-3 w-3 text-muted" aria-hidden="true" />
            <span>{t('common.duplicate')}</span>
          </button>

          <button
            type="button"
            disabled={!canDeleteRow}
            onClick={handleDeleteSelected}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-critical transition-colors hover:border-critical disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            <span>{t('common.delete')}</span>
          </button>
        </div>
      </div>

      {/* Read-Only Data Grid Area */}
      <div className="min-h-0 flex-1 overflow-auto bg-canvas">
        {/* VIEW 1: NETWORKS FOLDER */}
        {viewTarget.kind === 'folder' && viewTarget.folder === 'networks' && (
          <table className="w-full border-collapse text-left text-xs select-none">
            <thead className="sticky top-0 z-10 border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
              <tr>
                <th className="py-2.5 px-4">{t('list.col.networkName')}</th>
                <th className="py-2.5 px-3">{t('list.col.busAssignment')}</th>
                <th className="py-2.5 px-3">{t('list.col.dbcVersion')}</th>
                <th className="py-2.5 px-3">{t('list.col.cloudVersion')}</th>
                <th className="py-2.5 px-3 text-right">
                  {t('list.col.ecuBu')}
                </th>
                <th className="py-2.5 px-3 text-right">
                  {t('list.col.messageBo')}
                </th>
                <th className="py-2.5 px-3 text-right">
                  {t('list.col.signalSg')}
                </th>
                <th className="py-2.5 px-4">{t('list.col.commentCm')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline bg-surface">
              <tr
                onClick={() => onSelectRow({ kind: 'network' })}
                onDoubleClick={onOpenNetworkDialog}
                className={`cursor-pointer transition-colors ${
                  selectedRow?.kind === 'network'
                    ? 'bg-elevated'
                    : 'hover:bg-elevated/50'
                }`}
              >
                <td className="py-2.5 px-4 font-semibold text-ink">
                  <span className="inline-flex items-center gap-2">
                    <Network
                      className="h-3.5 w-3.5 text-focus"
                      aria-hidden="true"
                    />
                    <span className="font-mono">{databaseName}</span>
                  </span>
                </td>
                <td className="py-2.5 px-3 font-mono text-ink">
                  {busAssignment}
                </td>
                <td className="py-2.5 px-3 font-mono tabular-nums text-muted">
                  {schema.info.version || '1.0.0'}
                </td>
                <td className="py-2.5 px-3 font-mono font-semibold tabular-nums text-nominal">
                  {versionLabel}
                </td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                  {schema.ecus.length}
                </td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                  {schema.messages.length}
                </td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                  {schema.signals.length}
                </td>
                <td className="max-w-xs truncate py-2.5 px-4 text-muted">
                  {networkComment || '—'}
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {/* VIEW 2: NETWORK NODES (ECUs) FOLDER */}
        {viewTarget.kind === 'folder' &&
          viewTarget.folder === 'ecus' &&
          ecuViewMode === 'graph' && (
            <CandbNodeGraph
              schema={schema}
              storageKey={nodeGraphStorageKey}
              onOpenMessageDialog={onOpenMessageDialog}
              onOpenEcuDialog={onOpenEcuDialog}
            />
          )}
        {viewTarget.kind === 'folder' && viewTarget.folder === 'ecus' && ecuViewMode === 'table' && (
          ecusRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <Cpu className="h-6 w-6 text-muted" aria-hidden="true" />
              <p className="text-xs text-muted">{t('list.empty.ecus')}</p>
              {canMutate && (
                <button
                  type="button"
                  onClick={onAddEcu}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] bg-focus px-3 text-xs font-semibold text-on-accent"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('list.empty.addEcuBtn')}</span>
                </button>
              )}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs select-none">
              <thead className="sticky top-0 z-10 border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                <tr>
                  <th className="py-2.5 px-4">{t('list.col.ecuNodeBu')}</th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.txMessages')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.rxMessages')}
                  </th>
                  <th className="py-2.5 px-3">
                    {t('list.col.txMessagePreview')}
                  </th>
                  <th className="py-2.5 px-4">{t('list.col.commentCmBu')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-surface">
                {ecusRows.map((ecu) => {
                  const isSelected =
                    selectedRow?.kind === 'ecu' &&
                    selectedRow.ecuName === ecu.name;
                  const txNames = ecu.txMessageKeys
                    .map((k) => msgByKey.get(k)?.name ?? k)
                    .slice(0, 4);
                  return (
                    <tr
                      key={ecu.name}
                      onClick={() =>
                        onSelectRow({ kind: 'ecu', ecuName: ecu.name })
                      }
                      onDoubleClick={() => onOpenEcuDialog(ecu.name)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-elevated' : 'hover:bg-elevated/50'
                      }`}
                    >
                      <td className="py-2.5 px-4 font-mono font-semibold text-ink">
                        <span className="inline-flex items-center gap-2">
                          <Cpu
                            className="h-3.5 w-3.5 text-focus"
                            aria-hidden="true"
                          />
                          <span>{ecu.name}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-nominal">
                        {ecu.txMessageKeys.length}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-focus">
                        {ecu.rxMessageKeys.length}
                      </td>
                      <td className="max-w-sm truncate py-2.5 px-3 font-mono text-[11px] text-muted">
                        {txNames.length > 0
                          ? `${txNames.join(', ')}${ecu.txMessageKeys.length > 4 ? '…' : ''}`
                          : '—'}
                      </td>
                      <td className="max-w-xs truncate py-2.5 px-4 text-muted">
                        {ecu.comment || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {/* VIEW 3: MESSAGES FOLDER */}
        {viewTarget.kind === 'folder' && viewTarget.folder === 'messages' && (
          messagesRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <Layers className="h-6 w-6 text-muted" aria-hidden="true" />
              <p className="text-xs text-muted">{t('list.empty.messages')}</p>
              {canMutate && (
                <button
                  type="button"
                  onClick={onAddMessage}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] bg-focus px-3 text-xs font-semibold text-on-accent"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('list.empty.addMessageBtn')}</span>
                </button>
              )}
            </div>
          ) : (
            <table className="w-full min-w-[860px] border-collapse text-left text-xs select-none">
              <thead className="sticky top-0 z-10 border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                <tr>
                  <th className="py-2.5 px-4">{t('list.col.messageNameBo')}</th>
                  <th className="py-2.5 px-3">{t('list.col.idHex')}</th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.idDec')}
                  </th>
                  <th className="py-2.5 px-3">{t('list.col.idFormat')}</th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.dlcBytes')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.cycleTimeMs')}
                  </th>
                  <th className="py-2.5 px-3">{t('list.col.transmitterBu')}</th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.signalsCount')}
                  </th>
                  <th className="py-2.5 px-4">{t('list.col.comment')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-surface">
                {messagesRows.map((msg) => {
                  const isSelected =
                    selectedRow?.kind === 'message' &&
                    selectedRow.messageKey === msg.messageKey;
                  const sigCount = (signalsByMsg.get(msg.messageKey) ?? [])
                    .length;
                  const hasOverlap = overlapMsgKeys.has(msg.messageKey);

                  return (
                    <tr
                      key={msg.messageKey}
                      onClick={() =>
                        onSelectRow({
                          kind: 'message',
                          messageKey: msg.messageKey,
                        })
                      }
                      onDoubleClick={() =>
                        onOpenMessageDialog(msg.messageKey, false)
                      }
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-elevated' : 'hover:bg-elevated/50'
                      }`}
                    >
                      <td className="py-2.5 px-4 font-semibold text-ink">
                        <span className="inline-flex items-center gap-2">
                          <Layers
                            className="h-3.5 w-3.5 text-focus"
                            aria-hidden="true"
                          />
                          <span>{msg.name}</span>
                          {hasOverlap && (
                            <AlertTriangle
                              className="h-3.5 w-3.5 text-critical"
                              aria-label={t('list.summary.hasBitOverlapAria')}
                            />
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold tabular-nums text-focus">
                        {formatHexArbId(msg.arbId, msg.isExtended)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-muted">
                        {msg.arbId}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-ink">
                        {formatMessageIdFormatLabel(
                          getMessageIdFormat(msg),
                          locale
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                        {msg.dlc}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-muted">
                        {msg.expectedCycleMs ?? '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-ink">
                        {msg.transmitters.join(', ') ||
                          t('common.unassignedNode')}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                        {sigCount}
                      </td>
                      <td className="max-w-xs truncate py-2.5 px-4 text-muted">
                        {msg.comment || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {/* VIEW 4: SIGNALS TABLE (Message-Scoped OR Global Signals Folder) */}
        {(viewTarget.kind === 'messageSignals' ||
          (viewTarget.kind === 'folder' &&
            viewTarget.folder === 'signals')) && (
          signalsRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <ListTree className="h-6 w-6 text-muted" aria-hidden="true" />
              <p className="text-xs text-muted">
                {viewTarget.kind === 'messageSignals'
                  ? t('list.empty.messageSignals')
                  : t('list.empty.globalSignals')}
              </p>
              {canMutate && schema.messages.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    onAddSignal(
                      viewTarget.kind === 'messageSignals'
                        ? viewTarget.messageKey
                        : undefined
                    )
                  }
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] bg-focus px-3 text-xs font-semibold text-on-accent"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('list.empty.addSignalBtn')}</span>
                </button>
              )}
            </div>
          ) : (
            <table className="w-full min-w-[1040px] border-collapse text-left text-xs select-none">
              <thead className="sticky top-0 z-10 border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                <tr>
                  <th className="py-2.5 px-4">{t('list.col.signalNameSg')}</th>
                  {viewTarget.kind !== 'messageSignals' && (
                    <th className="py-2.5 px-3">{t('list.col.messageBo')}</th>
                  )}
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.startBit')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.lengthBits')}
                  </th>
                  <th className="py-2.5 px-3">{t('list.col.byteOrder')}</th>
                  <th className="py-2.5 px-3">{t('list.col.valueType')}</th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.factor')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.offset')}
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    {t('list.col.minMax')}
                  </th>
                  <th className="py-2.5 px-3">{t('list.col.unit')}</th>
                  <th className="py-2.5 px-3">{t('list.col.multiplexing')}</th>
                  <th className="py-2.5 px-3">{t('list.col.receiversBu')}</th>
                  <th className="py-2.5 px-4 text-right">VAL_</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-surface">
                {signalsRows.map((sig) => {
                  const isSelected =
                    selectedRow?.kind === 'signal' &&
                    selectedRow.signalId === sig.signalId;
                  const parentMsg = msgByKey.get(sig.messageKey);
                  const enumCount = Object.keys(sig.enumTable ?? {}).length;

                  return (
                    <tr
                      key={sig.signalId}
                      onClick={() =>
                        onSelectRow({
                          kind: 'signal',
                          messageKey: sig.messageKey,
                          signalId: sig.signalId,
                        })
                      }
                      onDoubleClick={() => onOpenSignalDialog(sig.signalId)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-elevated' : 'hover:bg-elevated/50'
                      }`}
                    >
                      <td className="py-2.5 px-4 font-mono font-semibold text-ink">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-3 w-1 shrink-0 rounded-[1px]"
                            style={{
                              backgroundColor: getSignalColor(sig.signalId),
                            }}
                          />
                          <span>{sig.name}</span>
                        </span>
                      </td>

                      {viewTarget.kind !== 'messageSignals' && (
                        <td className="py-2.5 px-3 font-mono text-[11px] tabular-nums text-focus">
                          {parentMsg
                            ? `${parentMsg.name} (${formatHexArbId(parentMsg.arbId, parentMsg.isExtended)})`
                            : sig.messageKey}
                        </td>
                      )}

                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                        {sig.startBit}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                        {sig.bitLength}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] tabular-nums text-muted">
                        {sig.byteOrder === 'bigEndian'
                          ? 'Motorola (@0)'
                          : 'Intel (@1)'}
                      </td>
                      <td className="py-2.5 px-3 text-muted">
                        {t(getValueTypeShardKey(sig.valueType))}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                        {sig.factor}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink">
                        {sig.offset}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-muted">
                        [{sig.min} | {sig.max}]
                      </td>
                      <td className="py-2.5 px-3 font-mono text-ink">
                        {sig.unit || '—'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] tabular-nums text-muted">
                        {formatMuxBadge(sig)}
                      </td>
                      <td className="max-w-[180px] truncate py-2.5 px-3 font-mono text-[11px] text-muted">
                        {sig.receivers.join(', ') || t('common.unassignedNode')}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-nominal">
                        {enumCount > 0 ? `${enumCount}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {/* VIEW 5: ECU DETAIL MAPPED TX MESSAGES & RX SIGNALS */}
        {viewTarget.kind === 'ecuDetail' && (
          <div className="p-4 space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-ink">
                  {t('list.ecuDetail.txHeader')}
                </h3>
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {t('list.ecuDetail.txCount', { count: messagesRows.length })}
                </span>
              </div>
              <div className="overflow-hidden rounded-[2px] border border-hairline bg-surface">
                {messagesRows.length === 0 ? (
                  <p className="p-4 text-xs text-muted">
                    {t('list.ecuDetail.txEmpty')}
                  </p>
                ) : (
                  <table className="w-full border-collapse text-left text-xs select-none">
                    <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                      <tr>
                        <th className="py-2 px-3">
                          {t('list.col.messageName')}
                        </th>
                        <th className="py-2 px-3">{t('list.col.idHex')}</th>
                        <th className="py-2 px-3">{t('list.col.idFormat')}</th>
                        <th className="py-2 px-3 text-right">
                          {t('list.col.dlcBytes')}
                        </th>
                        <th className="py-2 px-3 text-right">
                          {t('list.col.cycleTimeMs')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {messagesRows.map((msg) => {
                        const isSelected =
                          selectedRow?.kind === 'message' &&
                          selectedRow.messageKey === msg.messageKey;
                        return (
                          <tr
                            key={msg.messageKey}
                            onClick={() =>
                              onSelectRow({
                                kind: 'message',
                                messageKey: msg.messageKey,
                              })
                            }
                            onDoubleClick={() =>
                              onOpenMessageDialog(msg.messageKey, false)
                            }
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-elevated'
                                : 'hover:bg-elevated/50'
                            }`}
                          >
                            <td className="py-2 px-3 font-semibold text-ink">
                              {msg.name}
                            </td>
                            <td className="py-2 px-3 font-mono font-semibold tabular-nums text-focus">
                              {formatHexArbId(msg.arbId, msg.isExtended)}
                            </td>
                            <td className="py-2 px-3 font-mono text-[11px] text-muted">
                              {formatMessageIdFormatLabel(
                                getMessageIdFormat(msg),
                                locale
                              )}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                              {msg.dlc}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-muted">
                              {msg.expectedCycleMs ?? '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-ink">
                  {t('list.ecuDetail.rxHeader')}
                </h3>
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {t('list.ecuDetail.rxCount', { count: signalsRows.length })}
                </span>
              </div>
              <div className="overflow-hidden rounded-[2px] border border-hairline bg-surface">
                {signalsRows.length === 0 ? (
                  <p className="p-4 text-xs text-muted">
                    {t('list.ecuDetail.rxEmpty')}
                  </p>
                ) : (
                  <table className="w-full border-collapse text-left text-xs select-none">
                    <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                      <tr>
                        <th className="py-2 px-3">
                          {t('list.col.signalName')}
                        </th>
                        <th className="py-2 px-3">
                          {t('list.col.sourceMessage')}
                        </th>
                        <th className="py-2 px-3 text-right">
                          {t('list.col.startPipeBit')}
                        </th>
                        <th className="py-2 px-3">{t('list.col.unit')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                      {signalsRows.map((sig) => {
                        const parentMsg = msgByKey.get(sig.messageKey);
                        const isSelected =
                          selectedRow?.kind === 'signal' &&
                          selectedRow.signalId === sig.signalId;
                        return (
                          <tr
                            key={sig.signalId}
                            onClick={() =>
                              onSelectRow({
                                kind: 'signal',
                                messageKey: sig.messageKey,
                                signalId: sig.signalId,
                              })
                            }
                            onDoubleClick={() =>
                              onOpenSignalDialog(sig.signalId)
                            }
                            className={`cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-elevated'
                                : 'hover:bg-elevated/50'
                            }`}
                          >
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
                            <td className="py-2 px-3 font-mono text-muted">
                              {sig.unit || '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* VIEW 6: VALUE TABLES FOLDER */}
        {viewTarget.kind === 'folder' &&
          viewTarget.folder === 'valueTables' && (
            valueTableRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
                <Table2 className="h-6 w-6 text-muted" aria-hidden="true" />
                <p className="text-xs text-muted">
                  {t('list.empty.valueTables')}
                </p>
                {canMutate && (
                  <button
                    type="button"
                    onClick={onAddValueTable}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] bg-focus px-3 text-xs font-semibold text-on-accent"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('list.empty.addValueTableBtn')}</span>
                  </button>
                )}
              </div>
            ) : (
              <table className="w-full border-collapse text-left text-xs select-none">
                <thead className="sticky top-0 z-10 border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                  <tr>
                    <th className="py-2.5 px-4">
                      {t('list.col.valTableName')}
                    </th>
                    <th className="py-2.5 px-3 text-right">
                      {t('list.col.entryCount')}
                    </th>
                    <th className="py-2.5 px-4">
                      {t('list.col.entriesPreview')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline bg-surface">
                  {valueTableRows.map(({ vt, idx }) => {
                    const isSelected =
                      selectedRow?.kind === 'valueTable' &&
                      selectedRow.tableIndex === idx;
                    const sortedPreview = Object.entries(vt.entries)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .slice(0, 6)
                      .map(([k, v]) => `${k}: "${v}"`)
                      .join(' · ');

                    return (
                      <tr
                        key={`${vt.name}-${idx}`}
                        onClick={() =>
                          onSelectRow({ kind: 'valueTable', tableIndex: idx })
                        }
                        onDoubleClick={() => onOpenValueTableDialog(idx)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-elevated' : 'hover:bg-elevated/50'
                        }`}
                      >
                        <td className="py-2.5 px-4 font-mono font-semibold text-ink">
                          <span className="inline-flex items-center gap-2">
                            <Table2
                              className="h-3.5 w-3.5 text-focus"
                              aria-hidden="true"
                            />
                            <span>{vt.name}</span>
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-nominal">
                          {Object.keys(vt.entries).length}
                        </td>
                        <td className="max-w-xl truncate py-2.5 px-4 font-mono text-[11px] tabular-nums text-muted">
                          {sortedPreview || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
      </div>
    </section>
  );
}
