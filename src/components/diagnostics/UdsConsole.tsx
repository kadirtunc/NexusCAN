import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Send, Terminal, Zap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import type { UdsAddressing } from '../../types/udsClient';
import { UDS_SERVICES } from '../../types/diagnostics';
import {
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_INPUT,
  DIAG_LABEL,
  DIAG_SELECT,
  DIAG_SUBBAR,
  DIAG_TITLE,
  DiagBadge,
  DiagDemoBadge,
  DiagEmptyState,
  DiagErrorNotice,
  DiagSelectWrap,
} from './diagUi';
import { interpretUdsResponse } from '../../services/udsDecode';
import { bytesToHex, formatElapsedMs, parseHexBytes, toHex } from './diagFormat';

const QUICK_PRESETS = [
  { label: 'Tester Present', sid: 0x3e, subFn: 0x00, data: '' },
  { label: 'Session Default', sid: 0x10, subFn: 0x01, data: '' },
  { label: 'Session Extended', sid: 0x10, subFn: 0x03, data: '' },
  { label: 'Read VIN', sid: 0x22, subFn: null, data: 'F1 90' },
  { label: 'Comm Control OFF', sid: 0x28, subFn: 0x03, data: '01' },
  { label: 'DTC Setting OFF', sid: 0x85, subFn: 0x02, data: '' },
  { label: 'DTC Setting ON', sid: 0x85, subFn: 0x01, data: '' },
  { label: 'Erase Memory', sid: 0x31, subFn: 0x01, data: 'FF 00' },
  { label: 'Session Programming', sid: 0x10, subFn: 0x02, data: '' },
  { label: 'ECU Hard Reset', sid: 0x11, subFn: 0x01, data: '' },
];

export const UdsConsole: React.FC = () => {
  const { t } = useI18n();
  const state = useDiagnosticsStore();
  const { session, lastUds, lastError, mockMode, consoleDraft } = state;
  const connected = session.connected;
  const hasFunctional = session.config.functionalId !== null && session.config.functionalId !== undefined;

  const [selectedSid, setSelectedSid] = useState(0x3e);
  const [subFnInput, setSubFnInput] = useState('00');
  const [dataInput, setDataInput] = useState('');
  const [addressing, setAddressing] = useState<UdsAddressing>('physical');
  const [isSending, setIsSending] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const selectedService = UDS_SERVICES.find((s) => s.sid === selectedSid);
  const effectiveAddressing: UdsAddressing = hasFunctional ? addressing : 'physical';

  // "Resend in Console" from the Traffic Dock: apply the queued prefill once.
  useEffect(() => {
    if (consoleDraft === null) return;
    setSelectedSid(consoleDraft.sid);
    setSubFnInput(consoleDraft.subFn !== null ? toHex(consoleDraft.subFn) : '');
    setDataInput(bytesToHex(consoleDraft.data));
    setAddressing(consoleDraft.addressing);
    setInputError(null);
    diagnosticsStore.clearConsoleDraft();
  }, [consoleDraft]);

  async function handleSend() {
    if (!connected || isSending) return;
    let subFn: number | null = null;
    if (selectedService?.hasSubFunction) {
      const raw = subFnInput.trim().replace(/^0x/i, '');
      const parsed = raw.length === 0 ? 0 : /^[0-9a-fA-F]{1,2}$/.test(raw) ? parseInt(raw, 16) : NaN;
      if (Number.isNaN(parsed)) {
        setInputError(t('diagReal.uds.invalidSub'));
        return;
      }
      subFn = parsed;
    }
    const data = parseHexBytes(dataInput);
    if (!data.ok) {
      setInputError(t('diagReal.uds.invalidHex', { token: data.token }));
      return;
    }
    setInputError(null);
    setIsSending(true);
    try {
      await diagnosticsStore.sendUds(selectedSid, subFn, data.bytes, effectiveAddressing);
    } finally {
      setIsSending(false);
    }
  }

  function applyPreset(preset: (typeof QUICK_PRESETS)[0]) {
    setSelectedSid(preset.sid);
    setSubFnInput(preset.subFn !== null ? toHex(preset.subFn) : '');
    setDataInput(preset.data);
    setInputError(null);
  }

  const response = lastUds?.response ?? null;
  const interpretation = useMemo(
    () => (lastUds && response && response.raw.length > 0 ? interpretUdsResponse(lastUds.requestBytes, response.raw) : null),
    [lastUds, response],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Top split: Request + Response */}
      <div className="flex min-h-[272px] flex-1 border-b border-hairline">
        {/* Left: Request */}
        <div className="flex w-1/2 flex-col border-r border-hairline">
          <div className={DIAG_SUBBAR}>
            <Send className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <h2 className={DIAG_TITLE}>{t('diag.uds.title')}</h2>
            <div className="flex-1" />
            {mockMode && <DiagDemoBadge />}
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
            <div className="grid grid-cols-2 gap-2.5">
              {/* Service ID */}
              <label className="flex flex-col gap-1">
                <span className={DIAG_LABEL}>{t('diag.uds.service')}</span>
                <DiagSelectWrap chevron={<ChevronDown className="h-3 w-3" aria-hidden="true" />}>
                  <select
                    value={selectedSid}
                    onChange={(e) => setSelectedSid(Number(e.target.value))}
                    disabled={!connected}
                    className={DIAG_SELECT}
                  >
                    {UDS_SERVICES.map((s) => (
                      <option key={s.sid} value={s.sid}>
                        0x{toHex(s.sid)} {s.name}
                      </option>
                    ))}
                  </select>
                </DiagSelectWrap>
              </label>

              {/* Sub-Function */}
              <label className="flex flex-col gap-1">
                <span className={DIAG_LABEL}>{t('diag.uds.subFunction')}</span>
                <input
                  type="text"
                  value={subFnInput}
                  onChange={(e) => setSubFnInput(e.target.value)}
                  disabled={!connected || !selectedService?.hasSubFunction}
                  placeholder="00"
                  className={DIAG_INPUT}
                />
              </label>
            </div>

            {/* Data + addressing */}
            <div className="grid grid-cols-[1fr_auto] gap-2.5">
              <label className="flex flex-col gap-1">
                <span className={DIAG_LABEL}>{t('diag.uds.data')}</span>
                <input
                  type="text"
                  value={dataInput}
                  onChange={(e) => setDataInput(e.target.value)}
                  disabled={!connected}
                  placeholder="F1 90"
                  className={DIAG_INPUT}
                />
              </label>
              {hasFunctional && (
                <label className="flex flex-col gap-1">
                  <span className={DIAG_LABEL}>{t('diagReal.uds.addressing')}</span>
                  <DiagSelectWrap chevron={<ChevronDown className="h-3 w-3" aria-hidden="true" />}>
                    <select
                      value={addressing}
                      onChange={(e) => setAddressing(e.target.value === 'functional' ? 'functional' : 'physical')}
                      disabled={!connected}
                      className={`${DIAG_SELECT} !w-36`}
                    >
                      <option value="physical">{t('diagReal.uds.physical')}</option>
                      <option value="functional">{t('diagReal.uds.functional')}</option>
                    </select>
                  </DiagSelectWrap>
                </label>
              )}
            </div>

            {inputError && <p className="text-[12px] text-critical">{inputError}</p>}

            {/* Quick presets + Send */}
            <div className="mt-auto flex flex-wrap items-center gap-1.5">
              {QUICK_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  disabled={!connected}
                  className={DIAG_BTN_SM}
                >
                  <Zap className="h-2.5 w-2.5" aria-hidden="true" />
                  {p.label}
                </button>
              ))}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!connected || isSending}
                className={DIAG_BTN_PRIMARY}
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                {t('diag.uds.send')}
              </button>
            </div>
          </div>
        </div>

        {/* Right: Response */}
        <div className="flex w-1/2 flex-col">
          <div className={DIAG_SUBBAR}>
            <Terminal className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
            <h2 className={DIAG_TITLE}>{t('diag.uds.response')}</h2>
          </div>

          {!lastUds ? (
            <DiagEmptyState title={t('diag.uds.pending')} />
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {/* Request echo */}
              <div className="flex items-start gap-2">
                <span className={`${DIAG_LABEL} shrink-0 pt-0.5`}>{t('diagReal.uds.request')}</span>
                <span className="break-all font-mono text-[12px] tabular-nums text-muted">
                  {bytesToHex(lastUds.requestBytes)}
                </span>
              </div>

              {lastUds.error && <DiagErrorNotice error={lastUds.error} />}

              {response && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {response.suppressed ? (
                      <DiagBadge tone="neutral">{t('diagReal.uds.suppressed')}</DiagBadge>
                    ) : response.positive ? (
                      <DiagBadge tone="nominal">{t('diag.uds.positive')}</DiagBadge>
                    ) : (
                      <DiagBadge tone="critical">
                        {t('diag.uds.negative')}
                        {response.nrc !== null ? ` 0x${toHex(response.nrc)}` : ''}
                      </DiagBadge>
                    )}
                    {!response.positive && response.nrcName && (
                      <span className="font-mono text-[12px] font-semibold text-critical">{response.nrcName}</span>
                    )}
                  </div>

                  <div className="break-all rounded-[2px] border border-hairline bg-surface p-2 font-mono text-[12px] tabular-nums text-ink">
                    {response.raw.length > 0 ? bytesToHex(response.raw) : '—'}
                  </div>

                  {interpretation && interpretation.kind !== 'unknown' && (
                    <div className="space-y-0.5 rounded-[2px] border border-hairline bg-canvas px-2 py-1.5">
                      <div className={DIAG_LABEL}>{t('diagReal.uds.decoded')}</div>
                      <div className="break-all font-mono text-[12px] tabular-nums text-muted">{interpretation.title}</div>
                      {interpretation.value !== null && (
                        <div className="break-all font-mono text-[14px] font-semibold tabular-nums text-ink">
                          {interpretation.value}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11.5px] tabular-nums text-subtle">
                    <span>
                      {t('diagReal.uds.pendingCount')}: <span className={response.responsePendingCount > 0 ? 'text-warn' : 'text-muted'}>{response.responsePendingCount}</span>
                    </span>
                    <span>
                      {t('diagReal.uds.elapsed')}: <span className="text-muted">{formatElapsedMs(response.elapsedUs)}</span>
                    </span>
                    <span>
                      #{response.transactionSeq}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {lastError && lastUds?.error !== lastError && (
        <div className="shrink-0 border-b border-hairline bg-canvas px-3 py-1.5">
          <DiagErrorNotice error={lastError} onDismiss={() => diagnosticsStore.clearError()} />
        </div>
      )}

    </div>
  );
};
