/**
 * "Run inputs" dialog: asks for the `flow_input` values before a run. File inputs use the in-memory `flowFiles`
 * mechanism (keyed per document + input key); `ecu` inputs cannot be provided yet (ECU binding = Phase B2).
 */
import React, { useState } from 'react';
import { useI18n } from '../../../i18n';
import type { FlowPortSpecV1 } from '../../../types/flowLibrary';
import type { EcuRecordV1 } from '../../../types/diagWorkspace';
import { useDiagnosticsSelector } from '../../../store/diagnosticsStore';
import { selectActiveVehicle, useDiagWorkspace } from '../../diagnostics/workspace/diagWorkspaceStore';
import { openSessionFromEcu } from '../../diagnostics/workspace/openSession';
import { checkEcuSession } from '../ecuBinding';
import { DIAG_BTN, DIAG_BTN_PRIMARY, DIAG_BTN_SM, DIAG_CHECKBOX } from '../../diagnostics/diagUi';
import { flowFiles, useFlowFilesVersion } from '../flowFiles';
import { resolveRunInputs } from '../flowInterface';
import { ModalShell } from '../ModalShell';

const FIELD =
  'h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-subtle focus:border-focus disabled:opacity-50';

function hex(n: number): string {
  return n.toString(16).toUpperCase();
}

/** `flowFiles` key of a file input of a document. */
export function inputFileKey(docId: string, key: string): string {
  return `in:${docId}:${key}`;
}

function initialValue(s: FlowPortSpecV1): string | boolean {
  if (s.type === 'bool') return s.default === true || s.default === 'true';
  if (s.default !== undefined) return String(s.default);
  if (s.type === 'select') return s.options?.[0] ?? '';
  return '';
}

export const RunInputsDialog: React.FC<{
  docId: string;
  inputs: FlowPortSpecV1[];
  onRun: (provided: Record<string, unknown>, ecu: EcuRecordV1 | null) => void;
  onCancel: () => void;
}> = ({ docId, inputs, onRun, onCancel }) => {
  const { t } = useI18n();
  useFlowFilesVersion();
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const s of inputs) if (s.type !== 'file' && s.type !== 'ecu') init[s.key] = initialValue(s);
    return init;
  });
  const [errors, setErrors] = useState<string[]>([]);
  const vehicle = selectActiveVehicle(useDiagWorkspace());
  const ecus = vehicle ? [...vehicle.ecus].sort((a, b) => a.order - b.order) : [];
  const sessionEcuId = useDiagnosticsSelector((st) => (st.tabs.find((x) => x.id === st.activeTabId) ?? st.tabs[0]).ecuId);
  const sessionConnected = useDiagnosticsSelector((st) => (st.tabs.find((x) => x.id === st.activeTabId) ?? st.tabs[0]).session.connected);
  const sessionTabId = useDiagnosticsSelector((st) => st.activeTabId);
  const demo = useDiagnosticsSelector((st) => st.mockMode);
  const [ecuId, setEcuId] = useState<string>(() => (sessionEcuId !== null && ecus.some((e) => e.id === sessionEcuId) ? sessionEcuId : ''));
  const ecu: EcuRecordV1 | null = ecus.find((e) => e.id === ecuId) ?? null;
  const sessionMsg = ecu && !demo ? checkEcuSession(ecu, { tabId: sessionTabId, ecuId: sessionEcuId, connected: sessionConnected }) : null;
  const [openMsg, setOpenMsg] = useState<string | null>(null);

  const collect = (): Record<string, unknown> => {
    const provided: Record<string, unknown> = {};
    for (const s of inputs) {
      if (s.type === 'file') {
        const f = flowFiles.get(inputFileKey(docId, s.key));
        if (f) provided[s.key] = f.bytes;
      } else if (s.type !== 'ecu') {
        provided[s.key] = values[s.key];
      }
    }
    return provided;
  };

  const blockedByEcu = (inputs.some((s) => s.type === 'ecu' && s.required) && ecu === null) || sessionMsg !== null;

  const submit = (): void => {
    const provided = collect();
    const { errors: errs } = resolveRunInputs(inputs, { ...provided, ...(ecu ? { ecu } : {}) });
    setErrors(errs);
    if (errs.length === 0) onRun(provided, ecu);
  };

  return (
    <ModalShell title={t('flowReg.run.title')} onClose={onCancel} width={480}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
          {inputs.map((s) => {
            const label = s.label !== '' ? s.label : s.key;
            const id = `run-in-${s.key}`;
            return (
              <div key={s.key}>
                <label htmlFor={id} className="mb-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
                  <span>{label}</span>
                  <span className="font-mono text-[10.5px] text-subtle">{s.key} · {s.type}</span>
                  {s.required && <span className="font-mono text-[10.5px] text-warn">{t('flowReg.ports.required')}</span>}
                </label>
                {s.type === 'ecu' ? (
                  <div className="flex flex-col gap-1.5">
                    <select id={id} value={ecuId} onChange={(e) => { setEcuId(e.target.value); setOpenMsg(null); }} className={`${FIELD} cursor-pointer`}>
                      <option value="">{ecus.length === 0 ? t('flowNest.run.noEcus') : '—'}</option>
                      {ecus.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}  ·  REQ {hex(e.addressing.requestId)} / RSP {hex(e.addressing.responseId)}
                        </option>
                      ))}
                    </select>
                    {sessionMsg && (
                      <div className="flex items-center gap-2 border border-warn bg-canvas px-2 py-1">
                        <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-warn">{sessionMsg}</span>
                        <button
                          type="button"
                          className={DIAG_BTN_SM}
                          onClick={() => {
                            if (!ecu) return;
                            const r = openSessionFromEcu(ecu);
                            setOpenMsg(r.ok ? t('flowNest.run.sessionOpened') : t('flowNest.run.sessionFailed'));
                          }}
                        >
                          {t('flowNest.run.openSession')}
                        </button>
                      </div>
                    )}
                    {openMsg && <div className="text-[11.5px] text-muted">{openMsg}</div>}
                  </div>
                ) : s.type === 'file' ? (
                  <div className="flex flex-col gap-1.5">
                    <input
                      id={id}
                      type="file"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void flowFiles.set(inputFileKey(docId, s.key), f);
                        e.target.value = '';
                      }}
                      className="w-full text-[12px] text-muted file:mr-2 file:cursor-pointer file:rounded-[2px] file:border file:border-hairline file:bg-elevated file:px-2 file:py-1 file:text-[12px] file:text-ink"
                    />
                    {(() => {
                      const f = flowFiles.get(inputFileKey(docId, s.key));
                      return f ? (
                        <div className="flex items-center gap-2 font-mono text-[11.5px] tabular-nums">
                          <span className="min-w-0 truncate text-ink" title={f.name}>{f.name}</span>
                          <span className="shrink-0 text-subtle">{f.bytes.length} B</span>
                          <button type="button" className={DIAG_BTN_SM} onClick={() => flowFiles.clear(inputFileKey(docId, s.key))}>
                            {t('diagReal.flow.fileClear')}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11.5px] text-warn">{t('diagReal.flow.fileNone')}</span>
                      );
                    })()}
                  </div>
                ) : s.type === 'bool' ? (
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      id={id}
                      type="checkbox"
                      checked={values[s.key] === true}
                      onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.checked }))}
                      className={DIAG_CHECKBOX}
                    />
                    <span className="font-mono text-[12px] text-muted">{values[s.key] === true ? 'true' : 'false'}</span>
                  </label>
                ) : s.type === 'select' ? (
                  <select
                    id={id}
                    value={String(values[s.key] ?? '')}
                    onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                    className={`${FIELD} cursor-pointer`}
                  >
                    {(s.options ?? []).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    type="text"
                    spellCheck={false}
                    value={String(values[s.key] ?? '')}
                    placeholder={s.type === 'hex' ? '00 1A FF' : s.type === 'number' ? '0' : ''}
                    onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                    className={FIELD}
                  />
                )}
              </div>
            );
          })}
          {errors.length > 0 && (
            <div className="flex flex-col gap-1" role="alert">
              {errors.map((m, i) => (
                <div key={i} className="border border-critical bg-canvas px-2 py-1 text-[11.5px] leading-snug text-critical">{m}</div>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-hairline p-3">
          <button type="button" onClick={onCancel} className={DIAG_BTN}>
            {t('diagReal.flow.promptCancel')}
          </button>
          <button type="submit" disabled={blockedByEcu} className={DIAG_BTN_PRIMARY}>
            {t('diagHmi.flow.run')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
