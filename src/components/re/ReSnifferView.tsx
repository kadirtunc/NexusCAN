/** Reverse Engineering sniffer doc tab (re-toolkit-v1 R1): toolbar, filters, bit heatmap and row inspector. Passive only. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ReFieldDto, ReRowKey, ReSettablePhase } from '../../types/re';
import { reRowKey, reStore, selectVisibleRows, useReState } from '../../store/reStore';
import { formatElapsed } from './reModel';
import { DIAG_BTN, DIAG_CHECKBOX, DIAG_INPUT, DIAG_SELECT, DIAG_TOOLBAR, DIAG_DIVIDER, DIAG_SUBBAR, DiagBadge, diagToneButtonClass, type DiagTone } from '../diagnostics/diagUi';
import { ReHeatmapCanvas } from './ReHeatmapCanvas';
import { ReRowInspector } from './ReRowInspector';
import { ReSignalInspector, type ReSignalSeed } from './ReSignalInspector';
import { ReFoundSignalsPanel } from './ReFoundSignalsPanel';
import { ReSaveSignalDialog } from './ReSaveSignalDialog';
import { ReValueScanPanel } from './ReValueScanPanel';
import { scanRowToInspect } from './reScanModel';
import type { ReScanResultRowDto } from '../../types/reScan';
import { useReDraftState } from '../../store/reDraftStore';

const PHASE_TONES: Record<ReSettablePhase, DiagTone> = {
  baseline: 'focus',
  action: 'nominal',
  free: 'neutral',
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

export function ReSnifferView(): React.ReactElement {
  const { t } = useI18n();
  const s = useReState();
  const [markLabel, setMarkLabel] = useState('');
  const [inspecting, setInspecting] = useState<ReRowKey | null>(null);
  const [seed, setSeed] = useState<ReSignalSeed | null>(null);
  const seedNonce = useRef(0);
  const [showFound, setShowFound] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const found = useReDraftState();

  useEffect(() => {
    void reStore.attach();
    void reStore.refreshMarkers();
    return () => reStore.detach();
  }, []);

  const doMark = (label: string): void => {
    void reStore.mark(label.trim());
  };

  // Hotkey M = marker (not while typing, no modifiers).
  const labelRef = useRef(markLabel);
  labelRef.current = markLabel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      doMark(labelRef.current);
      setMarkLabel('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [labelRef]);

  const rows = selectVisibleRows(s);
  const enabled = s.status?.enabled ?? false;
  const phase = s.phase;
  const phaseElapsed =
    s.status?.phaseStartedAtUs != null && s.lastTsUs > 0 ? formatElapsed(s.lastTsUs - s.status.phaseStartedAtUs) : '00:00.0';

  const buses = useMemo(() => {
    const set = new Set<number>();
    for (const r of reStore.getRows().values()) set.add(r.bus);
    return Array.from(set).sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.rowsVersion]);

  const selectedRow = s.selected === null ? null : (reStore.getRows().get(reRowKey(s.selected.bus, s.selected.isExtended, s.selected.arbId)) ?? null);

  const inspectedRow =
    inspecting === null ? null : (reStore.getRows().get(reRowKey(inspecting.bus, inspecting.isExtended, inspecting.arbId)) ?? null);
  const openInspector = (field: ReFieldDto | null): void => {
    if (selectedRow === null) return;
    setInspecting({ bus: selectedRow.bus, arbId: selectedRow.arbId, isExtended: selectedRow.extended });
    if (field !== null) {
      seedNonce.current += 1;
      setSeed({ field, nonce: seedNonce.current });
    } else {
      setSeed(null);
    }
  };

  const inspectScanRow = (row: ReScanResultRowDto): void => {
    const { target, candidate } = scanRowToInspect(row);
    reStore.select(target);
    setInspecting(target);
    seedNonce.current += 1;
    setSeed({ field: candidate, candidate, nonce: seedNonce.current });
  };
  /** Heatmap hook: select the ID (and leave the inspector so the heatmap is visible). */
  const highlightScanRow = (row: ReScanResultRowDto): void => {
    const { target } = scanRowToInspect(row);
    setInspecting(null);
    reStore.select(target);
  };

  const mono = 'font-mono tabular-nums';

  const phaseBtn = (p: ReSettablePhase, label: string): React.ReactElement => {
    const active = phase === p;
    return (
      <button
        type="button"
        disabled={!enabled || s.busy}
        onClick={() => void reStore.setPhase(p)}
        className={diagToneButtonClass(PHASE_TONES[p], active)}
      >
        {label}
        {active && <span className={mono}>{phaseElapsed}</span>}
      </button>
    );
  };

  const check = (checked: boolean, label: string, onChange: (v: boolean) => void): React.ReactElement => (
    <label className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer select-none text-[var(--text-primary)]">
      <input type="checkbox" className={DIAG_CHECKBOX} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div className="h-full min-h-0 flex flex-col bg-canvas text-[var(--text-primary)]">
      <div className={`${DIAG_TOOLBAR} !h-auto flex-wrap py-2`}>
        {enabled ? (
          <button type="button" disabled={s.busy} onClick={() => void reStore.stop()} className={diagToneButtonClass('warn', true)}>
            {t('re.toolbar.stop')}
          </button>
        ) : (
          <button type="button" disabled={s.busy} onClick={() => void reStore.start()} className={diagToneButtonClass('nominal', true)}>
            {t('re.toolbar.start')}
          </button>
        )}
        <button type="button" disabled={s.busy} onClick={() => void reStore.reset()} className={DIAG_BTN}>
          {t('re.toolbar.reset')}
        </button>
        <span className={DIAG_DIVIDER} />
        {phaseBtn('baseline', t('re.phase.baseline'))}
        {phaseBtn('action', t('re.phase.action'))}
        {phaseBtn('free', t('re.phase.free'))}
        <span className={DIAG_DIVIDER} />
        <input
          value={markLabel}
          maxLength={64}
          onChange={(e) => setMarkLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              doMark(markLabel);
              setMarkLabel('');
            }
          }}
          placeholder={t('re.mark.placeholder')}
          className={`${DIAG_INPUT} !w-[190px]`}
        />
        <button
          type="button"
          disabled={!enabled}
          onClick={() => {
            doMark(markLabel);
            setMarkLabel('');
          }}
          className={DIAG_BTN}
          title={t('re.mark.tooltip')}
        >
          {t('re.mark.button')} <span className={`${mono} text-[var(--text-muted)]`}>[M]</span>
        </button>
        <span className="ml-auto inline-flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowScan((v) => !v)}
            className={diagToneButtonClass('focus', showScan)}
            title={t('re.scan.toggleTip')}
          >
            {t('re.scan.title')}
          </button>
          <button
            type="button"
            onClick={() => setShowFound((v) => !v)}
            className={diagToneButtonClass('focus', showFound)}
            title={t('re.draft.panel.toggleTip')}
          >
            {t('re.draft.panel.title')} <span className={mono}>({found.drafts.length})</span>
          </button>
          <label className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer select-none text-[var(--text-primary)]" title={t('re.demo.switchTip')}>
            <input
              type="checkbox"
              className={DIAG_CHECKBOX}
              checked={s.demo}
              onChange={(e) => void reStore.setSource(e.target.checked ? 'demo' : 'live')}
            />
            {t('re.demo.switch')}
          </label>
          {s.demo && (
            <DiagBadge tone="warn" title={t('re.demo.tooltip')}>
              {t('re.demo.badge')}
            </DiagBadge>
          )}
        </span>
      </div>

      <div className={`${DIAG_SUBBAR} !h-auto flex-wrap gap-4 py-1.5`}>
        {check(s.filters.onlyDiff, t('re.filter.onlyDiff'), (v) => reStore.setFilters({ onlyDiff: v }))}
        {check(s.filters.muteNoisy, t('re.filter.muteNoisy'), (v) => reStore.setFilters({ muteNoisy: v }))}
        {check(s.filters.hideConstant, t('re.filter.hideConstant'), (v) => reStore.setFilters({ hideConstant: v }))}
        <span className="inline-flex items-center gap-3" role="group" aria-label={t('re.view.group')}>
          <span className="text-[12px] text-[var(--text-muted)]">{t('re.view.group')}</span>
          {check(s.display.showBits, t('re.view.bits'), (v) => reStore.setDisplay({ showBits: v }))}
          {check(s.display.showHex, t('re.view.values'), (v) => reStore.setDisplay({ showHex: v }))}
          {check(s.display.showHeat, t('re.view.heat'), (v) => reStore.setDisplay({ showHeat: v }))}
          <span className="inline-flex" role="radiogroup" aria-label={t('re.view.format')}>
            {(['hex', 'dec'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={s.display.byteFormat === f}
                disabled={!s.display.showHex}
                onClick={() => reStore.setDisplay({ byteFormat: f })}
                className={`${DIAG_BTN} !h-[26px] !px-2 ${mono} ${s.display.byteFormat === f ? '!bg-[var(--bg-row-selected)]' : ''} ${f === 'hex' ? '!rounded-r-none' : '!rounded-l-none -ml-px'}`}
              >
                {f === 'hex' ? 'Hex' : 'Dec'}
              </button>
            ))}
          </span>
        </span>
        <input
          value={s.filters.search}
          onChange={(e) => reStore.setFilters({ search: e.target.value })}
          placeholder={t('re.filter.search')}
          className={`${DIAG_INPUT} !h-[26px] !w-[130px]`}
        />
        <label className="inline-flex items-center gap-1.5 text-[12px]">
          {t('re.filter.bus')}
          <select
            value={s.filters.bus ?? ''}
            onChange={(e) => reStore.setFilters({ bus: e.target.value === '' ? null : Number(e.target.value) })}
            className={`${DIAG_SELECT} !h-[26px] !w-[84px] !pr-2`}
          >
            <option value="">{t('re.filter.allBuses')}</option>
            {buses.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <span className={`ml-auto text-[12px] text-[var(--text-muted)] ${mono}`}>
          {t('re.status.rows', { shown: rows.length, total: s.totalRows })}
          {s.status !== null && s.status.overflowRows > 0 ? `  +${s.status.overflowRows} ${t('re.status.overflow')}` : ''}
          {`  seq ${s.lastSeq}`}
        </span>
      </div>

      {s.error !== null && <div className="px-3 py-1 text-[12px] text-critical border-b border-hairline">{s.error}</div>}

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col">
      {inspectedRow !== null ? (
        <div className="flex-1 min-h-0">
          <ReSignalInspector
            row={inspectedRow}
            markers={s.markers}
            startedAtUs={s.status?.startedAtUs ?? null}
            seed={seed}
            onClose={() => setInspecting(null)}
          />
        </div>
      ) : (
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 relative">
          {rows.length === 0 ? (
            <div className="p-4 text-[12px] text-[var(--text-muted)]">{enabled ? t('re.empty.waiting') : t('re.empty.idle')}</div>
          ) : (
            <ReHeatmapCanvas
              rows={rows}
              rowsVersion={s.rowsVersion}
              selectedKey={selectedRow?.key ?? null}
              muteNoisy={s.filters.muteNoisy}
              display={s.display}
              onSelect={(r) => reStore.select({ bus: r.bus, arbId: r.arbId, isExtended: r.extended })}
            />
          )}
        </div>
        <div className="w-[440px] shrink-0 border-l border-hairline min-h-0">
          <ReRowInspector row={selectedRow} markers={s.markers} startedAtUs={s.status?.startedAtUs ?? null} demo={s.demo} onInspect={openInspector} />
        </div>
      </div>
      )}
        </div>
        {showScan && (
          <div className="h-[380px] shrink-0 border-t border-hairline min-h-0">
            <ReValueScanPanel onInspect={inspectScanRow} onHighlight={highlightScanRow} />
          </div>
        )}
        {showFound && (
          <div className="h-[280px] shrink-0 border-t border-hairline min-h-0">
            <ReFoundSignalsPanel />
          </div>
        )}
      </div>
      <ReSaveSignalDialog />
    </div>
  );
}
