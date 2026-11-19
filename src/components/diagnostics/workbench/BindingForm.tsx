/**
 * Binding form (workbench-v1 §4): generated from the block's derived interface through `buildBindingForm`, using the
 * shared run-input field components. Params accept a literal or a whole `{ecu.<path>}` reference (resolved per row ECU).
 * `file` inputs store only the EXPECTED file name + CRC-32 (never bytes). Required inputs without value are allowed:
 * the binding is saved and its cell shows "incomplete".
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import type { EcuGroupV1, EcuRecordV1, FileExpectV1, FlowBindingParamValue, FlowBindingV1, FlowRefV1 } from '../../../types/diagWorkspace';
import { diagWorkbenchStore, useDiagWorkbench, type WbBindableBlock } from '../../../store/diagWorkbenchStore';
import { DIAG_BTN, DIAG_BTN_PRIMARY } from '../diagUi';
import { ModalShell } from '../../flow/ModalShell';
import { PortFieldFrame, PortScalarInput, RUN_FIELD, initialPortValue, type PortFieldSpec } from '../../flow/registry/runInputFields';
import { FILE_EXPECT_CRC_RE } from '../workspace/ecuValidation';
import { buildBindingForm, crc32Hex, resolveBindingParams, type WbFormField } from './workbenchModel';

export interface BindingFormResult {
  ecuIds: string[];
  flowRef: FlowRefV1;
  label: string | null;
  params: Record<string, FlowBindingParamValue>;
  fileExpect: Record<string, FileExpectV1>;
}

export interface BindingFormProps {
  mode: 'add' | 'edit' | 'group';
  blocks: WbBindableBlock[];
  ecus: EcuRecordV1[];
  groups: EcuGroupV1[];
  /** Existing bindings of the vehicle (duplicate (ECU, block) detection in add mode). */
  bindings: FlowBindingV1[];
  /** Edit mode: the binding. Add / group: optional presets. */
  initial?: FlowBindingV1;
  presetEcuId?: string;
  presetFlowId?: string;
  onSave: (r: BindingFormResult) => void;
  onCancel: () => void;
}

const NO_GROUP = '__none__';
const DEC_RE = /^[+-]?\d+(\.\d+)?$/;

/** Structural field spec for the shared components. */
function toSpec(f: WbFormField): PortFieldSpec {
  return {
    key: f.key, label: f.label, type: f.kind, required: f.required, order: f.order, description: f.description, unit: f.unit,
    min: f.min, max: f.max, byteLength: f.byteLength, options: f.options?.map((o) => o.value), accept: f.accept,
  };
}

export const BindingForm: React.FC<BindingFormProps> = ({ mode, blocks, ecus, groups, bindings, initial, presetEcuId, presetFlowId, onSave, onCancel }) => {
  const { t } = useI18n();
  useDiagWorkbench();
  const sortedEcus = useMemo(() => [...ecus].sort((a, b) => a.name.localeCompare(b.name)), [ecus]);
  const [flowId, setFlowId] = useState<string>(initial?.flowRef.flowId ?? presetFlowId ?? blocks[0]?.flowId ?? '');
  const [ecuId, setEcuId] = useState<string>(initial?.ecuId ?? presetEcuId ?? sortedEcus[0]?.id ?? '');
  const [groupId, setGroupId] = useState<string>(groups[0]?.id ?? NO_GROUP);
  const [label, setLabel] = useState<string>(initial?.label ?? '');

  const block = blocks.find((b) => b.flowId === flowId);
  // Edit keeps the pinned revision; add / group pin the library latest.
  const flowRef: FlowRefV1 | null = initial ? initial.flowRef : block ? { flowId: block.flowId, revision: block.latestRevision } : null;
  const refKeyStr = flowRef ? `${flowRef.flowId}@${flowRef.revision}` : '';
  useEffect(() => {
    if (flowRef) void diagWorkbenchStore.ensureIface(flowRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKeyStr]);
  const info = flowRef ? diagWorkbenchStore.getIface(flowRef) : undefined;
  const fields = useMemo(() => (info ? buildBindingForm(info.iface) : []), [info]);

  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [fileExpect, setFileExpect] = useState<Record<string, FileExpectV1 | { fileName: string; crc32: string }>>({});
  const [seeded, setSeeded] = useState<string>('');

  // Seed the field values once per (block, revision) from the binding (edit) or the interface defaults (add / group).
  useEffect(() => {
    if (!info || seeded === refKeyStr) return;
    const v: Record<string, string | boolean> = {};
    for (const f of fields) {
      if (f.kind === 'file') continue;
      const stored = initial?.params[f.key];
      if (stored !== undefined) v[f.key] = typeof stored === 'boolean' ? stored : String(stored);
      else if (f.kind === 'bool' || f.kind === 'select') v[f.key] = initialPortValue({ ...toSpec(f), default: f.defaultValue ?? undefined });
      else v[f.key] = '';
    }
    setValues(v);
    setFileExpect({ ...(initial?.fileExpect ?? {}) });
    setSeeded(refKeyStr);
  }, [info, seeded, refKeyStr, fields, initial]);

  const targets: EcuRecordV1[] = mode === 'group'
    ? sortedEcus.filter((e) => (groupId === NO_GROUP ? e.groupId === null : e.groupId === groupId))
    : sortedEcus.filter((e) => e.id === ecuId);

  const candidateParams = (): Record<string, FlowBindingParamValue> => {
    const out: Record<string, FlowBindingParamValue> = {};
    for (const f of fields) {
      if (f.kind === 'file') continue;
      const v = values[f.key];
      if (typeof v === 'boolean') {
        out[f.key] = v;
        continue;
      }
      const s = (v ?? '').trim();
      if (s === '') continue;
      out[f.key] = f.kind === 'number' && DEC_RE.test(s) ? Number(s) : s;
    }
    return out;
  };

  const crcErrors = Object.keys(fileExpect).filter((k) => !FILE_EXPECT_CRC_RE.test(fileExpect[k].crc32.toUpperCase()));
  const sample = targets[0];
  const candidate: FlowBindingV1 | null = flowRef && sample
    ? { id: initial?.id ?? 'candidate', ecuId: sample.id, flowRef, label: null, params: candidateParams(), order: 0, fileExpect: normalizedExpect() }
    : null;
  function normalizedExpect(): Record<string, FileExpectV1> {
    const out: Record<string, FileExpectV1> = {};
    for (const k of Object.keys(fileExpect)) {
      const e = fileExpect[k];
      if (e.fileName.trim() !== '' && FILE_EXPECT_CRC_RE.test(e.crc32.toUpperCase())) out[k] = { fileName: e.fileName.trim(), crc32: e.crc32.toUpperCase() };
    }
    return out;
  }
  const resolved = candidate && info ? resolveBindingParams(candidate, info.iface, sample) : null;
  const issues = resolved === null ? [] : resolved.status === 'ready' ? resolved.notes : resolved.issues;
  const blockingIssues = issues.filter((i) => i.code === 'type' || i.code === 'range');
  const refIssues = issues.filter((i) => i.code === 'ecu_ref');
  const duplicate = mode === 'add' && flowRef !== null && bindings.some((b) => b.ecuId === ecuId && b.flowRef.flowId === flowRef.flowId);
  const canSave = flowRef !== null && info !== undefined && targets.length > 0 && blockingIssues.length === 0 && crcErrors.length === 0 && !duplicate;
  const incomplete = resolved?.status === 'incomplete';

  const save = (): void => {
    if (!flowRef || !canSave) return;
    onSave({
      ecuIds: targets.map((e) => e.id),
      flowRef,
      label: label.trim() === '' ? null : label.trim(),
      params: candidateParams(),
      fileExpect: normalizedExpect(),
    });
  };

  const title = mode === 'edit' ? t('workbench.form.editTitle') : mode === 'group' ? t('workbench.form.groupTitle') : t('workbench.form.addTitle');

  return (
    <ModalShell title={title} onClose={onCancel} width={560}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="wb-bf-block" className="mb-0.5 block text-[11.5px] text-muted">{t('workbench.form.block')}</label>
              <select id="wb-bf-block" value={flowId} disabled={mode === 'edit'} onChange={(e) => setFlowId(e.target.value)} className={`${RUN_FIELD} cursor-pointer`}>
                {blocks.map((b) => (
                  <option key={b.flowId} value={b.flowId}>{b.name}</option>
                ))}
                {mode === 'edit' && !block && flowRef && <option value={flowRef.flowId}>{flowRef.flowId}</option>}
              </select>
              {flowRef && (
                <div className="mt-0.5 font-mono text-[11px] tabular-nums text-subtle">{t('workbench.form.revision')} r{flowRef.revision}</div>
              )}
            </div>
            {mode === 'group' ? (
              <div>
                <label htmlFor="wb-bf-group" className="mb-0.5 block text-[11.5px] text-muted">{t('workbench.form.group')}</label>
                <select id="wb-bf-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} className={`${RUN_FIELD} cursor-pointer`}>
                  {[...groups].sort((a, b) => a.order - b.order).map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                  <option value={NO_GROUP}>{t('diagWs.ungrouped')}</option>
                </select>
                <div className="mt-0.5 font-mono text-[11px] tabular-nums text-subtle">
                  {targets.length === 0 ? t('workbench.form.noMembers') : t('workbench.form.members', { n: targets.length })}
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="wb-bf-ecu" className="mb-0.5 block text-[11.5px] text-muted">{t('workbench.form.ecu')}</label>
                <select id="wb-bf-ecu" value={ecuId} disabled={mode === 'edit'} onChange={(e) => setEcuId(e.target.value)} className={`${RUN_FIELD} cursor-pointer`}>
                  {sortedEcus.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div>
            <label htmlFor="wb-bf-label" className="mb-0.5 block text-[11.5px] text-muted">{t('workbench.form.label')}</label>
            <input id="wb-bf-label" type="text" value={label} placeholder={t('workbench.form.labelHint')} onChange={(e) => setLabel(e.target.value)} className={RUN_FIELD} />
          </div>

          <div className="text-[11px] leading-snug text-subtle">{t('workbench.form.refHint')}</div>

          {info === undefined && flowRef !== null && <div className="font-mono text-[11.5px] text-muted">{t('workbench.cell.revLoading')}</div>}
          {info !== undefined && fields.length === 0 && <div className="text-[12px] text-muted">{t('workbench.form.noParams')}</div>}

          {fields.map((f) => {
            const spec = toSpec(f);
            const id = `wb-bf-${f.key}`;
            if (f.kind === 'file') {
              const exp = fileExpect[f.key];
              return (
                <PortFieldFrame key={f.key} spec={spec} htmlFor={id}>
                  <div className="flex flex-col gap-1.5 rounded-[2px] border border-hairline bg-canvas p-2">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-muted">{t('workbench.form.fileExpect')}</span>
                    <input
                      id={id}
                      type="file"
                      accept={f.accept?.join(',')}
                      aria-label={t('workbench.form.fileChoose')}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        void file.arrayBuffer().then((buf) => {
                          setFileExpect((cur) => ({ ...cur, [f.key]: { fileName: file.name, crc32: crc32Hex(new Uint8Array(buf)) } }));
                        });
                      }}
                      className="w-full text-[12px] text-muted file:mr-2 file:cursor-pointer file:rounded-[2px] file:border file:border-hairline file:bg-elevated file:px-2 file:py-1 file:text-[12px] file:text-ink"
                    />
                    <div className="grid grid-cols-[1fr_120px] gap-2">
                      <input
                        type="text"
                        spellCheck={false}
                        aria-label={t('workbench.form.fileName')}
                        placeholder={t('workbench.form.fileName')}
                        value={exp?.fileName ?? ''}
                        onChange={(e) => setFileExpect((cur) => ({ ...cur, [f.key]: { fileName: e.target.value, crc32: cur[f.key]?.crc32 ?? '' } }))}
                        className={RUN_FIELD}
                      />
                      <input
                        type="text"
                        spellCheck={false}
                        maxLength={8}
                        aria-label={t('workbench.form.fileCrc')}
                        placeholder="CRC-32"
                        value={exp?.crc32 ?? ''}
                        onChange={(e) => setFileExpect((cur) => ({ ...cur, [f.key]: { fileName: cur[f.key]?.fileName ?? '', crc32: e.target.value.toUpperCase() } }))}
                        className={`${RUN_FIELD} uppercase ${exp !== undefined && exp.crc32 !== '' && !FILE_EXPECT_CRC_RE.test(exp.crc32) ? 'border-critical' : ''}`}
                      />
                    </div>
                    <span className="text-[11px] leading-snug text-subtle">{t('workbench.form.fileHint')}</span>
                  </div>
                </PortFieldFrame>
              );
            }
            return (
              <PortFieldFrame key={f.key} spec={spec} htmlFor={id}>
                <PortScalarInput id={id} spec={spec} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
                  placeholder={f.defaultValue !== undefined && f.defaultValue !== null ? String(f.defaultValue) : undefined} />
              </PortFieldFrame>
            );
          })}

          {duplicate && <div className="border border-warn bg-canvas px-2 py-1 text-[11.5px] text-warn" role="alert">{t('workbench.form.exists')}</div>}
          {incomplete && <div className="border border-warn bg-canvas px-2 py-1 text-[11.5px] text-warn">{t('workbench.form.incompleteNote')}</div>}
          {issues.length > 0 && (
            <div className="flex flex-col gap-1" role="alert">
              {issues.map((i, n) => (
                <div key={n} className={`border bg-canvas px-2 py-1 text-[11.5px] leading-snug ${i.code === 'type' || i.code === 'range' ? 'border-critical text-critical' : 'border-warn text-warn'}`}>
                  {i.message}
                </div>
              ))}
            </div>
          )}
          {refIssues.length > 0 && mode === 'group' && (
            <div className="text-[11px] text-subtle">{t('workbench.form.refHint')}</div>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-hairline p-3">
          <button type="button" onClick={onCancel} className={DIAG_BTN}>{t('workbench.form.cancel')}</button>
          <button type="submit" disabled={!canSave} className={DIAG_BTN_PRIMARY}>{t('workbench.form.save')}</button>
        </div>
      </form>
    </ModalShell>
  );
};
