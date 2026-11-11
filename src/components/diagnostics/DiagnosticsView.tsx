import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, ChevronRight, Cpu, FileSearch, FlaskConical, Gauge, Network, Terminal, Wifi, Workflow } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import { DIAG_DIVIDER, DiagBadge, DiagDemoBadge, DiagDot, DiagNotice } from './diagUi';
import { sessionLabel } from './diagFormat';
import { diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import { DiagSessionSetup } from './DiagSessionSetup';
import { DtcPanel } from './DtcPanel';
import { DidInspector } from './DidInspector';
import { LivePidGauges } from './LivePidGauges';
import { UdsConsole } from './UdsConsole';
import { UdsFlowEditor } from './UdsFlowEditor';
import { UdsInstrumentPanel } from './uds-panel/UdsInstrumentPanel';
import { TrafficDock } from './traffic/TrafficDock';
import { EcuGraphView, type GraphNavTarget } from './ecu-graph/EcuGraphView';

export type DiagSubTab = 'session' | 'ecu_graph' | 'dtc' | 'live_pids' | 'uds_console' | 'did_inspector' | 'uds_flow' | 'uds_panel';

// ECU Simulator sekmesi kullanıcı kararıyla arayüzden kaldırıldı (kod korunuyor:
// ./ecu-sim/EcuSimulator.tsx, ./ecu-sim/ecuSimStore.ts). Gerekçe ve yeniden açma kriterleri:
// planning/backlog-deferred.md → D-004.

interface SubTabDef {
  id: DiagSubTab;
  labelKey: TranslationKey;
  icon: React.ReactNode;
}

const SUB_TABS: SubTabDef[] = [
  { id: 'session',       labelKey: 'diagHmi.tab.session',       icon: <Wifi className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'ecu_graph',     labelKey: 'diagHmi.tab.ecuGraph',      icon: <Network className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'dtc',           labelKey: 'diagHmi.tab.dtc',           icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'live_pids',     labelKey: 'diagHmi.tab.livePids',      icon: <Activity className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'uds_console',   labelKey: 'diagHmi.tab.udsConsole',    icon: <Terminal className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'did_inspector', labelKey: 'diagHmi.tab.didInspector',  icon: <FileSearch className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'uds_flow',      labelKey: 'diagHmi.tab.udsFlow',       icon: <Workflow className="h-3.5 w-3.5" aria-hidden="true" /> },
  { id: 'uds_panel',     labelKey: 'diagHmi.tab.udsPanel',      icon: <Gauge className="h-3.5 w-3.5" aria-hidden="true" /> },
];

const SessionStrip: React.FC = () => {
  const state = useDiagnosticsStore();
  const { t } = useI18n();
  const { session, sessionInfo, mockMode, connecting } = state;
  const { config, connected, udsSession, testerPresentActive } = session;

  const fallbackCode = udsSession === 'extended' ? 0x03 : udsSession === 'programming' ? 0x02 : 0x01;
  const activeLabel = sessionLabel(sessionInfo ? sessionInfo.activeSession : fallbackCode);

  return (
    <div className="flex h-10 shrink-0 select-none items-center gap-3 border-b border-hairline bg-elevated px-3.5 font-mono text-[12px]">
      {/* ECU address */}
      <div className="flex items-center gap-1.5">
        <Cpu className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        <span className="text-muted">{t('diag.session.requestId')}</span>
        <span className="tabular-nums text-ink">
          0x{config.requestId.toString(16).toUpperCase().padStart(3, '0')}
        </span>
        <ChevronRight className="h-3 w-3 text-subtle" aria-hidden="true" />
        <span className="text-muted">{t('diag.session.responseId')}</span>
        <span className="tabular-nums text-ink">
          0x{config.responseId.toString(16).toUpperCase().padStart(3, '0')}
        </span>
      </div>

      <div className={DIAG_DIVIDER} />

      {/* Connected status */}
      <div className="flex items-center gap-1.5">
        <DiagDot tone={connected ? 'nominal' : 'neutral'} />
        <span className={connected ? 'text-nominal' : 'text-muted'}>
          {connected
            ? t('diag.session.connected')
            : connecting
              ? t('diagReal.session.connecting')
              : t('diag.session.disconnected')}
        </span>
      </div>

      <div className={DIAG_DIVIDER} />

      {/* Session type */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted">{t('diag.session.udsSession')}</span>
        <DiagBadge tone={connected ? 'focus' : 'neutral'}>{activeLabel}</DiagBadge>
      </div>

      <div className={DIAG_DIVIDER} />

      {/* TesterPresent */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted">{t('diag.session.testerPresent')}</span>
        <DiagDot
          tone={testerPresentActive ? 'focus' : 'neutral'}
          pulse={testerPresentActive}
          title={testerPresentActive ? t('diagHmi.testerPresentActive') : t('diagHmi.testerPresentInactive')}
        />
      </div>

      <div className="flex-1" />

      {/* DEMO marker: visible on every tab while synthetic data is enabled */}
      {mockMode && <DiagDemoBadge />}

      {/* Protocol badge */}
      <DiagBadge tone="focus">{config.protocol === 'uds' ? 'ISO-TP / UDS' : 'ISO-TP / OBD-II'}</DiagBadge>
    </div>
  );
};

export const DiagnosticsView: React.FC = () => {
  const { t } = useI18n();
  const [activeSubTab, setActiveSubTab] = useState<DiagSubTab>('session');
  const [dockMaximized, setDockMaximized] = useState(false);
  const openConsole = useCallback(() => setActiveSubTab('uds_console'), []);
  const navigateFromGraph = useCallback((target: GraphNavTarget) => setActiveSubTab(target), []);
  const { mockMode } = useDiagnosticsStore();

  // Conversation polling (~4 Hz) runs only while connected AND this view is mounted.
  useEffect(() => diagnosticsStore.attachView(), []);

  function renderContent() {
    switch (activeSubTab) {
      case 'session':       return <DiagSessionSetup />;
      case 'ecu_graph':     return <EcuGraphView onNavigate={navigateFromGraph} />;
      case 'dtc':           return <DtcPanel />;
      case 'live_pids':     return <LivePidGauges />;
      case 'uds_console':   return <UdsConsole />;
      case 'did_inspector': return <DidInspector />;
      case 'uds_flow':
        return (
          <>
            {mockMode && (
              <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-canvas px-3 py-1.5">
                <DiagDemoBadge />
                <DiagNotice tone="warn">{t('diagReal.flow.notice')}</DiagNotice>
              </div>
            )}
            <UdsFlowEditor />
          </>
        );
      case 'uds_panel':     return <UdsInstrumentPanel />;
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Top strip: session info */}
      <SessionStrip />

      {/* Sub-tab bar */}
      <nav
        style={{ backgroundColor: 'var(--bg-header)', borderBottom: '1px solid var(--border-strong)' }}
        className="flex h-[34px] shrink-0 select-none items-end px-3"
        aria-label="Diagnostics"
      >
        {/* Scrollable tab strip */}
        <div className="no-scrollbar flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {SUB_TABS.map((tab) => {
            const isActive = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveSubTab(tab.id)}
                style={{
                  backgroundColor: isActive ? 'var(--bg-panel)' : 'transparent',
                  borderColor: isActive ? 'var(--border-strong)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderBottomColor: isActive ? 'var(--bg-panel)' : 'transparent',
                }}
                className={`flex h-full shrink-0 cursor-pointer items-center gap-1.5 rounded-t-[3px] border-l border-r border-t px-3 font-sans text-[12.5px] transition-colors ${
                  isActive ? 'font-semibold' : 'hover:text-[var(--text-primary)]'
                }`}
              >
                {tab.icon}
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>

        {/* Fixed badge (right, never scrolls) */}
        <div className="hidden shrink-0 items-center gap-1.5 pb-1.5 pl-2 font-mono text-[11px] text-muted xl:flex">
          <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('diagHmi.pack')}</span>
        </div>
      </nav>

      {/* Content area */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Kept mounted (display:none) while the traffic dock is maximized so tab state survives. */}
        <div className={`min-h-0 flex-1 flex-col overflow-hidden ${dockMaximized ? 'hidden' : 'flex'}`}>
          {renderContent()}
        </div>
        <TrafficDock onOpenConsole={openConsole} onMaximizedChange={setDockMaximized} />
      </div>
    </div>
  );
};
