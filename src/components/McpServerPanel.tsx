import React, { useEffect, useState } from 'react';
import { Server, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { GuideInfoButton } from '../onboarding/GuideButtons';
import {
  MCP_DEFAULT_PORT,
  buildClaudeCodeCommand,
  mcpStore,
  parseMcpPort,
  useMcpStore,
} from '../store/mcpStore';

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

type CopyKey = 'url' | 'token' | 'cmd';

export const McpServerPanel: React.FC = () => {
  const { t } = useI18n();
  const mcp = useMcpStore();
  const [portText, setPortText] = useState<string>(String(MCP_DEFAULT_PORT));
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<CopyKey | null>(null);

  useEffect(() => {
    if (!mcp.panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') mcpStore.setPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mcp.panelOpen]);

  useEffect(() => {
    if (copied === null) return;
    const h = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(h);
  }, [copied]);

  if (!mcp.panelOpen) return null;

  const st = mcp.status;
  const running = st?.running === true;
  const available = mcp.available;
  const parsedPort = parseMcpPort(portText);
  const portInvalid = available && !running && parsedPort === null;
  const shownError = !available ? null : mcp.error ?? st?.lastError ?? null;

  const copy = (key: CopyKey, text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(key));
  };

  const copyBtn = (key: CopyKey, text: string) => (
    <button
      type="button"
      onClick={() => copy(key, text)}
      className="px-2 h-[24px] border border-[var(--border-strong)] bg-[var(--bg-toolbar)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer text-[11px] shrink-0"
    >
      {copied === key ? t('mcp.copied') : t('mcp.copy')}
    </button>
  );

  const rowLabel = 'w-[120px] shrink-0 text-[var(--text-muted)]';
  const valueBox =
    'flex-1 min-w-0 truncate px-2 py-1 border border-[var(--border-grid)] bg-[var(--bg-row-signal)] font-mono tabular-nums text-[var(--text-primary)]';

  return (
    <div
      onClick={() => mcpStore.setPanelOpen(false)}
      className="fixed inset-0 z-50 bg-[var(--bg-scrim)] flex items-center justify-center p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-primary)',
        }}
        className="w-full max-w-[560px] max-h-[88vh] border shadow-2xl flex flex-col text-[12px] font-sans"
      >
        <div
          style={{ backgroundColor: 'var(--bg-header)', borderBottom: '1px solid var(--border-strong)' }}
          className="h-[40px] px-4 flex items-center justify-between shrink-0"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Server className="w-4 h-4 text-focus shrink-0" />
            <span className="font-semibold text-[13px] tracking-wide">{t('mcp.title')}</span>
            <span
              className={`px-2 py-0.5 rounded border font-mono text-[11px] shrink-0 ${
                running
                  ? 'border-[var(--status-nominal-border)] bg-[var(--status-nominal-bg)] text-nominal'
                  : 'border-[var(--border-strong)] bg-[var(--bg-toolbar)] text-[var(--text-secondary)]'
              }`}
            >
              {running ? t('mcp.status.running') : t('mcp.status.stopped')}
            </span>
            <span className="px-2 py-0.5 rounded border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] text-warn font-mono text-[11px] shrink-0">
              {t('mcp.badge.readOnly')}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <GuideInfoButton pageId="mcp" />
            <button
              type="button"
              onClick={() => mcpStore.setPanelOpen(false)}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer p-1"
              title={t('mcp.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {!available ? (
          <div className="p-5 text-[var(--text-secondary)]">
            <div className="p-3 bg-[var(--bg-row-signal)] border border-[var(--border-grid)] text-[11.5px] leading-relaxed">
              {t('mcp.unavailable')}
            </div>
            <button
              type="button"
              disabled
              className="mt-3 px-3 h-[26px] border border-[var(--border-strong)] text-[12px] font-semibold opacity-50 cursor-not-allowed"
            >
              {t('mcp.start')}
            </button>
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-5 space-y-3 text-[var(--text-secondary)]">
          <div className="flex items-center gap-2">
            <span className={rowLabel}>{t('mcp.port')}</span>
            <input
              type="text"
              inputMode="numeric"
              value={running && st?.port != null ? String(st.port) : portText}
              disabled={!available || running || mcp.busy}
              onChange={(e) => setPortText(e.target.value)}
              aria-invalid={portInvalid}
              className={`w-[96px] px-2 py-1 border bg-[var(--bg-row-signal)] font-mono tabular-nums text-[var(--text-primary)] disabled:opacity-60 ${
                portInvalid ? 'border-[var(--status-critical-border)]' : 'border-[var(--border-grid)]'
              }`}
            />
            <button
              type="button"
              disabled={!available || mcp.busy || (!running && parsedPort === null)}
              onClick={() => {
                if (running) void mcpStore.stop();
                else if (parsedPort !== null) void mcpStore.start(parsedPort);
              }}
              className={`px-3 h-[26px] border text-[12px] font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                running
                  ? 'border-[var(--status-critical-border)] bg-[var(--status-critical-bg)] text-critical hover:bg-hover'
                  : 'border-[var(--status-nominal-border)] bg-[var(--status-nominal-bg)] text-nominal hover:bg-[var(--status-nominal-bg)]'
              }`}
            >
              {running ? t('mcp.stop') : t('mcp.start')}
            </button>
            {portInvalid && <span className="text-[11px] text-critical">{t('mcp.portHint')}</span>}
          </div>

          {running && st && st.endpointUrl !== null && (
            <>
              <div className="flex items-center gap-2">
                <span className={rowLabel}>{t('mcp.endpoint')}</span>
                <span className={valueBox}>{st.endpointUrl}</span>
                {copyBtn('url', st.endpointUrl)}
              </div>
              {st.token !== null && (
                <>
                  <div className="flex items-center gap-2">
                    <span className={rowLabel}>{t('mcp.token')}</span>
                    <span className={valueBox}>
                      {showToken ? st.token : '•'.repeat(Math.min(st.token.length, 32))}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      className="px-2 h-[24px] border border-[var(--border-strong)] bg-[var(--bg-toolbar)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer text-[11px] shrink-0"
                    >
                      {showToken ? t('mcp.hide') : t('mcp.show')}
                    </button>
                    {copyBtn('token', st.token)}
                  </div>
                  <div className="flex">
                    <button
                      type="button"
                      onClick={() => copy('cmd', buildClaudeCodeCommand(st.endpointUrl ?? '', st.token ?? ''))}
                      className="px-3 h-[28px] border border-[var(--status-focus-border)] bg-[var(--status-focus-bg)] text-focus hover:bg-hover cursor-pointer text-[12px] font-semibold"
                    >
                      {copied === 'cmd' ? t('mcp.copied') : t('mcp.copyClaudeCmd')}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          <div className="flex items-center gap-6 font-mono tabular-nums">
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)] font-sans">{t('mcp.clients')}</span>
              <span className="text-[var(--text-primary)]">{st?.connectedClients ?? 0}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)] font-sans">{t('mcp.calls')}</span>
              <span className="text-[var(--text-primary)]">{st?.totalCalls ?? 0}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={rowLabel}>{t('mcp.ui.claudeTag')}</span>
            <span
              className={`px-2 py-0.5 rounded border font-mono text-[11px] ${
                st?.uiAttached
                  ? 'border-[var(--status-nominal-border)] bg-[var(--status-nominal-bg)] text-nominal'
                  : 'border-[var(--border-strong)] bg-[var(--bg-toolbar)] text-[var(--text-muted)]'
              }`}
            >
              {st?.uiAttached ? t('mcp.uiAttached') : t('mcp.uiDetached')}
            </span>
          </div>

          <div>
            <div className="mb-1 text-[var(--text-muted)]">{t('mcp.uiActions')}</div>
            <div className="border border-[var(--border-grid)] bg-[var(--bg-row-signal)] max-h-[180px] overflow-y-auto font-mono tabular-nums text-[11.5px]">
              {mcp.uiActions.length === 0 ? (
                <div className="px-2 py-1.5 text-[var(--text-muted)] font-sans">{t('mcp.uiActionsEmpty')}</div>
              ) : (
                mcp.uiActions.map((a) => (
                  <div key={a.seq} className="px-2 py-1 flex gap-3 border-b border-[var(--border-grid)] last:border-b-0">
                    <span className="text-[var(--text-muted)] shrink-0">{formatClock(a.atMs)}</span>
                    <span className={`shrink-0 w-[96px] ${a.ok ? 'text-focus' : 'text-critical'}`}>{a.kind}</span>
                    <span className="truncate text-[var(--text-primary)]">{a.summary}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="text-[11.5px] leading-relaxed">{t('mcp.uiNote')}</div>

          {shownError !== null && (
            <div className="px-3 py-2 border border-[var(--status-critical-border)] bg-[var(--status-critical-bg)] text-critical break-words">
              <span className="font-semibold">{t('mcp.error')}: </span>
              {shownError}
            </div>
          )}

          <div className="p-3 bg-[var(--bg-row-signal)] border border-[var(--border-grid)] text-[11.5px] leading-relaxed">
            {t('mcp.note')}
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
