/**
 * R2c Value Scan panel (Cheat-Engine style, re-toolkit-v1 §8.4): scan form, step history, virtualized server-paged
 * results with 2 Hz live refresh of the VISIBLE rows only (and only while the document is visible and RE is running).
 * Live scans always run in the backend; the demo source scans synthetic rows (DEMO badge). Passive only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { reStore, useReState } from '../../store/reStore';
import { reScanStore, useReScanState } from '../../store/reScanStoreDefault';
import { canUndo, hotkeyNextOp } from '../../store/reScanStore';
import type { ReByteOrder } from '../../types/re';
import type { ReScanAlignment, ReScanCandidateDto, ReScanKind, ReScanOpKind, ReScanResultRowDto, ReScanSort } from '../../types/reScan';
import { DIAG_BTN, DIAG_CHECKBOX, DIAG_INPUT, DIAG_SELECT, DIAG_TITLE, DiagBadge, diagToneButtonClass } from '../diagnostics/diagUi';
import { openSaveDialogForScanRow } from './reDraftOpen';
import { formatArbId } from './reModel';
import {
  RE_SCAN_NEXT_OPS,
  RE_SCAN_SELECTABLE_LENGTHS,
  buildFirstSpec,
  buildNextOp,
  formatScanCount,
  formatScanHistory,
  opNeedsRange,
  opNeedsStableMs,
  opNeedsValue,
  opSupportsPhysical,
  parseUserPreset,
  scanCandidateKey,
  scanHotkeyAction,
  validateFirstSpec,
  validateNextOp,
  virtualWindow,
} from './reScanModel';
import { formatSignalValue, parseReError } from './reSignalModel';

export interface ReValueScanPanelProps {
  onInspect: (row: ReScanResultRowDto) => void;
  onHighlight: (row: ReScanResultRowDto) => void;
}

const ROW_H = 22;
const REFRESH_MS = 500;
const PAGE_SIZES = [50, 100, 250, 500] as const;
const COLS = '36px 100px 76px 48px 44px 128px 104px 112px 104px 44px 76px 1fr';
const mono = 'font-mono tabular-nums';
const inputCls = `${DIAG_INPUT} !h-[24px] !px-1.5 !text-[12px] ${mono}`;
const selCls = `${DIAG_SELECT} !h-[24px] !w-auto !px-1.5 !pr-2 !text-[12px]`;
const smBtn = `${DIAG_BTN} !h-[20px] !px-1.5 !text-[10px]`;

const ERR_HINTS: Readonly<Record<string, TranslationKey>> = {
  scan_too_large: 're.err.scan_too_large',
  no_scan: 're.err.no_scan',
  not_started: 're.err.not_started',
};

interface DisplayItem {
  /** index into the page rows */
  pageIdx: number;
  row: ReScanResultRowDto;
  /** set for an expanded contained candidate */
  contained: ReScanCandidateDto | null;
}

function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
  if (t.tagName !== 'INPUT') return false;
  const type = (t as HTMLInputElement).type;
  return type === 'text' || type === 'number' || type === 'search';
}

function fmtPreset(row: ReScanResultRowDto): string {
  const p = row.preset;
  if (p === null) return '—';
  return `×${formatSignalValue(p.factor)} ${p.offset >= 0 ? '+' : '−'}${formatSignalValue(Math.abs(p.offset))}`;
}

const fmtVal = (v: number | null): string => (v === null ? '—' : formatSignalValue(v));
const typeLabel = (c: ReScanCandidateDto): string => (c.valueType === 'unsigned' ? 'u' : c.valueType === 'signed' ? 's' : c.valueType);
const orderLabel = (o: ReByteOrder): string => (o === 'intel' ? 'Intel' : 'Moto');

function toggleIn<T>(arr: readonly T[], v: T, sort = false): T[] {
  const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  return sort ? (next as unknown as number[]).sort((a, b) => a - b) as unknown as T[] : next;
}

export function ReValueScanPanel({ onInspect, onHighlight }: ReValueScanPanelProps): React.ReactElement {
  const { t } = useI18n();
  const sc = useReScanState();
  const re = useReState();
  const { form, ui, results } = sc;
  const [showOptions, setShowOptions] = useState(false);
  const [presetText, setPresetText] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(240);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const enabled = re.status?.enabled === true;
  const active = ui.status?.active === true;
  const knownBuses = useMemo(() => {
    const set = new Set<number>();
    for (const r of reStore.getRows().values()) set.add(r.bus);
    return Array.from(set).sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [re.rowsVersion]);

  const firstIssues = useMemo(() => validateFirstSpec(buildFirstSpec(form, knownBuses)), [form, knownBuses]);
  const nextIssues = useMemo(() => validateNextOp(buildNextOp(form)), [form]);

  useEffect(() => {
    void reScanStore.refreshStatus();
  }, []);

  // ---- display items (page rows + expanded contained candidates), virtualized ---------------------------------
  const items = useMemo<DisplayItem[]>(() => {
    const out: DisplayItem[] = [];
    (results?.rows ?? []).forEach((row, pageIdx) => {
      out.push({ pageIdx, row, contained: null });
      if (row.containedCount > 0 && expanded.has(scanCandidateKey(row.candidate))) {
        for (const c of row.contained) out.push({ pageIdx, row, contained: c });
      }
    });
    return out;
  }, [results, expanded]);
  const win = virtualWindow(scrollTop, viewH, ROW_H, items.length, 4);

  // visible page-row range for the 2 Hz refresh (parents of the rendered window, without overscan)
  const visRef = useRef({ first: 0, count: 0 });
  {
    const strict = virtualWindow(scrollTop, viewH, ROW_H, items.length, 0);
    const slice = items.slice(strict.start, strict.end);
    visRef.current =
      slice.length === 0
        ? { first: 0, count: 0 }
        : { first: slice[0].pageIdx, count: slice[slice.length - 1].pageIdx - slice[0].pageIdx + 1 };
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return undefined;
    const measure = (): void => setViewH(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [results === null]);

  // 2 Hz refresh: only while mounted (panel visible), document visible, RE running and a scan active.
  useEffect(() => {
    if (!enabled || !active) return undefined;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const v = visRef.current;
      if (v.count > 0) void reScanStore.refreshVisible(v.first, v.count);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, active]);

  // ---- actions ---------------------------------------------------------------------------------------------------
  const canFirst = enabled && !ui.busy && firstIssues.length === 0;
  const canNext = enabled && active && !ui.busy && nextIssues.length === 0;
  const runFirst = (): void => {
    if (canFirst) void reScanStore.first(knownBuses);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target;
    const action = scanHotkeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      targetIsEditable: isTextInput(target),
    });
    if (action === null) return;
    if (action === 'undo') {
      if (canUndo(ui)) {
        e.preventDefault();
        void reScanStore.undo();
      }
      return;
    }
    // Enter on buttons / selects / checkboxes keeps its native meaning
    if (target instanceof HTMLElement && (target.tagName === 'BUTTON' || target.tagName === 'SELECT' || (target.tagName === 'INPUT' && !isTextInput(target)))) return;
    e.preventDefault();
    if (hotkeyNextOp(ui) !== null) void reScanStore.repeatLast();
    else if (!active && isTextInput(target)) runFirst();
  };

  const setOptions = (patch: Partial<typeof form.options>): void => reScanStore.setForm({ options: { ...form.options, ...patch } });
  const check = (checked: boolean, label: string, onChange: (v: boolean) => void, title?: string): React.ReactElement => (
    <label className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer select-none" title={title}>
      <input type="checkbox" className={DIAG_CHECKBOX} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
  const textField = (value: string, onChange: (v: string) => void, width: number, ph?: string, title?: string): React.ReactElement => (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph} title={title} className={inputCls} style={{ width }} />
  );

  const op = form.op;
  const kindNeedsValue = form.kind === 'exact' || form.kind === 'physical';
  const status = ui.status;
  const parsedErr = ui.error === null ? null : parseReError(ui.error);
  const errHint = parsedErr?.code != null && ERR_HINTS[parsedErr.code] !== undefined ? t(ERR_HINTS[parsedErr.code]) : null;
  const total = results?.total ?? 0;
  const pageFrom = total === 0 || results === null ? 0 : results.offset + 1;
  const pageTo = results === null ? 0 : Math.min(total, results.offset + results.rows.length);

  return (
    <div tabIndex={-1} onKeyDown={onKeyDown} className="h-full min-h-0 flex flex-col text-[12px] bg-canvas outline-none">
      {/* first scan */}
      <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap border-b border-hairline">
        <span className={DIAG_TITLE}>{t('re.scan.title')}</span>
        {re.demo && (
          <DiagBadge tone="warn" title={t('re.scan.demoNote')}>
            {t('re.demo.badge')}
          </DiagBadge>
        )}
        <select aria-label={t('re.scan.type')} value={form.kind} onChange={(e) => reScanStore.setForm({ kind: e.target.value as ReScanKind })} className={selCls}>
          {(['exact', 'physical', 'range', 'unknown'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`re.scan.type.${k}` as TranslationKey)}
            </option>
          ))}
        </select>
        {kindNeedsValue && textField(form.valueText, (v) => reScanStore.setForm({ valueText: v }), 84, t('re.scan.value'))}
        {kindNeedsValue && textField(form.tolText, (v) => reScanStore.setForm({ tolText: v }), 70, t('re.scan.toleranceAuto'), t('re.scan.tolerance'))}
        {form.kind === 'range' && (
          <>
            {textField(form.rangeAText, (v) => reScanStore.setForm({ rangeAText: v }), 70, t('re.scan.rangeFrom'))}
            {textField(form.rangeBText, (v) => reScanStore.setForm({ rangeBText: v }), 70, t('re.scan.rangeTo'))}
            {check(form.rangePhysical, t('re.scan.rangePhysical'), (v) => reScanStore.setForm({ rangePhysical: v }))}
          </>
        )}
        <button type="button" disabled={!canFirst} onClick={runFirst} className={diagToneButtonClass('nominal', true)} title={t('re.scan.firstTip')}>
          {t('re.scan.first')}
        </button>
        <span className="mx-1 h-4 w-px bg-hairline" />
        <select aria-label={t('re.scan.op')} value={op} onChange={(e) => reScanStore.setForm({ op: e.target.value as ReScanOpKind })} className={selCls}>
          {RE_SCAN_NEXT_OPS.map((o) => (
            <option key={o} value={o}>
              {t(`re.scan.op.${o}` as TranslationKey)}
            </option>
          ))}
        </select>
        {opNeedsValue(op) && textField(form.opValueText, (v) => reScanStore.setForm({ opValueText: v }), 84, t('re.scan.value'))}
        {opNeedsValue(op) && textField(form.opTolText, (v) => reScanStore.setForm({ opTolText: v }), 70, t('re.scan.toleranceAuto'), t('re.scan.tolerance'))}
        {opNeedsRange(op) && textField(form.opRangeAText, (v) => reScanStore.setForm({ opRangeAText: v }), 70, t('re.scan.rangeFrom'))}
        {opNeedsRange(op) && textField(form.opRangeBText, (v) => reScanStore.setForm({ opRangeBText: v }), 70, t('re.scan.rangeTo'))}
        {opNeedsStableMs(op) && textField(form.opStableText, (v) => reScanStore.setForm({ opStableText: v }), 70, t('re.scan.stableMs'), t('re.scan.stableMs'))}
        {opSupportsPhysical(op) && check(form.opPhysical, t('re.scan.physical'), (v) => reScanStore.setForm({ opPhysical: v }))}
        <button type="button" disabled={!canNext} onClick={() => void reScanStore.next()} className={diagToneButtonClass('focus', true)} title={t('re.scan.nextTip')}>
          {t('re.scan.next')}
        </button>
        <button type="button" disabled={!canUndo(ui)} onClick={() => void reScanStore.undo()} className={DIAG_BTN} title={t('re.scan.undoTip')}>
          {t('re.scan.undo')}
        </button>
        <button type="button" disabled={ui.busy} onClick={() => void reScanStore.reset()} className={DIAG_BTN}>
          {t('re.scan.reset')}
        </button>
        <button type="button" onClick={() => setShowOptions((v) => !v)} className={`${diagToneButtonClass('neutral', showOptions)} ml-auto`}>
          {t('re.scan.options')}
        </button>
      </div>

      {showOptions && (
        <div className="px-3 py-1.5 border-b border-hairline flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="text-[var(--text-muted)]">{t('re.scan.lengths')}</span>
            {RE_SCAN_SELECTABLE_LENGTHS.map((l) => (
              <label key={l} className={`inline-flex items-center gap-1 cursor-pointer ${mono}`}>
                <input type="checkbox" className={DIAG_CHECKBOX} checked={form.options.lengths.includes(l)} onChange={() => setOptions({ lengths: toggleIn(form.options.lengths, l, true) })} />
                {l}
              </label>
            ))}
            {check(form.options.include64, t('re.scan.include64'), (v) => setOptions({ include64: v }))}
            {check(form.options.float32, t('re.scan.float32'), (v) => setOptions({ float32: v }))}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-[var(--text-muted)]">{t('re.scan.orders')}</span>
            {check(form.options.byteOrders.includes('intel'), t('re.scan.intel'), () => setOptions({ byteOrders: toggleIn(form.options.byteOrders, 'intel') }))}
            {check(form.options.byteOrders.includes('motorola'), t('re.scan.motorola'), () => setOptions({ byteOrders: toggleIn(form.options.byteOrders, 'motorola') }))}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-[var(--text-muted)]">{t('re.scan.signed')}</span>
            {check(form.options.signed.includes(false), t('re.scan.unsignedOpt'), () => setOptions({ signed: toggleIn(form.options.signed, false) }))}
            {check(form.options.signed.includes(true), t('re.scan.signedOpt'), () => setOptions({ signed: toggleIn(form.options.signed, true) }))}
          </span>
          <label className="inline-flex items-center gap-1.5">
            {t('re.scan.alignment')}
            <select value={form.options.alignment} onChange={(e) => setOptions({ alignment: e.target.value as ReScanAlignment })} className={selCls}>
              {(['any', 'nibble', 'byte'] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`re.scan.align.${a}` as TranslationKey)}
                </option>
              ))}
            </select>
          </label>
          {check(form.options.excludeCounterChecksum, t('re.scan.excludeCounter'), (v) => setOptions({ excludeCounterChecksum: v }))}
          {check(form.options.excludeConstant, t('re.scan.excludeConstant'), (v) => setOptions({ excludeConstant: v }))}
          <label className="inline-flex items-center gap-1.5">
            {t('re.scan.busFilter')}
            {textField(form.busText, (v) => reScanStore.setForm({ busText: v }), 60)}
          </label>
          <label className="inline-flex items-center gap-1.5" title={t('re.scan.idFilterTip')}>
            {t('re.scan.idFilter')}
            {textField(form.idText, (v) => reScanStore.setForm({ idText: v }), 150, '1A0, 0:18FF1234x')}
          </label>
          <label className="inline-flex items-center gap-1.5">
            {t('re.scan.readMode')}
            <select
              value={form.options.readMode.kind}
              onChange={(e) => setOptions({ readMode: e.target.value === 'median' ? { kind: 'median', samples: 5 } : { kind: 'latest' } })}
              className={selCls}
            >
              <option value="latest">{t('re.scan.read.latest')}</option>
              <option value="median">{t('re.scan.read.median')}</option>
            </select>
            {form.options.readMode.kind === 'median' && textField(form.medianSamplesText, (v) => reScanStore.setForm({ medianSamplesText: v }), 44)}
          </label>
          <span className="inline-flex items-center gap-1.5 flex-wrap">
            <span className="text-[var(--text-muted)]">{t('re.scan.userPresets')}</span>
            {form.userPresets.map((p, i) => (
              <button
                key={`${p.factor}:${p.offset}:${i}`}
                type="button"
                title={t('re.scan.presetRemove')}
                className={`${smBtn} ${mono}`}
                onClick={() => reScanStore.setForm({ userPresets: form.userPresets.filter((_, k) => k !== i) })}
              >
                ×{formatSignalValue(p.factor)}:{formatSignalValue(p.offset)} ✕
              </button>
            ))}
            {textField(presetText, setPresetText, 90, '0.02:0')}
            <button
              type="button"
              disabled={parseUserPreset(presetText) === null}
              className={smBtn}
              onClick={() => {
                const p = parseUserPreset(presetText);
                if (p === null) return;
                reScanStore.setForm({ userPresets: [...form.userPresets, p] });
                setPresetText('');
              }}
            >
              {t('re.scan.presetAdd')}
            </button>
          </span>
        </div>
      )}

      {/* count + history */}
      <div className="px-3 py-1 flex items-baseline gap-3 flex-wrap border-b border-hairline" aria-live="polite">
        <span className={`${mono} text-[22px] leading-none font-semibold text-ink`}>{status !== null && status.active ? formatScanCount(status.candidates) : '—'}</span>
        <span className="text-[var(--text-muted)]">{t('re.scan.candidates')}</span>
        {status !== null && status.active && (
          <>
            <span className={`${mono} text-[var(--text-secondary)]`}>{formatScanHistory(status.history)}</span>
            <span className={`${mono} text-[var(--text-muted)]`}>{t('re.scan.step', { step: status.step })}</span>
            <span className={`${mono} text-[var(--text-muted)]`}>{t('re.scan.elapsed', { ms: status.elapsedMs.toFixed(1) })}</span>
            {status.truncated && (
              <DiagBadge tone="warn" title={t('re.scan.truncatedTip')}>
                {t('re.scan.truncated')}
              </DiagBadge>
            )}
            {status.historyCovered === false && <DiagBadge tone="warn">{t('re.scan.historyShort')}</DiagBadge>}
          </>
        )}
        {!enabled && <span className="text-warn">{t('re.scan.notRunning')}</span>}
      </div>

      {(active ? nextIssues : firstIssues).length > 0 && (
        <div className={`px-3 py-0.5 border-b border-hairline text-[11px] text-[var(--text-muted)] ${mono}`}>
          {t('re.scan.issues')} {(active ? nextIssues : firstIssues).join(', ')}
        </div>
      )}
      {ui.error !== null && (
        <div className="px-3 py-1 border-b border-hairline text-critical" role="alert">
          <span className={mono}>{ui.error}</span>
          {errHint !== null && <span className="ml-2 text-warn">{errHint}</span>}
        </div>
      )}
      {sc.resultsError !== null && ui.error === null && <div className={`px-3 py-0.5 border-b border-hairline text-warn text-[11px] ${mono}`}>{sc.resultsError}</div>}

      {/* results */}
      {!active || results === null ? (
        <div className="p-3 text-[var(--text-muted)]">{t('re.scan.empty')}</div>
      ) : (
        <>
          <div className="px-3 py-1 flex items-center gap-2 border-b border-hairline">
            <label className="inline-flex items-center gap-1.5">
              {t('re.scan.sort')}
              <select value={sc.sort} onChange={(e) => void reScanStore.setSort(e.target.value as ReScanSort)} className={selCls}>
                {(['id', 'changes', 'width'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`re.scan.sort.${k}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5">
              {t('re.scan.pageSize')}
              <select value={sc.limit} onChange={(e) => void reScanStore.setLimit(Number(e.target.value))} className={selCls}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={DIAG_BTN} disabled={results.offset === 0} onClick={() => void reScanStore.setOffset(Math.max(0, results.offset - sc.limit))}>
              {t('re.scan.prevPage')}
            </button>
            <button type="button" className={DIAG_BTN} disabled={pageTo >= total} onClick={() => void reScanStore.setOffset(results.offset + sc.limit)}>
              {t('re.scan.nextPage')}
            </button>
            <span className={`${mono} text-[var(--text-muted)]`}>{t('re.scan.pageRange', { from: formatScanCount(pageFrom), to: formatScanCount(pageTo), total: formatScanCount(total) })}</span>
          </div>
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div className={`${mono} text-[11px]`} style={{ minWidth: 980 }}>
              <div className="sticky top-0 z-10 grid items-center bg-elevated border-b border-hairline text-[var(--text-muted)] px-3" style={{ gridTemplateColumns: COLS, height: ROW_H }}>
                <span>{t('re.scan.col.bus')}</span>
                <span>{t('re.scan.col.id')}</span>
                <span>{t('re.scan.col.bits')}</span>
                <span>{t('re.scan.col.order')}</span>
                <span>{t('re.scan.col.type')}</span>
                <span>{t('re.scan.col.preset')}</span>
                <span className="text-right pr-2">{t('re.scan.col.raw')}</span>
                <span className="text-right pr-2">{t('re.scan.col.phys')}</span>
                <span className="text-right pr-2">{t('re.scan.col.prev')}</span>
                <span className="text-right pr-2">{t('re.scan.col.changes')}</span>
                <span>{t('re.scan.col.hint')}</span>
                <span />
              </div>
              {items.length === 0 && <div className="p-3 text-[var(--text-muted)]">{t('re.scan.noRows')}</div>}
              <div style={{ paddingTop: win.start * ROW_H, paddingBottom: (items.length - win.end) * ROW_H }}>
                {items.slice(win.start, win.end).map((it) => {
                  const c = it.contained ?? it.row.candidate;
                  const key = scanCandidateKey(c);
                  const isMain = it.contained === null;
                  const rowKey = scanCandidateKey(it.row.candidate);
                  return (
                    <div
                      key={`${it.pageIdx}:${key}:${isMain ? 'm' : 'c'}`}
                      className={`grid items-center px-3 border-b border-hairline whitespace-nowrap ${isMain ? '' : 'text-[var(--text-muted)] bg-[var(--bg-row-alt)]'}`}
                      style={{ gridTemplateColumns: COLS, height: ROW_H }}
                    >
                      <span>{c.bus}</span>
                      <span>0x{formatArbId(c.arbId, c.isExtended)}</span>
                      <span>
                        {isMain ? '' : '↳ '}
                        {c.startBit}|{c.bitLength}
                      </span>
                      <span>{orderLabel(c.byteOrder)}</span>
                      <span>{typeLabel(c)}</span>
                      <span>{isMain ? fmtPreset(it.row) : ''}</span>
                      <span className="text-right pr-2">{isMain ? fmtVal(it.row.currentRaw) : ''}</span>
                      <span className="text-right pr-2">{isMain ? fmtVal(it.row.currentPhysical) : ''}</span>
                      <span className="text-right pr-2">{isMain ? fmtVal(it.row.previousRaw) : ''}</span>
                      <span className="text-right pr-2">{isMain ? it.row.changeCount : ''}</span>
                      <span>{isMain ? (it.row.kindHint ?? '') : ''}</span>
                      <span className="inline-flex items-center gap-1 font-sans">
                        {isMain && it.row.containedCount > 0 && (
                          <button
                            type="button"
                            className={smBtn}
                            title={t('re.scan.containedTip')}
                            onClick={() =>
                              setExpanded((s) => {
                                const n = new Set(s);
                                if (n.has(rowKey)) n.delete(rowKey);
                                else n.add(rowKey);
                                return n;
                              })
                            }
                          >
                            {t('re.scan.contained', { n: it.row.containedCount })}
                          </button>
                        )}
                        {isMain && (
                          <>
                            <button type="button" className={smBtn} title={t('re.scan.inspectTip')} onClick={() => onInspect(it.row)}>
                              {t('re.scan.inspect')}
                            </button>
                            <button type="button" className={smBtn} onClick={() => openSaveDialogForScanRow(it.row)}>
                              {t('re.scan.save')}
                            </button>
                            <button type="button" className={smBtn} title={t('re.scan.highlightTip')} onClick={() => onHighlight(it.row)}>
                              {t('re.scan.highlight')}
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
