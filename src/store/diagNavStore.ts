import { useSyncExternalStore } from 'react';

export type DiagSubTab =
  | 'ecu_registry'
  | 'workbench'
  | 'session'
  | 'ecu_graph'
  | 'dtc'
  | 'live_pids'
  | 'uds_console'
  | 'did_inspector'
  | 'flow'
  | 'uds_panel';

export const DIAG_SUB_TABS: readonly DiagSubTab[] = [
  'ecu_registry',
  'workbench',
  'session',
  'ecu_graph',
  'dtc',
  'live_pids',
  'uds_console',
  'did_inspector',
  'flow',
  'uds_panel',
];

/** Active Diagnostics sub-tab, hoisted out of `DiagnosticsView` so it can be driven externally (MCP UI bridge). */
let activeSubTab: DiagSubTab = 'ecu_registry';
const listeners = new Set<() => void>();

export const diagNavStore = {
  getActiveSubTab: (): DiagSubTab => activeSubTab,
  setActiveSubTab(tab: DiagSubTab): void {
    if (activeSubTab === tab) return;
    activeSubTab = tab;
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useDiagActiveSubTab(): DiagSubTab {
  return useSyncExternalStore(diagNavStore.subscribe, diagNavStore.getActiveSubTab, diagNavStore.getActiveSubTab);
}
