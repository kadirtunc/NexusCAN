'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Grid,
  Move,
  Plus,
} from 'lucide-react';
import type {
  BitCellDto,
  BitOverlapDiagnosticDto,
  MessageSchemaDto,
  SignalSchemaDto,
} from './contracts';
import {
  computeSignalScalingPreview,
  formatHexArbId,
  getSignalColor,
} from './dbcEditorUtils';
import { computeDropStartBit, computeSignalFootprint } from './bitDrag';
import {
  areMuxExclusive,
  buildMuxSwitchTree,
  defaultMuxSelection,
  isSignalVisibleOnPage,
  selectionRevealingSignal,
  visibleSwitchNodes,
  type MuxSelection,
} from './muxView';
import { useDbcStudioI18n } from './i18n/dbcStudio';

interface CandbInteractiveBitMatrixTabProps {
  selectedMessage: MessageSchemaDto | null;
  messageSignals: readonly SignalSchemaDto[];
  selectedSignal: SignalSchemaDto | null;
  messageBitOverlaps: readonly BitOverlapDiagnosticDto[];
  canMutate: boolean;
  onSelectSignal: (signalId: number | null) => void;
  onMoveSignalStartBit: (signalId: number, nextStartBit: number) => void;
  onAddSignalAtBit: (messageKey: string, startBit: number) => void;
  onOpenSignalDialog?: (signalId: number) => void;
}

type EmptyCellClickMode = 'moveSelected' | 'createNew';

/** Pointer travel (px) before a press on a signal cell becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 4;

interface DragSession {
  pointerId: number;
  signalId: number;
  grabbedBitIndex: number;
  originX: number;
  originY: number;
  active: boolean;
  targetBit: number | null;
}

/** Render state of an active drag; updated only when the hovered target cell changes. */
interface DragView {
  signalId: number;
  fromStart: number;
  toStart: number | null;
  targetBit: number;
  /** Ghost footprint (linear bits), null when the drop would be out of range. */
  ghost: ReadonlySet<number> | null;
  overlaps: number;
}

export function CandbInteractiveBitMatrixTab({
  selectedMessage,
  messageSignals,
  selectedSignal,
  messageBitOverlaps,
  canMutate,
  onSelectSignal,
  onMoveSignalStartBit,
  onAddSignalAtBit,
  onOpenSignalDialog,
}: CandbInteractiveBitMatrixTabProps): React.JSX.Element {
  const { locale, t } = useDbcStudioI18n();
  const [hoveredSignalId, setHoveredSignalId] = useState<number | null>(null);
  const [hoveredBitCoord, setHoveredBitCoord] = useState<{
    byteIndex: number;
    bitInByte: number;
  } | null>(null);
  const [clickMode, setClickMode] =
    useState<EmptyCellClickMode>('moveSelected');
  const [showAllFdBytes, setShowAllFdBytes] = useState<boolean>(true);

  // Drag-to-move: session in a ref (no re-render per pointer move), view state only on target change.
  const dragRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef<boolean>(false);
  const [dragView, setDragView] = useState<DragView | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current) {
        dragRef.current = null;
        setDragView(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A different message invalidates any drag in flight.
  useEffect(() => {
    dragRef.current = null;
    setDragView(null);
  }, [selectedMessage?.messageKey]);

  // Scaling tester bidirectional state
  const [rawTestValue, setRawTestValue] = useState<number>(0);
  const [physDraft, setPhysDraft] = useState<string>('0');

  useEffect(() => {
    if (!selectedSignal) {
      setRawTestValue(0);
      setPhysDraft('0');
      return;
    }
    const factor =
      Number.isFinite(selectedSignal.factor) && selectedSignal.factor !== 0
        ? selectedSignal.factor
        : 1;
    const offset = Number.isFinite(selectedSignal.offset)
      ? selectedSignal.offset
      : 0;
    const initialPhys = selectedSignal.initialValue ?? offset;
    const initRaw = (initialPhys - offset) / factor;
    const cleanRaw =
      selectedSignal.valueType === 'float32' ||
      selectedSignal.valueType === 'float64'
        ? initRaw
        : Math.round(initRaw);
    setRawTestValue(Number.isFinite(cleanRaw) ? cleanRaw : 0);
    setPhysDraft(
      String(
        Number(
          ((Number.isFinite(cleanRaw) ? cleanRaw : 0) * factor + offset).toPrecision(
            10
          )
        )
      )
    );
  }, [
    selectedSignal?.signalId,
    selectedSignal?.factor,
    selectedSignal?.offset,
    selectedSignal?.bitLength,
    selectedSignal?.valueType,
  ]);

  const signalMap = useMemo(() => {
    const map = new Map<number, SignalSchemaDto>();
    for (const s of messageSignals) {
      map.set(s.signalId, s);
    }
    return map;
  }, [messageSignals]);

  // --- Multiplexer page selection -------------------------------------------------------------
  const muxTree = useMemo(
    () => buildMuxSwitchTree(messageSignals),
    [messageSignals]
  );
  const messageKey = selectedMessage?.messageKey ?? null;
  const [muxState, setMuxState] = useState<{
    messageKey: string | null;
    sel: ReadonlyMap<number, number | 'all'>;
  }>({ messageKey: null, sel: new Map() });

  // Selection for the current message: stored choices (same message only) over per-switch defaults.
  const muxSel: MuxSelection = useMemo(() => {
    const base = defaultMuxSelection(muxTree);
    if (muxState.messageKey === messageKey) {
      for (const [id, v] of muxState.sel) {
        if (base.has(id)) base.set(id, v);
      }
    }
    return base;
  }, [muxTree, muxState, messageKey]);
  const muxSelRef = useRef<MuxSelection>(muxSel);
  muxSelRef.current = muxSel;

  const shownSwitches = useMemo(
    () => visibleSwitchNodes(muxTree, muxSel, signalMap),
    [muxTree, muxSel, signalMap]
  );

  const switchDepth = useMemo(() => {
    const depth = new Map<number, number>();
    const parentOf = new Map(muxTree.map((n) => [n.switchId, n.parentSwitchId]));
    for (const n of muxTree) {
      let d = 0;
      let cur = n.parentSwitchId;
      while (cur !== null && cur !== undefined && d < 16) {
        d += 1;
        cur = parentOf.get(cur) ?? null;
      }
      depth.set(n.switchId, d);
    }
    return depth;
  }, [muxTree]);

  const visibleIds = useMemo(() => {
    const ids = new Set<number>();
    for (const sg of messageSignals) {
      if (isSignalVisibleOnPage(sg, muxSel, signalMap)) ids.add(sg.signalId);
    }
    return ids;
  }, [messageSignals, muxSel, signalMap]);

  // Hidden signal selected from tree / list -> switch to the page that shows it.
  useEffect(() => {
    if (!selectedSignal || !messageKey) return;
    const sg = signalMap.get(selectedSignal.signalId);
    if (!sg || isSignalVisibleOnPage(sg, muxSelRef.current, signalMap)) return;
    setMuxState({
      messageKey,
      sel: selectionRevealingSignal(sg, muxSelRef.current, signalMap),
    });
    // Only react to a changed selection, never to the user's own combobox changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSignal?.signalId]);

  const setSwitchPage = (switchId: number, value: number | 'all') => {
    const next = new Map(muxSel);
    next.set(switchId, value);
    setMuxState({ messageKey, sel: next });
  };

  /** Visible cells per coordinate + collision classification (real collision vs mux overlay). */
  const cellInfoByCoord = useMemo(() => {
    const map = new Map<
      string,
      { cells: BitCellDto[]; colliding: boolean; overlaid: boolean }
    >();
    if (!selectedMessage) return map;
    for (const cell of selectedMessage.bitLayout) {
      if (!visibleIds.has(cell.signalId)) continue;
      const key = `${cell.byteIndex}:${cell.bitInByte}`;
      const hit = map.get(key);
      if (hit) hit.cells.push(cell);
      else map.set(key, { cells: [cell], colliding: false, overlaid: false });
    }
    for (const info of map.values()) {
      if (info.cells.length < 2) continue;
      let collide = false;
      for (let i = 0; i < info.cells.length && !collide; i += 1) {
        const a = signalMap.get(info.cells[i].signalId);
        for (let j = i + 1; j < info.cells.length; j += 1) {
          const b = signalMap.get(info.cells[j].signalId);
          if (!a || !b || !areMuxExclusive(a, b, signalMap)) {
            collide = true;
            break;
          }
        }
      }
      info.colliding = collide;
      info.overlaid = !collide;
    }
    return map;
  }, [selectedMessage, visibleIds, signalMap]);

  const occupantsByLinear = useMemo(() => {
    const map = new Map<number, number[]>();
    if (!selectedMessage) return map;
    for (const cell of selectedMessage.bitLayout) {
      if (!visibleIds.has(cell.signalId)) continue;
      const lin = cell.byteIndex * 8 + cell.bitInByte;
      const list = map.get(lin);
      if (list) {
        list.push(cell.signalId);
      } else {
        map.set(lin, [cell.signalId]);
      }
    }
    return map;
  }, [selectedMessage, visibleIds]);

  const scalingPreview = useMemo(() => {
    if (!selectedSignal) return null;
    return computeSignalScalingPreview(selectedSignal, rawTestValue, locale);
  }, [locale, rawTestValue, selectedSignal]);

  if (!selectedMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 p-8 text-center">
        <Grid className="h-7 w-7 text-muted" aria-hidden="true" />
        <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          {t('bitMatrix.emptyPrompt')}
        </p>
      </div>
    );
  }

  const totalBytes = Math.max(1, Math.min(64, selectedMessage.dlc));
  const visibleBytes =
    showAllFdBytes || totalBytes <= 24 ? totalBytes : 24;
  const activeFocusSigId = hoveredSignalId ?? selectedSignal?.signalId ?? null;

  const handleEmptyCellClick = (byteIdx: number, bitInByte: number) => {
    if (!canMutate) return;
    const linearBit = byteIdx * 8 + bitInByte;
    if (clickMode === 'createNew' || !selectedSignal) {
      onAddSignalAtBit(selectedMessage.messageKey, linearBit);
    } else {
      onMoveSignalStartBit(selectedSignal.signalId, linearBit);
    }
  };

  const totalBits = totalBytes * 8;

  const beginDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    cell: BitCellDto | undefined
  ) => {
    suppressClickRef.current = false;
    if (!canMutate || !cell || e.button !== 0 || !signalMap.has(cell.signalId) || !visibleIds.has(cell.signalId)) {
      return;
    }
    dragRef.current = {
      pointerId: e.pointerId,
      signalId: cell.signalId,
      grabbedBitIndex: cell.signalBitIndex,
      originX: e.clientX,
      originY: e.clientY,
      active: false,
      targetBit: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.active) {
      if (
        Math.hypot(e.clientX - d.originX, e.clientY - d.originY) <
        DRAG_THRESHOLD_PX
      ) {
        return;
      }
      d.active = true;
    }
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-bit]');
    const target = hit ? Number(hit.dataset.bit) : null;
    if (target === null || !Number.isInteger(target) || target === d.targetBit) {
      return;
    }
    d.targetBit = target;
    const sig = signalMap.get(d.signalId);
    if (!sig) return;
    const toStart = computeDropStartBit(
      d.grabbedBitIndex,
      target,
      sig,
      totalBits
    );
    const ghostBits =
      toStart === null
        ? null
        : computeSignalFootprint(
            toStart,
            sig.bitLength,
            sig.byteOrder,
            totalBits
          );
    let overlaps = 0;
    if (ghostBits) {
      for (const bit of ghostBits) {
        const occ = occupantsByLinear.get(bit);
        if (
          occ &&
          occ.some((id) => {
            if (id === d.signalId) return false;
            const other = signalMap.get(id);
            return !other || !areMuxExclusive(sig, other, signalMap);
          })
        ) {
          overlaps += 1;
        }
      }
    }
    setDragView({
      signalId: d.signalId,
      fromStart: sig.startBit,
      toStart,
      targetBit: target,
      ghost: ghostBits ? new Set(ghostBits) : null,
      overlaps,
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d.active) return;
    // The click that follows pointerup must not re-select / open the dialog.
    suppressClickRef.current = true;
    setDragView(null);
    const sig = signalMap.get(d.signalId);
    if (!sig || d.targetBit === null) return;
    const next = computeDropStartBit(
      d.grabbedBitIndex,
      d.targetBit,
      sig,
      totalBits
    );
    if (next !== null && next !== sig.startBit) {
      onMoveSignalStartBit(sig.signalId, next);
    }
  };

  const cancelDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    suppressClickRef.current = d.active;
    setDragView(null);
  };

  const dragSignal = dragView ? signalMap.get(dragView.signalId) : undefined;
  const ghostColor = dragView
    ? dragView.toStart === null
      ? 'var(--status-critical)'
      : dragView.overlaps > 0
        ? 'var(--status-warn)'
        : getSignalColor(dragView.signalId)
    : 'transparent';

  /** Per-cell drag overlay: dashed ghost outline on the target footprint, dimmed source cells. */
  const dragCellStyle = (linearBit: number): React.CSSProperties => {
    if (!dragView) return {};
    const style: React.CSSProperties = { cursor: 'grabbing' };
    const inGhost = dragView.ghost
      ? dragView.ghost.has(linearBit)
      : linearBit === dragView.targetBit;
    if (inGhost) {
      style.border = `1px dashed ${ghostColor}`;
      style.backgroundColor = `color-mix(in srgb, ${ghostColor} 28%, transparent)`;
    }
    const isSource = (occupantsByLinear.get(linearBit) ?? []).includes(
      dragView.signalId
    );
    if (isSource && !inGhost) style.opacity = 0.35;
    return style;
  };

  const handleRawInputChange = (valStr: string) => {
    if (!selectedSignal) return;
    const parsed = Number.parseFloat(valStr);
    const nextRaw = Number.isFinite(parsed) ? parsed : 0;
    setRawTestValue(nextRaw);
    const preview = computeSignalScalingPreview(
      selectedSignal,
      nextRaw,
      locale
    );
    setPhysDraft(String(preview.physicalValue));
  };

  const handlePhysInputChange = (valStr: string) => {
    setPhysDraft(valStr);
    if (!selectedSignal) return;
    const parsedPhys = Number.parseFloat(valStr);
    if (!Number.isFinite(parsedPhys)) return;
    const factor =
      Number.isFinite(selectedSignal.factor) && selectedSignal.factor !== 0
        ? selectedSignal.factor
        : 1;
    const offset = Number.isFinite(selectedSignal.offset)
      ? selectedSignal.offset
      : 0;
    const rawCalc = (parsedPhys - offset) / factor;
    const cleanRaw =
      selectedSignal.valueType === 'float32' ||
      selectedSignal.valueType === 'float64'
        ? rawCalc
        : Math.round(rawCalc);
    setRawTestValue(cleanRaw);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 space-y-3 bg-canvas">
      {/* WASM Bit-Overlap Status / Explanation Banner */}
      {messageBitOverlaps.length > 0 ? (
        <div
          role="alert"
          className="rounded-[2px] border p-2.5 space-y-1.5 font-mono text-xs"
          style={{
            backgroundColor: 'var(--status-critical-bg)',
            borderColor: 'var(--status-critical)',
            color: 'var(--status-critical)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {t('bitMatrix.overlapAlertTitle', {
                  count: messageBitOverlaps.length,
                })}
              </span>
            </div>
            <span className="tabular-nums text-[10px]">
              {t('bitMatrix.wasmValidationBadge')}
            </span>
          </div>
          <ul className="max-h-24 overflow-y-auto space-y-0.5 pl-6 text-[11px] tabular-nums text-ink">
            {messageBitOverlaps.slice(0, 8).map((ov, i) => (
              <li key={`${ov.byteIndex}-${ov.bitInByte}-${i}`}>
                {t('bitMatrix.overlapItemCoord', {
                  byte: ov.byteIndex,
                  bit: ov.bitInByte,
                  linear: ov.byteIndex * 8 + ov.bitInByte,
                })}{' '}
                <strong className="text-critical">
                  {ov.signalNames.join(' ↔ ')}
                </strong>{' '}
                — {ov.description}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-hairline bg-surface px-3 py-2 font-mono text-[11px]">
          <div className="flex items-center gap-2 text-nominal">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="font-semibold">
              {t('bitMatrix.verifiedZeroOverlaps')}
            </span>
            <span className="text-muted">·</span>
            <span className="tabular-nums text-ink">
              {formatHexArbId(
                selectedMessage.arbId,
                selectedMessage.isExtended
              )}{' '}
              {selectedMessage.name} ({selectedMessage.dlc}B /{' '}
              {selectedMessage.dlc * 8}b)
            </span>
          </div>

          {hoveredBitCoord && (
            <span className="tabular-nums text-focus">
              {t('bitMatrix.hoveredCellReadout', {
                byte: hoveredBitCoord.byteIndex,
                bit: hoveredBitCoord.bitInByte,
                linear:
                  hoveredBitCoord.byteIndex * 8 + hoveredBitCoord.bitInByte,
              })}
            </span>
          )}
        </div>
      )}

      {/* Interactive Click-to-Place / Move Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border border-hairline bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="uppercase tracking-wider text-muted">
            {t('bitMatrix.clickModeLabel')}
          </span>
          <div className="inline-flex divide-x divide-hairline rounded-[2px] border border-hairline bg-canvas">
            <button
              type="button"
              disabled={!canMutate}
              onClick={() => setClickMode('moveSelected')}
              className={`inline-flex h-6 cursor-pointer items-center gap-1 px-2.5 font-mono text-[10px] font-semibold uppercase transition-colors ${
                clickMode === 'moveSelected'
                  ? 'bg-elevated text-focus'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Move className="h-3 w-3" aria-hidden="true" />
              {t('bitMatrix.modeMoveSelected')}
            </button>
            <button
              type="button"
              disabled={!canMutate}
              onClick={() => setClickMode('createNew')}
              className={`inline-flex h-6 cursor-pointer items-center gap-1 px-2.5 font-mono text-[10px] font-semibold uppercase transition-colors ${
                clickMode === 'createNew'
                  ? 'bg-elevated text-nominal'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              {t('bitMatrix.modeCreateNew')}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
          {selectedSignal ? (
            <>
              <span className="text-ink">
                {t('bitMatrix.activeSignalLabel')}{' '}
                <strong className="text-focus">{selectedSignal.name}</strong> (
                start:{selectedSignal.startBit} · len:{selectedSignal.bitLength}b
                ·{' '}
                {selectedSignal.byteOrder === 'bigEndian'
                  ? '@0 Motorola BE'
                  : '@1 Intel LE'}
                )
              </span>
              {onOpenSignalDialog && (
                <button
                  type="button"
                  onClick={() => onOpenSignalDialog(selectedSignal.signalId)}
                  className="inline-flex h-6 cursor-pointer items-center rounded-[2px] border border-hairline bg-elevated px-2 font-mono text-[10px] font-semibold text-focus transition-colors hover:border-strong hover:text-ink"
                >
                  {t('common.edit')}
                </button>
              )}
            </>
          ) : (
            <span className="text-muted">
              {t('bitMatrix.noSignalSelectedHint')}
            </span>
          )}
        </div>
      </div>

      {/* Multiplexer page selector */}
      {shownSwitches.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-[2px] border border-hairline bg-surface px-3 py-2 font-mono text-[11px] tabular-nums">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {shownSwitches.map((node) => {
              const sw = signalMap.get(node.switchId);
              const cur = muxSel.get(node.switchId) ?? 'all';
              const depth = switchDepth.get(node.switchId) ?? 0;
              return (
                <label
                  key={node.switchId}
                  className="inline-flex items-center gap-1.5 text-muted"
                >
                  <span className="text-ink">
                    {depth > 0 ? `${'\u00a0\u00a0'.repeat(depth - 1)}↳ ` : ''}
                    {sw?.name ?? `#${node.switchId}`}:
                  </span>
                  <select
                    value={String(cur)}
                    onChange={(e) =>
                      setSwitchPage(
                        node.switchId,
                        e.target.value === 'all' ? 'all' : Number(e.target.value)
                      )
                    }
                    className="h-6 cursor-pointer rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[11px] tabular-nums text-ink focus:border-focus focus:outline-none"
                  >
                    <option value="all">{t('bitMatrix.muxAllPages')}</option>
                    {node.pages.map((pg) => (
                      <option key={pg.value} value={String(pg.value)}>
                        {pg.label}
                        {pg.hasSignals ? '' : ` ${t('bitMatrix.muxEmptyPage')}`}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          <span className="text-focus">
            {t('bitMatrix.muxPageSummary', {
              pages: shownSwitches
                .map((n) => {
                  const v = muxSel.get(n.switchId) ?? 'all';
                  return `${signalMap.get(n.switchId)?.name ?? `#${n.switchId}`}=${
                    v === 'all' ? '*' : v
                  }`;
                })
                .join(' · '),
              count: visibleIds.size,
            })}
          </span>
        </div>
      )}

      {/* Drag-to-move hint / live drop info */}
      {canMutate && (
        <div
          className="min-h-[1.5rem] font-mono text-[11px] tabular-nums"
          style={{
            color: dragView
              ? dragView.toStart === null
                ? 'var(--status-critical)'
                : dragView.overlaps > 0
                  ? 'var(--status-warn)'
                  : 'var(--text-ink)'
              : 'var(--text-muted)',
          }}
        >
          {dragView && dragSignal ? (
            dragView.toStart === null ? (
              t('bitMatrix.dragOutOfRange', { max: totalBits - 1 })
            ) : (
              <>
                <strong>{dragSignal.name}</strong>{' '}
                {t('bitMatrix.dragInfo', {
                  from: dragView.fromStart,
                  to: dragView.toStart,
                  byte: String(Math.floor(dragView.targetBit / 8)).padStart(
                    2,
                    '0'
                  ),
                  bit: dragView.targetBit % 8,
                  overlaps: dragView.overlaps,
                })}
              </>
            )
          ) : (
            t('bitMatrix.dragHint')
          )}
        </div>
      )}

      {/* Authoritative DBC Studio 8..64 Byte Layout Matrix */}
      <section
        className={`rounded-[2px] border border-hairline bg-surface p-3 space-y-2.5 ${
          dragView ? 'cursor-grabbing' : ''
        }`}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse select-none">
            <thead>
              <tr className="border-b border-hairline font-mono text-[10px] text-muted">
                <th className="w-16 pb-1.5 text-left font-semibold">
                  {t('bitMatrix.colByte')}
                </th>
                <th className="w-20 pb-1.5 text-left font-semibold">
                  {t('bitMatrix.colBitRange')}
                </th>
                {[7, 6, 5, 4, 3, 2, 1, 0].map((bit) => (
                  <th
                    key={bit}
                    className="pb-1.5 text-center font-semibold tabular-nums"
                  >
                    {t('bitMatrix.colBitHeader', { bit })}
                    {bit === 7 ? ' (MSB)' : bit === 0 ? ' (LSB)' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-[10px] tabular-nums">
              {Array.from({ length: visibleBytes }, (_, byteIdx) => {
                const isFdBoundary = byteIdx === 8;
                return (
                  <tr
                    key={byteIdx}
                    className={
                      isFdBoundary
                        ? 'border-t-2 border-dashed border-strong'
                        : 'border-b border-hairline/40'
                    }
                  >
                    <td className="py-1 pr-2 font-semibold text-ink">
                      <span className="inline-flex items-center gap-1">
                        <span>B{String(byteIdx).padStart(2, '0')}</span>
                        {byteIdx >= 8 && byteIdx === 8 && (
                          <span className="rounded-[1px] border border-hairline bg-elevated px-1 text-[8px] text-focus">
                            FD
                          </span>
                        )}
                      </span>
                    </td>

                    <td className="py-1 pr-2 text-subtle">
                      {byteIdx * 8 + 7}..{byteIdx * 8}
                    </td>

                    {[7, 6, 5, 4, 3, 2, 1, 0].map((bitInByte) => {
                      const coordKey = `${byteIdx}:${bitInByte}`;
                      const linearBit = byteIdx * 8 + bitInByte;
                      const info = cellInfoByCoord.get(coordKey);
                      const cells = info?.cells ?? [];

                      if (cells.length === 0) {
                        return (
                          <td key={bitInByte} className="p-0.5">
                            <button
                              type="button"
                              data-bit={linearBit}
                              disabled={!canMutate}
                              style={dragCellStyle(linearBit)}
                              onMouseEnter={() =>
                                setHoveredBitCoord({
                                  byteIndex: byteIdx,
                                  bitInByte,
                                })
                              }
                              onMouseLeave={() => setHoveredBitCoord(null)}
                              onClick={() =>
                                handleEmptyCellClick(byteIdx, bitInByte)
                              }
                              title={
                                clickMode === 'createNew' || !selectedSignal
                                  ? t('bitMatrix.emptyCellCreateTooltip', {
                                      byte: byteIdx,
                                      bit: bitInByte,
                                      linear: linearBit,
                                    })
                                  : t('bitMatrix.emptyCellMoveTooltip', {
                                      byte: byteIdx,
                                      bit: bitInByte,
                                      linear: linearBit,
                                      name: selectedSignal.name,
                                    })
                              }
                              className="flex h-6 w-full cursor-pointer items-center justify-between rounded-[2px] border border-hairline/70 bg-canvas px-1.5 text-[9px] text-subtle transition-colors hover:border-focus hover:bg-elevated hover:text-ink disabled:cursor-default"
                            >
                              <span>·</span>
                              <span>{linearBit}</span>
                            </button>
                          </td>
                        );
                      }

                      const primaryCell =
                        cells.find((c) => c.signalId === activeFocusSigId) ??
                        cells[0];
                      const sig = primaryCell
                        ? signalMap.get(primaryCell.signalId)
                        : undefined;
                      const isColliding = info?.colliding ?? false;
                      const isOverlaid = info?.overlaid ?? false;
                      const baseColor = isColliding
                        ? 'var(--status-critical)'
                        : getSignalColor(primaryCell?.signalId ?? 0);
                      const isFocused =
                        primaryCell !== undefined &&
                        activeFocusSigId === primaryCell.signalId;
                      const isDimmed =
                        !isColliding &&
                        activeFocusSigId !== null &&
                        primaryCell !== undefined &&
                        activeFocusSigId !== primaryCell.signalId;

                      const cellNames = cells
                        .map((c) => signalMap.get(c.signalId)?.name ?? `#${c.signalId}`)
                        .join(' ↔ ');
                      const tooltipText = isColliding
                        ? t('bitMatrix.collisionCellTooltip', {
                            byte: byteIdx,
                            bit: bitInByte,
                            linear: linearBit,
                            signals: cellNames,
                          })
                        : isOverlaid
                          ? t('bitMatrix.muxOverlayTooltip', {
                              signals: cellNames,
                            })
                          : t('bitMatrix.occupiedCellTooltip', {
                            name:
                              sig?.name ?? t('bitMatrix.signalFallbackName'),
                            byte: byteIdx,
                            bit: bitInByte,
                            linear: linearBit,
                            sigBit: primaryCell?.signalBitIndex ?? 0,
                            role: primaryCell?.isMsb
                              ? ' [MSB]'
                              : primaryCell?.isLsb
                                ? ' [LSB]'
                                : '',
                          });

                      return (
                        <td key={bitInByte} className="p-0.5">
                          <button
                            type="button"
                            data-bit={linearBit}
                            onPointerDown={(e) => beginDrag(e, primaryCell)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={cancelDrag}
                            onLostPointerCapture={cancelDrag}
                            onMouseEnter={() => {
                              setHoveredBitCoord({
                                byteIndex: byteIdx,
                                bitInByte,
                              });
                              if (primaryCell) {
                                setHoveredSignalId(primaryCell.signalId);
                              }
                            }}
                            onMouseLeave={() => {
                              setHoveredBitCoord(null);
                              setHoveredSignalId(null);
                            }}
                            onClick={() => {
                              if (suppressClickRef.current) {
                                suppressClickRef.current = false;
                                return;
                              }
                              if (primaryCell) {
                                onSelectSignal(primaryCell.signalId);
                              }
                            }}
                            onDoubleClick={() => {
                              if (suppressClickRef.current) return;
                              if (primaryCell && onOpenSignalDialog) {
                                onOpenSignalDialog(primaryCell.signalId);
                              }
                            }}
                            title={tooltipText}
                            className={`flex h-6 w-full cursor-pointer items-center justify-between rounded-[2px] px-1.5 transition-opacity ${
                              isDimmed ? 'opacity-35' : 'opacity-100'
                            }`}
                            style={{
                              backgroundColor: isColliding
                                ? 'var(--status-critical-border)'
                                : isFocused
                                  ? `color-mix(in srgb, ${baseColor} 22%, transparent)`
                                  : `color-mix(in srgb, ${baseColor} 13%, transparent)`,
                              border: `1px solid ${
                                isColliding
                                  ? 'var(--status-critical)'
                                  : isFocused
                                    ? baseColor
                                    : `color-mix(in srgb, ${baseColor} 47%, transparent)`
                              }`,
                              color: 'var(--text-ink)',
                              touchAction: 'none',
                              ...(isOverlaid
                                ? {
                                    backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${baseColor} 32%, transparent) 0 3px, transparent 3px 6px)`,
                                    borderStyle: 'dashed',
                                  }
                                : {}),
                              ...dragCellStyle(linearBit),
                            }}
                          >
                            <span
                              className="text-[8px] font-bold"
                              style={{ color: baseColor }}
                            >
                              {isColliding
                                ? 'ERR'
                                : isOverlaid
                                  ? `×${cells.length}`
                                  : primaryCell?.isMuxSwitch
                                  ? 'MUX'
                                  : primaryCell?.isMsb
                                    ? 'MSB'
                                    : primaryCell?.isLsb
                                      ? 'LSB'
                                      : `s${primaryCell?.signalBitIndex ?? 0}`}
                            </span>
                            <span className="text-[9px] font-semibold">
                              {linearBit}
                            </span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalBytes > 24 && (
          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={() => setShowAllFdBytes((prev) => !prev)}
              className="h-6 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2.5 font-mono text-[10px] uppercase text-ink hover:border-strong"
            >
              {showAllFdBytes
                ? t('bitMatrix.collapseTo24Bytes')
                : t('bitMatrix.expandAllFdBytes', { total: totalBytes })}
            </button>
          </div>
        )}

        {/* Signal Legend Strip */}
        {messageSignals.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-hairline pt-2.5">
            {messageSignals
              .filter((sg) => visibleIds.has(sg.signalId))
              .map((sig) => {
              const c = getSignalColor(sig.signalId);
              const active = selectedSignal?.signalId === sig.signalId;
              return (
                <button
                  key={sig.signalId}
                  type="button"
                  onMouseEnter={() => setHoveredSignalId(sig.signalId)}
                  onMouseLeave={() => setHoveredSignalId(null)}
                  onClick={() => onSelectSignal(sig.signalId)}
                  onDoubleClick={() => {
                    if (onOpenSignalDialog) {
                      onOpenSignalDialog(sig.signalId);
                    }
                  }}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] tabular-nums transition-colors ${
                    active
                      ? 'border-strong bg-elevated font-semibold text-ink'
                      : 'border-hairline bg-canvas text-muted hover:text-ink'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-[1px]"
                    style={{ backgroundColor: c }}
                  />
                  <span>{sig.name}</span>
                  <span className="text-subtle">
                    [{sig.startBit}|{sig.bitLength}
                    {sig.byteOrder === 'bigEndian' ? '@0' : '@1'}]
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Physical <-> Raw Value Scaling Tester Panel */}
      <section className="rounded-[2px] border border-hairline bg-surface p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2">
          <div className="flex items-center gap-2">
            <Calculator className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink">
              {t('bitMatrix.scalingTitle')}
            </h3>
          </div>
          {selectedSignal && (
            <span className="font-mono text-[10px] tabular-nums text-muted">
              {t('bitMatrix.scalingFormula', {
                factor: selectedSignal.factor,
                offset: selectedSignal.offset,
              })}{' '}
              {selectedSignal.unit ? `[${selectedSignal.unit}]` : ''}
            </span>
          )}
        </div>

        {!selectedSignal || !scalingPreview ? (
          <p className="font-mono text-xs text-muted">
            {t('bitMatrix.scalingEmptyHint')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            {/* Raw Value Input */}
            <div className="md:col-span-3 space-y-1">
              <label className="block font-mono text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t('bitMatrix.rawInputLabel', {
                  min: scalingPreview.rawMin,
                  max: scalingPreview.rawMax,
                })}
              </label>
              <input
                type="number"
                step={
                  selectedSignal.valueType === 'float32' ||
                  selectedSignal.valueType === 'float64'
                    ? 'any'
                    : 1
                }
                value={rawTestValue}
                onChange={(e) => handleRawInputChange(e.target.value)}
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs font-semibold tabular-nums text-ink"
              />
              {scalingPreview.isRawOutOfBitDomain && (
                <p className="font-mono text-[10px] tabular-nums text-warn">
                  {t('bitMatrix.rawClampedWarn', {
                    bits: selectedSignal.bitLength,
                    value: scalingPreview.clampedRaw,
                  })}
                </p>
              )}
            </div>

            {/* Physical Value Input */}
            <div className="md:col-span-3 space-y-1">
              <label className="block font-mono text-[9px] font-semibold uppercase tracking-wider text-muted">
                {t('bitMatrix.physInputLabel', {
                  unit:
                    selectedSignal.unit ||
                    t('bitMatrix.engineeringUnitFallback'),
                })}
              </label>
              <input
                type="number"
                step="any"
                value={physDraft}
                onChange={(e) => handlePhysInputChange(e.target.value)}
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs font-semibold tabular-nums text-focus"
              />
              <p className="font-mono text-[10px] tabular-nums text-muted">
                {t('bitMatrix.computedPhysReadout', {
                  value: scalingPreview.physicalValue,
                  unit: selectedSignal.unit,
                })}
              </p>
            </div>

            {/* Hex / Binary / Range Readout */}
            <div className="md:col-span-6 grid grid-cols-2 gap-2 rounded-[2px] border border-hairline bg-canvas p-2 font-mono text-[11px] tabular-nums">
              <div>
                <div className="text-[9px] uppercase text-muted">
                  {t('bitMatrix.rawHexLabel')}
                </div>
                <div className="mt-0.5 font-semibold text-ink">
                  {scalingPreview.rawHex}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-muted">
                  {t('bitMatrix.rangeAndValLabel', {
                    min: selectedSignal.min,
                    max: selectedSignal.max,
                  })}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {scalingPreview.isPhysicalOutOfRange ? (
                    <span className="rounded-[2px] border border-critical px-1.5 py-0.5 text-[10px] font-semibold text-critical">
                      {t('bitMatrix.outOfRangeBadge')}
                    </span>
                  ) : (
                    <span className="rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-nominal">
                      {t('bitMatrix.inRangeBadge')}
                    </span>
                  )}
                  {scalingPreview.enumLabel && (
                    <span className="rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[10px] text-focus">
                      &quot;{scalingPreview.enumLabel}&quot;
                    </span>
                  )}
                </div>
              </div>
              <div className="col-span-2 border-t border-hairline pt-1">
                <span className="text-[9px] uppercase text-muted">
                  {t('bitMatrix.binaryLabel', {
                    bits: selectedSignal.bitLength,
                  })}
                </span>
                <span className="break-all text-[10px] text-ink">
                  {scalingPreview.rawBinaryPreview}
                </span>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
