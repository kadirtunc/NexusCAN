/**
 * R2a correlation panel: reference picker (OBD-II PID / markers with values / another candidate), search range
 * (defaults to the classifier's non-constant bits), Run -> ranked table with Plot / Use as candidate. The sweep itself
 * runs in the backend (worker thread, 2 s budget); this panel only builds the request and renders the result.
 */
import { useEffect, useMemo, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { PID_CATALOG } from '../../types/diagnostics';
import type { ReMarkerDto, ReReferenceDto, ReSearchDto } from '../../types/re';
import { reSignalStore, type ReSignalState } from '../../store/reSignalStore';
import { defaultSearchFromConstant, formatSignalValue, normalizeSearch, RE_ERR_HINT_KEYS } from './reSignalModel';
import type { ReRowView } from '../../store/reStore';
import { formatElapsed } from './reModel';
import { useReTheme } from './reTheme';
import { openSaveDialogForRow } from './reDraftOpen';
import { DIAG_BTN, DIAG_BTN_GHOST, DIAG_BTN_SM, DIAG_INPUT, DIAG_SELECT, DiagBadge, diagToneButtonClass } from '../diagnostics/diagUi';

type RefKind = ReReferenceDto['kind'];

export interface ReCorrelatePanelProps {
  row: ReRowView;
  s: ReSignalState;
  markers: readonly ReMarkerDto[];
  startedAtUs: number | null;
}

const inputCls = `${DIAG_INPUT} !h-[24px] !px-1.5 !text-[12px]`;
const selCls = `${DIAG_SELECT} !h-[24px] !w-auto !px-1.5 !pr-2 !text-[12px]`;

function IntField(p: { value: number; min: number; max: number; onChange: (n: number) => void; width?: number }): React.ReactElement {
  const [text, setText] = useState(String(p.value));
  useEffect(() => setText(String(p.value)), [p.value]);
  const commit = (): void => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n)) p.onChange(Math.max(p.min, Math.min(p.max, n)));
    else setText(String(p.value));
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className={inputCls}
      style={{ width: p.width ?? 54 }}
    />
  );
}

export function ReCorrelatePanel({ row, s, markers, startedAtUs }: ReCorrelatePanelProps): React.ReactElement {
  const { t } = useI18n();
  const theme = useReTheme();
  const [kind, setKind] = useState<RefKind>('obd_pid');
  const [pid, setPid] = useState<number>(PID_CATALOG[0]?.pid ?? 0x0c);
  const [bus, setBus] = useState<number>(row.bus);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [candId, setCandId] = useState<number | null>(null);
  const [search, setSearch] = useState<ReSearchDto>(() => defaultSearchFromConstant(row.constant, row.dlcBytes));
  const [topN, setTopN] = useState(20);

  // re-seed the default search when another ID is inspected
  useEffect(() => {
    setSearch(defaultSearchFromConstant(row.constant, row.dlcBytes));
    setBus(row.bus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.key]);

  const markerPoints = useMemo(() => {
    const pts: { markerId: number; value: number }[] = [];
    for (const m of markers) {
      const raw = picked[m.id];
      if (raw === undefined || raw.trim() === '') continue;
      const v = Number(raw);
      if (Number.isFinite(v)) pts.push({ markerId: m.id, value: v });
    }
    return pts;
  }, [markers, picked]);

  const candEntry = s.candidates.find((c) => c.id === candId) ?? s.candidates.find((c) => c.id !== s.activeId) ?? null;

  const applyReference = (): void => {
    if (kind === 'obd_pid') {
      const def = PID_CATALOG.find((d) => d.pid === pid);
      reSignalStore.setReference({ kind: 'obd_pid', pid, bus }, `PID 0x${pid.toString(16).toUpperCase().padStart(2, '0')} ${def?.name ?? ''} [${def?.unit ?? ''}]`);
    } else if (kind === 'markers') {
      if (markerPoints.length < 2 || s.target === null) return;
      reSignalStore.setReference({ kind: 'markers', points: markerPoints }, t('re.corr.markersLabel', { n: markerPoints.length }));
    } else if (candEntry !== null && s.target !== null) {
      reSignalStore.setReference(
        { kind: 'candidate', target: s.target, candidate: candEntry.dto },
        `@${candEntry.dto.startBit}+${candEntry.dto.bitLength}`,
      );
    }
  };

  const canApply = kind === 'obd_pid' || (kind === 'markers' && markerPoints.length >= 2) || (kind === 'candidate' && candEntry !== null);
  const corr = s.correlation;
  const result = corr.result;
  const errKey = corr.errorCode === null ? undefined : RE_ERR_HINT_KEYS[corr.errorCode];

  const toggleIn = <T,>(list: T[], v: T, on: boolean): T[] => (on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v));
  const lbl = 'text-[11px] uppercase tracking-wide text-[var(--text-muted)]';

  return (
    <div className="text-[12px]">
      <div className={`${lbl} px-3 pt-2 pb-1`}>{t('re.corr.reference')}</div>
      <div className="px-3 flex items-center gap-2 flex-wrap">
        <select value={kind} onChange={(e) => setKind(e.target.value as RefKind)} className={selCls}>
          <option value="obd_pid">{t('re.corr.kind.obd')}</option>
          <option value="markers">{t('re.corr.kind.markers')}</option>
          <option value="candidate">{t('re.corr.kind.candidate')}</option>
        </select>
        {kind === 'obd_pid' && (
          <>
            <select value={pid} onChange={(e) => setPid(Number(e.target.value))} className={selCls}>
              {PID_CATALOG.map((d) => (
                <option key={d.pid} value={d.pid}>
                  {`0x${d.pid.toString(16).toUpperCase().padStart(2, '0')} ${d.name} [${d.unit}]`}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5">
              {t('re.filter.bus')}
              <IntField value={bus} min={0} max={255} onChange={setBus} width={40} />
            </label>
          </>
        )}
        {kind === 'candidate' && (
          <select value={candEntry?.id ?? ''} onChange={(e) => setCandId(Number(e.target.value))} className={selCls}>
            {s.candidates.map((c) => (
              <option key={c.id} value={c.id}>{`@${c.dto.startBit}+${c.dto.bitLength} ${c.dto.byteOrder === 'intel' ? 'I' : 'M'}`}</option>
            ))}
          </select>
        )}
        <button type="button" disabled={!canApply} onClick={applyReference} className={DIAG_BTN}>
          {t('re.corr.setReference')}
        </button>
        {s.reference !== null && (
          <span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-[var(--text-secondary)]">
            <span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: theme.textSecondary }} />
            {s.referenceLabel}
            <button type="button" onClick={() => reSignalStore.setReference(null)} className="px-1 text-[var(--text-muted)] cursor-pointer" title={t('re.corr.clearReference')}>
              x
            </button>
          </span>
        )}
      </div>
      {kind === 'obd_pid' && <div className="px-3 pt-1 text-[11px] text-[var(--text-muted)]">{t('re.corr.obdHint')}</div>}
      {kind === 'candidate' && s.candidates.length < 2 && <div className="px-3 pt-1 text-[11px] text-warn">{t('re.corr.needTwoCandidates')}</div>}
      {kind === 'markers' && (
        <div className="px-3 pt-1">
          {markers.length < 2 && <div className="text-warn text-[11px]">{t('re.corr.needMarkers')}</div>}
          {markers.map((m) => (
            <div key={m.id} className="flex items-center gap-2 py-0.5 font-mono tabular-nums">
              <span className="w-[26px] text-[var(--text-muted)]">#{m.id}</span>
              <span className="w-[62px]">{startedAtUs === null ? '-' : formatElapsed(m.tsUs - startedAtUs)}</span>
              <span className="font-sans truncate w-[110px]">{m.label === '' ? '-' : m.label}</span>
              <input
                value={picked[m.id] ?? ''}
                onChange={(e) => setPicked({ ...picked, [m.id]: e.target.value })}
                placeholder={t('re.corr.markerValue')}
                className={inputCls}
                style={{ width: 90 }}
              />
            </div>
          ))}
        </div>
      )}

      <div className={`${lbl} px-3 pt-3 pb-1`}>{t('re.corr.search')}</div>
      <div className="px-3 flex items-center gap-x-3 gap-y-1 flex-wrap">
        <label className="inline-flex items-center gap-1.5">
          {t('re.corr.bits')}
          <IntField value={search.bitFrom} min={0} max={511} onChange={(n) => setSearch({ ...search, bitFrom: n })} />
          ..
          <IntField value={search.bitTo} min={0} max={511} onChange={(n) => setSearch({ ...search, bitTo: n })} />
        </label>
        <label className="inline-flex items-center gap-1.5">
          {t('re.corr.lengths')}
          <IntField value={search.lengths[0]} min={1} max={32} onChange={(n) => setSearch({ ...search, lengths: [n, Math.max(n, search.lengths[1])] })} width={40} />
          ..
          <IntField value={search.lengths[1]} min={1} max={32} onChange={(n) => setSearch({ ...search, lengths: [Math.min(n, search.lengths[0]), n] })} width={40} />
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer accent-[var(--status-focus)]" checked={search.byteOrders.includes('intel')} onChange={(e) => setSearch({ ...search, byteOrders: toggleIn(search.byteOrders, 'intel', e.target.checked) })} />
          Intel
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer accent-[var(--status-focus)]" checked={search.byteOrders.includes('motorola')} onChange={(e) => setSearch({ ...search, byteOrders: toggleIn(search.byteOrders, 'motorola', e.target.checked) })} />
          Motorola
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer accent-[var(--status-focus)]" checked={search.signed.includes(false)} onChange={(e) => setSearch({ ...search, signed: toggleIn(search.signed, false, e.target.checked) })} />
          {t('re.corr.unsigned')}
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 cursor-pointer accent-[var(--status-focus)]" checked={search.signed.includes(true)} onChange={(e) => setSearch({ ...search, signed: toggleIn(search.signed, true, e.target.checked) })} />
          {t('re.corr.signed')}
        </label>
        <label className="inline-flex items-center gap-1.5">
          {t('re.corr.topN')}
          <IntField value={topN} min={1} max={50} onChange={setTopN} width={40} />
        </label>
        <button type="button" onClick={() => setSearch(defaultSearchFromConstant(row.constant, row.dlcBytes))} className={DIAG_BTN_GHOST} title={t('re.corr.resetRangeTip')}>
          {t('re.corr.resetRange')}
        </button>
      </div>

      <div className="px-3 pt-3 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={corr.status === 'running' || s.target === null}
          onClick={() => void reSignalStore.runCorrelation(normalizeSearch(search), topN)}
          className={DIAG_BTN}
        >
          {corr.status === 'running' ? t('re.corr.running') : t('re.corr.run')}
        </button>
        {result !== null && (
          <span className="font-mono tabular-nums text-[var(--text-muted)]">
            {t('re.corr.stats', { evaluated: result.evaluated, samples: result.referenceSamples, ms: Math.round(result.elapsedMs) })}
          </span>
        )}
        {result?.truncated === true && (
          <DiagBadge tone="warn" title={t('re.corr.truncatedTip')}>
            {t('re.corr.truncated')}
          </DiagBadge>
        )}
        {s.demo && <DiagBadge tone="warn" title={t('re.demo.tooltip')}>{t('re.demo.badge')}</DiagBadge>}
      </div>

      {corr.status === 'error' && (
        <div className="mx-3 mt-2 p-2 border border-[color:var(--status-critical-border)] bg-[var(--status-critical-bg)] text-[12px] rounded-[2px]">
          <div className="text-critical font-mono">{corr.error}</div>
          {errKey !== undefined && <div className="text-[var(--text-secondary)] pt-1">{t(errKey)}</div>}
        </div>
      )}

      {result !== null && result.rows.length === 0 && <div className="px-3 pt-2 text-[var(--text-muted)]">{t('re.corr.noRows')}</div>}
      {result !== null && result.rows.length > 0 && (
        <div className="px-3 pt-2 pb-3 overflow-x-auto">
          <table className="w-full font-mono tabular-nums text-[11px] border-collapse">
            <thead>
              <tr className="text-[var(--text-muted)] text-left">
                {['start', 'len', 'order', 'type', 'r', 'r2', 'factor', 'offset', 'rmse', 'lag'].map((h) => (
                  <th key={h} className="pr-3 py-0.5 font-normal">{t(`re.corr.col.${h}` as TranslationKey)}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={`${i}:${r.candidate.startBit}:${r.candidate.bitLength}:${r.candidate.byteOrder}:${r.candidate.valueType}`} className="border-t border-hairline">
                  <td className="pr-3">{r.candidate.startBit}</td>
                  <td className="pr-3">{r.candidate.bitLength}</td>
                  <td className="pr-3">{r.candidate.byteOrder === 'intel' ? 'Intel' : 'Moto'}</td>
                  <td className="pr-3">{r.candidate.valueType}</td>
                  <td className="pr-3">{r.r.toFixed(4)}</td>
                  <td className="pr-3">{r.r2.toFixed(4)}</td>
                  <td className="pr-3">{formatSignalValue(r.candidate.factor)}</td>
                  <td className="pr-3">{formatSignalValue(r.candidate.offset)}</td>
                  <td className="pr-3">{formatSignalValue(r.rmse)}</td>
                  <td className="pr-3">{r.lagMs} ms</td>
                  <td className="whitespace-nowrap font-sans">
                    <button type="button" onClick={() => reSignalStore.plotRow(r)} className={`${DIAG_BTN_SM} mr-1`}>
                      {t('re.corr.plot')}
                    </button>
                    <button type="button" onClick={() => reSignalStore.useRowAsCandidate(r)} className={diagToneButtonClass('nominal', true, 'sm')}>
                      {t('re.corr.use')}
                    </button>
                    <button type="button" onClick={() => openSaveDialogForRow(row, s, r)} className={`${DIAG_BTN_SM} ml-1`} title={t('re.draft.saveTip')}>
                      {t('re.draft.save')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
