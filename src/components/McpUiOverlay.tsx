import React, { useEffect } from 'react';
import { useI18n } from '../i18n';
import { mcpUiOverlayStore, useMcpUiOverlay } from '../store/mcpUiOverlayStore';
import type { UiNotifyLevel } from '../types/mcp';

const LEVEL_CLASS: Record<UiNotifyLevel, string> = {
  info: 'border-sky-500/60 text-sky-200',
  warn: 'border-amber-500/60 text-amber-200',
  success: 'border-emerald-500/60 text-emerald-200',
};

/** Toasts and Yes/No dialog requested by Claude through the MCP UI bridge. */
export const McpUiOverlay: React.FC = () => {
  const { t } = useI18n();
  const { toasts, confirm } = useMcpUiOverlay();

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') mcpUiOverlayStore.answerConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);

  return (
    <>
      {toasts.length > 0 && (
        <div className="fixed right-3 bottom-12 z-[60] flex flex-col gap-1.5 w-[340px] pointer-events-none">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              style={{ backgroundColor: 'var(--bg-panel)' }}
              className={`pointer-events-auto border px-3 py-2 text-[12px] shadow-xl ${LEVEL_CLASS[toast.level]}`}
              role="status"
            >
              <span className="mr-2 px-1.5 py-0.5 border border-current text-[10px] font-mono uppercase">
                {t('mcp.ui.claudeTag')}
              </span>
              <span className="break-words text-[var(--text-primary)]">{toast.text}</span>
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <div
          onClick={() => mcpUiOverlayStore.answerConfirm(false)}
          className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4 select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="w-full max-w-[460px] border shadow-2xl flex flex-col text-[12px] font-sans"
            role="dialog"
            aria-modal="true"
          >
            <div
              style={{ backgroundColor: 'var(--bg-header)', borderBottom: '1px solid var(--border-strong)' }}
              className="h-[40px] px-4 flex items-center gap-2.5 shrink-0"
            >
              <span className="px-2 py-0.5 rounded border border-sky-500/60 bg-sky-950/40 text-sky-300 font-mono text-[11px]">
                {t('mcp.ui.claudeAsks')}
              </span>
              <span className="font-semibold text-[13px] truncate">{confirm.title}</span>
            </div>
            <div className="p-5 text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
              {confirm.message}
            </div>
            <div className="px-5 pb-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => mcpUiOverlayStore.answerConfirm(false)}
                className="px-3 h-[28px] border border-[var(--border-strong)] bg-[var(--bg-toolbar)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer text-[12px]"
              >
                {t('mcp.ui.no')}
              </button>
              <button
                type="button"
                onClick={() => mcpUiOverlayStore.answerConfirm(true)}
                className="px-3 h-[28px] border border-sky-500/60 bg-sky-950/40 text-sky-300 hover:bg-sky-950/70 cursor-pointer text-[12px] font-semibold"
              >
                {confirm.confirmLabel ?? t('mcp.ui.yes')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
