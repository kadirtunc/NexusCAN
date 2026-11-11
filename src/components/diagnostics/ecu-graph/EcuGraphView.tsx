import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Info,
  LayoutGrid,
  Loader2,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Radar,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import { diagnosticsStore, useDiagnosticsStore } from '../../../store/diagnosticsStore';
import { activeNodeKey, ecuGraphStore, useEcuGraphStore } from '../../../store/ecuGraphStore';
import { useTelemetryHeader } from '../../../store/telemetryStore';
import { didName, formatDid } from '../../../services/udsDecode';
import {
  DIAG_BTN,
  DIAG_BTN_DANGER,
  DIAG_BTN_GHOST,
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_BTN_SM_ACTIVE,
  DIAG_CHECKBOX,
  DIAG_INPUT,
  DIAG_LABEL,
  DIAG_SECTION_TITLE,
  DIAG_SELECT,
  DIAG_TOOLBAR,
  DiagBadge,
  DiagDemoBadge,
  DiagEmptyState,
  DiagErrorNotice,
  DiagNotice,
  DiagSelectWrap,
} from '../diagUi';
import { bytesToHex } from '../diagFormat';
import {
  buildDiscoveryRequest,
  checkPdu,
  DEFAULT_DISCOVERY_PDU,
  DEFAULT_WINDOW_MS,
  defaultFunctionalId,
  idHex,
  parseId,
} from '../discoveryRequest';
import { EcuGraphCanvas, type GraphCanvasStrings } from './EcuGraphCanvas';
import { formatCanId, nodeTitle, IDENTITY_DIDS, type GraphIdentity, type GraphNode } from './graphModel';

export type GraphNavTarget = 'dtc' | 'did_inspector' | 'uds_console';

interface Props {
  onNavigate: (target: GraphNavTarget) => void;
}

function formatClock(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleTimeString() : '—';
}

const IDENTITY_LABEL: Record<keyof GraphIdentity, TranslationKey> = {
  vin: 'ecuGraph.id.vin',
  serialNumber: 'ecuGraph.id.serial',
  partNumber: 'ecuGraph.id.part',
  systemName: 'ecuGraph.id.system',
  swNumber: 'ecuGraph.id.swNumber',
  swVersion: 'ecuGraph.id.swVersion',
  hwNumber: 'ecuGraph.id.hwNumber',
};

const ICON_BTN = `${DIAG_BTN} !px-2`;
const ICON_BTN_GHOST = `${DIAG_BTN_GHOST} !px-2`;
const ICON_BTN_DANGER = `${DIAG_BTN_DANGER} !px-2`;

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-2 border-b border-hairline py-1 last:border-b-0">
    <span className="w-[104px] shrink-0 font-mono text-[11px] uppercase text-muted">{label}</span>
    <span className="min-w-0 flex-1 break-all font-mono text-[12px] tabular-nums text-ink">{children}</span>
  </div>
);

// ─── Side panel ───────────────────────────────────────────────────────────────

interface SidePanelProps {
  node: GraphNode;
  functionalId: number | null;
  isActive: boolean;
  onNavigate: (target: GraphNavTarget) => void;
}

const NodePanel: React.FC<SidePanelProps> = ({ node, functionalId, isActive, onNavigate }) => {
  const { t } = useI18n();
  const graph = useEcuGraphStore();
  const diag = useDiagnosticsStore();
  const busy = graph.busy !== null;
  const busyHere = graph.busy?.key === node.key ? graph.busy.action : null;
  const error = graph.nodeErrors[node.key] ?? null;
  const dash = <span className="text-subtle">—</span>;
  const needsActiveTitle = isActive ? undefined : t('ecuGraph.makeActiveFirst');
  const currentSession = isActive ? diag.session.udsSession : node.lastSession;
  const spin = <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />;

  const statusBadge = node.pending ? (
    <DiagBadge tone="warn">{t('diagReal.disc.pending')}</DiagBadge>
  ) : node.positive ? (
    <DiagBadge tone="nominal">{t('diagReal.disc.positive')}</DiagBadge>
  ) : (
    <DiagBadge tone="critical">
      {node.nrc !== null ? `0x${node.nrc.toString(16).toUpperCase().padStart(2, '0')} ` : ''}
      {node.nrcName ?? 'NRC'}
    </DiagBadge>
  );

  const mappedDids = new Set(IDENTITY_DIDS.map((m) => m.did));
  const otherDids = node.dids.filter((d) => !mappedDids.has(d.did));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-ink" title={nodeTitle(node)}>
            {nodeTitle(node)}
          </span>
          {isActive && <DiagBadge tone="focus">{t('ecuGraph.active')}</DiagBadge>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {statusBadge}
          {!node.lastScanSeen && <DiagBadge tone="neutral">{t('ecuGraph.notSeenLong')}</DiagBadge>}
          {node.dtcCount !== null && (
            <DiagBadge tone={node.dtcCount > 0 ? 'critical' : 'nominal'}>
              DTC {node.dtcCount}
            </DiagBadge>
          )}
        </div>
      </div>

      {/* Access */}
      <section className="space-y-2">
        <div className={DIAG_SECTION_TITLE}>{t('ecuGraph.sec.access')}</div>
        <button
          type="button"
          className={isActive ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_PRIMARY}
          disabled={isActive || busy || node.requestId === null || diag.connecting}
          onClick={() => void ecuGraphStore.makeActive(node.key, functionalId)}
        >
          {busyHere === 'connect' ? spin : <Plug className="h-3.5 w-3.5" aria-hidden="true" />}
          {isActive ? t('ecuGraph.isActive') : t('ecuGraph.makeActive')}
        </button>
        {node.requestId === null && (
          <p className="text-[11.5px] text-warn">{t('ecuGraph.noRequestIdHint')}</p>
        )}
        {isActive && diag.lastError && <DiagErrorNotice error={diag.lastError} onDismiss={() => diagnosticsStore.clearError()} />}
        {!isActive && diag.session.connected && (
          <p className="text-[11.5px] text-subtle">{t('ecuGraph.switchHint')}</p>
        )}
      </section>

      {/* Quick actions */}
      <section className="space-y-2">
        <div className={DIAG_SECTION_TITLE}>{t('ecuGraph.sec.actions')}</div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={DIAG_BTN_SM}
            disabled={busy}
            title={needsActiveTitle}
            onClick={() => void ecuGraphStore.readIdentification(node.key)}
          >
            {busyHere === 'identify' && spin}
            {t('ecuGraph.readIdent')}
          </button>
          <button
            type="button"
            className={DIAG_BTN_SM}
            disabled={busy}
            title={needsActiveTitle}
            onClick={() => void ecuGraphStore.readDtcs(node.key)}
          >
            {busyHere === 'dtc' && spin}
            {t('ecuGraph.readDtc')}
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] uppercase text-muted">{t('ecuGraph.session')}</span>
          <button
            type="button"
            className={isActive && currentSession === 'default' ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_SM}
            disabled={busy}
            title={needsActiveTitle}
            onClick={() => void ecuGraphStore.setSession(node.key, 'default')}
          >
            {t('ecuGraph.sessDefault')}
          </button>
          <button
            type="button"
            className={isActive && currentSession === 'extended' ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_SM}
            disabled={busy}
            title={needsActiveTitle}
            onClick={() => void ecuGraphStore.setSession(node.key, 'extended')}
          >
            {t('ecuGraph.sessExtended')}
          </button>
        </div>
        {!isActive && <p className="text-[11.5px] text-subtle">{t('ecuGraph.makeActiveFirst')}</p>}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={DIAG_BTN_SM} disabled={!isActive} title={needsActiveTitle} onClick={() => onNavigate('did_inspector')}>
            {t('ecuGraph.openDid')}
          </button>
          <button type="button" className={DIAG_BTN_SM} disabled={!isActive} title={needsActiveTitle} onClick={() => onNavigate('dtc')}>
            {t('ecuGraph.openDtc')}
          </button>
          <button type="button" className={DIAG_BTN_SM} disabled={!isActive} title={needsActiveTitle} onClick={() => onNavigate('uds_console')}>
            {t('ecuGraph.openConsole')}
          </button>
        </div>
        {error && (
          <DiagNotice tone="critical">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <button type="button" className={DIAG_BTN_SM} onClick={() => ecuGraphStore.clearNodeError(node.key)}>
                ×
              </button>
            </div>
          </DiagNotice>
        )}
      </section>

      {/* Identity */}
      <section className="space-y-1">
        <div className={DIAG_SECTION_TITLE}>{t('ecuGraph.sec.identity')}</div>
        <div className="rounded-[2px] border border-hairline bg-canvas px-2">
          {IDENTITY_DIDS.map((m) => (
            <Row key={m.did} label={`${t(IDENTITY_LABEL[m.field])} ${formatDid(m.did).slice(2)}`}>
              {node.identity[m.field] ?? dash}
            </Row>
          ))}
        </div>
        {node.identifyError && (
          <p className="text-[11.5px] text-warn">
            {t('ecuGraph.identifyError')}: {node.identifyError}
          </p>
        )}
        {otherDids.length > 0 && (
          <div className="rounded-[2px] border border-hairline bg-canvas px-2">
            {otherDids.map((d) => (
              <Row key={d.did} label={formatDid(d.did).slice(2)}>
                <span title={didName(d.did) ?? undefined}>{d.text}</span>
              </Row>
            ))}
          </div>
        )}
      </section>

      {/* Addressing */}
      <section className="space-y-1">
        <div className={DIAG_SECTION_TITLE}>{t('ecuGraph.sec.addressing')}</div>
        <div className="rounded-[2px] border border-hairline bg-canvas px-2">
          <Row label={t('ecuGraph.row.bus')}>{node.busId}</Row>
          <Row label={t('ecuGraph.row.mode')}>{node.isExtendedId ? '29-bit' : '11-bit'}</Row>
          <Row label={t('diagReal.disc.colReq')}>
            {node.requestId === null ? dash : formatCanId(node.requestId, node.isExtendedId)}
          </Row>
          <Row label={t('diagReal.disc.colResp')}>{formatCanId(node.responseId, node.isExtendedId)}</Row>
          <Row label={t('ecuGraph.row.firstResponse')}>{(node.firstResponseUs / 1000).toFixed(2)} ms</Row>
          <Row label={t('ecuGraph.row.firstSeen')}>{formatClock(node.firstSeenMs)}</Row>
          <Row label={t('ecuGraph.row.lastSeen')}>{formatClock(node.lastSeenMs)}</Row>
          <Row label={t('ecuGraph.row.raw')}>{node.raw.length > 0 ? bytesToHex(node.raw) : dash}</Row>
        </div>
      </section>

      <section className="flex flex-wrap gap-1.5">
        {node.pinned && (
          <button type="button" className={DIAG_BTN_SM} onClick={() => ecuGraphStore.unpinNode(node.key)}>
            {t('ecuGraph.unpin')}
          </button>
        )}
        <button
          type="button"
          className={`${DIAG_BTN_SM} !text-critical`}
          disabled={isActive}
          title={isActive ? t('ecuGraph.removeActive') : undefined}
          onClick={() => ecuGraphStore.removeNode(node.key)}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          {t('ecuGraph.removeNode')}
        </button>
      </section>
    </div>
  );
};

// ─── View ─────────────────────────────────────────────────────────────────────

export const EcuGraphView: React.FC<Props> = ({ onNavigate }) => {
  const { t } = useI18n();
  const graph = useEcuGraphStore();
  const diag = useDiagnosticsStore();
  const header = useTelemetryHeader();
  const { mockMode, discovering, discoveryError, session } = diag;

  const connectedBuses = header.buses.filter((b) => b.connected);
  const busOptions =
    connectedBuses.length > 0 || !mockMode ? connectedBuses.map((b) => b.busId) : Array.from({ length: 8 }, (_, i) => i);

  const [busId, setBusId] = useState(graph.busId);
  const [isExtended, setIsExtended] = useState(false);
  const [funcInput, setFuncInput] = useState(idHex(defaultFunctionalId(false), false));
  const [pduInput, setPduInput] = useState(DEFAULT_DISCOVERY_PDU);
  const [windowInput, setWindowInput] = useState(String(DEFAULT_WINDOW_MS));
  const [identify, setIdentify] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fitNonce, setFitNonce] = useState(0);

  const useFd = session.config.useFd ?? false;
  const padding = session.config.padding === undefined ? 0xaa : session.config.padding;

  useEffect(() => {
    if (busOptions.length === 0 || busOptions.includes(busId)) return;
    setBusId(busOptions[0]);
  }, [busOptions, busId]);

  // Graph scope = (demo | real, bus). Real and demo graphs never mix.
  useEffect(() => {
    ecuGraphStore.setScope(mockMode, busId);
  }, [mockMode, busId]);

  const selectedBus = connectedBuses.find((b) => b.busId === busId) ?? null;
  const needsArm = !mockMode && selectedBus !== null && (selectedBus.listenOnly || !selectedBus.txArmed);
  const noBus = !mockMode && connectedBuses.length === 0;
  const blocked = noBus || needsArm;

  const pdu = useMemo(() => checkPdu(pduInput, useFd), [pduInput, useFd]);
  const pduError = pdu.ok
    ? null
    : pdu.error === 'hex'
      ? t('diagReal.uds.invalidHex', { token: pdu.token ?? '' })
      : pdu.error === 'length'
        ? t('diagReal.disc.pduLength', { max: useFd ? 62 : 7 })
        : t('diagReal.disc.pduSuppressed');

  const functionalId = parseId(funcInput);
  const funcLabel = functionalId === null ? funcInput.trim() || '—' : idHex(functionalId, isExtended);

  function switchAddressing(ext: boolean) {
    setIsExtended(ext);
    setFuncInput(idHex(defaultFunctionalId(ext), ext));
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
    });
    if (!built.ok) {
      if (built.field === 'pdu') return setFormError(pduError);
      const field =
        built.field === 'functionalId' ? t('diagReal.disc.functionalId') : `${t('diagReal.disc.window')} 50..5000`;
      return setFormError(t('diagReal.disc.invalidInput', { field }));
    }
    setFormError(null);
    void ecuGraphStore.scan(built.request);
  }

  function handleClear() {
    if (graph.nodes.length === 0 || window.confirm(t('ecuGraph.clearConfirm'))) ecuGraphStore.clearGraph();
  }

  function handleRelayoutAll() {
    if (window.confirm(t('ecuGraph.relayoutAllConfirm'))) {
      ecuGraphStore.relayout(true);
      setFitNonce((n) => n + 1);
    }
  }

  const onSelect = useCallback((key: string | null) => ecuGraphStore.select(key), []);
  const onMove = useCallback((key: string, pos: { x: number; y: number }) => ecuGraphStore.moveNode(key, pos), []);
  const onActivate = useCallback(
    (key: string) => {
      ecuGraphStore.select(key);
      setPanelOpen(true);
      void ecuGraphStore.makeActive(key, parseId(funcInput));
    },
    [funcInput],
  );

  const activeKey = session.connected ? activeNodeKey() : null;
  const strings = useMemo<GraphCanvasStrings>(
    () => ({
      tester: t('ecuGraph.tester', { n: busId }),
      testerSub: t('ecuGraph.testerSub', { id: funcLabel }),
      active: t('ecuGraph.active'),
      notSeen: t('ecuGraph.notSeen'),
      seen: t('ecuGraph.cv.seen'),
      pending: t('ecuGraph.pending'),
      dtc: 'DTC',
      ariaLabel: t('ecuGraph.aria'),
    }),
    [t, busId, funcLabel],
  );

  const renderTooltip = useCallback(
    (n: GraphNode): React.ReactNode => (
      <div className="space-y-0.5">
        <div className="font-semibold">{nodeTitle(n)}</div>
        <div className="text-focus">
          {n.requestId === null ? '—' : formatCanId(n.requestId, n.isExtendedId)}/{formatCanId(n.responseId, n.isExtendedId)}
        </div>
        <div className="text-muted">
          {n.pending
            ? t('diagReal.disc.pending')
            : n.positive
              ? t('diagReal.disc.positive')
              : `NRC ${n.nrc !== null ? '0x' + n.nrc.toString(16).toUpperCase().padStart(2, '0') : ''} ${n.nrcName ?? ''}`}
          {' · '}
          {(n.firstResponseUs / 1000).toFixed(2)} ms
        </div>
        {n.identity.partNumber && <div className="text-muted">{n.identity.partNumber}</div>}
        {!n.lastScanSeen && <div className="text-warn">{t('ecuGraph.notSeenLong')}</div>}
        <div className="pt-0.5 text-subtle">{t('ecuGraph.tooltipHint')}</div>
      </div>
    ),
    [t],
  );

  const selected = graph.nodes.find((n) => n.key === graph.selectedKey) ?? null;
  const last = graph.lastScan;
  const hasPinned = graph.nodes.some((n) => n.pinned);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className={`${DIAG_TOOLBAR} !h-auto flex-wrap gap-y-2 !gap-x-2 py-2`}>
        <div className="flex items-center gap-2">
          <Radar className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          {mockMode && <DiagDemoBadge />}
        </div>

        <label className="flex items-center gap-1.5" title={t('ecuGraph.bus')}>
          <DiagSelectWrap chevron={<span aria-hidden="true">▾</span>}>
            <select
              value={busId}
              onChange={(e) => setBusId(Number(e.target.value))}
              disabled={discovering || busOptions.length === 0}
              className={`${DIAG_SELECT} !w-[84px]`}
            >
              {busOptions.map((id) => (
                <option key={id} value={id}>
                  {t('diagHmi.setup.bus', { n: id })}
                </option>
              ))}
            </select>
          </DiagSelectWrap>
        </label>

        <div className="flex items-center gap-1">
          <button type="button" className={!isExtended ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_SM} disabled={discovering} onClick={() => switchAddressing(false)}>
            11-bit
          </button>
          <button type="button" className={isExtended ? DIAG_BTN_SM_ACTIVE : DIAG_BTN_SM} disabled={discovering} onClick={() => switchAddressing(true)}>
            29-bit
          </button>
        </div>

        <label className="flex items-center gap-1.5">
          <span className={DIAG_LABEL} title={t('diagReal.disc.functionalId')}>{t('ecuGraph.funcShort')}</span>
          <input
            type="text"
            value={funcInput}
            onChange={(e) => setFuncInput(e.target.value)}
            disabled={discovering}
            className={`${DIAG_INPUT} !w-[104px]`}
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className={DIAG_LABEL}>PDU</span>
          <input
            type="text"
            value={pduInput}
            onChange={(e) => setPduInput(e.target.value)}
            disabled={discovering}
            aria-invalid={pduError !== null}
            className={`${DIAG_INPUT} !w-[96px] ${pduError ? '!border-[color:var(--status-critical)]' : ''}`}
          />
        </label>
        <label className="flex items-center gap-1.5" title={t('diagReal.disc.window')}>
          <span className={DIAG_LABEL}>{t('ecuGraph.windowMs')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={windowInput}
            onChange={(e) => setWindowInput(e.target.value)}
            disabled={discovering}
            className={`${DIAG_INPUT} !w-[56px]`}
          />
        </label>
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={identify}
            onChange={(e) => setIdentify(e.target.checked)}
            disabled={discovering}
            className={DIAG_CHECKBOX}
          />
          <span>{t('ecuGraph.identify')}</span>
        </label>

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

        <div className="flex-1" />

        <button type="button" className={ICON_BTN} onClick={() => ecuGraphStore.relayout(false)} disabled={graph.nodes.length === 0} title={`${t('ecuGraph.relayout')}: ${t('ecuGraph.relayoutHint')}`} aria-label={t('ecuGraph.relayout')}>
          <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" className={ICON_BTN_GHOST} onClick={handleRelayoutAll} disabled={!hasPinned} title={`${t('ecuGraph.relayoutAll')}: ${t('ecuGraph.relayoutAllHint')}`} aria-label={t('ecuGraph.relayoutAll')}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" className={ICON_BTN} onClick={() => setFitNonce((n) => n + 1)} title={t('ecuGraph.fit')} aria-label={t('ecuGraph.fit')}>
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" className={ICON_BTN_DANGER} onClick={handleClear} disabled={graph.nodes.length === 0} title={t('ecuGraph.clear')} aria-label={t('ecuGraph.clear')}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={ICON_BTN_GHOST}
          onClick={() => setPanelOpen((v) => !v)}
          aria-pressed={panelOpen}
          title={panelOpen ? t('ecuGraph.collapsePanel') : t('ecuGraph.expandPanel')}
          aria-label={panelOpen ? t('ecuGraph.collapsePanel') : t('ecuGraph.expandPanel')}
        >
          {panelOpen ? <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" /> : <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>

      {/* Notices + summary */}
      {(blocked || formError || pduError || discoveryError) && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-hairline bg-canvas px-3.5 py-2">
          {blocked && (
            <DiagNotice tone="warn" icon={<Info className="h-4 w-4 shrink-0" aria-hidden="true" />}>
              {noBus ? t('diagReal.session.noBus') : t('diagReal.session.armHint')}
            </DiagNotice>
          )}
          {(formError || pduError) && <p className="text-[12px] text-critical">{formError ?? pduError}</p>}
          {discoveryError && <DiagErrorNotice error={discoveryError} onDismiss={() => diagnosticsStore.clearDiscovery()} />}
        </div>
      )}
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-3.5 font-mono text-[11.5px] tabular-nums text-muted">
        {last ? (
          <span>
            {t('ecuGraph.summary', {
              n: last.count,
              added: last.added,
              time: formatClock(last.atMs),
              window: last.windowMs,
              ignored: last.ignoredFrames,
            })}
          </span>
        ) : (
          <span className="text-subtle">{t('ecuGraph.noScanYet')}</span>
        )}
        <span className="flex-1" />
        <span>{t('ecuGraph.nodeCount', { n: graph.nodes.length })}</span>
        {mockMode && <span className="text-warn">{t('diagReal.disc.demoNote')}</span>}
      </div>

      {/* Canvas + side panel */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <EcuGraphCanvas
            key={`${mockMode ? 'demo' : 'real'}:${graph.busId}`}
            nodes={graph.nodes}
            selectedKey={graph.selectedKey}
            activeKey={activeKey}
            strings={strings}
            fitNonce={fitNonce}
            onSelect={onSelect}
            onMove={onMove}
            onActivate={onActivate}
            renderTooltip={renderTooltip}
          />
          {graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-[96px] flex justify-center">
              <DiagEmptyState title={t('ecuGraph.emptyTitle')} hint={t('ecuGraph.emptyHint')} />
            </div>
          )}
        </div>
        {panelOpen && (
          <aside
            className="flex w-[340px] shrink-0 flex-col border-l border-hairline bg-surface"
            aria-label={t('ecuGraph.panelTitle')}
          >
            <div className="flex h-8 shrink-0 items-center border-b border-hairline bg-elevated px-3">
              <span className={DIAG_SECTION_TITLE}>{t('ecuGraph.panelTitle')}</span>
            </div>
            {selected ? (
              <NodePanel
                key={selected.key}
                node={selected}
                functionalId={functionalId}
                isActive={activeKey === selected.key}
                onNavigate={onNavigate}
              />
            ) : (
              <DiagEmptyState title={t('ecuGraph.noSelection')} hint={t('ecuGraph.noSelectionHint')} />
            )}
          </aside>
        )}
      </div>
    </div>
  );
};
