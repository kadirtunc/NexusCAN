import { t } from '../i18n';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { UiRequestDto, UiStateSnapshot } from '../types/mcp';
import type { MessageSchemaDto, SignalSchemaDto } from '../types/netdb';
import { databaseStore } from '../store/databaseStore';
import type { ExplorerSubTab } from '../store/databaseStore';
import { diagNavStore, type DiagSubTab } from '../store/diagNavStore';
import { plotStore } from '../store/plotStore';
import { traceSessionsStore } from '../store/traceSessionsStore';
import { traceIdFilterStore } from '../store/traceIdFilterStore';
import { mcpStore } from '../store/mcpStore';
import { mcpUiOverlayStore } from '../store/mcpUiOverlayStore';
import { isTauri } from './ipcClient';
import {
  describeUiAction,
  formatTraceId,
  handleUiRequest,
  type UiHost,
  type UiResponse,
} from './mcpUiHandlers';

function arbKey(arbId: number, isExtended: boolean): string {
  return `${isExtended ? 'EXT' : 'STD'}:${arbId >>> 0}`;
}

interface FoundMessage {
  msg: MessageSchemaDto;
  dbId: string | null;
  busId: number | null;
}

function findMessage(arbId: number, isExtended: boolean | null, busId: number | null): FoundMessage | null {
  const st = databaseStore.getState();
  const variants: boolean[] = isExtended === null ? [false, true] : [isExtended];
  for (const ext of variants) {
    const key = arbKey(arbId, ext);
    if (busId !== null) {
      const lookup = st.busSchemas.get(busId);
      const msg = lookup?.messagesByArbKey.get(key);
      if (lookup && msg) {
        const db = st.databases.find((d) => d.schema === lookup.schema);
        return { msg, dbId: db?.id ?? null, busId };
      }
      continue;
    }
    const inspected = st.messagesByArbKey.get(key);
    if (inspected) return { msg: inspected, dbId: st.inspectedDatabaseId, busId: null };
    for (const [bId, lookup] of st.busSchemas) {
      const msg = lookup.messagesByArbKey.get(key);
      if (msg) {
        const db = st.databases.find((d) => d.schema === lookup.schema);
        return { msg, dbId: db?.id ?? null, busId: bId };
      }
    }
  }
  return null;
}

interface FoundSignal {
  busId: number;
  sig: SignalSchemaDto;
}

function findSignalByName(name: string): FoundSignal | null {
  const want = name.trim().toLowerCase();
  const st = databaseStore.getState();
  for (const [busId, lookup] of st.busSchemas) {
    const sig = lookup.schema.signals.find((s) => s.name.toLowerCase() === want);
    if (sig) return { busId, sig };
  }
  if (st.busSchemas.size === 0 && st.schema) {
    const sig = st.schema.signals.find((s) => s.name.toLowerCase() === want);
    if (sig) return { busId: plotStore.getState().pickerBusId, sig };
  }
  return null;
}

function plottedNames(): string[] {
  return plotStore.getState().series.map((s) => s.signalName);
}

export const realUiHost: UiHost = {
  getState(): UiStateSnapshot {
    const st = databaseStore.getState();
    const view = st.activeDocTab;
    const subTab = view === 'diagnostics' ? diagNavStore.getActiveSubTab() : view === 'symbols' ? st.explorerSubTab : null;
    let selectedMessage: UiStateSnapshot['selectedMessage'] = null;
    if (st.selectedMessageKey !== null) {
      const key = st.selectedMessageKey;
      let msg = st.messagesByKey.get(key);
      let busId: number | null = null;
      // Prefer the bus recorded at selection time, if its schema still holds this message.
      if (st.selectedMessageBusId !== null) {
        const m = st.busSchemas.get(st.selectedMessageBusId)?.messagesByKey.get(key);
        if (m) {
          busId = st.selectedMessageBusId;
          msg = m;
        }
      }
      if (busId === null) {
        const hits: number[] = [];
        for (const [id, l] of st.busSchemas) {
          if (l.messagesByKey.has(key)) hits.push(id);
        }
        // Unambiguous only: exactly one bus schema carries this message.
        if (hits.length === 1) busId = hits[0];
        if (!msg && hits.length > 0) msg = st.busSchemas.get(hits[0])?.messagesByKey.get(key);
      }
      selectedMessage = msg
        ? {
            busId,
            arbId: formatTraceId({ arbId: msg.arbId, isExtended: msg.isExtended }),
            name: msg.name,
          }
        : { busId, arbId: key, name: null };
    }
    const sessionId = traceSessionsStore.getState().activeSessionId;
    const ids = traceIdFilterStore.get(sessionId);
    return {
      activeView: view,
      subTab,
      selectedMessage,
      plotSignals: plottedNames(),
      traceFilterIds: ids === null ? null : ids.map(formatTraceId),
      activeTraceSession: sessionId,
      theme: st.theme,
    };
  },

  navigate(view, subTab): void {
    databaseStore.setActiveDocTab(view);
    if (view === 'diagnostics' && subTab !== null) {
      diagNavStore.setActiveSubTab(subTab as DiagSubTab);
    } else if (view === 'symbols' && subTab !== null) {
      databaseStore.setExplorerSubTab(subTab as ExplorerSubTab);
    }
  },

  selectMessage(arbId, isExtended, busId) {
    const found = findMessage(arbId, isExtended, busId);
    if (!found) return { found: false, name: null };
    databaseStore.selectMessageInSymbolsTab(found.msg.messageKey, found.dbId ?? undefined, found.busId);
    databaseStore.setExplorerSubTab('messages');
    return { found: true, name: found.msg.name };
  },

  setTraceFilter(ids) {
    const sessionId = traceSessionsStore.getState().activeSessionId;
    traceIdFilterStore.set(sessionId, ids);
    return ids === null ? null : ids.map(formatTraceId);
  },

  plotSignals(add, remove, clear) {
    const unknown: string[] = [];
    if (clear) plotStore.clearAllSeries();
    for (const name of remove) {
      const want = name.trim().toLowerCase();
      const hits = plotStore.getState().series.filter((s) => s.signalName.toLowerCase() === want);
      if (hits.length === 0) unknown.push(name);
      for (const h of hits) plotStore.removeSeries(h.key);
    }
    for (const name of add) {
      const f = findSignalByName(name);
      if (!f) unknown.push(name);
      else plotStore.addSignal(f.busId, f.sig);
    }
    databaseStore.setActiveDocTab('plotter');
    return { plotSignals: plottedNames(), unknown };
  },

  notify(level, text): void {
    mcpUiOverlayStore.pushToast(level, text);
  },

  confirmBusArm(busId, device, channel) {
    return mcpUiOverlayStore.askConfirm(
      t('onb.mcp.arm.title'),
      t('onb.mcp.arm.message', { bus: busId + 1, device, channel }),
      t('onb.mcp.arm.confirm'),
      60_000,
    );
  },

  confirm(title, message, confirmLabel) {
    return mcpUiOverlayStore.askConfirm(title, message, confirmLabel);
  },
};

async function respond(res: UiResponse): Promise<void> {
  try {
    await invoke('cmd_mcp_ui_respond', {
      requestId: res.requestId,
      ok: res.ok,
      result: res.result,
      error: res.error,
    });
  } catch (err) {
    console.warn('[mcpUiBridge] respond failed:', err);
  }
}

export async function dispatchUiRequest(req: UiRequestDto): Promise<void> {
  const res = await handleUiRequest(realUiHost, req);
  const d = describeUiAction(req.kind, req.args);
  if (d) {
    const entry: Parameters<typeof mcpStore.recordUiAction>[0] = {
      kind: req.kind,
      summary: res.ok ? d.summary : `${d.summary} (${res.error ?? 'failed'})`,
      label: d.label,
      ok: res.ok,
    };
    mcpStore.recordUiAction(entry);
  }
  await respond(res);
}


let attached = false;

/** Attaches the UI request channel once (Tauri desktop only; no-op in browser mode). */
export async function attachMcpUiBridge(): Promise<void> {
  if (!isTauri || attached) return;
  attached = true;
  const channel = new Channel<UiRequestDto>();
  channel.onmessage = (req) => {
    void dispatchUiRequest(req);
  };
  try {
    await invoke('cmd_mcp_ui_attach', { onRequest: channel });
  } catch (err) {
    attached = false;
    console.warn('[mcpUiBridge] attach failed:', err);
  }
}
