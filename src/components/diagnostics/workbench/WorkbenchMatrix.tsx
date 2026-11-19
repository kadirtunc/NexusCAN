/**
 * Workbench matrix (workbench-v1 §2 / §6): rows = ECUs of the active vehicle (grouped, ordered), columns = distinct
 * bound blocks. Rows are windowed (fixed row heights) once there are more than `VIRTUALIZE_ABOVE` of them.
 * Every number / hex / timestamp is `font-mono tabular-nums`; no animations.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpCircle, Pencil, Play, Plus, Square, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { DiagVehicleV1, EcuGroupV1, EcuRecordV1, FlowBindingV1 } from '../../../types/diagWorkspace';
import type { RunRecordV1 } from '../../../types/runRecord';
import { diagWorkbenchStore, recordKey, type WbState } from '../../../store/diagWorkbenchStore';
import { DIAG_BTN_SM, DiagBadge, type DiagTone } from '../diagUi';
import { useFlowPrompt } from '../../flow/flowPrompt';
import { fmtTimestamp } from './RunRecordDetail';
import { cellView, resolveBindingParams } from './workbenchModel';

export const VIRTUALIZE_ABOVE = 200;
const ECU_ROW_H = 62;
const GROUP_ROW_H = 24;
const FIRST_COL_W = 200;
const COL_W = 248;
const HEADER_H = 52;
const OVERSCAN_PX = 400;

const CHIP_TONE: Record<'none' | 'ok' | 'warn' | 'critical', DiagTone> = { none: 'neutral', ok: 'nominal', warn: 'warn', critical: 'critical' };
const ICON_BTN =
  'inline-flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] border border-transparent text-muted hover:border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';

export interface MatrixColumn {
  flowId: string;
  name: string;
  /** Lowest revision pinned by any binding of the column. */
  pinned: number;
  /** Library latest revision (`null` = unknown). */
  latest: number | null;
}

type MatrixRow =
  | { kind: 'group'; key: string; name: string; color: string | null }
  | { kind: 'ecu'; key: string; ecu: EcuRecordV1 };

const GROUP_HEX: Record<EcuGroupV1['color'], string> = {
  amber: '#F59E0B', red: '#EF4444', orange: '#F97316', cyan: '#06B6D4', violet: '#8B5CF6', emerald: '#10B981', slate: '#64748B',
};

/** Rows in display order: groups by `order` (header + members by `order`), then the ungrouped ECUs. */
export function buildMatrixRows(vehicle: DiagVehicleV1, ungroupedName: string): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const byOrder = (a: { order: number }, b: { order: number }): number => a.order - b.order;
  for (const g of [...vehicle.groups].sort(byOrder)) {
    const members = vehicle.ecus.filter((e) => e.groupId === g.id).sort(byOrder);
    if (members.length === 0) continue;
    rows.push({ kind: 'group', key: `g:${g.id}`, name: g.name, color: GROUP_HEX[g.color] });
    for (const e of members) rows.push({ kind: 'ecu', key: e.id, ecu: e });
  }
  const loose = vehicle.ecus.filter((e) => e.groupId === null || !vehicle.groups.some((g) => g.id === e.groupId)).sort(byOrder);
  if (loose.length > 0) {
    if (rows.length > 0) rows.push({ kind: 'group', key: 'g:none', name: ungroupedName, color: null });
    for (const e of loose) rows.push({ kind: 'ecu', key: e.id, ecu: e });
  }
  return rows;
}

/** Distinct bound blocks of the vehicle in binding order. */
export function buildMatrixColumns(vehicle: DiagVehicleV1, latestByFlow: ReadonlyMap<string, number>): MatrixColumn[] {
  const cols = new Map<string, MatrixColumn & { order: number }>();
  for (const b of [...vehicle.bindings].sort((a, c) => a.order - c.order)) {
    const cur = cols.get(b.flowRef.flowId);
    if (cur) {
      cur.pinned = Math.min(cur.pinned, b.flowRef.revision);
      continue;
    }
    const info = diagWorkbenchStore.getIface(b.flowRef);
    cols.set(b.flowRef.flowId, {
      flowId: b.flowRef.flowId,
      name: b.label ?? info?.name ?? b.flowRef.flowId,
      pinned: b.flowRef.revision,
      latest: latestByFlow.get(b.flowRef.flowId) ?? null,
      order: b.order,
    });
  }
  return [...cols.values()];
}

export type CellSession = 'connected' | 'no_tab' | 'not_connected';

export interface MatrixHandlers {
  onRun: (binding: FlowBindingV1, ecu: EcuRecordV1) => void;
  onStop: () => void;
  onBind: (ecu: EcuRecordV1, flowId: string) => void;
  onEdit: (binding: FlowBindingV1) => void;
  onRemove: (binding: FlowBindingV1) => void;
  onDetail: (rec: RunRecordV1) => void;
  onOpenSession: (ecu: EcuRecordV1) => void;
  onUpdate: (flowId: string, latest: number) => void;
}

function shortOutputs(rec: RunRecordV1): string {
  const keys = Object.keys(rec.outputs).slice(0, 2);
  return keys.map((k) => `${k}=${String(rec.outputs[k])}`).join(' ');
}

const Cell: React.FC<{
  ecu: EcuRecordV1;
  binding: FlowBindingV1 | undefined;
  flowId: string;
  wb: WbState;
  session: CellSession;
  h: MatrixHandlers;
}> = ({ ecu, binding, flowId, wb, session, h }) => {
  const { t } = useI18n();
  const prompt = useFlowPrompt();
  if (!binding) {
    return (
      <div className="flex h-full items-center px-2">
        <button type="button" className={DIAG_BTN_SM} onClick={() => h.onBind(ecu, flowId)}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('workbench.cell.bind')}
        </button>
      </div>
    );
  }
  const info = diagWorkbenchStore.getIface(binding.flowRef);
  const rec = wb.records[recordKey(ecu.id, binding.flowRef.flowId)] ?? null;
  const running = wb.active?.bindingId === binding.id;
  const otherRunning = wb.active !== null && !running;
  const resolved = info ? resolveBindingParams(binding, info.iface, ecu) : null;
  const view = cellView(rec);
  const refusal = wb.refusals[binding.id];

  let status: { tone: DiagTone; text: string } | null = null;
  if (running && prompt !== null) status = { tone: 'warn', text: t('workbench.cell.waitOperator') };
  else if (running) status = { tone: 'focus', text: t('workbench.cell.running') };
  else if (!info) status = { tone: 'neutral', text: t('workbench.cell.revLoading') };
  else if (resolved?.status === 'incomplete') status = { tone: 'warn', text: t('workbench.cell.incomplete', { keys: resolved.missing.join(', ') }) };
  else if (resolved?.status === 'invalid') {
    status = { tone: 'critical', text: t('workbench.cell.invalid', { msg: resolved.issues.find((i) => i.code !== 'unknown_key')?.message ?? '' }) };
  }
  const canRun = resolved?.status === 'ready' && !running && !otherRunning && session === 'connected';

  return (
    <div className="flex h-full flex-col justify-center gap-0.5 px-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {status ? (
          <DiagBadge tone={status.tone}>{running && prompt === null ? t('workbench.cell.running') : status.tone === 'neutral' ? '…' : '!'}</DiagBadge>
        ) : (
          <button
            type="button"
            disabled={rec === null}
            onClick={() => rec && h.onDetail(rec)}
            className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 disabled:cursor-default"
            title={rec ? t('workbench.cell.lastRun') : t('workbench.cell.notRun')}
          >
            <DiagBadge tone={CHIP_TONE[view.chip]}>{rec ? rec.outcome : '—'}</DiagBadge>
          </button>
        )}
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[11.5px] tabular-nums ${status ? (status.tone === 'critical' ? 'text-critical' : 'text-muted') : view.chip === 'critical' ? 'text-critical' : 'text-ink'}`}
          title={status ? status.text : view.text}
        >
          {status ? status.text : view.text !== '' ? view.text : t('workbench.cell.notRun')}
        </span>
        {running ? (
          <button type="button" className={`${DIAG_BTN_SM} border-critical text-critical`} onClick={h.onStop} aria-label={t('workbench.cell.stop')}>
            <Square className="h-3 w-3" aria-hidden="true" />
            {t('workbench.cell.stop')}
          </button>
        ) : session === 'connected' ? (
          <button type="button" className={DIAG_BTN_SM} disabled={!canRun} onClick={() => h.onRun(binding, ecu)} aria-label={t('workbench.cell.run')}>
            <Play className="h-3 w-3" aria-hidden="true" />
            {t('workbench.cell.run')}
          </button>
        ) : (
          <button type="button" className={DIAG_BTN_SM} onClick={() => h.onOpenSession(ecu)} title={session === 'no_tab' ? t('workbench.cell.noSession') : t('workbench.cell.sessionNotConnected')}>
            {t('workbench.cell.openSession')}
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-subtle">
        {refusal !== undefined && !running ? (
          <span className="min-w-0 flex-1 truncate text-warn" title={refusal}>{refusal}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate" title={rec ? shortOutputs(rec) : ''}>{rec ? shortOutputs(rec) : ''}</span>
            {rec && <span className="shrink-0">{fmtTimestamp(rec.startedAt)}</span>}
          </>
        )}
        <button type="button" className={ICON_BTN} onClick={() => h.onEdit(binding)} title={t('workbench.cell.edit')} aria-label={t('workbench.cell.edit')} disabled={running}>
          <Pencil className="h-3 w-3" aria-hidden="true" />
        </button>
        <button type="button" className={ICON_BTN} onClick={() => h.onRemove(binding)} title={t('workbench.cell.remove')} aria-label={t('workbench.cell.remove')} disabled={running}>
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

/** Index of the first row whose bottom edge is below `y` (binary search over cumulative offsets). */
function firstVisible(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const WorkbenchMatrix: React.FC<{
  vehicle: DiagVehicleV1;
  columns: MatrixColumn[];
  wb: WbState;
  sessionOf: (ecuId: string) => CellSession;
  handlers: MatrixHandlers;
}> = ({ vehicle, columns, wb, sessionOf, handlers }) => {
  const { t } = useI18n();
  const rows = useMemo(() => buildMatrixRows(vehicle, t('diagWs.ungrouped')), [vehicle, t]);
  const bindingOf = useMemo(() => {
    const m = new Map<string, FlowBindingV1>();
    for (const b of [...vehicle.bindings].sort((a, c) => a.order - c.order)) {
      const k = `${b.ecuId}|${b.flowRef.flowId}`;
      if (!m.has(k)) m.set(k, b);
    }
    return m;
  }, [vehicle.bindings]);
  const offsets = useMemo(() => {
    const o: number[] = [0];
    for (const r of rows) o.push(o[o.length - 1] + (r.kind === 'group' ? GROUP_ROW_H : ECU_ROW_H));
    return o;
  }, [rows]);
  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !virtual) return;
    const measure = (): void => setScroll({ top: el.scrollTop, height: el.clientHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [virtual]);
  const totalH = offsets[offsets.length - 1];
  const totalW = FIRST_COL_W + columns.length * COL_W;

  let from = 0;
  let to = rows.length;
  if (virtual) {
    from = firstVisible(offsets, Math.max(0, scroll.top - OVERSCAN_PX));
    to = from;
    while (to < rows.length && offsets[to] < scroll.top + scroll.height + OVERSCAN_PX) to++;
  }

  const gridCols = `${FIRST_COL_W}px repeat(${columns.length}, ${COL_W}px)`;

  const renderRow = (r: MatrixRow, i: number): React.ReactElement => {
    const style: React.CSSProperties = virtual
      ? { position: 'absolute', top: offsets[i], left: 0, height: offsets[i + 1] - offsets[i], width: totalW, display: 'grid', gridTemplateColumns: gridCols }
      : { height: offsets[i + 1] - offsets[i], width: totalW, display: 'grid', gridTemplateColumns: gridCols };
    if (r.kind === 'group') {
      return (
        <div key={r.key} style={{ ...style, display: 'flex' }} className="items-center gap-2 border-b border-hairline bg-elevated px-3">
          <span className="sticky left-3 flex items-center gap-2">
            {r.color && <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: r.color }} aria-hidden="true" />}
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">{r.name}</span>
          </span>
        </div>
      );
    }
    const session = sessionOf(r.ecu.id);
    return (
      <div key={r.key} style={style} className="border-b border-hairline">
        <div className="sticky left-0 z-[1] flex flex-col justify-center gap-0.5 border-r border-hairline bg-surface px-3">
          <span className="truncate text-[12.5px] text-ink" title={r.ecu.name}>{r.ecu.name}</span>
          <span className="font-mono text-[11px] tabular-nums text-subtle">
            REQ {r.ecu.addressing.requestId.toString(16).toUpperCase()} / RSP {r.ecu.addressing.responseId.toString(16).toUpperCase()}
            {session === 'connected' && <span className="ml-1.5 text-nominal">●</span>}
          </span>
        </div>
        {columns.map((c) => (
          <div key={c.flowId} className="min-w-0 border-r border-hairline">
            <Cell ecu={r.ecu} binding={bindingOf.get(`${r.ecu.id}|${c.flowId}`)} flowId={c.flowId} wb={wb} session={session} h={handlers} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto bg-canvas"
      onScroll={(e) => {
        if (!virtual) return;
        const el = e.currentTarget;
        setScroll({ top: el.scrollTop, height: el.clientHeight });
      }}
      data-testid="wb-matrix"
      data-virtual={virtual ? 'true' : 'false'}
    >
      <div style={{ width: totalW }}>
        <div className="sticky top-0 z-[2] border-b border-strong bg-elevated" style={{ display: 'grid', gridTemplateColumns: gridCols, height: HEADER_H, width: totalW }}>
          <div className="sticky left-0 z-[3] flex items-center border-r border-hairline bg-elevated px-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">
            {t('workbench.col.ecu')}
          </div>
          {columns.map((c) => {
            const newer = c.latest !== null && c.latest > c.pinned;
            return (
              <div key={c.flowId} className="flex min-w-0 flex-col justify-center gap-0.5 border-r border-hairline px-2">
                <span className="truncate text-[12.5px] font-semibold text-ink" title={c.name}>{c.name}</span>
                <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-subtle">
                  <span>{t('workbench.col.pinned', { rev: c.pinned })}</span>
                  {newer && c.latest !== null && (
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-warn px-1 text-warn hover:bg-[var(--status-warn-bg)]"
                      title={t('workbench.col.update')}
                      onClick={() => handlers.onUpdate(c.flowId, c.latest as number)}
                    >
                      <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                      {t('workbench.col.newer', { rev: c.latest })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {virtual ? (
          <div style={{ position: 'relative', height: totalH, width: totalW }}>
            {rows.slice(from, to).map((r, k) => renderRow(r, from + k))}
          </div>
        ) : (
          rows.map((r, i) => renderRow(r, i))
        )}
      </div>
    </div>
  );
};
