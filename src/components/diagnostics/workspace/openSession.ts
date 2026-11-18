/**
 * "Oturum Aç": one-way copy of an ECU record into the diagnostics session tab (addressing, padding, FD,
 * p2Margin; bus id resolved from the ECU's connection profile when that bus is connected). The tab only
 * remembers `ecuId` for display; later edits of the record never flow into an existing tab.
 */
import { connectionStore } from '../../../store/connectionStore';
import { diagnosticsStore, MAX_DIAG_TABS } from '../../../store/diagnosticsStore';
import { telemetryStore } from '../../../store/telemetryStore';
import type { DiagSessionConfig } from '../../../types/diagnostics';
import type { EcuRecordV1 } from '../../../types/diagWorkspace';
import type { DiagWsKey } from '../../../i18n/shards/diagWorkspace';

export type OpenSessionNotice =
  | { tone: 'warn'; key: DiagWsKey; params?: Record<string, string | number> }
  | { tone: 'critical'; key: DiagWsKey; params?: Record<string, string | number> };

export interface OpenSessionResult {
  ok: boolean;
  notice: OpenSessionNotice | null;
}

export function sessionConfigFromEcu(ecu: EcuRecordV1, busId: number): DiagSessionConfig {
  const a = ecu.addressing;
  return {
    requestId: a.requestId,
    responseId: a.responseId,
    busId,
    isExtendedId: a.isExtendedId,
    protocol: 'uds',
    functionalId: a.functionalId,
    useFd: a.useFd,
    padding: a.padding,
    p2MarginMs: ecu.timing.p2MarginMs,
    addressFormat: a.addressFormat,
    targetAddress: a.targetAddress,
    responseAddress: a.responseAddress,
  };
}

export function openSessionFromEcu(ecu: EcuRecordV1): OpenSessionResult {
  const state = diagnosticsStore.getState();
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  let busId = active.session.config.busId;
  let notice: OpenSessionNotice | null = null;

  if (ecu.connectionProfileId !== null) {
    const profile = connectionStore.getState().profiles.find((p) => p.id === ecu.connectionProfileId);
    if (!profile) {
      notice = { tone: 'warn', key: 'diagWs.open.profileMissing' };
    } else if (telemetryStore.getHeaderSlice().buses.some((b) => b.busId === profile.busId && b.connected)) {
      busId = profile.busId;
    } else {
      notice = { tone: 'warn', key: 'diagWs.open.profileOffline', params: { profile: profile.name, bus: busId + 1 } };
    }
  }

  const config = sessionConfigFromEcu(ecu, busId);
  let tabId: string | null;
  if (active.session.connected || active.connecting) {
    // A live session must not be rewritten: open (or activate) another tab for this ECU.
    tabId = diagnosticsStore.openTabForConfig(config);
    if (tabId === null) {
      return { ok: false, notice: { tone: 'critical', key: 'diagWs.open.tabLimit', params: { max: MAX_DIAG_TABS } } };
    }
  } else {
    tabId = active.id;
    diagnosticsStore.updateConfig(config, tabId);
  }
  diagnosticsStore.setTabEcu(tabId, ecu.id);
  return { ok: true, notice };
}
