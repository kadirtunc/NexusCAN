import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Info, Loader2, Radar } from 'lucide-react';
import { useI18n } from '../../i18n';
import { MAX_DIAG_TABS, diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import type { DiscoveredEcuDto } from '../../types/udsClient';
import {
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_CHECKBOX,
  DIAG_GRID,
  DIAG_INPUT,
  DIAG_LABEL,
  DIAG_PANEL,
  DIAG_ROW_HOVER,
  DIAG_SECTION_TITLE,
  DiagBadge,
  DiagDemoBadge,
  DiagErrorNotice,
  DiagNotice,
} from './diagUi';
import { bytesToHex, toHex } from './diagFormat';
import {
  buildDiscoveryRequest,
  checkPdu,
  DEFAULT_DISCOVERY_PDU as DEFAULT_PDU,
  defaultFunctionalId,
  idHex,
} from './discoveryRequest';

interface Props {
  busId: number;
  isExtended: boolean;
  useFd: boolean;
  /** ISO-TP padding byte or `null` (no padding), same as the session form. */
  padding: number | null;
  /** A UDS session is open: "Use" is disabled. */
  sessionLocked: boolean;
  noBus: boolean;
  needsArm: boolean;
  onUse: (requestId: number | null, responseId: number, isExtended: boolean) => void;
}

export const EcuDiscoveryPanel: React.FC<Props> = ({
  busId,
  isExtended,
  useFd,
  padding,
  sessionLocked,
  noBus,
  needsArm,
  onUse,
}) => {
  const { t } = useI18n();
  const { discovery, discovering, discoveryError, mockMode, tabs } = useDiagnosticsStore();

  const [funcInput, setFuncInput] = useState(idHex(defaultFunctionalId(isExtended), isExtended));
  const [pduInput, setPduInput] = useState(DEFAULT_PDU);
  const [windowInput, setWindowInput] = useState('300');
  const [respIdInput, setRespIdInput] = useState('');
  const [respMaskInput, setRespMaskInput] = useState('');
  const [identify, setIdentify] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setFuncInput(idHex(defaultFunctionalId(isExtended), isExtended));
  }, [isExtended]);

  const pdu = useMemo(() => checkPdu(pduInput, useFd), [pduInput, useFd]);
  const pduError = pdu.ok
    ? null
    : pdu.error === 'hex'
      ? t('diagReal.uds.invalidHex', { token: pdu.token ?? '' })
      : pdu.error === 'length'
        ? t('diagReal.disc.pduLength', { max: useFd ? 62 : 7 })
        : t('diagReal.disc.pduSuppressed');

  const blocked = noBus || needsArm;

  /** New session tab pre-filled with the ECU's ids; an identical-addressing tab is just activated. */
  function openSession(requestId: number | null, responseId: number, ext: boolean) {
    if (requestId === null) return;
    diagnosticsStore.openTabForConfig({
      requestId,
      responseId,
      busId,
      isExtendedId: ext,
      protocol: 'uds',
      useFd,
      padding,
    });
  }
  function openSessionTitle(requestId: number | null, responseId: number, ext: boolean): string {
    if (requestId === null) return t('diagTabs.openNoRequest');
    const existing = diagnosticsStore.findTabByAddressing({
      requestId,
      responseId,
      busId,
      isExtendedId: ext,
      protocol: 'uds',
    });
    if (existing) return t('diagTabs.openExisting', { label: existing.label });
    if (tabs.length >= MAX_DIAG_TABS) return t('diagTabs.limit', { max: MAX_DIAG_TABS });
    return t('diagTabs.openHint');
  }
  function canOpenSession(requestId: number | null, responseId: number, ext: boolean): boolean {
    if (requestId === null) return false;
    if (tabs.length < MAX_DIAG_TABS) return true;
    return (
      diagnosticsStore.findTabByAddressing({ requestId, responseId, busId, isExtendedId: ext, protocol: 'uds' }) !== null
    );
  }

  function handleScan() {
    const built = buildDiscoveryRequest({
      busId,
      isExtended,
      useFd,
      padding,
      identify,
      funcInput,
      pduInput,
      windowInput,
      respIdInput,
      respMaskInput,
    });
    if (!built.ok) {
      if (built.field === 'pdu') return setFormError(pduError);
      const field =
        built.field === 'functionalId'
          ? t('diagReal.disc.functionalId')
          : built.field === 'window'
            ? `${t('diagReal.disc.window')} 50..5000`
            : built.field === 'respId'
              ? t('diagReal.disc.respId')
              : t('diagReal.disc.respMask');
      return setFormError(t('diagReal.disc.invalidInput', { field }));
    }
    setFormError(null);
    void diagnosticsStore.discoverEcus(built.request);
  }

  function statusCell(e: DiscoveredEcuDto): React.ReactNode {
    return (
      <span className="flex items-center gap-1">
        {e.pending ? (
          <DiagBadge tone="warn">{t('diagReal.disc.pending')}</DiagBadge>
        ) : e.positive ? (
          <DiagBadge tone="nominal">{t('diagReal.disc.positive')}</DiagBadge>
        ) : (
          <DiagBadge tone="critical">
            {e.nrc !== null ? `0x${toHex(e.nrc)} ` : ''}
            {e.nrcName ?? 'NRC'}
          </DiagBadge>
        )}
        {e.multiFrame && <DiagBadge tone="neutral">{t('diagReal.disc.multiFrame')}</DiagBadge>}
      </span>
    );
  }

  const dash = <span className="text-subtle">—</span>;

  return (
    <div className={`${DIAG_PANEL} space-y-3 p-4`}>
      <div className="flex items-center gap-2">
        <Radar className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
        <span className={DIAG_SECTION_TITLE}>{t('diagReal.disc.title')}</span>
        <div className="flex-1" />
        {mockMode && <DiagDemoBadge />}
      </div>
      <p className="text-[12px] leading-relaxed text-muted">{t('diagReal.disc.hint')}</p>

      {(noBus || needsArm) && (
        <DiagNotice tone="warn" icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" />}>
          {noBus ? t('diagReal.session.noBus') : t('diagReal.session.armHint')}
        </DiagNotice>
      )}

      <div className="grid grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className={DIAG_LABEL}>{t('diagReal.disc.functionalId')}</span>
          <input
            type="text"
            value={funcInput}
            onChange={(e) => setFuncInput(e.target.value)}
            disabled={discovering}
            className={DIAG_INPUT}
            placeholder={isExtended ? '0x18DB33F1' : '0x7DF'}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={DIAG_LABEL}>{t('diagReal.disc.pdu')}</span>
          <input
            type="text"
            value={pduInput}
            onChange={(e) => setPduInput(e.target.value)}
            disabled={discovering}
            aria-invalid={pduError !== null}
            className={`${DIAG_INPUT} ${pduError ? '!border-[color:var(--status-critical)]' : ''}`}
            placeholder={DEFAULT_PDU}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={DIAG_LABEL}>{t('diagReal.disc.window')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={windowInput}
            onChange={(e) => setWindowInput(e.target.value)}
            disabled={discovering}
            className={DIAG_INPUT}
            placeholder="300"
          />
        </label>
      </div>
      {pduError && <p className="text-[12px] text-critical">{pduError}</p>}
      <p className="text-[11.5px] text-subtle">{t('diagReal.disc.pduHint')}</p>

      <div className="grid grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className={DIAG_LABEL}>{t('diagReal.disc.respId')}</span>
          <input
            type="text"
            value={respIdInput}
            onChange={(e) => setRespIdInput(e.target.value)}
            disabled={discovering}
            className={DIAG_INPUT}
            placeholder={isExtended ? '0x18DAF100' : '0x7E8'}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={DIAG_LABEL}>{t('diagReal.disc.respMask')}</span>
          <input
            type="text"
            value={respMaskInput}
            onChange={(e) => setRespMaskInput(e.target.value)}
            disabled={discovering}
            className={DIAG_INPUT}
            placeholder={isExtended ? '0x1FFFFF00' : '0x7F8'}
          />
        </label>
        <label className="flex cursor-pointer select-none items-center gap-2 self-end rounded-[2px] border border-hairline bg-canvas px-2.5 py-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={identify}
            onChange={(e) => setIdentify(e.target.checked)}
            disabled={discovering}
            className={DIAG_CHECKBOX}
          />
          <span>{t('diagReal.disc.identify')}</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleScan}
          disabled={discovering || blocked || pduError !== null}
          className={DIAG_BTN_PRIMARY}
        >
          {discovering ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Radar className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {discovering ? t('diagReal.disc.scanning') : t('diagReal.disc.scan')}
        </button>
        {formError && <span className="text-[12px] text-critical">{formError}</span>}
      </div>

      {discoveryError && <DiagErrorNotice error={discoveryError} />}

      {discovery && (
        <div className="space-y-2">
          {discovery.ecus.length === 0 ? (
            <p className="text-[12px] text-subtle">{t('diagReal.disc.none')}</p>
          ) : (
            <div className="overflow-x-auto rounded-[2px] border border-hairline bg-surface">
              <table className={`${DIAG_GRID} min-w-[1090px]`}>
                <colgroup>
                  <col style={{ width: 110 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 190 }} />
                  <col style={{ width: 170 }} />
                  <col style={{ width: 80 }} />
                  <col style={{ width: 170 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 170 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>{t('diagReal.disc.colResp')}</th>
                    <th>{t('diagReal.disc.colReq')}</th>
                    <th className="font-sans">{t('diagReal.disc.colStatus')}</th>
                    <th>{t('diagReal.disc.colRaw')}</th>
                    <th>{t('diagReal.disc.colTime')}</th>
                    <th>{t('diagReal.disc.colVin')}</th>
                    <th>{t('diagReal.disc.colSerial')}</th>
                    <th>{t('diagReal.disc.colPart')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {discovery.ecus.map((e) => (
                    <tr key={`${e.responseId}-${e.isExtendedId ? 'x' : 's'}`} className={DIAG_ROW_HOVER}>
                      <td>
                        <div className="pcan-cell text-focus">{idHex(e.responseId, e.isExtendedId)}</div>
                      </td>
                      <td>
                        <div className="pcan-cell text-ink">
                          {e.requestId === null ? dash : idHex(e.requestId, e.isExtendedId)}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell font-sans">{statusCell(e)}</div>
                      </td>
                      <td>
                        <div className="pcan-cell text-[11.5px] text-muted" title={bytesToHex(e.raw)}>
                          {bytesToHex(e.raw)}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell text-[11.5px] text-muted">
                          {(e.firstResponseUs / 1000).toFixed(2)} ms
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell text-ink" title={e.identifyError ?? e.vin ?? ''}>
                          {e.vin ?? (e.identifyError ? <span className="text-warn">!</span> : dash)}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell text-ink" title={e.identifyError ?? e.serialNumber ?? ''}>
                          {e.serialNumber ?? dash}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell text-ink" title={e.identifyError ?? e.partNumber ?? ''}>
                          {e.partNumber ?? dash}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell pcan-cell-right gap-1">
                          <button
                            type="button"
                            disabled={!canOpenSession(e.requestId, e.responseId, e.isExtendedId)}
                            title={openSessionTitle(e.requestId, e.responseId, e.isExtendedId)}
                            onClick={() => openSession(e.requestId, e.responseId, e.isExtendedId)}
                            className={DIAG_BTN_SM}
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            {t('diagTabs.openSession')}
                          </button>
                          <button
                            type="button"
                            disabled={sessionLocked}
                            title={sessionLocked ? t('diagReal.disc.useLocked') : undefined}
                            onClick={() => onUse(e.requestId, e.responseId, e.isExtendedId)}
                            className={DIAG_BTN_SM}
                          >
                            {t('diagReal.disc.use')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="font-mono text-[11.5px] tabular-nums text-subtle">
            {t('diagReal.disc.summary', {
              request: bytesToHex(discovery.requestBytes),
              window: discovery.windowMs,
              ignored: discovery.ignoredFrames,
            })}
          </p>
          {mockMode && <p className="text-[11.5px] text-warn">{t('diagReal.disc.demoNote')}</p>}
        </div>
      )}
    </div>
  );
};
