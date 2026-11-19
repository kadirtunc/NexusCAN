/**
 * R2b "Save signal" dialog: edits one `ReSignalDraftDto` (prefilled from a correlation row / candidate), validates it
 * live (debounced ~300 ms) through `cmd_re_dbc_generate([draft], null)` and shows the diagnostics inline. Generator
 * errors block saving; warnings are shown. When the backend is unreachable the draft can still be saved (it is only
 * a project record; Apply/Export re-validate).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { reDbcGenerate } from '../../services/reClient';
import { reDebugLogger } from '../../store/reDebugLog';
import { reDraftStore, useReDraftState } from '../../store/reDraftStore';
import type { ReByteOrder } from '../../types/re';
import type { ReDbcDiagnosticDto, ReSignalDraftDto, ReSignalValueType } from '../../types/reDraft';
import { DIAG_BTN, DIAG_BTN_PRIMARY, DIAG_INPUT, DIAG_SELECT } from '../diagnostics/diagUi';
import { draftFromForm, formFromDraft, lengthForValueType, type ReDraftForm, type ReDraftFormField } from './reDraftForm';
import { formatArbId } from './reModel';
import { reMessageName, sortDiagnostics } from './reDraftModel';

export const RE_DRAFT_VALIDATE_DEBOUNCE_MS = 300;

const VALUE_TYPES: readonly ReSignalValueType[] = ['unsigned', 'signed', 'float32', 'float64'];
const inputCls = `${DIAG_INPUT} !h-[26px] !px-1.5 !text-[12px] font-mono tabular-nums`;
const selCls = `${DIAG_SELECT} !h-[26px] !w-auto !px-1.5 !pr-2 !text-[12px]`;
const lbl = 'block text-[10px] uppercase tracking-wide text-[var(--text-muted)] pb-0.5';

type Validation =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; diagnostics: ReDbcDiagnosticDto[] }
  | { kind: 'unavailable'; message: string };

export function DiagnosticList({ diagnostics }: { diagnostics: readonly ReDbcDiagnosticDto[] }): React.ReactElement | null {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[11px]">
      {sortDiagnostics(diagnostics).map((d, i) => (
        <li key={`${i}:${d.code}`} className={`font-mono ${d.severity === 'error' ? 'text-critical' : 'text-warn'}`}>
          <span className="uppercase">{d.severity === 'error' ? 'ERR' : 'WARN'}</span> [{d.code}] <span className="font-sans">{d.message}</span>
        </li>
      ))}
    </ul>
  );
}

function Field(p: { label: string; children: React.ReactNode; bad?: boolean; className?: string }): React.ReactElement {
  return (
    <label className={`block ${p.className ?? ''}`}>
      <span className={`${lbl} ${p.bad === true ? '!text-critical' : ''}`}>{p.label}</span>
      {p.children}
    </label>
  );
}

export function ReSaveSignalDialog(): React.ReactElement | null {
  const st = useReDraftState();
  const base = st.editing;
  if (base === null) return null;
  // remount the form for every opened draft
  return <DialogBody key={base.id} base={base} isNew={st.editingIsNew} />;
}

function DialogBody({ base, isNew }: { base: ReSignalDraftDto; isNew: boolean }): React.ReactElement {
  const { t } = useI18n();
  const [form, setForm] = useState<ReDraftForm>(() => formFromDraft(base));
  const [val, setVal] = useState<Validation>({ kind: 'idle' });
  const seq = useRef(0);

  const parsed = useMemo(() => draftFromForm(base, form), [base, form]);
  const draft = parsed.draft;

  useEffect(() => {
    if (draft === null) {
      seq.current += 1;
      setVal({ kind: 'idle' });
      return undefined;
    }
    const mine = ++seq.current;
    setVal({ kind: 'running' });
    const timer = window.setTimeout(() => {
      reDbcGenerate([draft], null).then(
        (res) => {
          if (seq.current === mine) setVal({ kind: 'done', diagnostics: res.diagnostics });
        },
        (e: unknown) => {
          if (seq.current !== mine) return;
          const message = e instanceof Error ? e.message : String(e);
          reDebugLogger.error('re.dbc_generate', 'RE draft validation failed', e, `name=${draft.name}`);
          setVal({ kind: 'unavailable', message });
        },
      );
    }, RE_DRAFT_VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const set = <K extends keyof ReDraftForm>(k: K, v: ReDraftForm[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const close = (): void => reDraftStore.closeEditor();

  const diagnostics = val.kind === 'done' ? val.diagnostics : [];
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const canSave = draft !== null && val.kind !== 'running' && errors.length === 0;

  const commit = (): void => {
    if (!canSave || draft === null) return;
    reDraftStore.upsert(draft);
    reDraftStore.closeEditor();
  };

  const bad = (f: ReDraftFormField): boolean => parsed.invalid.includes(f);
  const prov = base.provenance;
  const provText =
    prov.r === null && prov.reference === null && prov.samples === null
      ? t('re.draft.f.provManual')
      : [
          prov.r !== null ? `r=${prov.r.toFixed(3)}` : null,
          prov.lagMs !== null ? `lag=${prov.lagMs > 0 ? '+' : ''}${Math.round(prov.lagMs)}ms` : null,
          prov.reference !== null ? `ref=${prov.reference}` : null,
          prov.samples !== null ? `n=${prov.samples}` : null,
        ]
          .filter((x): x is string => x !== null)
          .join(' ');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t(isNew ? 're.draft.dlg.titleNew' : 're.draft.dlg.titleEdit')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
      }}
    >
      <div className="w-full max-w-2xl max-h-full overflow-y-auto space-y-3 rounded-[2px] border border-strong bg-surface p-4 text-[12px]">
        <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
          {t(isNew ? 're.draft.dlg.titleNew' : 're.draft.dlg.titleEdit')}
        </h2>
        <div className="font-mono tabular-nums text-[var(--text-muted)]">
          {t('re.draft.f.target')}: bus {base.bus} 0x{formatArbId(base.arbId, base.isExtended)} {base.isExtended ? 'EXT' : 'STD'}
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Field label={t('re.draft.f.name')}>
            <input autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.messageName')}>
            <input
              value={form.messageName}
              onChange={(e) => set('messageName', e.target.value)}
              placeholder={reMessageName(base.arbId, base.isExtended)}
              title={t('re.draft.f.messageNamePh')}
              className={`${inputCls} w-full`}
            />
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-x-3 gap-y-2">
          <Field label={t('re.draft.f.byteOrder')}>
            <select value={form.byteOrder} onChange={(e) => set('byteOrder', e.target.value as ReByteOrder)} className={`${selCls} w-full`}>
              <option value="intel">Intel @1</option>
              <option value="motorola">Motorola @0</option>
            </select>
          </Field>
          <Field label={t('re.draft.f.valueType')}>
            <select
              value={form.valueType}
              onChange={(e) => {
                const vt = e.target.value as ReSignalValueType;
                setForm((f) => ({ ...f, valueType: vt, bitLength: lengthForValueType(vt, f.bitLength) }));
              }}
              className={`${selCls} w-full`}
            >
              {VALUE_TYPES.map((vt) => (
                <option key={vt} value={vt}>{vt}</option>
              ))}
            </select>
          </Field>
          <Field label={t('re.draft.f.startBit')} bad={bad('startBit')}>
            <input value={form.startBit} onChange={(e) => set('startBit', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.bitLength')} bad={bad('bitLength')}>
            <input value={form.bitLength} onChange={(e) => set('bitLength', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.factor')} bad={bad('factor')}>
            <input value={form.factor} onChange={(e) => set('factor', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.offset')} bad={bad('offset')}>
            <input value={form.offset} onChange={(e) => set('offset', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.min')} bad={bad('min')}>
            <input value={form.min} onChange={(e) => set('min', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.max')} bad={bad('max')}>
            <input value={form.max} onChange={(e) => set('max', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.unit')}>
            <input value={form.unit} onChange={(e) => set('unit', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.dlc')} bad={bad('dlcBytes')}>
            <input value={form.dlcBytes} onChange={(e) => set('dlcBytes', e.target.value)} className={`${inputCls} w-full`} />
          </Field>
          <Field label={t('re.draft.f.comment')} className="col-span-2">
            <input value={form.comment} onChange={(e) => set('comment', e.target.value)} className={`${inputCls} w-full !font-sans`} />
          </Field>
        </div>

        <div>
          <div className={`${lbl} ${bad('valueTable') ? '!text-critical' : ''}`}>{t('re.draft.f.valueTable')}</div>
          {form.valueTable.map((e, i) => (
            <div key={i} className="flex items-center gap-1.5 pb-1">
              <input
                value={e.value}
                placeholder={t('re.draft.f.valuePh')}
                onChange={(ev) => set('valueTable', form.valueTable.map((x, k) => (k === i ? { ...x, value: ev.target.value } : x)))}
                className={inputCls}
                style={{ width: 80 }}
              />
              <input
                value={e.label}
                placeholder={t('re.draft.f.labelPh')}
                onChange={(ev) => set('valueTable', form.valueTable.map((x, k) => (k === i ? { ...x, label: ev.target.value } : x)))}
                className={`${inputCls} flex-1 !font-sans`}
              />
              <button
                type="button"
                title={t('re.draft.f.removeValue')}
                onClick={() => set('valueTable', form.valueTable.filter((_, k) => k !== i))}
                className="px-1.5 text-[var(--text-muted)] cursor-pointer"
              >
                x
              </button>
            </div>
          ))}
          <button type="button" className={DIAG_BTN} onClick={() => set('valueTable', [...form.valueTable, { value: String(form.valueTable.length), label: '' }])}>
            {t('re.draft.f.addValue')}
          </button>
        </div>

        <div className="font-mono tabular-nums text-[11px] text-[var(--text-muted)]">
          {t('re.draft.f.provenance')}: {provText}
        </div>

        <div className="min-h-[40px] space-y-1 border-t border-hairline pt-2" aria-live="polite">
          {parsed.invalid.length > 0 && (
            <div className="text-[11px] text-critical">
              {t('re.draft.val.badNumber', { fields: parsed.invalid.map((f) => t(`re.draft.f.${fieldKey(f)}` as TranslationKey)).join(', ') })}
            </div>
          )}
          {val.kind === 'running' && <div className="text-[11px] text-[var(--text-muted)]">{t('re.draft.val.running')}</div>}
          {val.kind === 'unavailable' && (
            <div className="text-[11px] text-warn" title={val.message}>
              {t('re.draft.val.unavailable')}
            </div>
          )}
          {val.kind === 'done' && diagnostics.length === 0 && <div className="text-[11px] text-nominal">{t('re.draft.val.ok')}</div>}
          {errors.length > 0 && (
            <>
              <div className="text-[10px] uppercase text-critical">{t('re.draft.val.errors')}</div>
              <DiagnosticList diagnostics={errors} />
            </>
          )}
          {warnings.length > 0 && (
            <>
              <div className="text-[10px] uppercase text-warn">{t('re.draft.val.warnings')}</div>
              <DiagnosticList diagnostics={warnings} />
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className={DIAG_BTN}>
            {t('re.draft.dlg.cancel')}
          </button>
          <button type="button" disabled={!canSave} onClick={commit} className={`${DIAG_BTN_PRIMARY} disabled:opacity-40`}>
            {t('re.draft.dlg.commit')}
          </button>
        </div>
      </div>
    </div>
  );
}

function fieldKey(f: ReDraftFormField): string {
  switch (f) {
    case 'dlcBytes':
      return 'dlc';
    case 'valueTable':
      return 'valueTable';
    default:
      return f;
  }
}
