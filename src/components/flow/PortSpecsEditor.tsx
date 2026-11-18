/**
 * Editor of an interface port list (`flow_input.inputs` / `flow_output.outputs`): key, label, type, required,
 * default and select options. Text fields commit on blur / Enter, so a half-typed key never rewires the graph.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { FlowPortSpecV1, FlowPortValueType } from '../../types/flowLibrary';
import { DIAG_BTN_SM, DIAG_CHECKBOX } from '../diagnostics/diagUi';
import { PORT_VALUE_TYPES, readPortSpecs } from './flowPorts';

const FIELD =
  'h-[26px] w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-subtle focus:border-focus';

/** Text input with a local draft: commits the draft on blur / Enter, reverts on Escape. */
const CommitInput: React.FC<{
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  invalid?: boolean;
}> = ({ value, onCommit, label, placeholder, invalid }) => {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (): void => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      value={text}
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          e.currentTarget.blur();
        }
      }}
      className={`${FIELD} ${invalid ? '!border-critical' : ''}`}
    />
  );
};

/** Next unused key `in1`, `in2`, ... (or `out1` ...). */
function nextKey(specs: readonly FlowPortSpecV1[], prefix: string): string {
  let n = 1;
  while (specs.some((s) => s.key === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export const PortSpecsEditor: React.FC<{
  value: unknown;
  /** `input` = flow_input (may declare the `ecu` input and file inputs), `output` = flow_output values. */
  side: 'input' | 'output';
  onChange: (specs: FlowPortSpecV1[]) => void;
}> = ({ value, side, onChange }) => {
  const { t } = useI18n();
  const specs = readPortSpecs(value);
  const update = (i: number, patch: Partial<FlowPortSpecV1>): void => {
    onChange(specs.map((s, idx) => {
      if (idx !== i) return s;
      const next: FlowPortSpecV1 = { ...s, ...patch };
      if (next.default === undefined) delete next.default;
      if (next.options === undefined) delete next.options;
      return next;
    }));
  };
  const types = PORT_VALUE_TYPES.filter((ty) => side === 'input' || ty !== 'file');

  return (
    <div className="flex flex-col gap-2">
      {specs.length === 0 && <div className="text-[11.5px] leading-snug text-subtle">{t('flowReg.ports.none')}</div>}
      {specs.map((s, i) => (
        <div key={i} className="flex flex-col gap-1 border border-hairline bg-canvas p-1.5">
          <div className="flex items-center gap-1">
            <CommitInput
              value={s.key}
              label={t('flowReg.ports.key')}
              placeholder="key"
              onCommit={(key) => update(i, { key: key.trim() })}
            />
            <button
              type="button"
              onClick={() => onChange(specs.filter((_, idx) => idx !== i))}
              title={t('flowReg.ports.remove')}
              aria-label={t('flowReg.ports.remove')}
              className={`${DIAG_BTN_SM} hover:!border-critical hover:!text-critical`}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
          <CommitInput
            value={s.label}
            label={t('flowReg.ports.label')}
            placeholder={t('flowReg.ports.label')}
            onCommit={(label) => update(i, { label })}
          />
          <div className="flex items-center gap-1">
            <select
              value={s.type}
              aria-label={t('flowReg.ports.type')}
              onChange={(e) => {
                const type = e.target.value as FlowPortValueType;
                const patch: Partial<FlowPortSpecV1> = { type };
                if (type === 'ecu') patch.key = 'ecu';
                if (type === 'select' && s.options === undefined) patch.options = [];
                update(i, patch);
              }}
              className={`${FIELD} cursor-pointer`}
            >
              {types.map((ty) => (
                <option key={ty} value={ty}>{ty}</option>
              ))}
            </select>
            <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11.5px] text-muted">
              <input
                type="checkbox"
                checked={s.required}
                onChange={(e) => update(i, { required: e.target.checked })}
                className={DIAG_CHECKBOX}
              />
              {t('flowReg.ports.required')}
            </label>
          </div>
          {s.type !== 'ecu' && s.type !== 'file' && (
            <CommitInput
              value={s.default === undefined ? '' : String(s.default)}
              label={t('flowReg.ports.default')}
              placeholder={t('flowReg.ports.default')}
              onCommit={(v) => {
                if (v === '') update(i, { default: undefined });
                else if (s.type === 'number' && Number.isFinite(Number(v))) update(i, { default: Number(v) });
                else if (s.type === 'bool') update(i, { default: v.trim().toLowerCase() === 'true' });
                else update(i, { default: v });
              }}
            />
          )}
          {s.type === 'select' && (
            <CommitInput
              value={(s.options ?? []).join(', ')}
              label={t('flowReg.ports.options')}
              placeholder={t('flowReg.ports.options')}
              invalid={(s.options ?? []).length === 0}
              onCommit={(v) => update(i, { options: v.split(',').map((x) => x.trim()).filter((x) => x.length > 0) })}
            />
          )}
        </div>
      ))}
      <button
        type="button"
        className={DIAG_BTN_SM}
        onClick={() => {
          const key = nextKey(specs, side === 'input' ? 'in' : 'out');
          onChange([...specs, { key, label: key, type: 'text', required: false }]);
        }}
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        {t('flowReg.ports.add')}
      </button>
    </div>
  );
};
