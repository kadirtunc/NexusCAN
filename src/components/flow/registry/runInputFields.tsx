/**
 * Shared run-input field components (Flow Editor `RunInputsDialog` and the Workbench `BindingForm` /
 * run dialog): label row, scalar inputs (text / hex / number / bool / select), range + byte-length hints and the
 * in-memory file picker. One implementation, so both forms render a flow's interface identically.
 */
import React from 'react';
import { useI18n } from '../../../i18n';
import type { FlowPortValueType } from '../../../types/flowLibrary';
import { DIAG_BTN_SM, DIAG_CHECKBOX } from '../../diagnostics/diagUi';
import { flowFiles, useFlowFilesVersion } from '../flowFiles';

/** Structural subset of `FlowPortSpecV1` the field components need. */
export interface PortFieldSpec {
  key: string;
  label: string;
  type: FlowPortValueType;
  required: boolean;
  order?: number;
  description?: string;
  unit?: string;
  min?: number;
  max?: number;
  byteLength?: number;
  options?: readonly string[];
  accept?: readonly string[];
}

export const RUN_FIELD =
  'h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-subtle focus:border-focus disabled:opacity-50';

/** Initial form value of a spec (`bool` -> boolean, others -> text). */
export function initialPortValue(s: PortFieldSpec & { default?: string | number | boolean }): string | boolean {
  if (s.type === 'bool') return s.default === true || s.default === 'true';
  if (s.default !== undefined) return String(s.default);
  if (s.type === 'select') return s.options?.[0] ?? '';
  return '';
}

/** Label row + description + children + range / byte-length hints of one input. */
export const PortFieldFrame: React.FC<{ spec: PortFieldSpec; htmlFor: string; children: React.ReactNode }> = ({ spec: s, htmlFor, children }) => {
  const { t } = useI18n();
  const label = s.label !== '' ? s.label : s.key;
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-0.5 flex items-center gap-1.5 text-[11.5px] text-muted" title={s.description}>
        <span className="font-mono text-[10.5px] tabular-nums text-subtle">{s.order ?? '–'}</span>
        <span>{label}</span>
        <span className="font-mono text-[10.5px] text-subtle">{s.key} · {s.type}</span>
        {s.unit !== undefined && <span className="font-mono text-[10.5px] text-subtle">[{s.unit}]</span>}
        {s.required && <span className="font-mono text-[10.5px] text-warn">{t('flowReg.ports.required')}</span>}
      </label>
      {s.description !== undefined && <div className="mb-1 text-[11px] leading-snug text-subtle">{s.description}</div>}
      {children}
      {s.type === 'number' && (s.min !== undefined || s.max !== undefined) && (
        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-subtle">
          {t('flowIface.run.range.hint', { min: s.min ?? '−∞', max: s.max ?? '∞' })}{s.unit !== undefined ? ` ${s.unit}` : ''}
        </div>
      )}
      {(s.type === 'hex' || s.type === 'bytes') && s.byteLength !== undefined && (
        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-subtle">{s.byteLength} B</div>
      )}
    </div>
  );
};

/** Scalar input of a non-`ecu`, non-`file` spec. `bool` uses `boolean` values, everything else text. */
export const PortScalarInput: React.FC<{
  id: string;
  spec: PortFieldSpec;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
  placeholder?: string;
}> = ({ id, spec: s, value, onChange, placeholder }) => {
  if (s.type === 'bool') {
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className={DIAG_CHECKBOX} />
        <span className="font-mono text-[12px] text-muted">{value === true ? 'true' : 'false'}</span>
      </label>
    );
  }
  if (s.type === 'select') {
    return (
      <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={`${RUN_FIELD} cursor-pointer`}>
        {(s.options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      id={id}
      type="text"
      spellCheck={false}
      value={String(value ?? '')}
      placeholder={placeholder ?? (s.type === 'hex' ? '00 1A FF' : s.type === 'number' ? '0' : '')}
      onChange={(e) => onChange(e.target.value)}
      className={RUN_FIELD}
    />
  );
};

/** In-memory file picker backed by `flowFiles` under `fileKey` (bytes never persisted). */
export const PortFileInput: React.FC<{ id: string; fileKey: string; accept?: readonly string[] }> = ({ id, fileKey, accept }) => {
  const { t } = useI18n();
  useFlowFilesVersion();
  const f = flowFiles.get(fileKey);
  return (
    <div className="flex flex-col gap-1.5">
      <input
        id={id}
        type="file"
        accept={accept !== undefined ? accept.join(',') : undefined}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void flowFiles.set(fileKey, file);
          e.target.value = '';
        }}
        className="w-full text-[12px] text-muted file:mr-2 file:cursor-pointer file:rounded-[2px] file:border file:border-hairline file:bg-elevated file:px-2 file:py-1 file:text-[12px] file:text-ink"
      />
      {accept !== undefined && <span className="font-mono text-[11px] text-subtle">{t('flowIface.run.accepts', { accept: accept.join(' ') })}</span>}
      {f ? (
        <div className="flex items-center gap-2 font-mono text-[11.5px] tabular-nums">
          <span className="min-w-0 truncate text-ink" title={f.name}>{f.name}</span>
          <span className="shrink-0 text-subtle">{f.bytes.length} B</span>
          <button type="button" className={DIAG_BTN_SM} onClick={() => flowFiles.clear(fileKey)}>
            {t('diagReal.flow.fileClear')}
          </button>
        </div>
      ) : (
        <span className="text-[11.5px] text-warn">{t('diagReal.flow.fileNone')}</span>
      )}
    </div>
  );
};
