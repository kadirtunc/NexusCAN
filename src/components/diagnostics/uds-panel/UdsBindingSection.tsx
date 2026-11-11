import React from 'react';
import { Link2, Plus, Unlink } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import type {
  UdsByteLen,
  UdsIoOption,
  UdsReadBinding,
  UdsReadService,
  UdsWidgetDto,
  UdsWriteBinding,
  UdsWriteService,
} from '../../../types/uds';
import { sanitizeHex } from './udsBinding';
import { defaultUdsRead, defaultUdsWrite, kindUsesUdsRead, kindUsesUdsWrite } from './udsInstrumentStore';
import { patchUdsBindings } from './udsPanelActions';

const INPUT_CLS =
  'h-6 w-full rounded-[2px] border border-hairline bg-surface px-1.5 text-ink disabled:opacity-60';
const LABEL_CLS = 'block text-[9px] text-subtle';

const READ_SERVICES: ReadonlyArray<{ value: UdsReadService; labelKey: TranslationKey }> = [
  { value: 'read_did', labelKey: 'udsPanel.bind.svc.read_did' },
  { value: 'read_mem', labelKey: 'udsPanel.bind.svc.read_mem' },
];
const WRITE_SERVICES: ReadonlyArray<{ value: UdsWriteService; labelKey: TranslationKey }> = [
  { value: 'write_did', labelKey: 'udsPanel.bind.svc.write_did' },
  { value: 'write_mem', labelKey: 'udsPanel.bind.svc.write_mem' },
  { value: 'io_control', labelKey: 'udsPanel.bind.svc.io_control' },
];
const IO_OPTIONS: ReadonlyArray<{ value: UdsIoOption; labelKey: TranslationKey }> = [
  { value: '00', labelKey: 'udsPanel.bind.io.00' },
  { value: '01', labelKey: 'udsPanel.bind.io.01' },
  { value: '02', labelKey: 'udsPanel.bind.io.02' },
  { value: '03', labelKey: 'udsPanel.bind.io.03' },
];
const BYTE_LENS: readonly UdsByteLen[] = [1, 2, 4];

function NumField({
  label,
  value,
  disabled,
  onChange,
  step = 'any',
  min,
  max,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
  step?: string;
  min?: number;
  max?: number;
}): React.JSX.Element {
  return (
    <label className="space-y-0.5">
      <span className={LABEL_CLS}>{label}</span>
      <input
        type="number"
        disabled={disabled}
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className={`${INPUT_CLS} font-mono tabular-nums`}
      />
    </label>
  );
}

function ByteLenField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: UdsByteLen;
  disabled: boolean;
  onChange: (next: UdsByteLen) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <label className="space-y-0.5">
      <span className={LABEL_CLS}>{label}</span>
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as UdsByteLen)}
        className={`${INPUT_CLS} font-mono`}
      >
        {BYTE_LENS.map((n) => (
          <option key={n} value={n}>
            {t('udsPanel.bind.byteN', { count: n })}
          </option>
        ))}
      </select>
    </label>
  );
}

function HexField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <label className="space-y-0.5">
      <span className={LABEL_CLS}>{label}</span>
      <input
        type="text"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(sanitizeHex(e.target.value))}
        className={`${INPUT_CLS} font-mono uppercase tabular-nums`}
      />
    </label>
  );
}

function ReadBlock({
  widget,
  read,
  canMutate,
}: {
  widget: UdsWidgetDto;
  read: UdsReadBinding;
  canMutate: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const patch = (p: Partial<UdsReadBinding>): void => {
    const nextRead = { ...read, ...p };
    // A textbox reads and writes the same identifier: keep the write target in sync.
    const sync =
      widget.kind === 'textbox' && widget.udsWrite
        ? {
            udsWrite: {
              ...widget.udsWrite,
              did: widget.udsWrite.did === read.did ? nextRead.did : widget.udsWrite.did,
              address:
                widget.udsWrite.address === read.address
                  ? nextRead.address
                  : widget.udsWrite.address,
            },
          }
        : {};
    patchUdsBindings(widget.id, { udsRead: nextRead, ...sync });
  };
  const dis = !canMutate;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="space-y-0.5">
          <span className={LABEL_CLS}>{t('udsPanel.bind.service')}</span>
          <select
            disabled={dis}
            value={read.service}
            onChange={(e) => patch({ service: e.target.value as UdsReadService })}
            className={INPUT_CLS}
          >
            {READ_SERVICES.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.labelKey)}
              </option>
            ))}
          </select>
        </label>
        {read.service === 'read_did' ? (
          <HexField label={t('udsPanel.bind.did')} value={read.did} disabled={dis} onChange={(v) => patch({ did: v })} />
        ) : (
          <HexField label={t('udsPanel.bind.address')} value={read.address} disabled={dis} onChange={(v) => patch({ address: v })} />
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <NumField label={t('udsPanel.bind.byteOffset')} value={read.byteOffset} disabled={dis} step="1" min={0} onChange={(v) => patch({ byteOffset: Math.max(0, Math.floor(v)) })} />
        <ByteLenField label={t('udsPanel.bind.byteLen')} value={read.byteLen} disabled={dis} onChange={(v) => patch({ byteLen: v })} />
        <label className="space-y-0.5">
          <span className={LABEL_CLS}>{t('udsPanel.bind.signed')}</span>
          <span className="flex h-6 items-center">
            <input
              type="checkbox"
              disabled={dis}
              checked={read.signed}
              onChange={(e) => patch({ signed: e.target.checked })}
              className="h-3.5 w-3.5 accent-[var(--status-focus)]"
            />
          </span>
        </label>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <NumField label={t('udsPanel.bind.factor')} value={read.factor} disabled={dis} onChange={(v) => patch({ factor: v === 0 ? 1 : v })} />
        <NumField label={t('udsPanel.bind.offset')} value={read.offset} disabled={dis} onChange={(v) => patch({ offset: v })} />
        <label className="space-y-0.5">
          <span className={LABEL_CLS}>{t('udsPanel.bind.unit')}</span>
          <input type="text" disabled={dis} value={read.unit} onChange={(e) => patch({ unit: e.target.value })} className={INPUT_CLS} />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <NumField label={t('udsPanel.bind.min')} value={read.min} disabled={dis} onChange={(v) => patch({ min: v })} />
        <NumField label={t('udsPanel.bind.max')} value={read.max} disabled={dis} onChange={(v) => patch({ max: v })} />
        <NumField label={t('udsPanel.bind.decimals')} value={read.decimals} disabled={dis} step="1" min={0} max={6} onChange={(v) => patch({ decimals: Math.max(0, Math.min(6, Math.floor(v))) })} />
      </div>

      <NumField label={t('udsPanel.bind.pollMs')} value={read.pollMs} disabled={dis} step="50" min={0} onChange={(v) => patch({ pollMs: Math.max(0, Math.floor(v)) })} />
      <p className="text-[9px] text-subtle">{t('udsPanel.bind.pollHint')}</p>
    </div>
  );
}

function WriteBlock({
  widget,
  write,
  canMutate,
}: {
  widget: UdsWidgetDto;
  write: UdsWriteBinding;
  canMutate: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const patch = (p: Partial<UdsWriteBinding>): void =>
    patchUdsBindings(widget.id, { udsWrite: { ...write, ...p } });
  const dis = !canMutate;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="space-y-0.5">
          <span className={LABEL_CLS}>{t('udsPanel.bind.service')}</span>
          <select
            disabled={dis}
            value={write.service}
            onChange={(e) => patch({ service: e.target.value as UdsWriteService })}
            className={INPUT_CLS}
          >
            {WRITE_SERVICES.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.labelKey)}
              </option>
            ))}
          </select>
        </label>
        {write.service === 'write_mem' ? (
          <HexField label={t('udsPanel.bind.address')} value={write.address} disabled={dis} onChange={(v) => patch({ address: v })} />
        ) : (
          <HexField label={t('udsPanel.bind.did')} value={write.did} disabled={dis} onChange={(v) => patch({ did: v })} />
        )}
      </div>

      {write.service === 'io_control' && (
        <label className="block space-y-0.5">
          <span className={LABEL_CLS}>{t('udsPanel.bind.ioOption')}</span>
          <select
            disabled={dis}
            value={write.ioOption}
            onChange={(e) => patch({ ioOption: e.target.value as UdsIoOption })}
            className={INPUT_CLS}
          >
            {IO_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        <ByteLenField label={t('udsPanel.bind.byteLen')} value={write.byteLen} disabled={dis} onChange={(v) => patch({ byteLen: v })} />
        <NumField label={t('udsPanel.bind.factor')} value={write.factor} disabled={dis} onChange={(v) => patch({ factor: v === 0 ? 1 : v })} />
        <NumField label={t('udsPanel.bind.offset')} value={write.offset} disabled={dis} onChange={(v) => patch({ offset: v })} />
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <NumField label={t('udsPanel.bind.writeMin')} value={write.min ?? widget.config.min ?? widget.udsRead?.min ?? 0} disabled={dis} onChange={(v) => patch({ min: v })} />
        <NumField label={t('udsPanel.bind.writeMax')} value={write.max ?? widget.config.max ?? widget.udsRead?.max ?? 0} disabled={dis} onChange={(v) => patch({ max: v })} />
      </div>
      <p className="text-[9px] text-subtle">{t('udsPanel.bind.writeClampHint')}</p>
    </div>
  );
}

/** Replaces the DBC signal picker of the shared Simulation inspector. */
export function UdsBindingSection({
  widget,
  canMutate,
}: {
  widget: UdsWidgetDto;
  canMutate: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const hasRead = widget.udsRead !== null;
  const hasWrite = widget.udsWrite !== null;
  const supportsRead = kindUsesUdsRead(widget.kind);
  const supportsWrite = kindUsesUdsWrite(widget.kind);

  const sectionHeader = (
    title: string,
    bound: boolean,
    onBind: () => void,
    onUnbind: () => void
  ): React.JSX.Element => (
    <div className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1 font-semibold uppercase text-ink">
        <Link2 className="h-3 w-3 text-focus" aria-hidden="true" />
        {title}
      </span>
      {canMutate &&
        (bound ? (
          <button
            type="button"
            onClick={onUnbind}
            className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] text-muted hover:text-critical"
          >
            <Unlink className="h-2.5 w-2.5" />
            {t('udsPanel.bind.remove')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onBind}
            className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 text-[9px] text-focus hover:border-strong"
          >
            <Plus className="h-2.5 w-2.5" />
            {t('udsPanel.bind.add')}
          </button>
        ))}
    </div>
  );

  return (
    <>
      {supportsRead && (
        <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-2.5">
          {sectionHeader(
            t('udsPanel.bind.readTitle'),
            hasRead,
            () => patchUdsBindings(widget.id, { udsRead: defaultUdsRead() }),
            () => patchUdsBindings(widget.id, { udsRead: null })
          )}
          {widget.udsRead && (
            <ReadBlock widget={widget} read={widget.udsRead} canMutate={canMutate} />
          )}
        </div>
      )}
      {supportsWrite && (
        <div className="space-y-2 rounded-[2px] border border-hairline bg-canvas p-2.5">
          {sectionHeader(
            t('udsPanel.bind.writeTitle'),
            hasWrite,
            () => patchUdsBindings(widget.id, { udsWrite: defaultUdsWrite() }),
            () => patchUdsBindings(widget.id, { udsWrite: null })
          )}
          {widget.udsWrite && (
            <WriteBlock widget={widget} write={widget.udsWrite} canMutate={canMutate} />
          )}
        </div>
      )}
    </>
  );
}
