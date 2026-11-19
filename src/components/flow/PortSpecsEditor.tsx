/**
 * Editor of ONE interface port (`flow_in` / `flow_out` block config, flow-interface-v2 §2): key, label, type,
 * required, order, description and the type-specific fields (default / options, unit / min / max, byteLength,
 * accept). Text fields commit on blur / Enter, so a half-typed key never renames the port mid-typing.
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import type { FlowPortValueType } from '../../types/flowLibrary';
import { DIAG_CHECKBOX } from '../diagnostics/diagUi';
import { flowStore } from './FlowStore';
import { PORT_VALUE_TYPES, blockPortSpec } from './flowPorts';
import type { FlowBlock } from './types';

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

const LABEL = 'mb-0.5 block text-[11.5px] text-muted';

/** Number draft that commits a finite number (or clears the field when emptied). */
const NumCommit: React.FC<{ value: number | undefined; onCommit: (v: number | undefined) => void; label: string }> = ({ value, onCommit, label }) => (
  <CommitInput
    value={value === undefined ? '' : String(value)}
    label={label}
    onCommit={(v) => {
      const trimmed = v.trim();
      if (trimmed === '') onCommit(undefined);
      else if (Number.isFinite(Number(trimmed))) onCommit(Number(trimmed));
    }}
  />
);

export const PortSpecEditor: React.FC<{ block: FlowBlock; side: 'input' | 'output' }> = ({ block, side }) => {
  const { t } = useI18n();
  const s = blockPortSpec(block);
  const set = (patch: Record<string, unknown>): void => flowStore.updateBlockConfig(block.id, patch);
  const types = PORT_VALUE_TYPES.filter((ty) => side === 'input' || ty !== 'file');
  const isNum = s.type === 'number';
  const isBytes = s.type === 'hex' || s.type === 'bytes';

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label className={LABEL}>{t('flowIface.spec.key')}</label>
        <CommitInput value={s.key} label={t('flowIface.spec.key')} placeholder="key" onCommit={(key) => set({ key: key.trim() })} />
      </div>
      <div>
        <label className={LABEL}>{t('flowIface.spec.label')}</label>
        <CommitInput value={s.label} label={t('flowIface.spec.label')} onCommit={(label) => set({ label })} />
      </div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label className={LABEL}>{t('flowIface.spec.type')}</label>
          <select
            value={s.type}
            aria-label={t('flowIface.spec.type')}
            onChange={(e) => {
              const type = e.target.value as FlowPortValueType;
              const patch: Record<string, unknown> = { type };
              if (type === 'ecu') patch['key'] = 'ecu';
              if (type === 'select' && s.options === undefined) patch['options'] = [];
              set(patch);
            }}
            className={`${FIELD} cursor-pointer`}
          >
            {types.map((ty) => (
              <option key={ty} value={ty}>{ty}</option>
            ))}
          </select>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1 pb-1 text-[11.5px] text-muted">
          <input type="checkbox" checked={s.required} onChange={(e) => set({ required: e.target.checked })} className={DIAG_CHECKBOX} />
          {t('flowIface.spec.required')}
        </label>
      </div>
      {s.type === 'ecu' && <div className="text-[11px] leading-snug text-subtle">{t('flowIface.spec.ecuNote')}</div>}
      <div>
        <label className={LABEL}>{t('flowIface.spec.order')}</label>
        <NumCommit value={s.order} label={t('flowIface.spec.order')} onCommit={(order) => set({ order })} />
      </div>
      <div>
        <label className={LABEL}>{t('flowIface.spec.description')}</label>
        <CommitInput value={s.description ?? ''} label={t('flowIface.spec.description')} onCommit={(description) => set({ description: description === '' ? undefined : description })} />
      </div>
      {side === 'input' && s.type !== 'ecu' && s.type !== 'file' && (
        <div>
          <label className={LABEL}>{t('flowIface.spec.default')}</label>
          <CommitInput
            value={s.default === undefined ? '' : String(s.default)}
            label={t('flowIface.spec.default')}
            onCommit={(v) => {
              if (v === '') set({ default: undefined });
              else if (s.type === 'number' && Number.isFinite(Number(v))) set({ default: Number(v) });
              else if (s.type === 'bool') set({ default: v.trim().toLowerCase() === 'true' });
              else set({ default: v });
            }}
          />
        </div>
      )}
      {side === 'input' && s.type === 'select' && (
        <div>
          <label className={LABEL}>{t('flowIface.spec.options')}</label>
          <CommitInput
            value={(s.options ?? []).join(', ')}
            label={t('flowIface.spec.options')}
            invalid={(s.options ?? []).length === 0}
            onCommit={(v) => set({ options: v.split(',').map((x) => x.trim()).filter((x) => x.length > 0) })}
          />
        </div>
      )}
      {isNum && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={LABEL}>{t('flowIface.spec.unit')}</label>
            <CommitInput value={s.unit ?? ''} label={t('flowIface.spec.unit')} onCommit={(unit) => set({ unit: unit === '' ? undefined : unit })} />
          </div>
          <div>
            <label className={LABEL}>{t('flowIface.spec.min')}</label>
            <NumCommit value={s.min} label={t('flowIface.spec.min')} onCommit={(min) => set({ min })} />
          </div>
          <div>
            <label className={LABEL}>{t('flowIface.spec.max')}</label>
            <NumCommit value={s.max} label={t('flowIface.spec.max')} onCommit={(max) => set({ max })} />
          </div>
        </div>
      )}
      {isBytes && (
        <div>
          <label className={LABEL}>{t('flowIface.spec.byteLength')}</label>
          <NumCommit value={s.byteLength} label={t('flowIface.spec.byteLength')} onCommit={(byteLength) => set({ byteLength: byteLength !== undefined && Number.isInteger(byteLength) && byteLength > 0 ? byteLength : undefined })} />
        </div>
      )}
      {side === 'input' && s.type === 'file' && (
        <div>
          <label className={LABEL}>{t('flowIface.spec.accept')}</label>
          <CommitInput
            value={(s.accept ?? []).join(', ')}
            label={t('flowIface.spec.accept')}
            placeholder=".hex, .s19, .bin"
            onCommit={(v) => set({ accept: v.split(',').map((x) => x.trim()).filter((x) => x.length > 0) })}
          />
        </div>
      )}
    </div>
  );
};
