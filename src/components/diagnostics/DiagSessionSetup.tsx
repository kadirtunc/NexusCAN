import React, { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Cpu, Info, Settings, Wifi, XCircle, Zap } from 'lucide-react';
import { useI18n } from '../../i18n';
import { diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import { useTelemetryHeader } from '../../store/telemetryStore';
import type { DiagProtocol, DiagSessionConfig } from '../../types/diagnostics';
import {
  DIAG_BTN_DANGER,
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_BTN_SM_ACTIVE,
  DIAG_CHECKBOX,
  DIAG_INPUT,
  DIAG_LABEL,
  DIAG_PANEL,
  DIAG_SELECT,
  DIAG_SECTION_TITLE,
  DIAG_TITLE,
  DIAG_TOOLBAR,
  DiagBadge,
  DiagDemoBadge,
  DiagDot,
  DiagErrorNotice,
  DiagNotice,
  DiagSelectWrap,
  type DiagTone,
} from './diagUi';
import { sessionLabel, toHex } from './diagFormat';
import { EcuDiscoveryPanel } from './EcuDiscoveryPanel';
import { suggestResponseId, validateSessionIds, type IdFieldError } from './sessionValidation';

const PRESETS: Array<{ labelKey: string; config: Partial<DiagSessionConfig> }> = [
  {
    labelKey: 'diag.session.preset.obd2std',
    config: { requestId: 0x7e0, responseId: 0x7e8, isExtendedId: false, protocol: 'obd2' },
  },
  {
    labelKey: 'diag.session.preset.j1939',
    config: { requestId: 0x18db33f1, responseId: 0x18daf100, isExtendedId: true, protocol: 'uds' },
  },
];

function hexInput(val: number): string {
  return '0x' + val.toString(16).toUpperCase().padStart(3, '0');
}

function parseHexInput(s: string): number | null {
  const clean = s.replace(/^0x/i, '').trim();
  const n = parseInt(clean, 16);
  return isNaN(n) ? null : n;
}

const WARN_TEXT = 'text-[11.5px] text-[color:var(--status-warn)]';

const SESSION_TONE: Record<string, DiagTone> = {
  default: 'neutral',
  extended: 'warn',
  programming: 'critical',
};

export const DiagSessionSetup: React.FC = () => {
  const { t } = useI18n();
  const state = useDiagnosticsStore();
  const header = useTelemetryHeader();
  const { session, mockMode, sessionInfo, connecting, lastError, duplicateOfTabId, tabs } = state;
  const duplicateTab = duplicateOfTabId === null ? null : (tabs.find((tb) => tb.id === duplicateOfTabId) ?? null);
  const { config } = session;
  const locked = session.connected || connecting;

  const [txIdInput, setTxIdInput] = useState(hexInput(config.requestId));
  const [rxIdInput, setRxIdInput] = useState(hexInput(config.responseId));
  const [busId, setBusId] = useState(config.busId);
  const [protocol, setProtocol] = useState<DiagProtocol>(config.protocol);
  const [isExtended, setIsExtended] = useState(config.isExtendedId);
  const [funcIdInput, setFuncIdInput] = useState(
    config.functionalId === null || config.functionalId === undefined ? '' : hexInput(config.functionalId),
  );
  const [useFd, setUseFd] = useState(config.useFd ?? false);
  const [paddingOn, setPaddingOn] = useState(config.padding !== null);
  const [paddingInput, setPaddingInput] = useState(toHex(config.padding ?? 0xaa));
  const [p2MarginInput, setP2MarginInput] = useState(String(config.p2MarginMs ?? 100));
  const [tpIntervalInput, setTpIntervalInput] = useState('2000');
  // The response id is auto-filled (request + 8) only while the user has not edited it.
  const [rxTouched, setRxTouched] = useState(
    config.responseId !== config.requestId + 8 || suggestResponseId(config.requestId, config.isExtendedId) === null,
  );

  const ids = validateSessionIds(txIdInput, rxIdInput, isExtended);
  const suggestedResponse = suggestResponseId(ids.requestValue, isExtended);

  // Real mode: only connected buses are selectable (Demo: any bus when none is connected).
  const connectedBuses = header.buses.filter((b) => b.connected);
  const busOptions =
    connectedBuses.length > 0 || !mockMode
      ? connectedBuses.map((b) => b.busId)
      : Array.from({ length: 8 }, (_, i) => i);
  const selectedBus = connectedBuses.find((b) => b.busId === busId) ?? null;
  const needsArm = !mockMode && selectedBus !== null && (selectedBus.listenOnly || !selectedBus.txArmed);
  const noBus = !mockMode && connectedBuses.length === 0;

  useEffect(() => {
    if (locked || busOptions.length === 0 || busOptions.includes(busId)) return;
    setBusId(busOptions[0]);
  }, [locked, busOptions, busId]);

  function idErrorText(err: IdFieldError | null, fieldLabel: string): string | null {
    if (err === null) return null;
    if (err === 'badHex') return t('diagTabs.val.badHex', { field: fieldLabel });
    return err === 'range11'
      ? t('diagTabs.val.range11', { field: fieldLabel })
      : t('diagTabs.val.range29', { field: fieldLabel });
  }
  const reqLabel = t('diag.session.requestId');
  const respLabel = t('diag.session.responseId');
  const requestErrorText = idErrorText(ids.requestError, reqLabel);
  const responseErrorText =
    idErrorText(ids.responseError, respLabel) ?? (ids.sameIds ? t('diagTabs.val.sameIds') : null);

  function handleRequestChange(value: string) {
    setTxIdInput(value);
    if (rxTouched) return;
    const sug = suggestResponseId(validateSessionIds(value, '0', isExtended).requestValue, isExtended);
    if (sug !== null) setRxIdInput(hexInput(sug));
  }

  function handleResponseChange(value: string) {
    setRxTouched(true);
    setRxIdInput(value);
  }

  function buildConfig(): DiagSessionConfig {
    const funcRaw = funcIdInput.trim();
    const padParsed = parseHexInput(paddingInput);
    const margin = parseInt(p2MarginInput, 10);
    return {
      requestId: ids.requestValue ?? config.requestId,
      responseId: ids.responseValue ?? config.responseId,
      busId,
      isExtendedId: isExtended,
      protocol,
      functionalId: funcRaw.length > 0 ? parseHexInput(funcRaw) : null,
      useFd,
      padding: paddingOn ? (padParsed !== null ? padParsed & 0xff : 0xaa) : null,
      p2MarginMs: Number.isFinite(margin) && margin >= 0 ? margin : 100,
      // Not editable in this form: carried over (e.g. from an ECU registry record) so the form never drops them.
      addressFormat: config.addressFormat,
      targetAddress: config.targetAddress,
      responseAddress: config.responseAddress,
    };
  }

  // Keep the (not yet connected) form in the tab so switching tabs never loses edits and the tab strip
  // shows the pending addressing. The store ignores this while connected / connecting.
  const formSig = [txIdInput, rxIdInput, busId, protocol, isExtended, funcIdInput, useFd, paddingOn, paddingInput, p2MarginInput].join('|');
  useEffect(() => {
    if (locked || ids.hasError) return;
    diagnosticsStore.updateConfig(buildConfig());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSig, locked]);

  function handleConnect() {
    void diagnosticsStore.connect(buildConfig());
  }

  function handleDisconnect() {
    void diagnosticsStore.disconnect();
  }

  function applyTesterPresent(enabled: boolean) {
    const interval = parseInt(tpIntervalInput, 10);
    void diagnosticsStore.setTesterPresent(enabled, Number.isFinite(interval) && interval > 0 ? interval : null);
  }

  function applyPreset(partial: Partial<DiagSessionConfig>) {
    if (partial.requestId !== undefined) setTxIdInput(hexInput(partial.requestId));
    if (partial.responseId !== undefined) {
      setRxIdInput(hexInput(partial.responseId));
      setRxTouched(true);
    }
    if (partial.isExtendedId !== undefined) setIsExtended(partial.isExtendedId);
    if (partial.protocol !== undefined) setProtocol(partial.protocol);
  }

  const activeCode = sessionInfo
    ? sessionInfo.activeSession
    : session.udsSession === 'extended'
      ? 0x03
      : session.udsSession === 'programming'
        ? 0x02
        : 0x01;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Toolbar */}
      <div className={DIAG_TOOLBAR}>
        <Settings className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
        <h2 className={DIAG_TITLE}>{t('diag.session.title')}</h2>
        {session.connected && (
          <DiagBadge tone={SESSION_TONE[session.udsSession] ?? 'neutral'}>{sessionLabel(activeCode)}</DiagBadge>
        )}
        <div className="flex-1" />
        {mockMode && <DiagDemoBadge />}
        {session.connected ? (
          <button type="button" onClick={handleDisconnect} className={DIAG_BTN_DANGER}>
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('diag.session.disconnect')}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting || noBus || ids.hasError}
            title={ids.hasError ? (requestErrorText ?? responseErrorText ?? undefined) : undefined}
            className={DIAG_BTN_PRIMARY}
          >
            <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
            {connecting ? t('diagReal.session.connecting') : t('diag.session.connect')}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {lastError && duplicateTab === null && (
            <DiagErrorNotice error={lastError} onDismiss={() => diagnosticsStore.clearError()} />
          )}
          {lastError && duplicateTab !== null && (
            <DiagNotice tone="critical" icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" />}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-words">{t('diagTabs.err.duplicate', { detail: duplicateTab.label })}</span>
                <button
                  type="button"
                  onClick={() => diagnosticsStore.setActiveTab(duplicateTab.id)}
                  className={DIAG_BTN_SM}
                >
                  {t('diagTabs.dup.switch')}
                </button>
                <button type="button" onClick={() => diagnosticsStore.clearError()} className={DIAG_BTN_SM}>
                  {t('diagReal.error.dismiss')}
                </button>
              </div>
            </DiagNotice>
          )}
          {noBus && (
            <DiagNotice tone="warn" icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" />}>
              {t('diagReal.session.noBus')}
            </DiagNotice>
          )}
          {needsArm && (
            <DiagNotice tone="warn" icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" />}>
              {t('diagReal.session.armHint')}
            </DiagNotice>
          )}

          {/* Config grid */}
          <div className={`${DIAG_PANEL} grid grid-cols-2 gap-3.5 p-4`}>
            {/* Request ID (Tester -> ECU) */}
            <label className="flex flex-col gap-1">
              <span className={DIAG_LABEL}>{reqLabel}</span>
              <input
                type="text"
                value={txIdInput}
                onChange={(e) => handleRequestChange(e.target.value)}
                disabled={locked}
                aria-invalid={requestErrorText !== null}
                className={`${DIAG_INPUT} ${requestErrorText ? '!border-[color:var(--status-warn)]' : ''}`}
                placeholder="0x7E0"
              />
              {requestErrorText && <span className={WARN_TEXT}>{requestErrorText}</span>}
            </label>

            {/* Response ID (ECU -> Tester) */}
            <label className="flex flex-col gap-1">
              <span className={DIAG_LABEL}>{respLabel}</span>
              <input
                type="text"
                value={rxIdInput}
                onChange={(e) => handleResponseChange(e.target.value)}
                disabled={locked}
                aria-invalid={responseErrorText !== null}
                className={`${DIAG_INPUT} ${responseErrorText ? '!border-[color:var(--status-warn)]' : ''}`}
                placeholder="0x7E8"
              />
              {responseErrorText && <span className={WARN_TEXT}>{responseErrorText}</span>}
              {!responseErrorText && suggestedResponse !== null && !locked && (
                <span className="flex items-center gap-2 text-[11.5px] text-muted">
                  {rxTouched && ids.responseValue !== suggestedResponse ? (
                    <>
                      <span>{t('diagTabs.val.suggest', { id: hexInput(suggestedResponse) })}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setRxTouched(false);
                          setRxIdInput(hexInput(suggestedResponse));
                        }}
                        className={DIAG_BTN_SM}
                      >
                        {t('diagTabs.val.apply')}
                      </button>
                    </>
                  ) : (
                    !rxTouched && <span>{t('diagTabs.val.autoFilled')}</span>
                  )}
                </span>
              )}
            </label>

            {/* Bus ID */}
            <label className="flex flex-col gap-1">
              <span className={DIAG_LABEL}>{t('diag.session.busId')}</span>
              <DiagSelectWrap chevron={<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}>
                <select
                  value={busId}
                  onChange={(e) => setBusId(Number(e.target.value))}
                  disabled={locked}
                  className={DIAG_SELECT}
                >
                  {busOptions.length === 0 && <option value={busId}>{t('diagHmi.setup.bus', { n: busId + 1 })}</option>}
                  {busOptions.map((id) => (
                    <option key={id} value={id}>
                      {t('diagHmi.setup.bus', { n: id + 1 })}
                    </option>
                  ))}
                </select>
              </DiagSelectWrap>
            </label>

            {/* Protocol */}
            <label className="flex flex-col gap-1">
              <span className={DIAG_LABEL}>{t('diag.session.protocol')}</span>
              <DiagSelectWrap chevron={<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}>
                <select
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value as DiagProtocol)}
                  disabled={locked}
                  className={DIAG_SELECT}
                >
                  <option value="obd2">OBD-II (SAE J1979)</option>
                  <option value="uds">UDS (ISO 14229)</option>
                </select>
              </DiagSelectWrap>
            </label>

            {/* Extended ID */}
            <label className="col-span-2 flex cursor-pointer select-none items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-2.5 py-2 text-[12px] text-ink">
              <input
                type="checkbox"
                checked={isExtended}
                onChange={(e) => setIsExtended(e.target.checked)}
                disabled={locked}
                className={DIAG_CHECKBOX}
              />
              <span>{t('diagHmi.setup.extendedId')}</span>
            </label>

            {/* D-003 optional connection fields */}
            <div className="col-span-2 border-t border-hairline pt-3">
              <span className={DIAG_SECTION_TITLE}>{t('diagReal.session.advanced')}</span>
            </div>

            <label className="flex flex-col gap-1">
              <span className={DIAG_LABEL}>{t('diagReal.session.functionalId')}</span>
              <input
                type="text"
                value={funcIdInput}
                onChange={(e) => setFuncIdInput(e.target.value)}
                disabled={locked}
                className={DIAG_INPUT}
                placeholder="0x7DF"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className={DIAG_LABEL}>{t('diagReal.session.p2Margin')}</span>
              <input
                type="text"
                inputMode="numeric"
                value={p2MarginInput}
                onChange={(e) => setP2MarginInput(e.target.value)}
                disabled={locked}
                className={DIAG_INPUT}
                placeholder="100"
              />
            </label>

            <label className="flex cursor-pointer select-none items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-2.5 py-2 text-[12px] text-ink">
              <input
                type="checkbox"
                checked={useFd}
                onChange={(e) => setUseFd(e.target.checked)}
                disabled={locked}
                className={DIAG_CHECKBOX}
              />
              <span>{t('diagReal.session.useFd')}</span>
            </label>

            <div className="flex items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-2.5 py-1">
              <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={paddingOn}
                  onChange={(e) => setPaddingOn(e.target.checked)}
                  disabled={locked}
                  className={DIAG_CHECKBOX}
                />
                <span>{t('diagReal.session.padding')}</span>
              </label>
              <input
                type="text"
                value={paddingInput}
                onChange={(e) => setPaddingInput(e.target.value)}
                disabled={locked || !paddingOn}
                aria-label={t('diagReal.session.paddingByte')}
                title={t('diagReal.session.paddingByte')}
                className={`${DIAG_INPUT} ml-auto !w-16 text-center`}
                placeholder="AA"
              />
            </div>
          </div>

          {/* Connect / session behaviour (what actually goes on the wire) */}
          <DiagNotice tone="focus" icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" />}>
            <p>{t('diagReal.session.connectNote')}</p>
            <p className="mt-1">{t('diagReal.session.sessionNote')}</p>
          </DiagNotice>

          {/* Functional ECU discovery (works without an open session) */}
          <EcuDiscoveryPanel
            busId={busId}
            isExtended={isExtended}
            useFd={useFd}
            padding={paddingOn ? (parseHexInput(paddingInput) ?? 0xaa) & 0xff : null}
            sessionLocked={session.connected || connecting}
            noBus={noBus}
            needsArm={needsArm}
            onUse={(requestId, responseId, ext) => {
              if (requestId !== null) setTxIdInput(hexInput(requestId));
              setRxIdInput(hexInput(responseId));
              setRxTouched(true);
              setIsExtended(ext);
            }}
          />

          {/* Presets */}
          <div className={`${DIAG_PANEL} p-3`}>
            <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('diag.session.presets')}</div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.labelKey}
                  type="button"
                  onClick={() => applyPreset(preset.config)}
                  disabled={locked}
                  className={DIAG_BTN_SM}
                >
                  {t(preset.labelKey as Parameters<typeof t>[0])}
                </button>
              ))}
            </div>
          </div>

          {/* Demo mode */}
          <label className="flex cursor-pointer select-none items-center gap-2 rounded-[2px] border border-hairline bg-surface px-3 py-2.5 text-[12px] text-ink">
            <input
              type="checkbox"
              checked={mockMode}
              onChange={() => diagnosticsStore.setMockMode(!mockMode)}
              disabled={connecting}
              className={DIAG_CHECKBOX}
            />
            <span>{t('diag.session.mockMode')}</span>
            {mockMode && <DiagDemoBadge />}
          </label>

          {/* Status card */}
          {session.connected && (
            <DiagNotice
              tone="nominal"
              icon={<CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">{t('diag.session.connected')}</span>
                <span className="font-mono tabular-nums text-muted">
                  {t('diagTabs.reqShort')} 0x{config.requestId.toString(16).toUpperCase()} →{' '}
                  {t('diagTabs.respShort')} 0x{config.responseId.toString(16).toUpperCase()}
                </span>
                {session.testerPresentActive && (
                  <DiagBadge tone="focus">
                    <DiagDot tone="focus" pulse />
                    {t('diag.session.testerPresent')}
                  </DiagBadge>
                )}
              </div>

              {/* UDS session switcher */}
              {config.protocol === 'uds' && (
                <div className="mt-2 flex items-center gap-2">
                  <span className={DIAG_SECTION_TITLE}>{t('diag.session.udsSession')}</span>
                  {(
                    [
                      ['default', 0x01],
                      ['extended', 0x03],
                      ['programming', 0x02],
                    ] as const
                  ).map(([name, code]) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => void diagnosticsStore.setUdsSession(name)}
                      className={activeCode === code ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_SM}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}

              {/* TesterPresent background keep-alive */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    checked={session.testerPresentActive}
                    onChange={(e) => applyTesterPresent(e.target.checked)}
                    className={DIAG_CHECKBOX}
                  />
                  <span>{t('diagReal.session.tpToggle')}</span>
                </label>
                <span className={DIAG_SECTION_TITLE}>{t('diagReal.session.tpInterval')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={tpIntervalInput}
                  onChange={(e) => setTpIntervalInput(e.target.value)}
                  className={`${DIAG_INPUT} !w-20 text-center`}
                  aria-label={t('diagReal.session.tpInterval')}
                />
                {session.testerPresentActive && (
                  <button type="button" onClick={() => applyTesterPresent(true)} className={DIAG_BTN_SM}>
                    {t('diagReal.session.tpApply')}
                  </button>
                )}
              </div>
            </DiagNotice>
          )}

          {/* DiagSessionInfoDto (real mode) */}
          {session.connected && sessionInfo && (
            <div className={`${DIAG_PANEL} p-3`}>
              <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('diagReal.session.infoTitle')}</div>
              <dl className="grid grid-cols-4 gap-3 font-mono text-[12px] tabular-nums">
                <div className="flex flex-col gap-1">
                  <dt className={DIAG_LABEL}>{t('diagReal.session.infoActive')}</dt>
                  <dd>
                    <DiagBadge tone={SESSION_TONE[session.udsSession] ?? 'neutral'}>
                      {sessionLabel(sessionInfo.activeSession)}
                    </DiagBadge>
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className={DIAG_LABEL}>{t('diagReal.session.infoSecurity')}</dt>
                  <dd>
                    {sessionInfo.unlockedLevel === null ? (
                      <DiagBadge tone="neutral">{t('diagReal.session.infoLocked')}</DiagBadge>
                    ) : (
                      <DiagBadge tone="nominal">
                        {t('diagReal.session.infoUnlocked', { level: toHex(sessionInfo.unlockedLevel) })}
                      </DiagBadge>
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className={DIAG_LABEL}>{t('diagReal.session.infoP2')}</dt>
                  <dd className="text-ink">
                    {sessionInfo.p2ServerMs === null ? (
                      <span className="text-subtle">{t('diagReal.session.infoNotReported')}</span>
                    ) : (
                      `${sessionInfo.p2ServerMs} ms`
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className={DIAG_LABEL}>{t('diagReal.session.infoP2Star')}</dt>
                  <dd className="text-ink">
                    {sessionInfo.p2StarServerMs === null ? (
                      <span className="text-subtle">{t('diagReal.session.infoNotReported')}</span>
                    ) : (
                      `${sessionInfo.p2StarServerMs} ms`
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {/* Info card */}
          <div className={`${DIAG_PANEL} p-3`}>
            <div className="mb-2 flex items-center gap-2">
              <Info className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              <span className={DIAG_SECTION_TITLE}>{t('diagHmi.setup.howTitle')}</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Cpu className="h-3 w-3 text-focus" aria-hidden="true" />
                  <span className="font-mono text-[12px] font-semibold text-ink">ISO-TP</span>
                </div>
                <p className="text-[12px] leading-relaxed text-muted">{t('diagHmi.setup.isotpDesc')}</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3 w-3 text-warn" aria-hidden="true" />
                  <span className="font-mono text-[12px] font-semibold text-ink">OBD-II</span>
                </div>
                <p className="text-[12px] leading-relaxed text-muted">{t('diagHmi.setup.obdDesc')}</p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Settings className="h-3 w-3 text-nominal" aria-hidden="true" />
                  <span className="font-mono text-[12px] font-semibold text-ink">UDS</span>
                </div>
                <p className="text-[12px] leading-relaxed text-muted">{t('diagHmi.setup.udsDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
