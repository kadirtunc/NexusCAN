/**
 * R2a Signal Inspector: pick bits of one ID (drag-select grid), up to 4 colour-coded candidates + 1 reference,
 * live min/max plot (5 Hz while visible and following), correlation sweep. Passive only; no DBC write in R2a.
 * All values come from the backend `cmd_re_series` round trip (DEMO-badged synthetic data in a browser preview).
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ReByteOrder, ReCandidateDto, ReFieldDto, ReMarkerDto, ReValueType } from '../../types/re';
import type { ReRowView } from '../../store/reStore';
import { reSignalStore, useReSignalState, type ReCandidateEntry } from '../../store/reSignalStore';
import { formatArbId } from './reModel';
import { DIAG_BTN, DIAG_CHECKBOX, DIAG_INPUT, DIAG_SELECT, DIAG_TITLE, DIAG_TOOLBAR, DiagBadge, DiagDot } from '../diagnostics/diagUi';
import { ReBitSelectGrid } from './ReBitSelectGrid';
import { ReCorrelatePanel } from './ReCorrelatePanel';
import { ReSeriesCanvas } from './ReSeriesCanvas';
import { openSaveDialogForCandidate } from './reDraftOpen';
import { candidateColors, useReTheme } from './reTheme';
import { formatSignalValue, RE_ERR_HINT_KEYS, selectionFits } from './reSignalModel';

export interface ReSignalSeed {
  field: Pick<ReFieldDto, 'startBit' | 'bitLength' | 'byteOrder'>;
  /** full candidate (value type + scale), e.g. from a Value Scan row; wins over `field` */
  candidate?: ReCandidateDto;
  /** increments on every "Inspect" click so the same field can be seeded twice */
  nonce: number;
}

export interface ReSignalInspectorProps {
  row: ReRowView;
  markers: readonly ReMarkerDto[];
  startedAtUs: number | null;
  seed: ReSignalSeed | null;
  onClose: () => void;
}

const SPANS_S = [2, 5, 10, 30, 60, 300] as const;
const VALUE_TYPES: readonly ReValueType[] = ['unsigned', 'signed', 'float32', 'float64'];

const inputCls = `${DIAG_INPUT} !h-[24px] !px-1.5 !text-[12px]`;
const selCls = `${DIAG_SELECT} !h-[24px] !w-auto !px-1.5 !pr-2 !text-[12px]`;

/** Text field committing on blur/Enter (avoids one backend request per keystroke). */
function CommitField(p: { value: string; onCommit: (text: string) => void; width: number; title?: string; mono?: boolean }): React.ReactElement {
  const [text, setText] = useState(p.value);
  useEffect(() => setText(p.value), [p.value]);
  return (
    <input
      value={text}
      title={p.title}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== p.value && p.onCommit(text)}
      onKeyDown={(e) => e.key === 'Enter' && p.onCommit(text)}
      className={inputCls}
      style={{ width: p.width }}
    />
  );
}

function lastValue(s: ReturnType<typeof useReSignalState>, index: number): number | null {
  const e = s.series?.series.find((x) => x.kind === 'candidate' && x.index === index);
  if (e === undefined) return null;
  const n = e.points.tUsRel.length;
  return n === 0 ? null : (e.points.min[n - 1] + e.points.max[n - 1]) / 2;
}

export function ReSignalInspector({ row, markers, startedAtUs, seed, onClose }: ReSignalInspectorProps): React.ReactElement {
  const { t } = useI18n();
  const s = useReSignalState();
  const theme = useReTheme();
  const slotColors = candidateColors(theme);
  const [defaultOrder, setDefaultOrder] = useState<ReByteOrder>('intel');

  useEffect(() => {
    reSignalStore.setVisible(true);
    return () => reSignalStore.setVisible(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await reSignalStore.setTarget({ bus: row.bus, arbId: row.arbId, isExtended: row.extended });
      if (!cancelled && seed !== null) {
        if (seed.candidate !== undefined) reSignalStore.addCandidate(seed.candidate);
        else reSignalStore.addCandidateFromField(seed.field);
      }
    })();
    return () => {
      cancelled = true;
    };
    // identity of the inspected ID + a new seed click
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.key, seed?.nonce]);

  const onGridSelect = (sel: { startBit: number; bitLength: number }): void => {
    const active = s.candidates.find((c) => c.id === s.activeId);
    if (active !== undefined) reSignalStore.updateCandidate(active.id, sel);
    else
      reSignalStore.addCandidate({ ...sel, byteOrder: defaultOrder, valueType: 'unsigned', factor: 1, offset: 0 });
  };

  const parseNum = (text: string, fallback: number): number => {
    const n = Number(text.replace(',', '.'));
    return Number.isFinite(n) ? n : fallback;
  };

  const errCode = s.seriesErrorCode;
  const errHint = errCode === null ? undefined : RE_ERR_HINT_KEYS[errCode];
  const total = row.dlcBytes * 8;
  const mono = 'font-mono tabular-nums';

  const candRow = (c: ReCandidateEntry, i: number): React.ReactElement => {
    const d = c.dto;
    const v = lastValue(s, i);
    const fits = selectionFits(d, total);
    const floatBad = (d.valueType === 'float32' && d.bitLength !== 32) || (d.valueType === 'float64' && d.bitLength !== 64);
    return (
      <div
        key={c.id}
        className={`px-3 py-1.5 border-t border-hairline ${c.id === s.activeId ? 'bg-[var(--bg-row-selected)]' : ''}`}
        onClick={() => reSignalStore.setActive(c.id)}
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-3 h-3 shrink-0" style={{ backgroundColor: slotColors[c.slot] }} />
          <span className={`${mono} text-[12px]`}>
            @{d.startBit} +{d.bitLength}
          </span>
          {c.preview && <DiagBadge tone="neutral">{t('re.cand.preview')}</DiagBadge>}
          <span className={`${mono} ml-auto text-[13px] font-semibold`} style={{ color: slotColors[c.slot] }}>
            {v === null ? '-' : formatSignalValue(v)} {c.unit}
          </span>
          <button
            type="button"
            disabled={!fits || floatBad}
            onClick={(e) => {
              e.stopPropagation();
              openSaveDialogForCandidate(row, s, c, i);
            }}
            className="px-1.5 h-[22px] border border-hairline rounded-[2px] text-[11px] text-ink cursor-pointer hover:border-focus disabled:opacity-40"
            title={t('re.draft.saveTip')}
          >
            {t('re.draft.save')}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              reSignalStore.removeCandidate(c.id);
            }}
            className="px-1.5 text-[var(--text-muted)] cursor-pointer"
            title={t('re.cand.remove')}
          >
            x
          </button>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap pt-1 text-[11px]">
          <select
            value={d.byteOrder}
            onChange={(e) => {
              setDefaultOrder(e.target.value as ReByteOrder);
              reSignalStore.updateCandidate(c.id, { byteOrder: e.target.value as ReByteOrder });
            }}
            className={selCls}
            title={t('re.cand.byteOrder')}
          >
            <option value="intel">Intel @1</option>
            <option value="motorola">Motorola @0</option>
          </select>
          <select
            value={d.valueType}
            onChange={(e) => {
              const vt = e.target.value as ReValueType;
              reSignalStore.updateCandidate(c.id, vt === 'float32' ? { valueType: vt, bitLength: 32 } : vt === 'float64' ? { valueType: vt, bitLength: 64 } : { valueType: vt });
            }}
            className={selCls}
            title={t('re.cand.valueType')}
          >
            {VALUE_TYPES.map((vt) => (
              <option key={vt} value={vt}>{vt}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1">
            {t('re.cand.start')}
            <CommitField value={String(d.startBit)} width={46} onCommit={(x) => reSignalStore.updateCandidate(c.id, { startBit: Math.max(0, Math.min(511, Math.round(parseNum(x, d.startBit)))) })} />
          </label>
          <label className="inline-flex items-center gap-1">
            {t('re.cand.len')}
            <CommitField value={String(d.bitLength)} width={40} onCommit={(x) => reSignalStore.updateCandidate(c.id, { bitLength: Math.max(1, Math.min(64, Math.round(parseNum(x, d.bitLength)))) })} />
          </label>
          <label className="inline-flex items-center gap-1">
            {t('re.cand.factor')}
            <CommitField value={String(d.factor)} width={70} onCommit={(x) => reSignalStore.updateCandidate(c.id, { factor: parseNum(x, d.factor) })} />
          </label>
          <label className="inline-flex items-center gap-1">
            {t('re.cand.offset')}
            <CommitField value={String(d.offset)} width={70} onCommit={(x) => reSignalStore.updateCandidate(c.id, { offset: parseNum(x, d.offset) })} />
          </label>
          <label className="inline-flex items-center gap-1">
            {t('re.cand.unit')}
            <CommitField value={c.unit} width={50} onCommit={(x) => reSignalStore.setCandidateUnit(c.id, x.slice(0, 16))} />
          </label>
        </div>
        {!fits && <div className="pt-1 text-[11px] text-warn">{t('re.cand.outOfRange', { bits: total })}</div>}
        {floatBad && <div className="pt-1 text-[11px] text-warn">{t('re.cand.floatLen')}</div>}
      </div>
    );
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-canvas text-[12px] text-[var(--text-primary)]">
      <div className={`${DIAG_TOOLBAR} !h-auto flex-wrap gap-3 py-2`}>
        <button type="button" onClick={onClose} className={DIAG_BTN}>
          {t('re.sig.back')}
        </button>
        <span className={DIAG_TITLE}>{t('re.sig.title')}</span>
        <span className={`${mono} text-[14px] font-semibold`}>0x{formatArbId(row.arbId, row.extended)}</span>
        <span className={`${mono} text-[var(--text-muted)]`}>
          bus {row.bus} {row.extended ? 'EXT' : 'STD'} DLC {row.dlcBytes}
        </span>
        {s.demo && (
          <DiagBadge tone="warn" title={t('re.demo.tooltip')}>
            {t('re.demo.badge')}
          </DiagBadge>
        )}
        <span className="ml-auto inline-flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" className={DIAG_CHECKBOX} checked={s.followLive} onChange={(e) => reSignalStore.setFollow(e.target.checked)} />
            {t('re.sig.follow')}
            {s.followLive && <DiagDot tone="nominal" />}
          </label>
          <label className="inline-flex items-center gap-1.5">
            {t('re.sig.span')}
            <select
              value={SPANS_S.includes(Math.round(s.spanUs / 1e6) as (typeof SPANS_S)[number]) ? Math.round(s.spanUs / 1e6) : ''}
              onChange={(e) => reSignalStore.setSpan(Number(e.target.value) * 1e6)}
              className={selCls}
            >
              <option value="" disabled>{`${(s.spanUs / 1e6).toFixed(1)}`}</option>
              {SPANS_S.map((x) => (
                <option key={x} value={x}>{`${x} s`}</option>
              ))}
            </select>
          </label>
        </span>
      </div>

      {s.seriesError !== null && (
        <div className="px-3 py-1 border-b border-hairline">
          <span className="text-critical font-mono">{s.seriesError}</span>
          {errHint !== undefined && <span className="text-[var(--text-secondary)]">{`  ${t(errHint)}`}</span>}
        </div>
      )}
      {s.notice === 'max' && <div className="px-3 py-1 border-b border-hairline text-warn">{t('re.cand.max')}</div>}

      <div className="flex-1 min-h-0 flex">
        <div className="w-[420px] shrink-0 border-r border-hairline min-h-0 overflow-y-auto">
          <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)] flex items-center gap-2">
            {t('re.sig.bits')}
            <select
              value={defaultOrder}
              onChange={(e) => {
                const o = e.target.value as ReByteOrder;
                setDefaultOrder(o);
                const a = s.candidates.find((c) => c.id === s.activeId);
                if (a !== undefined) reSignalStore.updateCandidate(a.id, { byteOrder: o });
              }}
              className={`${selCls} normal-case`}
            >
              <option value="intel">Intel @1</option>
              <option value="motorola">Motorola @0</option>
            </select>
          </div>
          <div className="px-3 pb-1 text-[11px] text-[var(--text-muted)]">{t('re.sig.dragHint')}</div>
          <div className="px-3 pb-2 overflow-auto max-h-[300px]">
            <ReBitSelectGrid
              dlcBytes={row.dlcBytes}
              constant={row.constant}
              candidates={s.candidates}
              activeId={s.activeId}
              defaultOrder={defaultOrder}
              onSelect={onGridSelect}
            />
          </div>
          <div className="px-3 pt-1 pb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)] flex items-center">
            {t('re.sig.candidates')} <span className={`${mono} ml-1`}>({s.candidates.length}/4)</span>
          </div>
          {s.candidates.length === 0 && <div className="px-3 pb-2 text-[var(--text-muted)]">{t('re.sig.noCandidates')}</div>}
          {s.candidates.map(candRow)}
        </div>

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="flex-1 min-h-[220px]">
            <ReSeriesCanvas
              series={s.series}
              candidates={s.candidates}
              referenceLabel={s.referenceLabel}
              followLive={s.followLive}
              spanUs={s.spanUs}
              originUs={s.originUs}
              view={s.view}
              markers={markers}
            />
          </div>
          <div className="h-[46%] min-h-[200px] overflow-auto border-t border-hairline">
            <ReCorrelatePanel row={row} s={s} markers={markers} startedAtUs={startedAtUs} />
          </div>
        </div>
      </div>
    </div>
  );
}

