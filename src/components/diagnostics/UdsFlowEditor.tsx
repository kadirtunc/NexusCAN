import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Pause, Square, Trash2, LayoutTemplate, ChevronDown, ChevronUp,
  Save, HelpCircle, Grid3x3, Map, X,
} from 'lucide-react';
import { FlowCanvas } from './uds-flow/FlowCanvas';
import { FlowPalette } from './uds-flow/FlowPalette';
import { FlowInspector } from './uds-flow/FlowInspector';
import { useFlowStore, flowStore } from './uds-flow/FlowStore';
import { FlowEngine } from './uds-flow/FlowEngine';
import { FLOW_TEMPLATES } from './uds-flow/templates';
import type { RunLogEntry } from './uds-flow/FlowStore';
import { useI18n } from '../../i18n';
import { flowPrompt, useFlowPrompt } from './uds-flow/flowPrompt';
import {
  DIAG_BTN,
  DIAG_BTN_ACTIVE,
  DIAG_BTN_DANGER,
  DIAG_BTN_GHOST,
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_BTN_WARN,
  DIAG_DIVIDER,
  DIAG_SECTION_TITLE,
  DIAG_TEXT_TONE,
  DIAG_TOOLBAR,
  DiagBadge,
  DiagDot,
  type DiagTone,
} from './diagUi';

/** Real user-input dialog of the `io_user_prompt` block. */
const FlowPromptDialog: React.FC = () => {
  const { t } = useI18n();
  const prompt = useFlowPrompt();
  const [text, setText] = useState('');
  useEffect(() => {
    if (prompt) setText('');
  }, [prompt]);
  if (!prompt) return null;
  return (
    <ModalShell title={prompt.message} onClose={() => flowPrompt.cancel()} width={420}>
      <form
        className="flex flex-col gap-3 p-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          flowPrompt.answer(text);
        }}
      >
        <input
          autoFocus
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-[2px] border border-hairline bg-canvas px-2 py-1.5 font-mono text-[12px] tabular-nums text-ink outline-none focus:border-focus"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => flowPrompt.cancel()} className={DIAG_BTN}>
            {t('diagReal.flow.promptCancel')}
          </button>
          <button type="submit" className={DIAG_BTN_PRIMARY}>
            {t('diagReal.flow.promptOk')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

// ─── Modal chrome ─────────────────────────────────────────────────────────────

const ModalShell: React.FC<{
  title: string;
  onClose: () => void;
  width: number;
  children: React.ReactNode;
}> = ({ title, onClose, width, children }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ backgroundColor: 'var(--bg-scrim)' }}
    role="dialog"
    aria-modal="true"
  >
    <div
      className="flex max-h-[80vh] w-full flex-col overflow-hidden rounded-[2px] border border-strong bg-surface"
      style={{ maxWidth: width }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline bg-elevated px-3.5">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-ink"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  </div>
);

// ─── Template dialog ──────────────────────────────────────────────────────────

const TEMPLATE_CAT_CLASS: Record<string, string> = {
  firmware: 'text-warn',
  diagnostics: 'text-focus',
};

const TemplateDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const { savedDiagrams } = useFlowStore();

  const handleLoad = useCallback(
    (templateId: string) => {
      const tpl = FLOW_TEMPLATES.find((tp) => tp.id === templateId);
      if (!tpl) return;
      const confirmed = window.confirm(t('diagHmi.flow.templateLoadConfirm', { name: t(tpl.nameKey) }));
      if (confirmed) {
        flowStore.loadTemplate(tpl);
        onClose();
      }
    },
    [onClose, t],
  );

  const handleLoadSaved = useCallback(
    (id: string) => {
      const confirmed = window.confirm(t('diagHmi.flow.savedLoadConfirm'));
      if (confirmed) {
        flowStore.loadDiagram(id);
        onClose();
      }
    },
    [onClose, t],
  );

  const handleDeleteSaved = useCallback((id: string) => {
    flowStore.deleteSavedDiagram(id);
  }, []);

  return (
    <ModalShell title={t('diagHmi.flow.templates')} onClose={onClose} width={640}>
      <div className="flex-1 overflow-y-auto p-4">
        {/* Built-in templates */}
        <div className={`${DIAG_SECTION_TITLE} mb-3`}>{t('diagHmi.flow.builtinTemplates')}</div>
        <div className="mb-6 grid grid-cols-2 gap-3">
          {FLOW_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => handleLoad(tpl.id)}
              className="cursor-pointer rounded-[2px] border border-hairline bg-canvas p-3 text-left transition-colors hover:border-focus"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className={`font-mono text-[12px] font-semibold ${TEMPLATE_CAT_CLASS[tpl.category] ?? 'text-ink'}`}>
                  {t(tpl.nameKey)}
                </span>
              </div>
              <div className="text-[12px] text-muted">{t(tpl.descriptionKey)}</div>
              <div className="mt-2 font-mono text-[11px] tabular-nums text-subtle">
                {t('diagHmi.flow.blockConnCount', {
                  blocks: tpl.diagram.blocks.length,
                  conns: tpl.diagram.connections.length,
                })}
              </div>
            </button>
          ))}
        </div>

        {/* Saved diagrams */}
        {savedDiagrams.length > 0 && (
          <>
            <div className={`${DIAG_SECTION_TITLE} mb-3`}>{t('diagHmi.flow.savedDiagrams')}</div>
            <div className="flex flex-col gap-2">
              {savedDiagrams.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-3 py-2"
                >
                  <div className="flex-1">
                    <div className="text-[12px] text-ink">{d.name}</div>
                    <div className="font-mono text-[11px] tabular-nums text-subtle">
                      {t('diagHmi.flow.blockCount', { n: d.blocks.length })}
                    </div>
                  </div>
                  <button type="button" onClick={() => handleLoadSaved(d.id)} className={DIAG_BTN_SM}>
                    {t('diagHmi.flow.load')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteSaved(d.id)}
                    className={`${DIAG_BTN_SM} hover:!border-critical hover:!text-critical`}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
};

// ─── Run log entry row ────────────────────────────────────────────────────────

const LOG_TONE: Record<RunLogEntry['level'], DiagTone> = {
  info: 'neutral',
  success: 'nominal',
  error: 'critical',
  warn: 'warn',
};

const LogRow: React.FC<{ entry: RunLogEntry }> = React.memo(({ entry }) => (
  <div className={`flex items-center gap-2 py-0.5 font-mono text-[12px] ${DIAG_TEXT_TONE[LOG_TONE[entry.level]]}`}>
    <DiagDot tone={LOG_TONE[entry.level]} />
    <span className="break-all">{entry.message}</span>
  </div>
));

LogRow.displayName = 'LogRow';

// ─── Help overlay ─────────────────────────────────────────────────────────────

const HelpOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Delete / Backspace', t('diagHmi.flow.sc.delete')],
    ['Ctrl + Z',           t('diagHmi.flow.sc.undo')],
    ['Ctrl + A',           t('diagHmi.flow.sc.selectAll')],
    ['Ctrl + S',           t('diagHmi.flow.sc.save')],
    ['Escape',             t('diagHmi.flow.sc.escape')],
    [t('diagHmi.flow.sc.keySpaceDrag'), t('diagHmi.flow.sc.pan')],
    [t('diagHmi.flow.sc.keyWheel'),     t('diagHmi.flow.sc.zoom')],
    [t('diagHmi.flow.sc.keyDblClick'),  t('diagHmi.flow.sc.rename')],
  ];
  return (
    <ModalShell title={t('diagHmi.flow.shortcuts')} onClose={onClose} width={440}>
      <div className="p-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 border-b border-hairline py-1.5 last:border-0">
            <code className="rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
              {k}
            </code>
            <span className="text-[12px] text-muted">{v}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
};

// ─── UdsFlowEditor ────────────────────────────────────────────────────────────

export const UdsFlowEditor: React.FC = () => {
  const { t } = useI18n();
  const state = useFlowStore();
  const {
    diagram, isRunning, isPaused, runLog,
    templateDialogOpen, zoom, showGrid, showMinimap,
  } = state;

  const engineRef    = useRef<FlowEngine | null>(null);
  const logEndRef    = useRef<HTMLDivElement>(null);
  const [logOpen,     setLogOpen]     = useState(true);
  const [helpOpen,    setHelpOpen]    = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameValue,   setNameValue]   = useState(diagram.name);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [runLog.length]);

  // Sync name
  useEffect(() => {
    setNameValue(diagram.name);
  }, [diagram.name]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { selectedBlockIds, selectedConnectionId } = flowStore.getSnapshot();
        selectedBlockIds.forEach((id) => flowStore.removeBlock(id));
        if (selectedConnectionId) flowStore.removeConnection(selectedConnectionId);
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          flowStore.undo();
        }
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault();
          flowStore.selectAllBlocks();
        }
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          flowStore.saveDiagram(diagram.name);
        }
      }

      if (e.key === 'Escape') {
        flowStore.deselectAll();
        flowStore.cancelConnecting();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [diagram.name]);

  // ── Run controls ───────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    if (isRunning) return;
    const engine = new FlowEngine();
    engineRef.current = engine;
    await engine.run();
    engineRef.current = null;
  }, [isRunning]);

  const handlePause = useCallback(() => {
    if (!engineRef.current) return;
    if (isPaused) {
      engineRef.current.resume();
    } else {
      engineRef.current.pause();
    }
  }, [isPaused]);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
    flowStore.setRunning(false);
    flowStore.setPaused(false);
  }, []);

  const handleClear = useCallback(() => {
    if (window.confirm(t('diagHmi.flow.clearConfirm'))) {
      flowStore.clearDiagram();
    }
  }, [t]);

  const handleSave = useCallback(() => {
    flowStore.saveDiagram(diagram.name);
  }, [diagram.name]);

  const handleNameCommit = useCallback(() => {
    setNameEditing(false);
    if (nameValue.trim()) {
      flowStore.setDiagramName(nameValue.trim());
    }
  }, [nameValue]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* ── Toolbar ── */}
      <div className={DIAG_TOOLBAR}>
        {/* Diagram name */}
        <div className="mr-1 flex items-center gap-1.5">
          {nameEditing ? (
            <input
              autoFocus
              className="h-[30px] w-[180px] rounded-[2px] border border-hairline bg-canvas px-2.5 text-[12.5px] text-ink outline-none focus:border-focus"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleNameCommit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameCommit();
                if (e.key === 'Escape') setNameEditing(false);
              }}
            />
          ) : (
            <span
              className="cursor-pointer font-mono text-xs font-semibold uppercase tracking-wider text-ink hover:text-focus"
              onDoubleClick={() => setNameEditing(true)}
              title={t('diagHmi.flow.renameHint')}
            >
              {diagram.name}
            </span>
          )}
          <button type="button" onClick={handleSave} className={DIAG_BTN_GHOST} title="Ctrl+S">
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className={DIAG_DIVIDER} />

        {/* Run controls */}
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={isRunning}
          className={DIAG_BTN_PRIMARY}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.flow.run')}
        </button>

        <button
          type="button"
          onClick={handlePause}
          disabled={!isRunning}
          className={isPaused ? DIAG_BTN_WARN : DIAG_BTN}
        >
          <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          {isPaused ? t('diagHmi.flow.resume') : t('diagHmi.flow.pause')}
        </button>

        <button type="button" onClick={handleStop} disabled={!isRunning} className={DIAG_BTN_DANGER}>
          <Square className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.flow.stop')}
        </button>

        <button type="button" onClick={handleClear} className={DIAG_BTN_GHOST}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.flow.clear')}
        </button>

        <div className="flex-1" />

        {/* View toggles */}
        <button
          type="button"
          onClick={() => flowStore.setShowGrid(!showGrid)}
          className={showGrid ? DIAG_BTN_ACTIVE : DIAG_BTN_GHOST}
          title={t('diagHmi.flow.grid')}
          aria-pressed={showGrid}
        >
          <Grid3x3 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={() => flowStore.setShowMinimap(!showMinimap)}
          className={showMinimap ? DIAG_BTN_ACTIVE : DIAG_BTN_GHOST}
          title={t('diagHmi.flow.minimap')}
          aria-pressed={showMinimap}
        >
          <Map className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        {/* Zoom badge */}
        <DiagBadge>{Math.round(zoom * 100)}%</DiagBadge>

        <div className={DIAG_DIVIDER} />

        {/* Templates */}
        <button type="button" onClick={() => flowStore.setTemplateDialogOpen(true)} className={DIAG_BTN}>
          <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.flow.templates')}
        </button>

        {/* Help */}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className={DIAG_BTN_GHOST}
          title={t('diagHmi.flow.shortcutsTitle')}
        >
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* ── Main 3-panel layout ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Palette */}
        <FlowPalette />

        {/* Canvas area (flex col to accommodate log panel) */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Canvas */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <FlowCanvas />
          </div>

          {/* Run log panel */}
          <div className="shrink-0 border-t border-hairline bg-surface">
            {/* Log header */}
            <div
              className="flex h-8 cursor-pointer select-none items-center gap-2 bg-elevated px-3"
              onClick={() => setLogOpen((v) => !v)}
            >
              <span className={DIAG_SECTION_TITLE}>{t('diagHmi.flow.runLog')}</span>
              {runLog.length > 0 && <DiagBadge>{runLog.length}</DiagBadge>}
              <div className="flex-1" />
              {logOpen && (
                <button
                  type="button"
                  className={DIAG_BTN_SM}
                  onClick={(e) => {
                    e.stopPropagation();
                    flowStore.clearRunLog();
                  }}
                >
                  {t('diagHmi.flow.clear')}
                </button>
              )}
              {logOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              ) : (
                <ChevronUp className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              )}
            </div>

            {/* Log content */}
            {logOpen && (
              <div className="overflow-y-auto border-t border-hairline px-3 py-1" style={{ height: 160 }}>
                {runLog.length === 0 ? (
                  <div className="py-2 font-mono text-[12px] text-subtle">{t('diagHmi.flow.runLogEmpty')}</div>
                ) : (
                  runLog.map((entry) => <LogRow key={entry.id} entry={entry} />)
                )}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Inspector */}
        <FlowInspector />
      </div>

      {/* ── Dialogs ── */}
      {templateDialogOpen && <TemplateDialog onClose={() => flowStore.setTemplateDialogOpen(false)} />}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      <FlowPromptDialog />
    </div>
  );
};
