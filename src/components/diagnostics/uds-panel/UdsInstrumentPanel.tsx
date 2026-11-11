import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  FlaskConical,
  Gauge,
  Lock,
  OctagonX,
  Play,
  Plus,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import { performPanicStop } from '../../../store/panicStop';
import type { SimulationSignalBindingDto, SimulationWidgetKind } from '../../../types/simulation';
import type { UdsPanelDto, UdsWidgetDto } from '../../../types/uds';
import { InstrumentCanvasGrid } from '../../simulation/InstrumentCanvasGrid';
import {
  useInstrumentGridDrag,
  useInstrumentGridDrop,
  useInstrumentGridKeyboard,
  useRunModeButtonHotkeys,
} from '../../simulation/instrumentGridInteractions';
import { SimulationInspectorSidebar } from '../../simulation/SimulationInspectorSidebar';
import { SimulationPaletteSidebar } from '../../simulation/SimulationPaletteSidebar';
import { SimulationRuntimeBus } from '../../simulation/simulationRuntimeBus';
import { SimulationWidgetBody } from '../../simulation/SimulationWidgets';
import {
  findContainingGroup,
  makeSignalBusKey,
  type PaletteDragPayload,
} from '../../simulation/virtualCanPacking';
import { DiagDemoBadge } from '../diagUi';
import { UdsBindingSection } from './UdsBindingSection';
import {
  clampToRange,
  resolveWriteRange,
  udsWidgetReadKey,
  udsServiceLabel,
} from './udsBinding';
import { udsPanelStore, useUdsPanelStore } from './udsInstrumentStore';
import {
  addUdsWidget,
  deleteUdsWidget,
  duplicateUdsWidget,
  moveUdsWidgetIntoGroup,
  updateUdsWidget,
} from './udsPanelActions';
import { UdsPollEngine, useUdsReadStatus, type UdsReadErrorKind } from './udsPollEngine';
import { buildUdsTextboxAdapter } from './udsTextbox';
import { UdsQuickDidList } from './UdsQuickDidList';
import {
  executeUdsWrite,
  useUdsTxGate,
  type UdsTxGateReason,
  type UdsTxGateState,
} from './udsTransport';

/** GNSS map has no UDS meaning; every other Simulation instrument is available. */
const UDS_WIDGET_KINDS: readonly SimulationWidgetKind[] = [
  'gauge',
  'bar',
  'numeric',
  'led',
  'enum_badge',
  'graph',
  'button',
  'checkbox',
  'combobox',
  'slider',
  'textbox',
  'group',
];

const POLL_OPTIONS_MS: readonly number[] = [250, 500, 1000, 2000, 5000];
const NO_WIDGETS: UdsWidgetDto[] = [];

const GATE_REASON_KEY: Record<UdsTxGateReason, TranslationKey> = {
  panic: 'udsPanel.gate.panic',
  noSession: 'udsPanel.gate.noSession',
  busNotConnected: 'udsPanel.gate.busNotConnected',
  listenOnly: 'udsPanel.gate.listenOnly',
  notArmed: 'udsPanel.gate.notArmed',
};

const READ_ERROR_KEY: Record<UdsReadErrorKind, TranslationKey> = {
  backendMissing: 'udsPanel.status.backendMissing',
  notConnected: 'udsPanel.status.notConnected',
  failed: 'udsPanel.status.failed',
  invalidId: 'udsPanel.status.invalidId',
  shortPayload: 'udsPanel.status.shortPayload',
};

function formatPollLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

// ─── Per-widget body (shared Simulation renderer + honest data-state overlay) ─

function UdsWidgetBody({
  widget,
  runtimeBus,
  engine,
  isRunMode,
  isTxOpen,
  groupChildCount,
  onStimulus,
}: {
  widget: UdsWidgetDto;
  runtimeBus: SimulationRuntimeBus;
  engine: UdsPollEngine;
  isRunMode: boolean;
  isTxOpen: boolean;
  groupChildCount: number;
  onStimulus: (
    widget: UdsWidgetDto,
    value: number,
    flags?: { holdMomentary?: boolean; releaseMomentary?: boolean }
  ) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const readKey = udsWidgetReadKey(widget);
  const status = useUdsReadStatus(engine, readKey);
  const showOverlay =
    isRunMode && readKey !== null && widget.kind !== 'group' && status.state !== 'ok';

  const textboxAdapter = useMemo(
    () =>
      widget.kind === 'textbox'
        ? buildUdsTextboxAdapter({ widget, runtimeBus, nowSec: () => engine.nowSec(), t })
        : undefined,
    [engine, runtimeBus, t, widget]
  );

  const handleStimulus = useCallback(
    (
      _binding: SimulationSignalBindingDto,
      value: number,
      flags?: { holdMomentary?: boolean; releaseMomentary?: boolean }
    ) => onStimulus(widget, value, flags),
    [onStimulus, widget]
  );

  return (
    <>
      <SimulationWidgetBody
        widget={widget}
        runtimeBus={runtimeBus}
        isRunMode={isRunMode}
        telemetrySource="live_bridge"
        activeSchema={null}
        allBindings={[]}
        isLiveBusArmed={isTxOpen}
        onStimulus={handleStimulus}
        textboxAdapter={textboxAdapter}
        canMutate
        groupChildCount={groupChildCount}
        onQuickAddToGroup={(groupId, kind) => addUdsWidget(kind, { groupId })}
      />
      {showOverlay && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/85 p-2 text-center font-mono text-[10px] font-semibold uppercase tracking-wider"
          style={{
            color: status.state === 'error' ? 'var(--status-critical)' : 'var(--text-muted)',
          }}
          title={status.state === 'error' ? status.message : undefined}
        >
          {status.state === 'error' ? t(READ_ERROR_KEY[status.kind]) : t('udsPanel.status.awaiting')}
        </div>
      )}
    </>
  );
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function TxGateStrip({ gate, mock }: { gate: UdsTxGateState; mock: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const open = mock || gate === 'open';
  return (
    <span
      className="inline-flex h-[28px] items-center gap-1.5 rounded-[2px] border px-2 font-mono text-[11px] font-semibold uppercase"
      style={{
        backgroundColor: open ? 'var(--status-nominal-bg)' : 'var(--status-warn-bg)',
        borderColor: open ? 'var(--status-nominal-border)' : 'var(--status-warn-border)',
        color: open ? 'var(--status-nominal)' : 'var(--status-warn)',
      }}
      title={mock ? t('udsPanel.gate.mockTitle') : gate === 'open' ? undefined : t(GATE_REASON_KEY[gate])}
    >
      <Lock className="h-3 w-3" aria-hidden="true" />
      {mock
        ? t('udsPanel.gate.mockLocal')
        : gate === 'open'
          ? t('udsPanel.gate.armed')
          : t(GATE_REASON_KEY[gate])}
    </span>
  );
}

function PanelTab({
  panel,
  active,
}: {
  panel: UdsPanelDto;
  active: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(panel.name);

  if (renaming) {
    const commit = (): void => {
      const next = draft.trim();
      if (next) udsPanelStore.renamePanel(panel.id, next);
      setRenaming(false);
    };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setRenaming(false);
        }}
        aria-label={t('udsPanel.toolbar.renameAria')}
        className="h-[28px] w-40 rounded-[2px] border border-focus bg-canvas px-2 font-mono text-[12px] text-ink"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => udsPanelStore.setActivePanel(panel.id)}
      onDoubleClick={() => {
        setDraft(panel.name);
        setRenaming(true);
      }}
      title={t('udsPanel.toolbar.renameHint')}
      aria-pressed={active}
      className={`inline-flex h-[28px] shrink-0 cursor-pointer items-center rounded-[2px] border px-2.5 font-mono text-[12px] ${
        active
          ? 'border-strong bg-elevated font-semibold text-ink'
          : 'border-hairline bg-canvas text-muted hover:border-strong hover:text-ink'
      }`}
    >
      {panel.name}
    </button>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

export const UdsInstrumentPanel: React.FC = () => {
  const { t } = useI18n();
  const state = useUdsPanelStore();
  const gate = useUdsTxGate();

  const runtimeBusRef = useRef<SimulationRuntimeBus | null>(null);
  if (runtimeBusRef.current === null) runtimeBusRef.current = new SimulationRuntimeBus();
  const runtimeBus = runtimeBusRef.current;

  const engineRef = useRef<UdsPollEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new UdsPollEngine(runtimeBus);
  const engine = engineRef.current;

  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [suppressAutoGroupTarget, setSuppressAutoGroupTarget] = useState(false);

  const { panels, activePanelId, mode, selectedWidgetId, pollIntervalMs, mockMode, notice } = state;
  const panel = useMemo(
    () => panels.find((p) => p.id === activePanelId) ?? null,
    [panels, activePanelId]
  );
  const widgets = panel?.widgets ?? NO_WIDGETS;
  const isDesign = mode === 'design';
  const isRun = mode === 'run';
  const isTxOpen = mockMode || gate === 'open';

  const selectedWidget = useMemo(
    () => widgets.find((w) => w.id === selectedWidgetId) ?? null,
    [widgets, selectedWidgetId]
  );

  useEffect(() => {
    setSuppressAutoGroupTarget(false);
  }, [selectedWidgetId]);

  const activeTargetGroup = useMemo<UdsWidgetDto | null>(() => {
    if (!panel || !selectedWidget || suppressAutoGroupTarget) return null;
    if (selectedWidget.kind === 'group') return selectedWidget;
    const found = findContainingGroup(selectedWidget.layout, panel.widgets);
    return found ? (panel.widgets.find((w) => w.id === found.id) ?? null) : null;
  }, [panel, selectedWidget, suppressAutoGroupTarget]);

  // ── Data plane: one poll timer per panel → runtime bus ────────────────────

  const hasGraph = useMemo(() => widgets.some((w) => w.kind === 'graph'), [widgets]);

  // Never let values of a previous panel / run / MOCK session leak into the next one.
  useEffect(() => {
    runtimeBus.reset([], null);
  }, [runtimeBus, activePanelId, mockMode, mode]);

  useEffect(() => {
    engine.configure(widgets, { defaultPollMs: pollIntervalMs, mock: mockMode });
  }, [engine, widgets, pollIntervalMs, mockMode]);

  useEffect(() => {
    if (!isRun || !panel) return;
    engine.start();
    let raf = 0;
    const loop = (): void => {
      runtimeBus.advanceClock(engine.nowSec());
      raf = window.requestAnimationFrame(loop);
    };
    if (hasGraph) raf = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(raf);
      engine.stop();
    };
  }, [engine, runtimeBus, isRun, panel, hasGraph]);

  useEffect(() => () => engine.stop(), [engine]);

  // ── Shared grid interactions ──────────────────────────────────────────────

  const clearSelection = useCallback(() => udsPanelStore.selectWidget(null), []);
  const { dragStateRef, dragHoverGroupId, setDragHoverGroupId } = useInstrumentGridDrag<
    UdsWidgetDto,
    UdsPanelDto
  >({
    panel,
    containerRef: gridContainerRef,
    mutatePanel: udsPanelStore.mutateActivePanel,
  });

  useInstrumentGridKeyboard<UdsWidgetDto, UdsPanelDto>({
    enabled: panel !== null,
    isDesignMode: isDesign,
    canMutate: true,
    selectedWidgetId,
    mutatePanel: udsPanelStore.mutateActivePanel,
    onClearSelection: clearSelection,
  });

  useRunModeButtonHotkeys({ enabled: isRun && panel !== null, widgets, runtimeBus });

  const handleDropPayload = useCallback(
    (
      payload: PaletteDragPayload,
      cell: { col: number; row: number },
      hoveredGroupId: string | null
    ) => {
      if (hoveredGroupId && payload.kind !== 'group') {
        addUdsWidget(payload.kind, { groupId: hoveredGroupId, preferredCell: cell });
        return;
      }
      addUdsWidget(payload.kind, { dropCell: cell });
      setSuppressAutoGroupTarget(false);
    },
    []
  );

  const { handleDragOver, handleDragLeave, handleDrop } = useInstrumentGridDrop<
    UdsWidgetDto,
    UdsPanelDto
  >({
    containerRef: gridContainerRef,
    panel,
    isDesignMode: isDesign,
    canMutate: true,
    setDragHoverGroupId,
    onDropPayload: handleDropPayload,
  });

  // ── Writes: clamp → TX gate (Listen-Only / Arm / Panic) → raw UDS request ──

  const handleStimulus = useCallback(
    (widget: UdsWidgetDto, value: number) => {
      void (async () => {
        if (!widget.udsWrite || !widget.binding) {
          udsPanelStore.notify('warning', 'udsPanel.notice.noWriteBinding', { title: widget.title });
          return;
        }
        const busKey = makeSignalBusKey(widget.binding.messageKey, widget.binding.signalName);
        const snap = udsPanelStore.getSnapshot();

        if (snap.mockMode) {
          // DEMO only: nothing is transmitted; local echo so the demo panel reacts.
          runtimeBus.publishExternalSample(
            busKey,
            clampToRange(value, resolveWriteRange(widget)),
            engine.nowSec()
          );
          return;
        }

        const result = await executeUdsWrite(widget, value);
        switch (result.status) {
          case 'sent':
            // Positive response: reflect the clamped value that actually went on the wire.
            runtimeBus.publishExternalSample(busKey, result.clampedValue, engine.nowSec());
            if (result.wasClamped) {
              udsPanelStore.notify('warning', 'udsPanel.notice.clamped', {
                title: widget.title,
                requested: Number(value.toFixed(3)),
                sent: Number(result.clampedValue.toFixed(3)),
              });
            }
            break;
          case 'blocked':
            udsPanelStore.notify('error', 'udsPanel.notice.blocked', {
              title: widget.title,
              reason: t(GATE_REASON_KEY[result.reason]),
            });
            break;
          case 'invalid':
            udsPanelStore.notify(
              'error',
              result.reason === 'offsetUnsupported'
                ? 'udsPanel.notice.writeOffsetUnsupported'
                : 'udsPanel.notice.writeInvalidId',
              { title: widget.title }
            );
            break;
          case 'error':
            udsPanelStore.notify(
              'error',
              result.kind === 'backendMissing'
                ? 'udsPanel.notice.backendMissing'
                : result.kind === 'notConnected'
                  ? 'udsPanel.notice.notConnected'
                  : 'udsPanel.notice.writeFailed',
              { title: widget.title, message: result.message }
            );
            break;
        }
      })();
    },
    [engine, runtimeBus, t]
  );

  const handlePanicStop = useCallback(() => {
    void performPanicStop().catch((err: unknown) => {
      udsPanelStore.notify('error', 'udsPanel.notice.panicFailed', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, []);

  const handleAddWidget = useCallback(
    (kind: SimulationWidgetKind) => {
      addUdsWidget(kind, { groupId: kind !== 'group' ? (activeTargetGroup?.id ?? null) : null });
      setSuppressAutoGroupTarget(false);
    },
    [activeTargetGroup]
  );

  const handleSelectWidget = useCallback((id: string | null) => {
    udsPanelStore.selectWidget(id);
    if (id !== null) setSuppressAutoGroupTarget(false);
  }, []);

  const handleDeletePanel = useCallback(() => {
    if (!panel) return;
    if (window.confirm(t('udsPanel.toolbar.deleteConfirm', { name: panel.name }))) {
      udsPanelStore.deletePanel(panel.id);
    }
  }, [panel, t]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-surface px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold uppercase tracking-wider text-ink">
            <Gauge className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            {t('udsPanel.toolbar.title')}
          </span>
          <div className="flex min-w-0 max-w-[46vw] items-center gap-1 overflow-x-auto">
            {panels.map((p) => (
              <PanelTab key={p.id} panel={p} active={p.id === activePanelId} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => udsPanelStore.createPanel(t('udsPanel.toolbar.newPanelName', { n: panels.length + 1 }))}
            title={t('udsPanel.toolbar.newPanel')}
            aria-label={t('udsPanel.toolbar.newPanel')}
            className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-focus hover:border-strong"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {panel && (
            <button
              type="button"
              onClick={handleDeletePanel}
              title={t('udsPanel.toolbar.deletePanel')}
              aria-label={t('udsPanel.toolbar.deletePanel')}
              className="inline-flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-canvas text-muted hover:border-critical hover:text-critical"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted">
            {t('udsPanel.toolbar.poll')}
            <select
              value={pollIntervalMs}
              onChange={(e) => udsPanelStore.setPollInterval(Number(e.target.value))}
              className="h-[28px] rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[11px] tabular-nums text-ink"
            >
              {POLL_OPTIONS_MS.map((ms) => (
                <option key={ms} value={ms}>
                  {formatPollLabel(ms)}
                </option>
              ))}
            </select>
          </label>

          {mockMode && <DiagDemoBadge />}

          <TxGateStrip gate={gate} mock={mockMode} />

          <button
            type="button"
            onClick={handlePanicStop}
            title={t('udsPanel.toolbar.stopAllTxTitle')}
            className="inline-flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[2px] border px-2.5 font-mono text-[11px] font-bold uppercase"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical-border)',
              color: 'var(--status-critical)',
            }}
          >
            <OctagonX className="h-3.5 w-3.5" aria-hidden="true" />
            {t('udsPanel.toolbar.stopAllTx')}
          </button>

          {/* Mode Switch: [ DESIGN ] vs [ RUN ] */}
          <div
            role="group"
            aria-label={t('udsPanel.toolbar.modeAria')}
            className="inline-flex h-[30px] items-center rounded-[2px] border border-strong bg-canvas p-0.5 font-mono text-[12px] font-bold uppercase tracking-wider"
          >
            <button
              type="button"
              onClick={() => udsPanelStore.setMode('design')}
              aria-pressed={isDesign}
              className={`inline-flex h-full cursor-pointer items-center gap-1 rounded-[2px] border px-3 transition-colors ${
                isDesign
                  ? 'border-hairline bg-elevated text-ink'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              <Wrench className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
              {t('udsPanel.toolbar.modeDesign')}
            </button>
            <button
              type="button"
              onClick={() => udsPanelStore.setMode('run')}
              aria-pressed={isRun}
              className={`inline-flex h-full cursor-pointer items-center gap-1 rounded-[2px] border px-3 transition-colors ${
                isRun ? '' : 'border-transparent text-muted hover:text-ink'
              }`}
              style={
                isRun
                  ? {
                      backgroundColor: 'var(--status-nominal-bg)',
                      borderColor: 'var(--status-nominal-border)',
                      color: 'var(--status-nominal)',
                    }
                  : undefined
              }
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {t('udsPanel.toolbar.modeRun')}
            </button>
          </div>
        </div>
      </div>

      {mockMode && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-1 font-mono text-[11px] font-bold uppercase tracking-wider"
          style={{
            backgroundColor: 'var(--status-warn-bg)',
            borderColor: 'var(--status-warn-border)',
            color: 'var(--status-warn)',
          }}
          role="status"
        >
          <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
          {t('udsPanel.mockBanner')}
        </div>
      )}

      {notice && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 font-mono text-xs"
          style={{
            backgroundColor:
              notice.tone === 'error' ? 'var(--status-critical-bg)' : 'var(--status-warn-bg)',
            borderColor:
              notice.tone === 'error' ? 'var(--status-critical-border)' : 'var(--status-warn-border)',
            color: notice.tone === 'error' ? 'var(--status-critical)' : 'var(--status-warn)',
          }}
        >
          <span className="inline-flex items-center gap-2">
            {notice.tone === 'info' ? (
              <Check className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            )}
            {t(notice.key, notice.params)}
          </span>
          <button
            type="button"
            onClick={() => udsPanelStore.dismissNotice()}
            className="cursor-pointer p-0.5"
            aria-label={t('udsPanel.notice.dismissAria')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {!panel ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-xl rounded-[2px] border border-hairline bg-surface p-6">
            <div className="flex items-center gap-2 border-b border-hairline pb-3 font-mono text-xs font-bold uppercase tracking-wider text-ink">
              <Gauge className="h-4 w-4 text-focus" aria-hidden="true" />
              {t('udsPanel.empty.title')}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted">{t('udsPanel.empty.desc')}</p>
            <button
              type="button"
              onClick={() => udsPanelStore.createPanel(t('udsPanel.toolbar.newPanelName', { n: 1 }))}
              className="mt-5 inline-flex h-[32px] cursor-pointer items-center gap-1.5 rounded-[2px] border px-3.5 font-mono text-[12px] font-semibold uppercase"
              style={{
                backgroundColor: 'var(--status-focus-bg)',
                borderColor: 'var(--status-focus-border)',
                color: 'var(--status-focus)',
              }}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('udsPanel.empty.create')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {isDesign && (
            <SimulationPaletteSidebar
              canMutate
              widgetKinds={UDS_WIDGET_KINDS}
              targetGroupTitle={activeTargetGroup?.title ?? null}
              onClearTargetGroup={() => setSuppressAutoGroupTarget(true)}
              onAddWidget={handleAddWidget}
              signalSource={<UdsQuickDidList />}
            />
          )}

          <InstrumentCanvasGrid<UdsWidgetDto>
            widgets={panel.widgets}
            gridCols={panel.gridCols}
            rowHeightPx={panel.rowHeightPx}
            isDesignMode={isDesign}
            canMutate
            selectedWidgetId={selectedWidgetId}
            dragHoverGroupId={dragHoverGroupId}
            containerRef={gridContainerRef}
            dragStateRef={dragStateRef}
            onSelectWidget={handleSelectWidget}
            onDuplicateWidget={duplicateUdsWidget}
            onDeleteWidget={deleteUdsWidget}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            getHeaderMeta={(w) => {
              const src = w.udsRead ?? w.udsWrite;
              if (!src) return { badge: null, tag: null };
              const id =
                src.service === 'read_did' || src.service === 'write_did' || src.service === 'io_control'
                  ? src.did
                  : src.address;
              return { badge: `UDS ${udsServiceLabel(src.service)}`, tag: id.toUpperCase() };
            }}
            emptyState={
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="max-w-md rounded-[2px] border border-hairline bg-surface p-5 text-center">
                  <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                    {t('udsPanel.grid.emptyTitle')}
                  </p>
                  <p className="mt-1.5 text-xs text-muted">{t('udsPanel.grid.emptyDesc')}</p>
                </div>
              </div>
            }
            renderBody={(widget, { groupChildCount }) => (
              <UdsWidgetBody
                widget={widget}
                runtimeBus={runtimeBus}
                engine={engine}
                isRunMode={isRun}
                isTxOpen={isTxOpen}
                groupChildCount={groupChildCount}
                onStimulus={handleStimulus}
              />
            )}
          />

          {isDesign && (
            <SimulationInspectorSidebar
              canMutate
              gridCols={panel.gridCols}
              selectedWidget={selectedWidget}
              allWidgets={panel.widgets}
              widgetKinds={UDS_WIDGET_KINDS}
              showGeneratorsTab={false}
              showTxCycle={false}
              textboxSource="bytes"
              onSelectWidget={handleSelectWidget}
              onAddWidgetToGroup={(groupId, kind) => addUdsWidget(kind, { groupId, select: false })}
              onMoveWidgetIntoGroup={moveUdsWidgetIntoGroup}
              onUpdateWidget={updateUdsWidget}
              onDuplicateWidget={duplicateUdsWidget}
              onDeleteWidget={deleteUdsWidget}
              renderBindingSection={(w) => {
                const target = panel.widgets.find((cand) => cand.id === w.id);
                return target ? <UdsBindingSection widget={target} canMutate /> : null;
              }}
            />
          )}
        </div>
      )}
    </div>
  );
};
