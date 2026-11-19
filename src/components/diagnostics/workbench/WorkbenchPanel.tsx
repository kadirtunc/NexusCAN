/**
 * Workbench (Phase C1): pick ECU(s), pick blocks, fill parameters, run one cell at a time, see results. Production runs
 * and their records come only from here (the Flow Editor stays the block workshop). Never auto-arms: a cell without a
 * connected session offers "Oturum Aç" (existing `openSessionFromEcu`); Listen-Only / Arm Active Bus are untouched and the
 * global Panic Stop (Ctrl+Shift+Space) reaches a running cell through the tx-source registry.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Layers, Plus, Square, Undo2, Workflow } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { EcuRecordV1, FlowBindingV1 } from '../../../types/diagWorkspace';
import type { RunRecordV1 } from '../../../types/runRecord';
import { diagWorkbenchStore, useDiagWorkbench, type WbUpdatePlan } from '../../../store/diagWorkbenchStore';
import { useDiagnosticsSelector } from '../../../store/diagnosticsStore';
import { useFlowRegistry } from '../../flow/registry/flowRegistryStore';
import { flowFiles } from '../../flow/flowFiles';
import { ModalShell } from '../../flow/ModalShell';
import type { PortFieldSpec } from '../../flow/registry/runInputFields';
import { DIAG_BTN, DIAG_BTN_DANGER, DIAG_BTN_PRIMARY, DIAG_SUBBAR, DiagEmptyState, DiagNotice } from '../diagUi';
import { EcuEmptyState } from '../workspace/EcuEmptyState';
import { diagWorkspaceStore, selectActiveVehicle, useDiagWorkspace } from '../workspace/diagWorkspaceStore';
import { BindingForm, type BindingFormResult } from './BindingForm';
import { ReviewDialog } from './ReviewDialog';
import { RunFilesDialog, wbFileKey } from './RunFilesDialog';
import { RunRecordDetail } from './RunRecordDetail';
import { WorkbenchMatrix, buildMatrixColumns, type CellSession, type MatrixHandlers } from './WorkbenchMatrix';

type FormState = { mode: 'add' | 'edit' | 'group'; initial?: FlowBindingV1; presetEcuId?: string; presetFlowId?: string };

export const WorkbenchPanel: React.FC<{
  onOpenSession: (ecu: EcuRecordV1) => void;
  onGoRegistry: () => void;
  onFindEcu: () => void;
  onSimulate: () => void;
}> = ({ onOpenSession, onGoRegistry, onFindEcu, onSimulate }) => {
  const { t } = useI18n();
  const ws = useDiagWorkspace();
  const vehicle = selectActiveVehicle(ws);
  const wb = useDiagWorkbench();
  const registry = useFlowRegistry();
  const [form, setForm] = useState<FormState | null>(null);
  const [runDialog, setRunDialog] = useState<{ binding: FlowBindingV1; ecu: EcuRecordV1; specs: PortFieldSpec[] } | null>(null);
  const [detail, setDetail] = useState<RunRecordV1 | null>(null);
  const [plan, setPlan] = useState<WbUpdatePlan | null>(null);
  const [removing, setRemoving] = useState<FlowBindingV1 | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void diagWorkbenchStore.refreshBindable();
  }, [registry.entries]);
  useEffect(() => {
    void diagWorkbenchStore.loadLatest();
  }, [vehicle?.id]);

  // Pinned revisions of the vehicle's bindings are loaded for the cells (interface -> resolution status).
  const refsKey = vehicle ? [...new Set(vehicle.bindings.map((b) => `${b.flowRef.flowId}@${b.flowRef.revision}`))].join(',') : '';
  useEffect(() => {
    if (!vehicle) return;
    for (const b of vehicle.bindings) void diagWorkbenchStore.ensureIface(b.flowRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey]);

  const sessionKey = useDiagnosticsSelector((st) => `${st.mockMode ? 'D' : 'R'}|${st.tabs.map((tab) => `${tab.ecuId ?? ''}:${tab.session.connected ? 1 : 0}`).join(',')}`);
  const sessionOf = useMemo(() => {
    const [mode, rest] = sessionKey.split('|');
    const map = new Map<string, CellSession>();
    for (const part of rest.split(',')) {
      const [id, conn] = part.split(':');
      if (id === '' || id === undefined) continue;
      const cur = map.get(id);
      map.set(id, conn === '1' && mode === 'R' ? 'connected' : cur === 'connected' ? 'connected' : 'not_connected');
    }
    return (ecuId: string): CellSession => map.get(ecuId) ?? 'no_tab';
  }, [sessionKey]);

  if (!vehicle || vehicle.ecus.length === 0) {
    return <EcuEmptyState onAddEcu={onGoRegistry} onFindEcu={onFindEcu} onSimulate={onSimulate} />;
  }

  const latestByFlow = new Map(registry.entries.filter((e) => !e.deleted).map((e) => [e.id, e.latestRevision] as const));
  const columns = buildMatrixColumns(vehicle, latestByFlow);
  const groupsWithMembers = vehicle.groups.filter((g) => vehicle.ecus.some((e) => e.groupId === g.id));
  const hasBindable = wb.bindable.length > 0;

  const closeForm = (): void => setForm(null);
  const saveForm = (r: BindingFormResult): void => {
    const fileExpect = Object.keys(r.fileExpect).length > 0 ? r.fileExpect : undefined;
    if (form?.mode === 'edit' && form.initial) {
      diagWorkspaceStore.updateBinding(vehicle.id, { ...form.initial, flowRef: r.flowRef, label: r.label, params: r.params, fileExpect });
    } else {
      const fresh = r.ecuIds.filter((id) => !vehicle.bindings.some((b) => b.ecuId === id && b.flowRef.flowId === r.flowRef.flowId));
      const skipped = r.ecuIds.length - fresh.length;
      if (fresh.length > 0) {
        diagWorkspaceStore.addBindings(vehicle.id, fresh.map((ecuId) => ({ ecuId, flowRef: r.flowRef, label: r.label, params: { ...r.params }, ...(fileExpect ? { fileExpect: { ...fileExpect } } : {}) })));
      }
      setNote(skipped > 0 ? t('workbench.form.skipped', { n: skipped }) : null);
    }
    closeForm();
  };

  const startRun = (binding: FlowBindingV1, ecu: EcuRecordV1, files: Record<string, { name: string; bytes: Uint8Array }>): void => {
    void diagWorkbenchStore.run(binding, ecu, files);
  };

  const handlers: MatrixHandlers = {
    onRun: (binding, ecu) => {
      const info = diagWorkbenchStore.getIface(binding.flowRef);
      const specs: PortFieldSpec[] = (info?.iface.inputs ?? []).filter((s) => s.type === 'file');
      if (specs.length > 0) setRunDialog({ binding, ecu, specs });
      else startRun(binding, ecu, {});
    },
    onStop: () => diagWorkbenchStore.stop(),
    onBind: (ecu, flowId) => setForm({ mode: 'add', presetEcuId: ecu.id, presetFlowId: flowId }),
    onEdit: (binding) => setForm({ mode: 'edit', initial: binding }),
    onRemove: (binding) => setRemoving(binding),
    onDetail: setDetail,
    onOpenSession,
    onUpdate: (flowId, latest) => {
      void diagWorkbenchStore.planUpdate(vehicle.id, flowId, latest).then(setPlan);
    },
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      <div className={`${DIAG_SUBBAR} h-10 gap-2`}>
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">{t('workbench.title')}</span>
        <span className="font-mono text-[11.5px] text-muted">{vehicle.name}</span>
        <div className="flex-1" />
        {wb.undo && (
          <button type="button" className={DIAG_BTN} onClick={() => diagWorkbenchStore.undoUpdate()} title={t('workbench.bind.updated', { n: wb.undo.count })}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('workbench.bind.undo')}
          </button>
        )}
        {wb.active !== null && (
          <button type="button" className={DIAG_BTN_DANGER} onClick={() => diagWorkbenchStore.stop()}>
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
            {t('workbench.stopRun')}
          </button>
        )}
        <span className="hidden font-mono text-[11px] text-subtle xl:inline">{t('workbench.panicHint')}</span>
        <button type="button" className={DIAG_BTN} disabled={!hasBindable} onClick={() => setForm({ mode: 'add' })}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('workbench.bind.add')}
        </button>
        <button type="button" className={DIAG_BTN} disabled={!hasBindable || groupsWithMembers.length === 0} onClick={() => setForm({ mode: 'group' })}>
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          {t('workbench.bind.group')}
        </button>
      </div>

      {(wb.banner || note) && (
        <div className="flex shrink-0 flex-col gap-1 border-b border-hairline bg-canvas px-3 py-1.5">
          {wb.banner && (
            <DiagNotice tone={wb.banner.tone}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-words">{wb.banner.message}</span>
                <button type="button" className="shrink-0 cursor-pointer font-mono text-[11px] uppercase underline" onClick={() => diagWorkbenchStore.setBanner(null)}>
                  {t('workbench.dismiss')}
                </button>
              </div>
            </DiagNotice>
          )}
          {note && <DiagNotice tone="warn">{note}</DiagNotice>}
        </div>
      )}

      {vehicle.bindings.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {hasBindable ? (
            <DiagEmptyState icon={<Workflow className="h-7 w-7 text-muted" aria-hidden="true" />} title={t('workbench.empty.noBindings')} hint={t('workbench.empty.noBindingsHint')} />
          ) : (
            <DiagEmptyState icon={<Workflow className="h-7 w-7 text-muted" aria-hidden="true" />} title={t('workbench.empty.noBlock')} hint={t('workbench.empty.noBlockHint')} />
          )}
        </div>
      ) : (
        <WorkbenchMatrix vehicle={vehicle} columns={columns} wb={wb} sessionOf={sessionOf} handlers={handlers} />
      )}

      {form && (
        <BindingForm
          mode={form.mode}
          blocks={wb.bindable}
          ecus={vehicle.ecus}
          groups={groupsWithMembers}
          bindings={vehicle.bindings}
          initial={form.initial}
          presetEcuId={form.presetEcuId}
          presetFlowId={form.presetFlowId}
          onSave={saveForm}
          onCancel={closeForm}
        />
      )}

      {runDialog && (
        <RunFilesDialog
          binding={runDialog.binding}
          ecu={runDialog.ecu}
          fileSpecs={runDialog.specs}
          onCancel={() => setRunDialog(null)}
          onRun={(files) => {
            const { binding, ecu, specs } = runDialog;
            setRunDialog(null);
            startRun(binding, ecu, files);
            // Firmware bytes are asked for again on every run (never kept between runs).
            for (const s of specs) flowFiles.clear(wbFileKey(binding.id, s.key));
          }}
        />
      )}

      {wb.review && <ReviewDialog request={wb.review} onAnswer={(ok) => diagWorkbenchStore.answerReview(ok)} />}
      {detail && <RunRecordDetail record={detail} onClose={() => setDetail(null)} />}

      {removing && (
        <ModalShell title={t('workbench.cell.remove')} onClose={() => setRemoving(null)} width={420}>
          <div className="p-3.5 text-[12.5px] text-ink">
            {removing.label ?? diagWorkbenchStore.getIface(removing.flowRef)?.name ?? removing.flowRef.flowId} · {diagWorkspaceStore.findEcu(removing.ecuId)?.ecu.name ?? ''}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-hairline p-3">
            <button type="button" className={DIAG_BTN} onClick={() => setRemoving(null)}>{t('workbench.form.cancel')}</button>
            <button
              type="button"
              className={DIAG_BTN_DANGER}
              onClick={() => {
                diagWorkspaceStore.removeBinding(vehicle.id, removing.id);
                setRemoving(null);
              }}
            >
              {t('workbench.cell.remove')}
            </button>
          </div>
        </ModalShell>
      )}

      {plan && (
        <ModalShell title={t('workbench.update.title')} onClose={() => setPlan(null)} width={560}>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3.5">
            <div className="font-mono text-[12px] tabular-nums text-ink">{t('workbench.update.intro', { name: plan.name, from: plan.fromRevision, to: plan.toRevision })}</div>
            {plan.entries.every((e) => e.result.dropped.length === 0 && e.result.newlyMissing.length === 0) && (
              <div className="text-[12px] text-muted">{t('workbench.update.clean')}</div>
            )}
            {plan.entries.map((e) => (
              <div key={e.before.id} className="border border-hairline bg-canvas px-2 py-1 font-mono text-[11.5px] tabular-nums">
                <div className="text-ink">{diagWorkspaceStore.findEcu(e.before.ecuId)?.ecu.name ?? e.before.ecuId} · r{e.before.flowRef.revision} → r{plan.toRevision}</div>
                {e.result.dropped.length > 0 && <div className="text-warn">{t('workbench.update.dropped', { keys: e.result.dropped.join(', ') })}</div>}
                {e.result.newlyMissing.length > 0 && <div className="text-warn">{t('workbench.update.missing', { keys: e.result.newlyMissing.join(', ') })}</div>}
              </div>
            ))}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-hairline p-3">
            <button type="button" className={DIAG_BTN} onClick={() => setPlan(null)}>{t('workbench.form.cancel')}</button>
            <button
              type="button"
              className={DIAG_BTN_PRIMARY}
              onClick={() => {
                diagWorkbenchStore.applyUpdate(plan);
                setPlan(null);
              }}
            >
              {t('workbench.update.apply', { n: plan.entries.length })}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
};
