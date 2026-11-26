'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cpu,
  Folder,
  FolderOpen,
  Layers,
  ListTree,
  Network,
  Plus,
  Search,
  Table2,
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
  type CandbFolderKind,
  type CandbSelectedRow,
  type CandbViewTarget,
} from './dbcEditorUtils';
import { useDbcStudioI18n } from './i18n/dbcStudio';

interface CandbTreeSidebarProps {
  widthPx: number;
  databaseName: string;
  schema: DatabaseSchemaDto;
  valueTables: readonly ReusableValueTableDto[];
  bitOverlaps: readonly BitOverlapDiagnosticDto[];
  viewTarget: CandbViewTarget;
  selectedRow: CandbSelectedRow | null;
  canMutate?: boolean;
  onSelectFolder: (folder: CandbFolderKind) => void;
  onSelectNetworkLeaf: (openDialog: boolean) => void;
  onSelectEcuLeaf: (ecuName: string, openDialog: boolean) => void;
  onSelectMessageLeaf: (messageKey: string, openDialog: boolean) => void;
  onSelectSignalLeaf: (
    messageKey: string,
    signalId: number,
    openDialog: boolean
  ) => void;
  onSelectValueTableLeaf: (tableIndex: number, openDialog: boolean) => void;
  onAddEcu?: () => void;
  onAddMessage?: () => void;
  onAddSignal?: () => void;
  onAddValueTable?: () => void;
}

export function CandbTreeSidebar({
  widthPx,
  databaseName,
  schema,
  valueTables,
  bitOverlaps,
  viewTarget,
  selectedRow,
  canMutate = false,
  onSelectFolder,
  onSelectNetworkLeaf,
  onSelectEcuLeaf,
  onSelectMessageLeaf,
  onSelectSignalLeaf,
  onSelectValueTableLeaf,
  onAddEcu,
  onAddMessage,
  onAddSignal,
  onAddValueTable,
}: CandbTreeSidebarProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [query, setQuery] = useState<string>('');
  const [expandedFolders, setExpandedFolders] = useState<
    Record<CandbFolderKind, boolean>
  >({
    networks: true,
    ecus: true,
    messages: true,
    signals: false,
    valueTables: true,
  });

  const [expandedMessages, setExpandedMessages] = useState<
    Record<string, boolean>
  >(() => {
    const init: Record<string, boolean> = {};
    const first = schema.messages[0];
    if (first) {
      init[first.messageKey] = true;
    }
    return init;
  });

  const overlapMsgKeys = useMemo(() => {
    const set = new Set<string>();
    for (const ov of bitOverlaps) {
      set.add(ov.messageKey);
    }
    return set;
  }, [bitOverlaps]);

  const signalsByMsg = useMemo(() => {
    const map = new Map<string, SignalSchemaDto[]>();
    for (const sig of schema.signals) {
      const list = map.get(sig.messageKey);
      if (list) {
        list.push(sig);
      } else {
        map.set(sig.messageKey, [sig]);
      }
    }
    return map;
  }, [schema.signals]);

  const msgByKey = useMemo(() => {
    const map = new Map<string, MessageSchemaDto>();
    for (const m of schema.messages) {
      map.set(m.messageKey, m);
    }
    return map;
  }, [schema.messages]);

  const q = query.trim().toLowerCase();

  const filteredEcus = useMemo(() => {
    if (!q) return schema.ecus;
    return schema.ecus.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.comment?.toLowerCase().includes(q) ?? false)
    );
  }, [q, schema.ecus]);

  const filteredMessages = useMemo(() => {
    if (!q) {
      return schema.messages.map((msg) => ({
        msg,
        signals: signalsByMsg.get(msg.messageKey) ?? [],
        forceExpand: false,
      }));
    }

    const out: Array<{
      msg: MessageSchemaDto;
      signals: SignalSchemaDto[];
      forceExpand: boolean;
    }> = [];

    for (const msg of schema.messages) {
      const allSigs = signalsByMsg.get(msg.messageKey) ?? [];
      const hexShort = `0x${msg.arbId.toString(16).toLowerCase()}`;
      const hexFull = formatHexArbId(msg.arbId, msg.isExtended).toLowerCase();
      const decStr = String(msg.arbId);

      const msgMatch =
        msg.name.toLowerCase().includes(q) ||
        hexShort.includes(q) ||
        hexFull.includes(q) ||
        decStr === q ||
        msg.transmitters.some((t) => t.toLowerCase().includes(q));

      const sigMatches = allSigs.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.longName?.toLowerCase().includes(q) ?? false) ||
          s.unit.toLowerCase().includes(q)
      );

      if (msgMatch) {
        out.push({
          msg,
          signals: sigMatches.length > 0 ? sigMatches : allSigs,
          forceExpand: sigMatches.length > 0,
        });
      } else if (sigMatches.length > 0) {
        out.push({
          msg,
          signals: sigMatches,
          forceExpand: true,
        });
      }
    }
    return out;
  }, [q, schema.messages, signalsByMsg]);

  const filteredSignals = useMemo(() => {
    if (!q) return schema.signals;
    return schema.signals.filter((s) => {
      const parent = msgByKey.get(s.messageKey);
      const hex = parent
        ? formatHexArbId(parent.arbId, parent.isExtended).toLowerCase()
        : '';
      return (
        s.name.toLowerCase().includes(q) ||
        (s.longName?.toLowerCase().includes(q) ?? false) ||
        s.unit.toLowerCase().includes(q) ||
        hex.includes(q)
      );
    });
  }, [msgByKey, q, schema.signals]);

  const filteredValueTables = useMemo(() => {
    const indexed = valueTables.map((vt, idx) => ({ vt, idx }));
    if (!q) return indexed;
    return indexed.filter(
      ({ vt }) =>
        vt.name.toLowerCase().includes(q) ||
        Object.values(vt.entries).some((label) =>
          label.toLowerCase().includes(q)
        )
    );
  }, [q, valueTables]);

  const toggleFolderExpand = (folder: CandbFolderKind) => {
    setExpandedFolders((prev) => ({ ...prev, [folder]: !prev[folder] }));
  };

  const toggleMessageExpand = (messageKey: string) => {
    setExpandedMessages((prev) => ({
      ...prev,
      [messageKey]: !prev[messageKey],
    }));
  };

  const isFolderSelected = (folder: CandbFolderKind): boolean =>
    viewTarget.kind === 'folder' && viewTarget.folder === folder;

  const renderFolderHeader = (params: {
    folder: CandbFolderKind;
    label: string;
    count: number;
    hasChildTree: boolean;
    onQuickAdd?: (() => void) | undefined;
    quickAddTitle?: string;
  }) => {
    const active = isFolderSelected(params.folder);
    const expanded = Boolean(expandedFolders[params.folder]) || Boolean(q);
    const FolderIcon = expanded ? FolderOpen : Folder;

    return (
      <div
        className={`group flex h-7 items-center gap-1 rounded-[2px] border px-1.5 transition-colors ${
          active
            ? 'border-strong bg-elevated text-ink font-semibold'
            : 'border-transparent text-ink hover:bg-elevated/50'
        }`}
      >
        {params.hasChildTree ? (
          <button
            type="button"
            onClick={() => toggleFolderExpand(params.folder)}
            aria-label={t('tree.toggleFolderAria', { folder: params.label })}
            className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:text-ink"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onSelectFolder(params.folder)}
          onDoubleClick={() => toggleFolderExpand(params.folder)}
          className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-1.5 text-left"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderIcon
              className={`h-3.5 w-3.5 shrink-0 ${
                active ? 'text-focus' : 'text-muted'
              }`}
              aria-hidden="true"
            />
            <span className="truncate text-xs">{params.label}</span>
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
            ({params.count})
          </span>
        </button>

        {canMutate && params.onQuickAdd && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              params.onQuickAdd?.();
            }}
            title={params.quickAddTitle}
            aria-label={params.quickAddTitle}
            className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[2px] text-muted opacity-70 transition-colors hover:bg-canvas hover:text-focus group-hover:opacity-100"
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  return (
    <aside
      style={{ width: `${widthPx}px` }}
      className="flex h-full shrink-0 flex-col bg-surface select-none"
    >
      {/* Search Box */}
      <div className="border-b border-hairline bg-elevated/60 p-2.5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tree.searchPlaceholder')}
            aria-label={t('tree.searchAria')}
            className="h-7 w-full rounded-[2px] border border-hairline bg-canvas pr-6 pl-8 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('tree.clearSearchAria')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded-[2px] p-0.5 text-muted hover:text-ink"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* DBC Studio Overall View Folder Tree */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
        {/* 1. Networks (1) */}
        <div>
          {renderFolderHeader({
            folder: 'networks',
            label: t('tree.folder.networks'),
            count: 1,
            hasChildTree: true,
          })}
          {(expandedFolders.networks || Boolean(q)) && (
            <div className="ml-4 mt-0.5 border-l border-hairline pl-2 space-y-0.5">
              <button
                type="button"
                onClick={() => onSelectNetworkLeaf(false)}
                onDoubleClick={() => onSelectNetworkLeaf(true)}
                title={t('tree.networkLeafTitle')}
                className={`flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[2px] border px-2 text-left transition-colors ${
                  selectedRow?.kind === 'network' &&
                  viewTarget.kind === 'folder' &&
                  viewTarget.folder === 'networks'
                    ? 'border-strong bg-elevated text-ink font-semibold'
                    : 'border-transparent text-muted hover:bg-elevated/40 hover:text-ink'
                }`}
              >
                <Network
                  className="h-3 w-3 shrink-0 text-focus"
                  aria-hidden="true"
                />
                <span className="truncate font-mono text-[11px]">
                  {databaseName ||
                    schema.info.name ||
                    t('tree.defaultNetworkName')}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* 2. Network Nodes (ECUs) */}
        <div>
          {renderFolderHeader({
            folder: 'ecus',
            label: t('tree.folder.ecus'),
            count: filteredEcus.length,
            hasChildTree: schema.ecus.length > 0,
            onQuickAdd: onAddEcu,
            quickAddTitle: t('tree.quickAddEcu'),
          })}
          {(expandedFolders.ecus || Boolean(q)) && filteredEcus.length > 0 && (
            <div className="ml-4 mt-0.5 border-l border-hairline pl-2 space-y-0.5">
              {filteredEcus.map((ecu) => {
                const isSelected =
                  (viewTarget.kind === 'ecuDetail' &&
                    viewTarget.ecuName === ecu.name) ||
                  (selectedRow?.kind === 'ecu' &&
                    selectedRow.ecuName === ecu.name);
                return (
                  <button
                    key={ecu.name}
                    type="button"
                    onClick={() => onSelectEcuLeaf(ecu.name, false)}
                    onDoubleClick={() => onSelectEcuLeaf(ecu.name, true)}
                    title={t('tree.ecuLeafTitle', { name: ecu.name })}
                    className={`flex h-6 w-full cursor-pointer items-center justify-between gap-1.5 rounded-[2px] border px-2 text-left transition-colors ${
                      isSelected
                        ? 'border-strong bg-elevated text-ink font-semibold'
                        : 'border-transparent text-muted hover:bg-elevated/40 hover:text-ink'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Cpu
                        className="h-3 w-3 shrink-0 text-focus"
                        aria-hidden="true"
                      />
                      <span className="truncate font-mono text-[11px]">
                        {ecu.name}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-subtle">
                      {ecu.txMessageKeys.length}T/{ecu.rxMessageKeys.length}R
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. Messages -> Signals */}
        <div>
          {renderFolderHeader({
            folder: 'messages',
            label: t('tree.folder.messages'),
            count: filteredMessages.length,
            hasChildTree: schema.messages.length > 0,
            onQuickAdd: onAddMessage,
            quickAddTitle: t('tree.quickAddMessage'),
          })}
          {(expandedFolders.messages || Boolean(q)) &&
            filteredMessages.length > 0 && (
              <div className="ml-4 mt-0.5 border-l border-hairline pl-1.5 space-y-0.5">
                {filteredMessages.map(({ msg, signals, forceExpand }) => {
                  const isMsgExpanded =
                    forceExpand || Boolean(expandedMessages[msg.messageKey]);
                  const isMsgFocused =
                    (viewTarget.kind === 'messageSignals' &&
                      viewTarget.messageKey === msg.messageKey &&
                      selectedRow?.kind !== 'signal') ||
                    (selectedRow?.kind === 'message' &&
                      selectedRow.messageKey === msg.messageKey);
                  const isParentOfSelectedSig =
                    selectedRow?.kind === 'signal' &&
                    selectedRow.messageKey === msg.messageKey;
                  const hasOverlap = overlapMsgKeys.has(msg.messageKey);
                  const msgHexId = formatHexArbId(msg.arbId, msg.isExtended);

                  return (
                    <div key={msg.messageKey}>
                      <div
                        className={`flex h-6 items-center gap-1 rounded-[2px] border px-1 transition-colors ${
                          isMsgFocused
                            ? 'border-strong bg-elevated text-ink font-semibold'
                            : isParentOfSelectedSig
                              ? 'border-hairline bg-elevated/45 text-ink'
                              : 'border-transparent text-muted hover:bg-elevated/40 hover:text-ink'
                        }`}
                      >
                        {signals.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleMessageExpand(msg.messageKey)}
                            aria-label={t('tree.toggleMsgSignalsAria', {
                              name: msg.name,
                            })}
                            className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:text-ink"
                          >
                            {isMsgExpanded ? (
                              <ChevronDown
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            ) : (
                              <ChevronRight
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        ) : (
                          <span className="w-4 shrink-0" />
                        )}

                        <button
                          type="button"
                          onClick={() =>
                            onSelectMessageLeaf(msg.messageKey, false)
                          }
                          onDoubleClick={() =>
                            onSelectMessageLeaf(msg.messageKey, true)
                          }
                          title={t('tree.messageLeafTitle', {
                            name: msg.name,
                            hexId: msgHexId,
                          })}
                          className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-1.5 text-left"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Layers
                              className="h-3 w-3 shrink-0 text-focus"
                              aria-hidden="true"
                            />
                            <span className="truncate text-[11px] text-ink">
                              {msg.name}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-subtle">
                            {hasOverlap && (
                              <AlertTriangle
                                className="h-3 w-3 text-critical"
                                aria-label={t('tree.bitOverlapAria')}
                              />
                            )}
                            <span>({msgHexId})</span>
                          </span>
                        </button>
                      </div>

                      {isMsgExpanded && signals.length > 0 && (
                        <div className="ml-4 mt-0.5 border-l border-hairline pl-2 space-y-0.5">
                          {signals.map((sig) => {
                            const isSigSelected =
                              selectedRow?.kind === 'signal' &&
                              selectedRow.signalId === sig.signalId;
                            return (
                              <button
                                key={sig.signalId}
                                type="button"
                                onClick={() =>
                                  onSelectSignalLeaf(
                                    msg.messageKey,
                                    sig.signalId,
                                    false
                                  )
                                }
                                onDoubleClick={() =>
                                  onSelectSignalLeaf(
                                    msg.messageKey,
                                    sig.signalId,
                                    true
                                  )
                                }
                                title={t('tree.signalLeafTitle', {
                                  name: sig.name,
                                })}
                                className={`flex h-6 w-full cursor-pointer items-center justify-between gap-1.5 rounded-[2px] border px-2 text-left transition-colors ${
                                  isSigSelected
                                    ? 'border-strong bg-elevated text-ink font-semibold'
                                    : 'border-transparent text-muted hover:bg-elevated/40 hover:text-ink'
                                }`}
                              >
                                <span className="truncate font-mono text-[11px]">
                                  {sig.name}
                                </span>
                                <span className="shrink-0 font-mono text-[9px] tabular-nums text-subtle">
                                  {sig.startBit}|{sig.bitLength}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </div>

        {/* 4. Signals (Global Folder) */}
        <div>
          {renderFolderHeader({
            folder: 'signals',
            label: t('tree.folder.signals'),
            count: filteredSignals.length,
            hasChildTree: schema.signals.length > 0,
            onQuickAdd: schema.messages.length > 0 ? onAddSignal : undefined,
            quickAddTitle: t('tree.quickAddSignal'),
          })}
          {expandedFolders.signals && filteredSignals.length > 0 && (
            <div className="ml-4 mt-0.5 max-h-56 overflow-y-auto border-l border-hairline pl-2 space-y-0.5">
              {filteredSignals.map((sig) => {
                const isSigSelected =
                  selectedRow?.kind === 'signal' &&
                  selectedRow.signalId === sig.signalId &&
                  viewTarget.kind === 'folder' &&
                  viewTarget.folder === 'signals';
                return (
                  <button
                    key={sig.signalId}
                    type="button"
                    onClick={() => {
                      onSelectFolder('signals');
                      onSelectSignalLeaf(sig.messageKey, sig.signalId, false);
                    }}
                    onDoubleClick={() =>
                      onSelectSignalLeaf(sig.messageKey, sig.signalId, true)
                    }
                    title={t('tree.signalLeafTitle', { name: sig.name })}
                    className={`flex h-6 w-full cursor-pointer items-center justify-between gap-1.5 rounded-[2px] border px-2 text-left transition-colors ${
                      isSigSelected
                        ? 'border-strong bg-elevated text-ink font-semibold'
                        : 'border-transparent text-muted hover:bg-elevated/40 hover:text-ink'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ListTree
                        className="h-3 w-3 shrink-0 text-focus"
                        aria-hidden="true"
                      />
                      <span className="truncate font-mono text-[11px]">
                        {sig.name}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[9px] tabular-nums text-subtle">
                      {sig.bitLength}b
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 5. Value Tables */}
        <div>
          {renderFolderHeader({
            folder: 'valueTables',
            label: t('tree.folder.valueTables'),
            count: filteredValueTables.length,
            hasChildTree: valueTables.length > 0,
            onQuickAdd: onAddValueTable,
            quickAddTitle: t('tree.quickAddValueTable'),
          })}
          {(expandedFolders.valueTables || Boolean(q)) &&
            filteredValueTables.length > 0 && (
              <div className="ml-4 mt-0.5 border-l border-hairline pl-2 space-y-0.5">
                {filteredValueTables.map(({ vt, idx }) => {
                  const isVtSelected =
                    selectedRow?.kind === 'valueTable' &&
                    selectedRow.tableIndex === idx;
                  return (
                    <button
                      key={`${vt.name}-${idx}`}
                      type="button"
                      onClick={() => onSelectValueTableLeaf(idx, false)}
                      onDoubleClick={() => onSelectValueTableLeaf(idx, true)}
                      title={t('tree.valueTableLeafTitle', { name: vt.name })}
                      className={`flex h-6 w-full cursor-pointer items-center justify-between gap-1.5 rounded-[2px] border px-2 text-left transition-colors ${
                        isVtSelected
                          ? 'border-strong bg-elevated text-ink font-semibold'
                          : 'border-transparent text-muted hover:bg-elevated/40 hover:text-ink'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Table2
                          className="h-3 w-3 shrink-0 text-focus"
                          aria-hidden="true"
                        />
                        <span className="truncate font-mono text-[11px]">
                          {vt.name}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-subtle">
                        {Object.keys(vt.entries).length}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    </aside>
  );
}
