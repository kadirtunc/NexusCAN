import React, { useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import type { DtcEntryDto } from '../../types/diagnostics';
import {
  DIAG_BTN,
  DIAG_BTN_DANGER,
  DIAG_BTN_GHOST,
  DIAG_BTN_PRIMARY,
  DIAG_GRID,
  DIAG_ROW_HOVER,
  DIAG_SECTION_TITLE,
  DIAG_TITLE,
  DIAG_TOOLBAR,
  DiagBadge,
  DiagDemoBadge,
  DiagEmptyState,
  DiagErrorNotice,
  DiagNotice,
} from './diagUi';

type TFn = ReturnType<typeof useI18n>['t'];

const DtcRow: React.FC<{ dtc: DtcEntryDto; t: TFn }> = ({ dtc, t }) => (
  <tr className={DIAG_ROW_HOVER}>
    <td>
      <div className="pcan-cell font-bold text-ink">{dtc.code}</div>
    </td>
    <td>
      <div className="pcan-cell">
        {dtc.isConfirmed ? (
          <DiagBadge tone="critical">{t('diag.dtc.confirmed')}</DiagBadge>
        ) : dtc.isPending ? (
          <DiagBadge tone="warn">{t('diag.dtc.pending_badge')}</DiagBadge>
        ) : (
          <span className="text-subtle">—</span>
        )}
      </div>
    </td>
    <td>
      <div className="pcan-cell pcan-cell-center">
        {dtc.isMilOn ? <DiagBadge tone="warn">{t('diag.dtc.milOn')}</DiagBadge> : <span className="text-subtle">—</span>}
      </div>
    </td>
    <td>
      <div className="pcan-cell font-sans text-muted" title={dtc.description ?? undefined}>
        {dtc.description ?? '—'}
      </div>
    </td>
  </tr>
);

const DtcTable: React.FC<{ dtcs: DtcEntryDto[]; t: TFn }> = ({ dtcs, t }) => (
  <div className="overflow-hidden rounded-[2px] border border-hairline bg-surface">
    <table className={DIAG_GRID}>
      <colgroup>
        <col style={{ width: 110 }} />
        <col style={{ width: 130 }} />
        <col style={{ width: 80 }} />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th>{t('diag.dtc.colCode')}</th>
          <th>{t('diag.dtc.colStatus')}</th>
          <th className="text-center">{t('diag.dtc.colMil')}</th>
          <th className="font-sans">{t('diag.dtc.colDescription')}</th>
        </tr>
      </thead>
      <tbody>
        {dtcs.map((dtc) => (
          <DtcRow key={dtc.code} dtc={dtc} t={t} />
        ))}
      </tbody>
    </table>
  </div>
);

export const DtcPanel: React.FC = () => {
  const { t } = useI18n();
  const state = useDiagnosticsStore();
  const { session, storedDtcs, pendingDtcs, isScanning, lastError, mockMode } = state;
  const [confirmClear, setConfirmClear] = useState(false);

  const disabled = !session.connected;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Toolbar */}
      <div className={DIAG_TOOLBAR}>
        <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
        <h2 className={DIAG_TITLE}>{t('diag.dtc.title')}</h2>

        <div className="flex-1" />
        {mockMode && <DiagDemoBadge />}

        <button
          type="button"
          disabled={disabled || isScanning}
          onClick={() => void diagnosticsStore.scanDtcs()}
          className={DIAG_BTN}
        >
          {isScanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isScanning ? t('diag.dtc.scanning') : t('diag.dtc.scan')}
        </button>

        <button
          type="button"
          disabled={disabled || (storedDtcs.length === 0 && pendingDtcs.length === 0)}
          onClick={() => setConfirmClear(true)}
          className={DIAG_BTN_DANGER}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diag.dtc.clear')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          {/* Not connected notice */}
          {disabled && (
            <DiagNotice tone="warn" icon={<AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />}>
              {t('diag.error.notConnected')}
            </DiagNotice>
          )}

          {lastError && (
            <DiagErrorNotice error={lastError} onDismiss={() => diagnosticsStore.clearError()} />
          )}

          {/* Confirm clear */}
          {confirmClear && (
            <DiagNotice tone="critical" icon={<AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />}>
              <div className="flex items-center justify-between gap-3">
                <span>{t('diag.dtc.clearConfirm')}</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setConfirmClear(false)} className={DIAG_BTN_GHOST}>
                    {t('diagHmi.dtc.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void diagnosticsStore.clearDtcs();
                      setConfirmClear(false);
                    }}
                    className={DIAG_BTN_PRIMARY}
                  >
                    {t('diagHmi.dtc.clearAction')}
                  </button>
                </div>
              </div>
            </DiagNotice>
          )}

          {/* Stored DTCs */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className={DIAG_SECTION_TITLE}>{t('diag.dtc.stored')}</span>
              {storedDtcs.length > 0 && <DiagBadge tone="critical">{storedDtcs.length}</DiagBadge>}
            </div>
            {storedDtcs.length === 0 && !isScanning ? (
              <div className="rounded-[2px] border border-hairline bg-surface">
                <DiagEmptyState title={t('diag.dtc.empty')} />
              </div>
            ) : isScanning ? (
              <div className="rounded-[2px] border border-hairline bg-surface">
                <DiagEmptyState
                  icon={<Loader2 className="h-4 w-4 animate-spin text-focus" aria-hidden="true" />}
                  title={t('diag.dtc.scanning')}
                />
              </div>
            ) : (
              <DtcTable dtcs={storedDtcs} t={t} />
            )}
          </div>

          {/* Pending DTCs */}
          {(pendingDtcs.length > 0 || (!isScanning && session.connected)) && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className={DIAG_SECTION_TITLE}>{t('diag.dtc.pending')}</span>
                {pendingDtcs.length > 0 && <DiagBadge tone="warn">{pendingDtcs.length}</DiagBadge>}
              </div>
              {pendingDtcs.length === 0 ? (
                <div className="rounded-[2px] border border-hairline bg-surface">
                  <DiagEmptyState title={t('diag.dtc.empty')} />
                </div>
              ) : (
                <DtcTable dtcs={pendingDtcs} t={t} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
