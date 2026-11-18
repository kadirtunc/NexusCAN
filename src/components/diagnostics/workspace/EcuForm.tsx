/**
 * ECU record form. Edits a DRAFT copy; nothing reaches the store until Save (disabled while invalid).
 * Sections: General, Addressing, Timing, Security, Routines, Flash, Identification, DIDs, Variables.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Save, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { apiSeedKeyListProfiles } from '../../../services/ipcClient';
import { useConnectionStore } from '../../../store/connectionStore';
import {
  DIAG_PROTOCOLS,
  ECU_ROUTINE_KEYS,
  OPERABLE_PROTOCOLS,
  type DiagVehicleV1,
  type EcuDidFormat,
  type EcuRecordV1,
} from '../../../types/diagWorkspace';
import { ADDRESS_FORMATS, type AddressFormat } from '../../../types/udsClient';
import { DIAG_BTN, DIAG_BTN_PRIMARY, DIAG_BTN_SM, DIAG_CHECKBOX, DIAG_INPUT, DIAG_TOOLBAR, DiagNotice } from '../diagUi';
import { usesTargetByte } from '../addressing';
import { cloneRecord } from './ecuDefaults';
import { issueFor, validateEcu, type EcuIssue } from './ecuValidation';
import { ERR_TEXT, Field, Grid, HexNumInput, IntInput, ListEditor, SelectInput, Section, TextInput } from './formParts';


const DID_FORMATS: readonly EcuDidFormat[] = ['ascii', 'hex', 'uint', 'int', 'bcd'];
const ROUTINE_LABEL_KEYS = {
  erase: 'diagWs.routine.erase',
  checkIntegrity: 'diagWs.routine.checkIntegrity',
  checkDependencies: 'diagWs.routine.checkDependencies',
  checkPreconditions: 'diagWs.routine.checkPreconditions',
} as const;

interface Props {
  initial: EcuRecordV1;
  isNew: boolean;
  vehicle: DiagVehicleV1;
  onSave: (draft: EcuRecordV1) => void;
  onCancel: () => void;
}

interface SeedProfileOption {
  id: string;
  name: string;
}

export const EcuForm: React.FC<Props> = ({ initial, isNew, vehicle, onSave, onCancel }) => {
  const { t } = useI18n();
  const connections = useConnectionStore();
  const [draft, setDraft] = useState<EcuRecordV1>(() => cloneRecord(initial));
  const [profiles, setProfiles] = useState<SeedProfileOption[] | null>(null);
  const [profilesFailed, setProfilesFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    apiSeedKeyListProfiles().then(
      (list) => {
        if (alive) setProfiles(list.map((p) => ({ id: p.id, name: p.name })));
      },
      () => {
        if (alive) setProfilesFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const groupIds = useMemo(() => new Set(vehicle.groups.map((g) => g.id)), [vehicle.groups]);
  const issues: EcuIssue[] = useMemo(
    () => validateEcu(draft, { others: vehicle.ecus, groupIds }, t),
    [draft, vehicle.ecus, groupIds, t],
  );
  const err = (field: string): string | null => issueFor(issues, field)?.message ?? null;
  const bad = (field: string): boolean => issueFor(issues, field) !== undefined;

  const set = (fn: (d: EcuRecordV1) => EcuRecordV1): void => setDraft((d) => fn(d));
  const setAddr = (patch: Partial<EcuRecordV1['addressing']>): void => set((d) => ({ ...d, addressing: { ...d.addressing, ...patch } }));
  const setFlash = (patch: Partial<EcuRecordV1['flash']>): void => set((d) => ({ ...d, flash: { ...d.flash, ...patch } }));
  const setIdent = (patch: Partial<EcuRecordV1['identification']>): void => set((d) => ({ ...d, identification: { ...d.identification, ...patch } }));
  const a = draft.addressing;
  const removeLabel = t('diagWs.form.remove');
  const profileMissing =
    draft.connectionProfileId !== null && !connections.profiles.some((p) => p.id === draft.connectionProfileId);
  const seedMissing =
    draft.security.seedKeyProfileId !== null && profiles !== null && !profiles.some((p) => p.id === draft.security.seedKeyProfileId);
  const wellKnownMissing = ECU_ROUTINE_KEYS.filter((k) => !draft.routines.some((r) => r.key === k));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className={DIAG_TOOLBAR}>
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          {isNew ? t('diagWs.form.titleNew') : t('diagWs.form.titleEdit', { name: initial.name })}
        </h2>
        <div className="flex-1" />
        {issues.length > 0 && (
          <span className="font-mono text-[11.5px] tabular-nums text-[color:var(--status-critical)]">
            {t('diagWs.form.issueCount', { count: issues.length })}
          </span>
        )}
        <button type="button" onClick={onCancel} className={DIAG_BTN}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagWs.form.cancel')}
        </button>
        <button
          type="button"
          disabled={issues.length > 0}
          onClick={() => onSave(draft)}
          title={issues.length > 0 ? t('diagWs.form.saveBlocked') : undefined}
          className={DIAG_BTN_PRIMARY}
        >
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagWs.form.save')}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
        {/* ── General ── */}
        <Section title={t('diagWs.sec.general')}>
          <Grid cols={2}>
            <Field label={t('diagWs.f.name')} error={err('name')}>
              <TextInput value={draft.name} onChange={(v) => set((d) => ({ ...d, name: v }))} invalid={bad('name')} ariaLabel={t('diagWs.f.name')} />
            </Field>
            <Field label={t('diagWs.f.group')} error={err('groupId')}>
              <SelectInput value={draft.groupId ?? ''} onChange={(v) => set((d) => ({ ...d, groupId: v === '' ? null : v }))} ariaLabel={t('diagWs.f.group')}>
                <option value="">{t('diagWs.ungrouped')}</option>
                {vehicle.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={t('diagWs.f.protocol')}>
              <SelectInput value={draft.protocol} onChange={(v) => set((d) => ({ ...d, protocol: DIAG_PROTOCOLS.find((p) => p === v) ?? d.protocol }))} ariaLabel={t('diagWs.f.protocol')}>
                {DIAG_PROTOCOLS.map((p) => {
                  const operable = OPERABLE_PROTOCOLS.includes(p);
                  return (
                    <option key={p} value={p} disabled={!operable && p !== draft.protocol}>
                      {operable ? t(`diagWs.protocol.${p}`) : `${t(`diagWs.protocol.${p}`)} - ${t('diagWs.protocol.unsupported')}`}
                    </option>
                  );
                })}
              </SelectInput>
            </Field>
            <Field label={t('diagWs.f.connection')} hint={t('diagWs.f.connectionHint')}>
              <SelectInput
                value={draft.connectionProfileId ?? ''}
                onChange={(v) => set((d) => ({ ...d, connectionProfileId: v === '' ? null : v }))}
                ariaLabel={t('diagWs.f.connection')}
              >
                <option value="">{t('diagWs.f.connectionAtRun')}</option>
                {profileMissing && draft.connectionProfileId !== null && (
                  <option value={draft.connectionProfileId}>{t('diagWs.f.connectionMissing')}</option>
                )}
                {connections.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </Grid>
          {!OPERABLE_PROTOCOLS.includes(draft.protocol) && <DiagNotice tone="warn">{t('diagWs.protocol.reservedNote')}</DiagNotice>}
          <Field label={t('diagWs.f.notes')}>
            <textarea
              value={draft.notes}
              onChange={(e) => set((d) => ({ ...d, notes: e.target.value }))}
              rows={2}
              className={`${DIAG_INPUT} h-auto py-1.5 font-sans`}
            />
          </Field>
        </Section>

        {/* ── Addressing ── */}
        <Section title={t('diagWs.sec.addressing')}>
          <Grid cols={3}>
            <Field label={t('diagWs.f.requestId')} error={err('addressing.requestId')}>
              <HexNumInput value={a.requestId} digits={a.isExtendedId ? 8 : 3} onChange={(v) => setAddr({ requestId: v ?? Number.NaN })} invalid={bad('addressing.requestId')} ariaLabel={t('diagWs.f.requestId')} />
            </Field>
            <Field label={t('diagWs.f.responseId')} error={err('addressing.responseId')}>
              <HexNumInput value={a.responseId} digits={a.isExtendedId ? 8 : 3} onChange={(v) => setAddr({ responseId: v ?? Number.NaN })} invalid={bad('addressing.responseId')} ariaLabel={t('diagWs.f.responseId')} />
            </Field>
            <Field label={t('diagWs.f.functionalId')} error={err('addressing.functionalId')} hint={t('diagWs.f.functionalHint')}>
              <HexNumInput value={a.functionalId} digits={a.isExtendedId ? 8 : 3} nullable onChange={(v) => setAddr({ functionalId: v })} invalid={bad('addressing.functionalId')} ariaLabel={t('diagWs.f.functionalId')} />
            </Field>
            <Field label={t('diagWs.f.addressFormat')} error={err('addressing.isExtendedId')}>
              <SelectInput
                value={a.addressFormat}
                onChange={(v) => {
                  const fmt = ADDRESS_FORMATS.find((f): f is AddressFormat => f === v) ?? a.addressFormat;
                  setAddr(usesTargetByte(fmt) ? { addressFormat: fmt } : { addressFormat: fmt, targetAddress: null, responseAddress: null });
                }}
                ariaLabel={t('diagWs.f.addressFormat')}
              >
                {ADDRESS_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`diagWs.addrFormat.${f}`)}
                  </option>
                ))}
              </SelectInput>
            </Field>
            {usesTargetByte(a.addressFormat) && (
              <>
                <Field label={t('diagWs.f.targetAddress')} error={err('addressing.targetAddress')}>
                  <HexNumInput value={a.targetAddress} nullable onChange={(v) => setAddr({ targetAddress: v })} invalid={bad('addressing.targetAddress')} ariaLabel={t('diagWs.f.targetAddress')} />
                </Field>
                <Field label={t('diagWs.f.responseAddress')} error={err('addressing.responseAddress')}>
                  <HexNumInput value={a.responseAddress} nullable onChange={(v) => setAddr({ responseAddress: v })} invalid={bad('addressing.responseAddress')} ariaLabel={t('diagWs.f.responseAddress')} />
                </Field>
              </>
            )}
          </Grid>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
              <input type="checkbox" checked={a.isExtendedId} onChange={(e) => setAddr({ isExtendedId: e.target.checked })} className={DIAG_CHECKBOX} />
              {t('diagWs.f.extended')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
              <input type="checkbox" checked={a.useFd} onChange={(e) => setAddr({ useFd: e.target.checked })} className={DIAG_CHECKBOX} />
              {t('diagWs.f.useFd')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
              <input type="checkbox" checked={a.padding !== null} onChange={(e) => setAddr({ padding: e.target.checked ? 0xaa : null })} className={DIAG_CHECKBOX} />
              {t('diagWs.f.padding')}
            </label>
            {a.padding !== null && (
              <div className="w-20">
                <HexNumInput value={a.padding} onChange={(v) => setAddr({ padding: v ?? Number.NaN })} invalid={bad('addressing.padding')} ariaLabel={t('diagWs.f.paddingByte')} />
              </div>
            )}
          </div>
          {err('addressing.padding') && <span className={ERR_TEXT}>{err('addressing.padding')}</span>}
        </Section>

        {/* ── Timing ── */}
        <Section title={t('diagWs.sec.timing')}>
          <Grid cols={2}>
            <Field label={t('diagWs.f.p2Margin')} error={err('timing.p2MarginMs')}>
              <IntInput value={draft.timing.p2MarginMs} onChange={(v) => set((d) => ({ ...d, timing: { ...d.timing, p2MarginMs: v ?? Number.NaN } }))} invalid={bad('timing.p2MarginMs')} ariaLabel={t('diagWs.f.p2Margin')} />
            </Field>
            <Field label={t('diagWs.f.keepalive')} error={err('timing.keepaliveIntervalMs')}>
              <IntInput value={draft.timing.keepaliveIntervalMs} onChange={(v) => set((d) => ({ ...d, timing: { ...d.timing, keepaliveIntervalMs: v ?? Number.NaN } }))} invalid={bad('timing.keepaliveIntervalMs')} ariaLabel={t('diagWs.f.keepalive')} />
            </Field>
          </Grid>
        </Section>

        {/* ── Security ── */}
        <Section title={t('diagWs.sec.security')}>
          <Field label={t('diagWs.f.seedKeyProfile')} hint={t('diagWs.f.seedKeyHint')}>
            <SelectInput
              value={draft.security.seedKeyProfileId ?? ''}
              onChange={(v) => set((d) => ({ ...d, security: { ...d.security, seedKeyProfileId: v === '' ? null : v } }))}
              ariaLabel={t('diagWs.f.seedKeyProfile')}
            >
              <option value="">{t('diagWs.f.seedKeyNone')}</option>
              {seedMissing && draft.security.seedKeyProfileId !== null && (
                <option value={draft.security.seedKeyProfileId}>{t('diagWs.f.seedKeyMissing')}</option>
              )}
              {draft.security.seedKeyProfileId !== null && profiles === null && (
                <option value={draft.security.seedKeyProfileId}>{draft.security.seedKeyProfileId}</option>
              )}
              {(profiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          {profilesFailed && <DiagNotice tone="warn">{t('diagWs.f.seedKeyUnavailable')}</DiagNotice>}
          <ListEditor
            prefix="security.levels"
            items={draft.security.levels}
            onChange={(levels) => set((d) => ({ ...d, security: { ...d.security, levels } }))}
            makeItem={() => ({ key: '', label: '', level: 0x01 })}
            issues={issues}
            addLabel={t('diagWs.form.addLevel')}
            removeLabel={removeLabel}
            emptyLabel={t('diagWs.form.noLevels')}
            columns={[
              { header: t('diagWs.col.key'), width: 'w-40', render: (it, _i, up, badF) => <TextInput value={it.key} onChange={(v) => up({ key: v })} invalid={badF.has('key')} maxLength={32} ariaLabel={t('diagWs.col.key')} /> },
              { header: t('diagWs.col.label'), width: 'flex-1', render: (it, _i, up) => <TextInput value={it.label} onChange={(v) => up({ label: v })} ariaLabel={t('diagWs.col.label')} /> },
              { header: t('diagWs.col.level'), width: 'w-20', render: (it, _i, up, badF) => <HexNumInput value={it.level} onChange={(v) => up({ level: v ?? Number.NaN })} invalid={badF.has('level')} ariaLabel={t('diagWs.col.level')} /> },
            ]}
          />
        </Section>

        {/* ── Routines ── */}
        <Section title={t('diagWs.sec.routines')}>
          {wellKnownMissing.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-subtle">{t('diagWs.form.suggested')}</span>
              {wellKnownMissing.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={DIAG_BTN_SM}
                  onClick={() => set((d) => ({ ...d, routines: [...d.routines, { key: k, label: t(ROUTINE_LABEL_KEYS[k]), rid: 'FF00' }] }))}
                >
                  + {k}
                </button>
              ))}
            </div>
          )}
          <ListEditor
            prefix="routines"
            items={draft.routines}
            onChange={(routines) => set((d) => ({ ...d, routines }))}
            makeItem={() => ({ key: '', label: '', rid: 'FF00' })}
            issues={issues}
            addLabel={t('diagWs.form.addRoutine')}
            removeLabel={removeLabel}
            emptyLabel={t('diagWs.form.noRoutines')}
            columns={[
              { header: t('diagWs.col.key'), width: 'w-44', render: (it, _i, up, badF) => <TextInput value={it.key} onChange={(v) => up({ key: v })} invalid={badF.has('key')} maxLength={32} ariaLabel={t('diagWs.col.key')} /> },
              { header: t('diagWs.col.label'), width: 'flex-1', render: (it, _i, up) => <TextInput value={it.label} onChange={(v) => up({ label: v })} ariaLabel={t('diagWs.col.label')} /> },
              { header: 'RID', width: 'w-24', render: (it, _i, up, badF) => <TextInput value={it.rid} onChange={(v) => up({ rid: v.toUpperCase() })} invalid={badF.has('rid')} maxLength={4} mono ariaLabel="RID" /> },
            ]}
          />
        </Section>

        {/* ── Flash ── */}
        <Section title={t('diagWs.sec.flash')}>
          <Grid cols={4}>
            <Field label="ALFID" error={err('flash.alfid')}>
              <HexNumInput value={draft.flash.alfid} onChange={(v) => setFlash({ alfid: v ?? Number.NaN })} invalid={bad('flash.alfid')} ariaLabel="ALFID" />
            </Field>
            <Field label="DFI" error={err('flash.dfi')}>
              <HexNumInput value={draft.flash.dfi} onChange={(v) => setFlash({ dfi: v ?? Number.NaN })} invalid={bad('flash.dfi')} ariaLabel="DFI" />
            </Field>
            <Field label={t('diagWs.f.eraseAlfid')} error={err('flash.eraseAlfid')}>
              <HexNumInput value={draft.flash.eraseAlfid} onChange={(v) => setFlash({ eraseAlfid: v ?? Number.NaN })} invalid={bad('flash.eraseAlfid')} ariaLabel={t('diagWs.f.eraseAlfid')} />
            </Field>
            <Field label={t('diagWs.f.maxBlockLen')} error={err('flash.maxBlockLenOverride')} hint={t('diagWs.f.maxBlockLenHint')}>
              <IntInput value={draft.flash.maxBlockLenOverride} nullable onChange={(v) => setFlash({ maxBlockLenOverride: v })} invalid={bad('flash.maxBlockLenOverride')} ariaLabel={t('diagWs.f.maxBlockLen')} />
            </Field>
          </Grid>
          <ListEditor
            prefix="flash.memoryRegions"
            items={draft.flash.memoryRegions}
            onChange={(memoryRegions) => setFlash({ memoryRegions })}
            makeItem={() => ({ key: '', label: '', start: 0, length: 0x1000 })}
            issues={issues}
            addLabel={t('diagWs.form.addRegion')}
            removeLabel={removeLabel}
            emptyLabel={t('diagWs.form.noRegions')}
            columns={[
              { header: t('diagWs.col.key'), width: 'w-36', render: (it, _i, up, badF) => <TextInput value={it.key} onChange={(v) => up({ key: v })} invalid={badF.has('key')} maxLength={32} ariaLabel={t('diagWs.col.key')} /> },
              { header: t('diagWs.col.label'), width: 'flex-1', render: (it, _i, up) => <TextInput value={it.label} onChange={(v) => up({ label: v })} ariaLabel={t('diagWs.col.label')} /> },
              { header: t('diagWs.col.start'), width: 'w-28', render: (it, _i, up, badF) => <HexNumInput value={it.start} digits={8} onChange={(v) => up({ start: v ?? Number.NaN })} invalid={badF.has('start')} ariaLabel={t('diagWs.col.start')} /> },
              { header: t('diagWs.col.length'), width: 'w-28', render: (it, _i, up, badF) => <HexNumInput value={it.length} digits={8} onChange={(v) => up({ length: v ?? Number.NaN })} invalid={badF.has('length')} ariaLabel={t('diagWs.col.length')} /> },
            ]}
          />
        </Section>

        {/* ── Identification ── */}
        <Section title={t('diagWs.sec.ident')}>
          <Grid cols={2}>
            <Field label={t('diagWs.f.expectedHw')}>
              <TextInput value={draft.identification.expectedHw ?? ''} onChange={(v) => setIdent({ expectedHw: v === '' ? null : v })} ariaLabel={t('diagWs.f.expectedHw')} />
            </Field>
            <Field label={t('diagWs.f.expectedSpare')}>
              <TextInput value={draft.identification.expectedSparePart ?? ''} onChange={(v) => setIdent({ expectedSparePart: v === '' ? null : v })} ariaLabel={t('diagWs.f.expectedSpare')} />
            </Field>
          </Grid>
          <Grid cols={4}>
            {(
              [
                ['vinDid', 'diagWs.f.vinDid'],
                ['swDid', 'diagWs.f.swDid'],
                ['hwDid', 'diagWs.f.hwDid'],
                ['sparePartDid', 'diagWs.f.sparePartDid'],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={t(label)} error={err(`identification.${k}`)}>
                <TextInput value={draft.identification[k]} onChange={(v) => setIdent({ [k]: v.toUpperCase() })} invalid={bad(`identification.${k}`)} maxLength={4} mono ariaLabel={t(label)} />
              </Field>
            ))}
          </Grid>
        </Section>

        {/* ── DIDs ── */}
        <Section title={t('diagWs.sec.dids')}>
          <ListEditor
            prefix="dids"
            items={draft.dids}
            onChange={(dids) => set((d) => ({ ...d, dids }))}
            makeItem={() => ({ did: 'F190', name: '', format: 'hex' as EcuDidFormat })}
            issues={issues}
            addLabel={t('diagWs.form.addDid')}
            removeLabel={removeLabel}
            emptyLabel={t('diagWs.form.noDids')}
            columns={[
              { header: 'DID', width: 'w-24', render: (it, _i, up, badF) => <TextInput value={it.did} onChange={(v) => up({ did: v.toUpperCase() })} invalid={badF.has('did')} maxLength={4} mono ariaLabel="DID" /> },
              { header: t('diagWs.col.name'), width: 'flex-1', render: (it, _i, up) => <TextInput value={it.name} onChange={(v) => up({ name: v })} ariaLabel={t('diagWs.col.name')} /> },
              {
                header: t('diagWs.col.format'),
                width: 'w-28',
                render: (it, _i, up) => (
                  <SelectInput value={it.format} onChange={(v) => up({ format: DID_FORMATS.find((f) => f === v) ?? it.format })} ariaLabel={t('diagWs.col.format')}>
                    {DID_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </SelectInput>
                ),
              },
            ]}
          />
        </Section>

        {/* ── Variables ── */}
        <Section title={t('diagWs.sec.vars')}>
          <ListEditor
            prefix="vars"
            items={draft.vars}
            onChange={(vars) => set((d) => ({ ...d, vars }))}
            makeItem={() => ({ key: '', value: '' })}
            issues={issues}
            addLabel={t('diagWs.form.addVar')}
            removeLabel={removeLabel}
            emptyLabel={t('diagWs.form.noVars')}
            columns={[
              { header: t('diagWs.col.key'), width: 'w-44', render: (it, _i, up, badF) => <TextInput value={it.key} onChange={(v) => up({ key: v })} invalid={badF.has('key')} maxLength={32} ariaLabel={t('diagWs.col.key')} /> },
              { header: t('diagWs.col.value'), width: 'flex-1', render: (it, _i, up) => <TextInput value={it.value} onChange={(v) => up({ value: v })} maxLength={512} ariaLabel={t('diagWs.col.value')} /> },
            ]}
          />
        </Section>
      </div>
    </div>
  );
};
