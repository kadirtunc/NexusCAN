/**
 * "Run inputs" dialog (Test Run, flow-interface-v2 §7): the form is generated from the `flow_in` specs in
 * (order, key) order, showing unit / min / max / byte length / accepted extensions and the description. File
 * inputs use the in-memory `flowFiles` mechanism (keyed per document + input key) and are handed over as
 * `FlowFileValue { name, bytes }`; the `ecu` input is an ECU picker over the active vehicle's ECU registry.
 * Values are checked by `resolveRunInputs` (range / length / extension errors refuse the run, never clamped).
 */
import React, { useState } from 'react';
import { useI18n } from '../../../i18n';
import type { FlowPortSpecV1 } from '../../../types/flowLibrary';
import type { EcuRecordV1 } from '../../../types/diagWorkspace';
import { useDiagnosticsSelector } from '../../../store/diagnosticsStore';
import { selectActiveVehicle, useDiagWorkspace } from '../../diagnostics/workspace/diagWorkspaceStore';
import { openSessionFromEcu } from '../../diagnostics/workspace/openSession';
import { checkEcuSession } from '../ecuBinding';
import { DIAG_BTN, DIAG_BTN_PRIMARY, DIAG_BTN_SM } from '../../diagnostics/diagUi';
import { flowFiles, useFlowFilesVersion } from '../flowFiles';
import { resolveRunInputs } from '../flowInterface';
import { ModalShell } from '../ModalShell';
import { PortFieldFrame, PortFileInput, PortScalarInput, RUN_FIELD, initialPortValue } from './runInputFields';

function hex(n: number): string {
  return n.toString(16).toUpperCase();
}

/** `flowFiles` key of a file input of a document. */
export function inputFileKey(docId: string, key: string): string {
  return `in:${docId}:${key}`;
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
    for (const s of inputs) if (s.type !== 'file' && s.type !== 'ecu') init[s.key] = initialPortValue(s);
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
        if (f) provided[s.key] = { name: f.name, bytes: f.bytes };
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
            const id = `run-in-${s.key}`;
            return (
              <PortFieldFrame key={s.key} spec={s} htmlFor={id}>
                {s.type === 'ecu' ? (
                  <div className="flex flex-col gap-1.5">
                    <select id={id} value={ecuId} onChange={(e) => { setEcuId(e.target.value); setOpenMsg(null); }} className={`${RUN_FIELD} cursor-pointer`}>
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
                  <PortFileInput id={id} fileKey={inputFileKey(docId, s.key)} accept={s.accept} />
                ) : (
                  <PortScalarInput id={id} spec={s} value={values[s.key]} onChange={(v) => setValues((cur) => ({ ...cur, [s.key]: v }))} />
                )}
              </PortFieldFrame>
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
