import React from 'react';
import { Database, Plus } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import type { UdsReadBinding } from '../../../types/uds';
import { addUdsWidget } from './udsPanelActions';

interface QuickDid {
  did: string;
  labelKey: TranslationKey;
  unit: string;
  min: number;
  max: number;
  /** ASCII identifiers become a textbox (ascii display); fixedLength e.g. 17 for the VIN. */
  ascii?: { fixedLength?: number };
}

/** Standard / common data identifiers offered as one-click read widgets. */
const QUICK_DIDS: readonly QuickDid[] = [
  { did: 'F190', labelKey: 'udsPanel.quick.vin', unit: '', min: 0, max: 1, ascii: { fixedLength: 17 } },
  { did: 'F18C', labelKey: 'udsPanel.quick.serial', unit: '', min: 0, max: 1, ascii: {} },
  { did: 'F187', labelKey: 'udsPanel.quick.partNumber', unit: '', min: 0, max: 1, ascii: {} },
  { did: 'F188', labelKey: 'udsPanel.quick.swNumber', unit: '', min: 0, max: 1, ascii: {} },
  { did: 'F189', labelKey: 'udsPanel.quick.ecuSwVersion', unit: '', min: 0, max: 1, ascii: {} },
  { did: 'F191', labelKey: 'udsPanel.quick.hwNumber', unit: '', min: 0, max: 1, ascii: {} },
  { did: 'F195', labelKey: 'udsPanel.quick.supplierSw', unit: '', min: 0, max: 1, ascii: {} },
  { did: 'F186', labelKey: 'udsPanel.quick.session', unit: '', min: 1, max: 4 },
  { did: 'F105', labelKey: 'udsPanel.quick.rpm', unit: 'RPM', min: 0, max: 8000 },
  { did: 'F106', labelKey: 'udsPanel.quick.coolant', unit: '°C', min: 0, max: 130 },
  { did: 'F107', labelKey: 'udsPanel.quick.speed', unit: 'km/h', min: 0, max: 300 },
  { did: 'F108', labelKey: 'udsPanel.quick.battery', unit: 'V', min: 10, max: 16 },
  { did: 'F10A', labelKey: 'udsPanel.quick.iat', unit: '°C', min: -40, max: 80 },
  { did: '2201', labelKey: 'udsPanel.quick.fanRelay', unit: '', min: 0, max: 1 },
  { did: '2202', labelKey: 'udsPanel.quick.acRelay', unit: '', min: 0, max: 1 },
];

/** Data-source browser of the UDS palette (replaces the DBC signal browser of the Simulation palette). */
export function UdsQuickDidList(): React.JSX.Element {
  const { t } = useI18n();

  const addQuick = (q: QuickDid): void => {
    const read: Partial<UdsReadBinding> = {
      service: 'read_did',
      did: q.did,
      unit: q.unit,
      min: q.min,
      max: q.max,
      decimals: q.max - q.min <= 20 ? 1 : 0,
    };
    if (q.ascii) {
      addUdsWidget('textbox', {
        title: t(q.labelKey),
        readOverride: read,
        configOverride: {
          textMode: 'display',
          textFormat: 'ascii',
          textByteLen: q.ascii.fixedLength ?? 0,
          fixedLength: q.ascii.fixedLength,
          padByte: 0x00,
        },
      });
      return;
    }
    addUdsWidget('numeric', { title: t(q.labelKey), readOverride: read });
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-hairline bg-elevated px-3 py-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider tabular-nums text-ink">
          <Database className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
          {t('udsPanel.quick.header', { count: QUICK_DIDS.length })}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="divide-y divide-hairline rounded-[2px] border border-hairline bg-canvas">
          {QUICK_DIDS.map((q) => (
            <div
              key={q.did}
              className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 font-mono text-[11.5px] tabular-nums hover:bg-surface"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-ink">{t(q.labelKey)}</div>
                <div className="truncate text-[10px] text-subtle">
                  0x22 · {q.did}{q.ascii ? ' · ASCII' : ''}
                  {q.unit ? ` [${q.unit}]` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => addQuick(q)}
                title={t('udsPanel.quick.addTooltip', { did: q.did })}
                className="inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 text-[10px] font-semibold text-ink hover:border-strong"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                {t('udsPanel.quick.addBtn')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
