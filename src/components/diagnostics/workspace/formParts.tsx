/** Small controlled inputs / layout pieces of the ECU form (industrial dark HMI: mono tabular-nums, no animation). */
import React, { useEffect, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { DIAG_BTN_SM, DIAG_INPUT, DIAG_PANEL, DIAG_SECTION_TITLE, DIAG_SELECT, DiagSelectWrap } from '../diagUi';
import type { EcuIssue } from './ecuValidation';
import { fmtHex, parseHexText, parseIntText, sameNumber } from './ecuViewHelpers';

export const ERR_TEXT = 'text-[11.5px] text-[color:var(--status-critical)]';
const INVALID_RING = '!border-[color:var(--status-critical)]';

export const Section: React.FC<{ title: string; children: React.ReactNode; right?: React.ReactNode }> = ({ title, children, right }) => (
  <section className={`${DIAG_PANEL} p-3`}>
    <div className="mb-2 flex items-center gap-2">
      <h3 className={DIAG_SECTION_TITLE}>{title}</h3>
      <div className="flex-1" />
      {right}
    </div>
    <div className="flex flex-col gap-2.5">{children}</div>
  </section>
);

export const Field: React.FC<{
  label: string;
  error?: string | null;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ label, error, hint, className = '', children }) => (
  <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
    <span className={DIAG_SECTION_TITLE}>{label}</span>
    {children}
    {error ? <span className={ERR_TEXT}>{error}</span> : hint ? <span className="text-[11px] text-subtle">{hint}</span> : null}
  </label>
);

export const Grid: React.FC<{ cols?: 2 | 3 | 4; children: React.ReactNode }> = ({ cols = 3, children }) => (
  <div className={`grid gap-2.5 ${cols === 2 ? 'grid-cols-2' : cols === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>{children}</div>
);

export const TextInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  placeholder?: string;
  maxLength?: number;
  mono?: boolean;
  ariaLabel?: string;
}> = ({ value, onChange, invalid = false, placeholder, maxLength = 128, mono = false, ariaLabel }) => (
  <input
    type="text"
    value={value}
    maxLength={maxLength}
    placeholder={placeholder}
    aria-label={ariaLabel}
    onChange={(e) => onChange(e.target.value)}
    className={`${DIAG_INPUT} ${mono ? 'uppercase' : ''} ${invalid ? INVALID_RING : ''}`}
  />
);

/** Hex number input. Invalid text reports NaN (never silently keeps the previous value); empty reports null. */
export const HexNumInput: React.FC<{
  value: number | null;
  onChange: (v: number | null) => void;
  digits?: number;
  invalid?: boolean;
  nullable?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}> = ({ value, onChange, digits = 2, invalid = false, nullable = false, disabled = false, placeholder, ariaLabel }) => {
  const [text, setText] = useState(() => fmtHex(value, digits));
  useEffect(() => {
    const parsed = parseHexText(text, 8);
    if (!sameNumber(parsed === null && !nullable ? Number.NaN : parsed, value)) setText(fmtHex(value, digits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const parsed = parseHexText(next, 8);
        onChange(parsed === null && !nullable ? Number.NaN : parsed);
      }}
      className={`${DIAG_INPUT} uppercase ${invalid ? INVALID_RING : ''}`}
    />
  );
};

/** Decimal integer input (NaN = invalid, null = empty). */
export const IntInput: React.FC<{
  value: number | null;
  onChange: (v: number | null) => void;
  invalid?: boolean;
  nullable?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}> = ({ value, onChange, invalid = false, nullable = false, placeholder, ariaLabel }) => {
  const fmt = (v: number | null): string => (v === null || !Number.isFinite(v) ? '' : String(v));
  const [text, setText] = useState(() => fmt(value));
  useEffect(() => {
    const parsed = parseIntText(text);
    if (!sameNumber(parsed === null && !nullable ? Number.NaN : parsed, value)) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const parsed = parseIntText(next);
        onChange(parsed === null && !nullable ? Number.NaN : parsed);
      }}
      className={`${DIAG_INPUT} ${invalid ? INVALID_RING : ''}`}
    />
  );
};

export const SelectInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  invalid?: boolean;
  ariaLabel?: string;
}> = ({ value, onChange, children, invalid = false, ariaLabel }) => (
  <DiagSelectWrap chevron={<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}>
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={`${DIAG_SELECT} ${invalid ? INVALID_RING : ''}`}
    >
      {children}
    </select>
  </DiagSelectWrap>
);

export interface ListColumn<T> {
  header: string;
  /** Tailwind width class of the cell (`w-32`, `flex-1`). */
  width: string;
  render: (item: T, index: number, set: (patch: Partial<T>) => void, invalidFields: ReadonlySet<string>) => React.ReactNode;
}

/** Editable table of records with add / remove; issues of `${prefix}[i].*` are listed under their row. */
export function ListEditor<T>(props: {
  prefix: string;
  items: readonly T[];
  onChange: (items: T[]) => void;
  makeItem: () => T;
  columns: readonly ListColumn<T>[];
  issues: readonly EcuIssue[];
  addLabel: string;
  removeLabel: string;
  emptyLabel: string;
}): React.ReactElement {
  const { prefix, items, onChange, makeItem, columns, issues, addLabel, removeLabel, emptyLabel } = props;
  return (
    <div className="flex flex-col gap-1.5">
      {items.length === 0 ? (
        <p className="text-[12px] text-subtle">{emptyLabel}</p>
      ) : (
        <>
          <div className="flex gap-2 px-0.5">
            {columns.map((c) => (
              <span key={c.header} className={`${c.width} ${DIAG_SECTION_TITLE} shrink-0`}>
                {c.header}
              </span>
            ))}
            <span className="w-[24px] shrink-0" />
          </div>
          {items.map((item, i) => {
            const rowIssues = issues.filter((x) => x.field.startsWith(`${prefix}[${i}].`));
            const bad = new Set(rowIssues.map((x) => x.field.slice(`${prefix}[${i}].`.length)));
            return (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="flex items-start gap-2">
                  {columns.map((c) => (
                    <div key={c.header} className={`${c.width} min-w-0 shrink-0`}>
                      {c.render(item, i, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))), bad)}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => onChange(items.filter((_, j) => j !== i))}
                    title={removeLabel}
                    aria-label={removeLabel}
                    className="flex h-[30px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] text-muted hover:text-[color:var(--status-critical)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                {rowIssues.map((x) => (
                  <span key={`${x.field}|${x.code}`} className={ERR_TEXT}>
                    {x.message}
                  </span>
                ))}
              </div>
            );
          })}
        </>
      )}
      <div>
        <button type="button" onClick={() => onChange([...items, makeItem()])} className={DIAG_BTN_SM}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          {addLabel}
        </button>
      </div>
    </div>
  );
}

/** Convenience: localized "remove" label for list editors. */
export function useRemoveLabel(): string {
  const { t } = useI18n();
  return t('diagWs.form.remove');
}
