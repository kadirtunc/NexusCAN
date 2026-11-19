import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Pause, Square, Trash2, LayoutTemplate, ChevronDown, ChevronUp,
  Save, HelpCircle, Grid3x3, Map, Boxes, Package, Settings2, FilePlus2, Upload, RotateCcw,
} from 'lucide-react';
import { FlowCanvas } from './FlowCanvas';
import { FlowPalette } from './FlowPalette';
import { FlowInspector } from './FlowInspector';
import { useFlowStore, flowStore } from './FlowStore';
import { ModalShell } from './ModalShell';
import { ResizablePanel } from './ResizablePanel';
import { FlowRegistryPanel } from './registry/FlowRegistryPanel';
import { FlowDocTabs } from './registry/FlowDocTabs';
import { RunInputsDialog } from './registry/RunInputsDialog';
import { flowRegistry, useFlowRegistry } from './registry/flowRegistryStore';
import { deriveFlowInterface, interfaceSummary } from './flowInterface';
import { ExtractDialog, FlowNotices, FlowTrailBar } from './FlowNestUi';
import type { EcuRecordV1 } from '../../types/diagWorkspace';
import { formatValue } from './coreBlocks';
import { FlowEngine } from './FlowEngine';
import { FLOW_TEMPLATES } from './templates';
import type { RunLogEntry } from './FlowStore';
import type { FlowTemplate } from './types';
import { useI18n } from '../../i18n';
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
} from '../diagnostics/diagUi';

// ─── Template dialog ──────────────────────────────────────────────────────────

const TEMPLATE_CAT_CLASS: Record<string, string> = {
  firmware: 'text-warn',
  diagnostics: 'text-focus',
  examples: 'text-nominal',
};

const TemplateDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n();

  // A template is only a seed: it opens as a NEW, independent flow (nothing is replaced, nothing to confirm).
  const handlePick = useCallback(
    (tpl: FlowTemplate) => {
      flowRegistry.newFromTemplate(tpl);
      onClose();
    },
    [onClose],
  );

  return (
    <ModalShell title={t('flowReg.newFromTemplate')} onClose={onClose} width={640}>
      <div className="flex-1 overflow-y-auto p-4">
        <div className={`${DIAG_SECTION_TITLE} mb-3`}>{t('diagHmi.flow.builtinTemplates')}</div>
        <div className="grid grid-cols-2 gap-3">
          {FLOW_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => handlePick(tpl)}
              className="cursor-pointer rounded-[2px] border border-hairline bg-canvas p-3 text-left hover:border-focus"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className={`font-mono text-[12px] font-semibold ${TEMPLATE_CAT_CLASS[tpl.category] ?? 'text-ink'}`}>
                  {t(tpl.nameKey)}
                </span>
                {tpl.category === 'examples' && (
                  <span className="ml-auto font-mono text-[10.5px] uppercase tracking-wider text-subtle">{t('flowCore.tpl.example')}</span>
                )}
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
      </div>
    </ModalShell>
  );
};

// ─── Conflict dialog ──────────────────────────────────────────────────────────

const ConflictDialog: React.FC = () => {
  const { t } = useI18n();
  const { conflict } = useFlowRegistry();
  if (!conflict) return null;
  return (
    <ModalShell title={t('flowReg.conflict.title')} onClose={() => flowRegistry.dismissConflict()} width={460}>
      <div className="flex flex-col gap-3 p-3.5">
        <div className="text-[12.5px] leading-snug text-ink">
          {t('flowReg.conflict.body', { name: conflict.name, rev: conflict.latestRevision ?? '?' })}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={DIAG_BTN} onClick={() => flowRegistry.dismissConflict()}>
            {t('diagReal.flow.promptCancel')}
          </button>
          <button type="button" className={DIAG_BTN_WARN} onClick={() => void flowRegistry.resolveConflictReload()}>
            {t('flowReg.conflict.reload')}
          </button>
          <button type="button" className={DIAG_BTN_PRIMARY} onClick={() => void flowRegistry.resolveConflictSaveCopy()}>
            {t('flowReg.conflict.copy')}
          </button>
        </div>
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
    {entry.path.length > 1 && <span className="shrink-0 text-subtle" title={entry.path.join(' › ')}>{entry.path.slice(1).join(' › ')} ›</span>}
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

// ─── FlowEditor ────────────────────────────────────────────────────────────

export const FlowEditor: React.FC = () => {
  const { t } = useI18n();
  const state = useFlowStore();
  const registry = useFlowRegistry();
  const {
    diagram, isRunning, isPaused, runLog, readOnly,
    zoom, showGrid, showMinimap,
  } = state;
  const activeDoc = registry.docs.find((d) => d.key === registry.activeKey);

  const engineRef    = useRef<FlowEngine | null>(null);
  const logEndRef    = useRef<HTMLDivElement>(null);
  const [logOpen,     setLogOpen]     = useState(true);
  const [helpOpen,    setHelpOpen]    = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [runDialog,   setRunDialog]   = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameValue,   setNameValue]   = useState(diagram.name);

  // Library index + one-time localStorage migration.
  useEffect(() => {
    void flowRegistry.init();
  }, []);

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
      // Ctrl+S saves the active document (also from inside a field: the browser's "save page" is never wanted here).
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void flowRegistry.save();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { selectedBlockIds, selectedConnectionId } = flowStore.getSnapshot();
        flowStore.removeBlocks(selectedBlockIds);
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
      }

      if (e.key === 'Escape') {
        flowStore.deselectAll();
        flowStore.cancelConnecting();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Run controls ───────────────────────────────────────────────────────────
  const startRun = useCallback(async (inputs: Record<string, unknown>, ecu: EcuRecordV1 | null = null) => {
    if (flowStore.getSnapshot().isRunning) return;
    const engine = new FlowEngine();
    engineRef.current = engine;
    flowRegistry.setRunRoot(flowRegistry.getSnapshot().activeKey);
    await engine.run({ inputs, ecu });
    flowRegistry.setRunRoot(null);
    engineRef.current = null;
    const r = engine.result;
    if (r && !r.refused && !r.stopped) {
      flowStore.addRunLog({
        blockId: '', blockLabel: 'Engine',
        level: r.outcome === 'ok' ? 'success' : r.outcome === 'fail' ? 'warn' : 'error',
        message: t('flowReg.run.result', { outcome: r.outcome, name: r.name ?? '—' }),
      });
      for (const [k, v] of Object.entries(r.outputs)) {
        flowStore.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'info', message: `  ${k} = ${formatValue(v)}` });
      }
    }
  }, [t]);

  const handleRun = useCallback(() => {
    if (isRunning || !activeDoc) return;
    if (deriveFlowInterface(flowStore.getSnapshot().diagram).inputs.length > 0) setRunDialog(true);
    else void startRun({});
  }, [activeDoc, isRunning, startRun]);

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

  const handleNameCommit = useCallback(() => {
    setNameEditing(false);
    if (nameValue.trim()) {
      flowStore.setDiagramName(nameValue.trim());
    }
  }, [nameValue]);

  const hasDoc = activeDoc !== undefined;
  const editable = hasDoc && !readOnly;
  const inputsSpec = hasDoc ? deriveFlowInterface(diagram).inputs : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* ── Toolbar ── */}
      <div className={DIAG_TOOLBAR}>
        {/* Document name */}
        <div className="mr-1 flex items-center gap-1.5">
          {nameEditing && editable ? (
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
              className="max-w-[260px] cursor-pointer truncate font-mono text-xs font-semibold uppercase tracking-wider text-ink hover:text-focus"
              onDoubleClick={() => editable && setNameEditing(true)}
              title={t('diagHmi.flow.renameHint')}
            >
              {hasDoc ? diagram.name : t('flowReg.noDocument')}
            </span>
          )}
          {activeDoc && activeDoc.kind === 'nexuscan.block' && <DiagBadge tone="warn">{t('flowReg.customBlock')}</DiagBadge>}
          {activeDoc && !activeDoc.readOnly && (
            <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted">
              {activeDoc.baseRevision > 0 ? `r${activeDoc.baseRevision}` : t('flowReg.unsavedNew')}
              {activeDoc.dirty && <span className="ml-1 text-warn" title={t('flowReg.unsaved')}>●</span>}
            </span>
          )}
          <button
            type="button"
            onClick={() => void flowRegistry.save()}
            disabled={!editable}
            className={DIAG_BTN_GHOST}
            title={`${t('flowReg.save')} (Ctrl+S)`}
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className={DIAG_DIVIDER} />

        {/* Run controls */}
        <button
          type="button"
          onClick={handleRun}
          disabled={isRunning || !hasDoc}
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

        <button type="button" onClick={handleClear} disabled={!editable} className={DIAG_BTN_GHOST}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.flow.clear')}
        </button>

        <button
          type="button"
          onClick={() => setExtractOpen(true)}
          disabled={!editable || state.selectedBlockIds.length === 0}
          className={DIAG_BTN_GHOST}
          title={t('flowNest.extract.title')}
        >
          <Package className="h-3.5 w-3.5" aria-hidden="true" />
          {t('flowNest.extract.short')}
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

        {/* New from template */}
        <button type="button" onClick={() => setTemplatesOpen(true)} className={DIAG_BTN}>
          <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />
          {t('flowReg.newFromTemplate')}
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

      {/* ── Interface summary / read-only banner ── */}
      {activeDoc && (
        <div className={`flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-3.5 ${activeDoc.readOnly ? 'bg-[var(--status-warn-bg)]' : 'bg-surface'}`}>
          {activeDoc.readOnly ? (
            <>
              <span className="font-mono text-[11.5px] font-semibold uppercase text-warn">
                {t('flowReg.readOnlyBanner', { rev: activeDoc.viewRevision ?? 0 })}
              </span>
              <button
                type="button"
                className={DIAG_BTN_SM}
                onClick={() => {
                  if (activeDoc.viewRevision !== null) void flowRegistry.restoreRevision(activeDoc.id, activeDoc.viewRevision);
                }}
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                {t('flowReg.restoreRevision')}
              </button>
            </>
          ) : (
            <>
              <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-subtle">{t('flowReg.interface')}</span>
              <span className="min-w-0 truncate font-mono text-[11.5px] tabular-nums text-muted" title={interfaceSummary(diagram)}>
                {interfaceSummary(diagram)}
              </span>
            </>
          )}
        </div>
      )}

      <FlowNotices />
      <FlowTrailBar />

      {/* ── Main layout: registry | palette | canvas | inspector ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <FlowRegistryPanel onNewFromTemplate={() => setTemplatesOpen(true)} />

        <ResizablePanel
          id="palette"
          side="left"
          defaultWidth={220}
          minWidth={160}
          maxWidth={480}
          title={t('flowReg.palette.title')}
          icon={<Boxes className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          <FlowPalette />
        </ResizablePanel>

        {/* Canvas area (flex col to accommodate tabs + log panel) */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <FlowDocTabs />

          <div className="min-h-0 flex-1 overflow-hidden">
            {hasDoc ? (
              <FlowCanvas />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="font-mono text-[12px] font-semibold uppercase tracking-wider text-muted">{t('flowReg.empty.title')}</div>
                <div className="max-w-[420px] text-[12px] leading-snug text-subtle">{t('flowReg.empty.hint')}</div>
                <div className="flex flex-wrap justify-center gap-2">
                  <button type="button" className={DIAG_BTN_PRIMARY} onClick={() => flowRegistry.newDocument('nexuscan.flow')}>
                    <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('flowReg.newFlow')}
                  </button>
                  <button type="button" className={DIAG_BTN} onClick={() => flowRegistry.newDocument('nexuscan.block')}>
                    <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('flowReg.newBlock')}
                  </button>
                  <button type="button" className={DIAG_BTN} onClick={() => void flowRegistry.importFromFile()}>
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('flowReg.import')}
                  </button>
                </div>
              </div>
            )}
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

        <ResizablePanel
          id="inspector"
          side="right"
          defaultWidth={260}
          minWidth={240}
          maxWidth={640}
          title={t('diagHmi.flow.properties')}
          icon={<Settings2 className="h-3.5 w-3.5" aria-hidden="true" />}
        >
          <FlowInspector />
        </ResizablePanel>
      </div>

      {/* ── Dialogs ── */}
      {templatesOpen && <TemplateDialog onClose={() => setTemplatesOpen(false)} />}

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      {extractOpen && <ExtractDialog onClose={() => setExtractOpen(false)} />}

      {runDialog && activeDoc && (
        <RunInputsDialog
          docId={activeDoc.id}
          inputs={inputsSpec}
          onCancel={() => setRunDialog(false)}
          onRun={(provided, ecu) => {
            setRunDialog(false);
            void startRun(provided, ecu);
          }}
        />
      )}

      <ConflictDialog />
    </div>
  );
};
