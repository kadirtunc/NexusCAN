/**
 * R2b Found Signals panel (RE tab): saved drafts (project file), edit / delete (inline confirm) / multi-select and the
 * three actions: Apply to bus (RE_found.dbc), Export .dbc, Merge into DBC (always a NEW file). All DBC text comes from
 * the backend generator; when it is unreachable the actions are disabled with a hint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { reDbcGenerate } from '../../services/reClient';
import { useDatabaseStore } from '../../store/databaseStore';
import { reDraftStore, useReDraftState } from '../../store/reDraftStore';
import { applyDraftsToBus, exportDrafts, planMerge, saveMerge, type ReMergePlan } from '../../store/reDraftActions';
import { defaultReDraftActionDeps } from '../../store/reDraftActionsDefault';
import { reDebugLogger } from '../../store/reDebugLog';
import type { ReDbcDiagnosticDto, ReSignalDraftDto } from '../../types/reDraft';
import { DIAG_BTN, DIAG_BTN_DANGER, DIAG_CHECKBOX, DIAG_SELECT, DiagBadge, diagToneButtonClass } from '../diagnostics/diagUi';
import { DiagnosticList } from './ReSaveSignalDialog';
import { RE_FOUND_DB_FILE_NAME, reMessageName } from './reDraftModel';
import { formatArbId } from './reModel';
import { formatSignalValue } from './reSignalModel';

type Reach = 'unknown' | 'ok' | 'down';

/** Probes the generator once (empty list is a valid request) so the actions can be disabled with a hint. */
function useGeneratorReachable(): { reach: Reach; recheck: () => void } {
  const [reach, setReach] = useState<Reach>('unknown');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReach('unknown');
    reDbcGenerate([], null).then(
      () => {
        if (!cancelled) setReach('ok');
      },
      (e: unknown) => {
        reDebugLogger.error('re.dbc_generate', 'RE DBC generator unreachable', e);
        if (!cancelled) setReach('down');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);
  const recheck = useCallback(() => setTick((n) => n + 1), []);
  return { reach, recheck };
}

interface Report {
  tone: 'ok' | 'warn' | 'err';
  text: string;
  diagnostics: ReDbcDiagnosticDto[];
}

const selCls = `${DIAG_SELECT} !h-[24px] !w-auto !px-1.5 !pr-2 !text-[12px]`;

export function ReFoundSignalsPanel(): React.ReactElement {
  const { t } = useI18n();
  const st = useReDraftState();
  const db = useDatabaseStore();
  const { reach, recheck } = useGeneratorReachable();
  const [busSel, setBusSel] = useState<number | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeDb, setMergeDb] = useState<string>('');
  const [plan, setPlan] = useState<ReMergePlan | null>(null);

  const drafts = st.drafts;
  const buses = useMemo(() => Array.from(new Set(drafts.map((d) => d.bus))).sort((a, b) => a - b), [drafts]);
  const bus = busSel !== null && buses.includes(busSel) ? busSel : (buses[0] ?? null);
  const selected = drafts.filter((d) => st.selected.has(d.id));
  const scope: ReSignalDraftDto[] = selected.length > 0 ? selected : [...drafts];
  const mergeCandidates = db.databases.filter(
    (d) => d.contentBase64.length > 0 && d.fileName.trim().toLowerCase() !== RE_FOUND_DB_FILE_NAME.toLowerCase(),
  );
  const mergeId = mergeCandidates.some((d) => d.id === mergeDb) ? mergeDb : (mergeCandidates[0]?.id ?? '');
  const enabled = reach === 'ok' && !busy;
  const mono = 'font-mono tabular-nums';

  const fail = (error: string, diagnostics: ReDbcDiagnosticDto[]): void =>
    setReport({ tone: 'err', text: t('re.draft.result.failed', { error }), diagnostics });

  const doApply = async (): Promise<void> => {
    if (bus === null) return;
    setBusy(true);
    try {
      const out = await applyDraftsToBus(defaultReDraftActionDeps, drafts, bus);
      if (!out.ok) return fail(out.error, out.diagnostics);
      const notes: string[] = [];
      if (out.boundProfiles === 0) notes.push(t('re.draft.result.noProfile'));
      if (!out.schemaOk) notes.push(t('re.draft.result.schemaFail'));
      setReport({
        tone: out.warnings.length > 0 || notes.length > 0 ? 'warn' : 'ok',
        text: [t('re.draft.result.applied', { bus, messages: out.result.messages, signals: out.result.signals, bound: out.boundProfiles }), ...notes].join('  '),
        diagnostics: out.warnings,
      });
    } finally {
      setBusy(false);
    }
  };

  const doExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const out = await exportDrafts(defaultReDraftActionDeps, scope);
      if (!out.ok) return fail(out.error, out.diagnostics);
      setReport({
        tone: out.warnings.length > 0 ? 'warn' : 'ok',
        text: t('re.draft.result.exported', { file: out.fileName, signals: out.result.signals }),
        diagnostics: out.warnings,
      });
    } finally {
      setBusy(false);
    }
  };

  const doPlanMerge = async (): Promise<void> => {
    setBusy(true);
    setPlan(null);
    try {
      const out = await planMerge(defaultReDraftActionDeps, scope, mergeId);
      if (!out.ok) return fail(out.error, out.diagnostics);
      setPlan(out);
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const doSaveMerge = (): void => {
    if (plan === null) return;
    const original = db.databases.find((d) => d.id === mergeId)?.fileName ?? '';
    const out = saveMerge(defaultReDraftActionDeps, plan, original);
    if (!out.ok) return fail(out.error, []);
    setReport({ tone: plan.warnings.length > 0 ? 'warn' : 'ok', text: t('re.draft.result.merged', { file: plan.fileName }), diagnostics: plan.warnings });
    setPlan(null);
    setMergeOpen(false);
  };

  const tone = (r: Report): string => (r.tone === 'err' ? 'text-critical' : r.tone === 'warn' ? 'text-warn' : 'text-nominal');

  return (
    <div className="h-full min-h-0 flex flex-col text-[12px] bg-canvas">
      <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap border-b border-hairline">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">{t('re.draft.panel.title')}</span>
        <span className={`${mono} text-[var(--text-muted)]`}>({drafts.length})</span>
        <span className="mx-1 h-4 w-px bg-hairline" />
        <label className="inline-flex items-center gap-1.5">
          {t('re.draft.bus')}
          <select value={bus ?? ''} disabled={buses.length === 0} onChange={(e) => setBusSel(Number(e.target.value))} className={selCls}>
            {buses.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!enabled || bus === null} onClick={() => void doApply()} className={diagToneButtonClass('nominal', true)} title={t('re.draft.applyTip')}>
          {t('re.draft.apply')}
        </button>
        <button type="button" disabled={!enabled || scope.length === 0} onClick={() => void doExport()} className={DIAG_BTN} title={t('re.draft.exportTip')}>
          {t('re.draft.export')}
        </button>
        <button
          type="button"
          disabled={!enabled || scope.length === 0}
          onClick={() => {
            setMergeOpen((v) => !v);
            setPlan(null);
          }}
          className={DIAG_BTN}
          title={t('re.draft.mergeTip')}
        >
          {t('re.draft.merge')}
        </button>
        <span className={`${mono} text-[11px] text-[var(--text-muted)]`}>
          {t('re.draft.scope', { scope: t(selected.length > 0 ? 're.draft.scope.selected' : 're.draft.scope.all'), n: scope.length })}
        </span>
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => setConfirmDelete(selected.map((d) => d.id))}
          className={`${DIAG_BTN_DANGER} ml-auto disabled:opacity-40`}
        >
          {t('re.draft.deleteSelected')}
        </button>
      </div>

      {reach === 'down' && (
        <div className="px-3 py-1 border-b border-hairline text-warn flex items-center gap-2">
          <DiagBadge tone="warn">{t('re.draft.unreachable')}</DiagBadge>
          <button type="button" className={DIAG_BTN} onClick={recheck}>
            {t('re.draft.recheck')}
          </button>
        </div>
      )}

      {confirmDelete !== null && (
        <div role="alertdialog" className="px-3 py-1.5 border-b border-hairline flex items-center gap-2 bg-[var(--status-critical-bg)]">
          <span className={`${mono} text-critical`}>{t('re.draft.deleteConfirm', { count: confirmDelete.length })}</span>
          <button
            type="button"
            className={DIAG_BTN_DANGER}
            onClick={() => {
              reDraftStore.remove(confirmDelete);
              setConfirmDelete(null);
            }}
          >
            {t('re.draft.confirmYes')}
          </button>
          <button type="button" className={DIAG_BTN} onClick={() => setConfirmDelete(null)}>
            {t('re.draft.confirmNo')}
          </button>
        </div>
      )}

      {mergeOpen && (
        <div className="px-3 py-1.5 border-b border-hairline space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="inline-flex items-center gap-1.5">
              {t('re.draft.merge.pick')}
              <select value={mergeId} onChange={(e) => { setMergeDb(e.target.value); setPlan(null); }} disabled={mergeCandidates.length === 0} className={selCls}>
                {mergeCandidates.map((d) => (
                  <option key={d.id} value={d.id}>{d.fileName}</option>
                ))}
              </select>
            </label>
            {mergeCandidates.length === 0 && <span className="text-warn">{t('re.draft.merge.none')}</span>}
            <button type="button" disabled={!enabled || mergeId === ''} onClick={() => void doPlanMerge()} className={DIAG_BTN}>
              {t('re.draft.merge.generate')}
            </button>
            <button type="button" onClick={() => { setMergeOpen(false); setPlan(null); }} className={DIAG_BTN}>
              {t('re.draft.merge.cancel')}
            </button>
          </div>
          {plan !== null && (
            <div className="space-y-1">
              {plan.warnings.length > 0 && (
                <>
                  <div className="text-[11px] text-warn">{t('re.draft.merge.warnTitle')}</div>
                  <DiagnosticList diagnostics={plan.warnings} />
                </>
              )}
              <button type="button" onClick={doSaveMerge} className={diagToneButtonClass(plan.warnings.length > 0 ? 'warn' : 'nominal', true)}>
                {t('re.draft.merge.save', { file: plan.fileName })}
              </button>
            </div>
          )}
        </div>
      )}

      {report !== null && (
        <div className="px-3 py-1 border-b border-hairline space-y-0.5" aria-live="polite">
          <div className={`${mono} ${tone(report)}`}>{report.text}</div>
          <DiagnosticList diagnostics={report.diagnostics} />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {drafts.length === 0 ? (
          <div className="p-3 text-[var(--text-muted)]">{t('re.draft.panel.empty')}</div>
        ) : (
          <table className={`w-full ${mono} text-[11px] border-collapse`}>
            <thead>
              <tr className="text-[var(--text-muted)] text-left">
                <th className="pl-3 pr-2 py-0.5 w-6">
                  <input
                    type="checkbox"
                    className={DIAG_CHECKBOX}
                    title={t('re.draft.selectAll')}
                    checked={selected.length === drafts.length}
                    onChange={(e) => reDraftStore.setSelected(e.target.checked ? drafts.map((d) => d.id) : [])}
                  />
                </th>
                {(['bus', 'msg', 'name', 'bits', 'order', 'scale', 'unit', 'r'] as const).map((h) => (
                  <th key={h} className="pr-3 py-0.5 font-normal">
                    {h === 'bus' ? t('re.draft.bus') : t(`re.draft.col.${h}` as TranslationKey)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr key={d.id} className={`border-t border-hairline ${st.selected.has(d.id) ? 'bg-[var(--bg-row-selected)]' : ''}`}>
                  <td className="pl-3 pr-2">
                    <input type="checkbox" className={DIAG_CHECKBOX} checked={st.selected.has(d.id)} onChange={(e) => reDraftStore.toggleSelected(d.id, e.target.checked)} />
                  </td>
                  <td className="pr-3">{d.bus}</td>
                  <td className="pr-3 whitespace-nowrap">
                    0x{formatArbId(d.arbId, d.isExtended)} <span className="text-[var(--text-muted)]">{d.messageName ?? reMessageName(d.arbId, d.isExtended)}</span>
                  </td>
                  <td className="pr-3 font-semibold">{d.name}</td>
                  <td className="pr-3">@{d.startBit}+{d.bitLength}</td>
                  <td className="pr-3">{d.byteOrder === 'intel' ? 'Intel' : 'Moto'}</td>
                  <td className="pr-3 whitespace-nowrap">
                    {formatSignalValue(d.factor)} / {formatSignalValue(d.offset)}
                  </td>
                  <td className="pr-3">{d.unit}</td>
                  <td className="pr-3">{d.provenance.r === null ? '-' : d.provenance.r.toFixed(3)}</td>
                  <td className="whitespace-nowrap font-sans pr-3">
                    <button type="button" className={`${DIAG_BTN} !h-[22px] mr-1`} onClick={() => reDraftStore.openEditor(d)}>
                      {t('re.draft.edit')}
                    </button>
                    <button type="button" className={`${DIAG_BTN_DANGER} !h-[22px]`} onClick={() => setConfirmDelete([d.id])}>
                      {t('re.draft.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
