import React, { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  MAX_DIAG_TABS,
  diagnosticsStore,
  useDiagnosticsSelector,
  type DiagSessionTab,
} from '../../store/diagnosticsStore';
import { toHex } from './diagFormat';
import { useEcuName } from './workspace/diagWorkspaceStore';

const SESSION_NAME: Record<string, string> = {
  default: 'Default',
  extended: 'Extended',
  programming: 'Programming',
};

const SESSION_COLOR: Record<string, string> = {
  default: 'var(--text-secondary)',
  extended: 'var(--status-warn)',
  programming: 'var(--status-critical)',
};

function idPair(tab: DiagSessionTab): string {
  const c = tab.session.config;
  const w = c.isExtendedId ? 8 : 3;
  return `${toHex(c.requestId, w)}→${toHex(c.responseId, w)}`;
}

const TabItem: React.FC<{ tab: DiagSessionTab; active: boolean }> = ({ tab, active }) => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.label);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ecuName = useEcuName(tab.ecuId);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const { connected, udsSession } = tab.session;
  const connecting = tab.connecting;
  const hasError = tab.lastError !== null;
  const dotColor = connected
    ? 'var(--status-nominal)'
    : hasError
      ? 'var(--status-critical)'
      : 'var(--text-muted)';
  const dotTitle = connected
    ? t('diagTabs.status.connected')
    : connecting
      ? t('diagTabs.status.connecting')
      : hasError
        ? t('diagTabs.status.error')
        : t('diagTabs.status.disconnected');

  function commit() {
    setEditing(false);
    if (draft.trim() !== tab.label) diagnosticsStore.renameTab(tab.id, draft);
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={() => diagnosticsStore.setActiveTab(tab.id)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          diagnosticsStore.setActiveTab(tab.id);
        }
      }}
      style={{
        backgroundColor: active ? 'var(--bg-panel)' : 'transparent',
        borderColor: active ? 'var(--border-strong)' : 'transparent',
        borderTopColor: active ? 'var(--status-focus)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
      className="group flex h-full max-w-[300px] shrink-0 cursor-pointer select-none items-center gap-2 border-x border-t px-2.5 text-[12px]"
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
        title={dotTitle}
        aria-label={dotTitle}
      />
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={32}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="h-[22px] w-32 rounded-[2px] border border-[color:var(--status-focus)] bg-canvas px-1.5 font-sans text-[12px] text-ink outline-none"
          aria-label={t('diagTabs.rename')}
        />
      ) : (
        <span
          className="min-w-0 truncate font-sans font-semibold"
          title={t('diagTabs.renameHint')}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(tab.label);
            setEditing(true);
          }}
        >
          {tab.label}
        </span>
      )}
      {ecuName !== null && (
        <span
          className="max-w-[120px] shrink-0 truncate rounded-[2px] border px-1 font-mono text-[10.5px] font-semibold"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--status-focus)' }}
          title={t('diagWs.tab.fromEcu', { name: ecuName })}
        >
          {ecuName}
        </span>
      )}
      <span className="shrink-0 font-mono tabular-nums text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        {t('diagTabs.busShort', { n: tab.session.config.busId + 1 })} {idPair(tab)}
      </span>
      {connected && (
        <span
          className="shrink-0 rounded-[2px] border px-1 font-mono text-[10.5px] font-semibold uppercase"
          style={{
            borderColor: 'var(--border-strong)',
            color: SESSION_COLOR[udsSession] ?? 'var(--text-secondary)',
          }}
        >
          {SESSION_NAME[udsSession] ?? udsSession}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void diagnosticsStore.closeTab(tab.id);
        }}
        title={t('diagTabs.close')}
        aria-label={t('diagTabs.close')}
        className="flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] text-[color:var(--text-muted)] hover:bg-[var(--border-grid)] hover:text-[color:var(--text-primary)]"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
};

/** Compact strip of concurrent UDS sessions (one per ECU addressing); the active tab drives all Diagnostics panels. */
export const DiagSessionTabs: React.FC = () => {
  const { t } = useI18n();
  const tabs = useDiagnosticsSelector((s) => s.tabs);
  const activeTabId = useDiagnosticsSelector((s) => s.activeTabId);
  const atLimit = tabs.length >= MAX_DIAG_TABS;

  return (
    <div
      role="tablist"
      aria-label={t('diagTabs.aria')}
      style={{ backgroundColor: 'var(--bg-header)', borderBottom: '1px solid var(--border-grid)' }}
      className="no-scrollbar flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto px-2 pt-1"
    >
      {tabs.map((tab) => (
        <TabItem key={tab.id} tab={tab} active={tab.id === activeTabId} />
      ))}
      <button
        type="button"
        disabled={atLimit}
        onClick={() => diagnosticsStore.addTab()}
        title={atLimit ? t('diagTabs.limit', { max: MAX_DIAG_TABS }) : t('diagTabs.newHint')}
        className="mb-1 ml-1 inline-flex h-[24px] shrink-0 cursor-pointer select-none items-center gap-1 rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[11px] font-semibold uppercase text-muted hover:border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        {t('diagTabs.new')}
      </button>
    </div>
  );
};
