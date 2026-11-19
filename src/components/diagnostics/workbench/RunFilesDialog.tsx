/**
 * "Choose files and run": firmware files are chosen at run time (bytes live only in memory) and checked against the
 * binding's expected CRC-32 before the run starts. A mismatch disables Run (and the runner refuses it anyway).
 */
import React from 'react';
import { useI18n } from '../../../i18n';
import type { EcuRecordV1, FlowBindingV1 } from '../../../types/diagWorkspace';
import type { FlowFileValue } from '../../../types/flowLibrary';
import { DIAG_BTN, DIAG_BTN_PRIMARY } from '../diagUi';
import { ModalShell } from '../../flow/ModalShell';
import { flowFiles, useFlowFilesVersion } from '../../flow/flowFiles';
import { PortFieldFrame, PortFileInput, type PortFieldSpec } from '../../flow/registry/runInputFields';
import { checkFileExpectation } from './workbenchModel';

export const wbFileKey = (bindingId: string, key: string): string => `wb:${bindingId}:${key}`;

export const RunFilesDialog: React.FC<{
  binding: FlowBindingV1;
  ecu: EcuRecordV1;
  fileSpecs: PortFieldSpec[];
  onRun: (files: Record<string, FlowFileValue>) => void;
  onCancel: () => void;
}> = ({ binding, ecu, fileSpecs, onRun, onCancel }) => {
  const { t } = useI18n();
  useFlowFilesVersion();
  const chosen: Record<string, FlowFileValue> = {};
  let ready = true;
  for (const s of fileSpecs) {
    const f = flowFiles.get(wbFileKey(binding.id, s.key));
    if (f) chosen[s.key] = f;
    else if (s.required) ready = false;
  }
  const checks = fileSpecs.map((s) => {
    const f = chosen[s.key];
    const exp = binding.fileExpect?.[s.key];
    return { s, f, exp, chk: f && exp ? checkFileExpectation(binding, s.key, f) : null };
  });
  const crcBad = checks.some((c) => c.chk !== null && !c.chk.ok);
  return (
    <ModalShell title={`${t('workbench.run.title')} · ${ecu.name}`} onClose={onCancel} width={520}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); if (ready && !crcBad) onRun(chosen); }}>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
          {checks.map(({ s, exp, chk, f }) => (
            <PortFieldFrame key={s.key} spec={s} htmlFor={`wb-run-${s.key}`}>
              <PortFileInput id={`wb-run-${s.key}`} fileKey={wbFileKey(binding.id, s.key)} accept={s.accept} />
              {exp && <div className="mt-1 font-mono text-[11.5px] tabular-nums text-muted">{t('workbench.run.expected', { name: exp.fileName, crc: exp.crc32 })}</div>}
              {chk && chk.ok && (
                <div className="font-mono text-[11.5px] tabular-nums text-nominal">{t('workbench.run.crcOk', { actual: chk.ref.crc32 })}</div>
              )}
              {chk && chk.ok && f && exp && f.name !== exp.fileName && <div className="text-[11.5px] text-warn">{t('workbench.run.nameDiffers')}</div>}
              {chk && !chk.ok && (
                <div className="font-mono text-[11.5px] tabular-nums text-critical" role="alert">{t('workbench.run.crcBad', { actual: chk.actual })}</div>
              )}
            </PortFieldFrame>
          ))}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-hairline p-3">
          <button type="button" onClick={onCancel} className={DIAG_BTN}>{t('workbench.form.cancel')}</button>
          <button type="submit" disabled={!ready || crcBad} className={DIAG_BTN_PRIMARY}>{t('workbench.run.go')}</button>
        </div>
      </form>
    </ModalShell>
  );
};
