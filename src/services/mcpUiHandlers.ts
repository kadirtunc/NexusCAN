import type {
  UiNotifyLevel,
  UiRequestDto,
  UiStateSnapshot,
  UiView,
} from '../types/mcp';
import type { DiagSubTab } from '../store/diagNavStore';
import type { TraceIdEntry } from '../store/traceIdFilterStore';

/** Pure request validation + dispatch for the MCP UI bridge. No React / Tauri / store imports. */

export const UI_VIEWS: readonly UiView[] = [
  'start', 'connections', 'rxtx', 'trace', 'plotter', 'symbols', 'panels', 'diagnostics', 're',
];
export const DIAG_SUBTABS: readonly DiagSubTab[] = [
  'ecu_registry', 'workbench', 'session', 'ecu_graph', 'dtc', 'live_pids', 'uds_console', 'did_inspector', 'flow', 'uds_panel',
];
export const SYMBOLS_SUBTABS: readonly ('messages' | 'ecus' | 'diagnostics')[] = ['messages', 'ecus', 'diagnostics'];

export interface UiHost {
  getState(): UiStateSnapshot;
  navigate(view: UiView, subTab: string | null): void;
  selectMessage(arbId: number, isExtended: boolean | null, busId: number | null): { found: boolean; name: string | null };
  /** `null` clears the filter. Returns the applied IDs as normalized strings. */
  setTraceFilter(ids: TraceIdEntry[] | null): string[] | null;
  plotSignals(add: string[], remove: string[], clear: boolean): { plotSignals: string[]; unknown: string[] };
  notify(level: UiNotifyLevel, text: string): void;
  confirm(title: string, message: string, confirmLabel: string | null): Promise<boolean>;
  confirmBusArm?(busId: number, device: string, channel: string): Promise<boolean>;
}

export interface UiResponse {
  requestId: number;
  ok: boolean;
  result: unknown | null;
  error: string | null;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}
function optStrArray(o: Obj, key: string): string[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!isStrArray(v)) throw new Error(`'${key}' must be an array of strings`);
  return v;
}
function argObj(args: unknown): Obj {
  if (args === undefined || args === null) return {};
  if (!isObj(args)) throw new Error('args must be an object');
  return args;
}
function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return isStr(v) && (list as readonly string[]).includes(v);
}

/** Parses "0x1A0", "1A0", "STD:0x1A0", "EXT:0x18FEF100" into a numeric arbitration ID (<= 0x1FFFFFFF). */
export function parseArbId(raw: string): number | null {
  const m = /^(?:(?:STD|EXT):)?(?:0x)?([0-9a-f]{1,8})$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return n >= 0 && n <= 0x1fffffff ? n : null;
}

export function formatArbId(id: number): string {
  return `0x${(id >>> 0).toString(16).toUpperCase().padStart(3, '0')}`;
}

/**
 * Parses a trace-filter ID with frame-format inference: explicit `STD:`/`EXT:` prefix wins;
 * otherwise value > 0x7FF or an 8-digit hex spelling (`0x000001A0`) means extended.
 */
export function parseTraceId(raw: string): TraceIdEntry | null {
  const m = /^(?:(STD|EXT):)?(?:0x)?([0-9a-f]{1,8})$/i.exec(raw.trim());
  if (!m) return null;
  const arbId = parseInt(m[2], 16);
  if (arbId > 0x1fffffff) return null;
  const prefix = m[1]?.toUpperCase();
  if (prefix === 'STD') return arbId <= 0x7ff ? { arbId, isExtended: false } : null;
  const isExtended = prefix === 'EXT' || arbId > 0x7ff || m[2].length === 8;
  return { arbId, isExtended };
}

/** STD -> 3 hex digits, EXT -> 8 hex digits. */
export function formatTraceId(e: TraceIdEntry): string {
  return `0x${(e.arbId >>> 0).toString(16).toUpperCase().padStart(e.isExtended ? 8 : 3, '0')}`;
}

/** Validates, de-duplicates and sorts an ID list. `null`/empty means "clear". */
export function parseTraceIds(v: unknown): TraceIdEntry[] | null {
  if (v === null || v === undefined) return null;
  if (!isStrArray(v)) throw new Error("'ids' must be an array of strings or null");
  if (v.length === 0) return null;
  const out = new Map<string, TraceIdEntry>();
  for (const s of v) {
    const e = parseTraceId(s);
    if (e === null) throw new Error(`invalid CAN ID: '${s}'`);
    out.set(`${e.isExtended ? 'E' : 'S'}${e.arbId}`, e);
  }
  return [...out.values()].sort((a, b) => Number(a.isExtended) - Number(b.isExtended) || a.arbId - b.arbId);
}

export interface NavigateArgs {
  view: UiView;
  subTab: string | null;
}

export function parseNavigateArgs(args: unknown): NavigateArgs {
  const o = argObj(args);
  if (!oneOf(UI_VIEWS, o.view)) throw new Error(`'view' must be one of: ${UI_VIEWS.join(', ')}`);
  const sub = o.subTab;
  if (sub === undefined || sub === null) return { view: o.view, subTab: null };
  if (!isStr(sub)) throw new Error("'subTab' must be a string");
  if (o.view === 'diagnostics') {
    if (!oneOf(DIAG_SUBTABS, sub)) throw new Error(`invalid diagnostics subTab '${sub}'; expected one of: ${DIAG_SUBTABS.join(', ')}`);
  } else if (o.view === 'symbols') {
    if (!oneOf(SYMBOLS_SUBTABS, sub)) throw new Error(`invalid symbols subTab '${sub}'; expected one of: ${SYMBOLS_SUBTABS.join(', ')}`);
  } else {
    throw new Error(`view '${o.view}' has no sub tabs`);
  }
  return { view: o.view, subTab: sub };
}

export function describeUiAction(kind: string, args: unknown): { label: string; summary: string } | null {
  const o = isObj(args) ? args : {};
  switch (kind) {
    case 'get_state':
      return null; // read-only polling noise; not surfaced
    case 'navigate': {
      const v = isStr(o.view) ? o.view : '?';
      const sub = isStr(o.subTab) ? `/${o.subTab}` : '';
      const name = v === 'rxtx' ? 'RX/TX' : v.charAt(0).toUpperCase() + v.slice(1);
      return { label: `Claude → ${name}`, summary: `navigate ${v}${sub}` };
    }
    case 'select_message': {
      const id = isStr(o.arbId) ? parseArbId(o.arbId) : null;
      const txt = id === null ? '?' : formatArbId(id);
      return { label: `Claude → ${txt}`, summary: `select ${txt}` };
    }
    case 'trace_filter': {
      const n = isStrArray(o.ids) ? o.ids.length : 0;
      return { label: 'Claude → Trace', summary: n > 0 ? `filter ${n} ID(s)` : 'clear filter' };
    }
    case 'plot_signals': {
      const add = isStrArray(o.add) ? o.add.length : 0;
      const rem = isStrArray(o.remove) ? o.remove.length : 0;
      const parts = [add > 0 ? `+${add}` : '', rem > 0 ? `-${rem}` : '', o.clear === true ? 'clear' : ''].filter(Boolean);
      return { label: 'Claude → Plotter', summary: `plot ${parts.join(' ') || 'show'}` };
    }
    case 'notify':
      return { label: 'Claude → notify', summary: 'notify' };
    case 'confirm_bus_arm':
      return { label: 'MCP → Arm Active Bus', summary: 'bus approval' };
    case 'confirm':
      return { label: 'Claude → confirm', summary: 'confirm' };
    default:
      return { label: 'Claude → ?', summary: kind };
  }
}

async function run(host: UiHost, kind: string, args: unknown): Promise<unknown> {
  switch (kind) {
    case 'get_state':
      return host.getState();
    case 'navigate': {
      const a = parseNavigateArgs(args);
      host.navigate(a.view, a.subTab);
      const st = host.getState();
      return { activeView: st.activeView, subTab: st.subTab };
    }
    case 'select_message': {
      const o = argObj(args);
      if (!isStr(o.arbId)) throw new Error("'arbId' must be a string");
      const arb = parseArbId(o.arbId);
      if (arb === null) throw new Error(`invalid arbId '${o.arbId}'`);
      let ext: boolean | null = null;
      if (o.isExtended !== undefined && o.isExtended !== null) {
        if (typeof o.isExtended !== 'boolean') throw new Error("'isExtended' must be a boolean");
        ext = o.isExtended;
      }
      let busId: number | null = null;
      if (o.busId !== undefined && o.busId !== null) {
        if (typeof o.busId !== 'number' || !Number.isInteger(o.busId) || o.busId < 0) {
          throw new Error("'busId' must be a non-negative integer");
        }
        busId = o.busId;
      }
      return host.selectMessage(arb, ext, busId);
    }
    case 'trace_filter': {
      const o = argObj(args);
      if (!('ids' in o)) throw new Error("'ids' is required (array of strings or null)");
      return { applied: host.setTraceFilter(parseTraceIds(o.ids)) };
    }
    case 'plot_signals': {
      const o = argObj(args);
      if (o.clear !== undefined && typeof o.clear !== 'boolean') throw new Error("'clear' must be a boolean");
      return host.plotSignals(optStrArray(o, 'add'), optStrArray(o, 'remove'), o.clear === true);
    }
    case 'notify': {
      const o = argObj(args);
      if (!oneOf(['info', 'warn', 'success'] as const, o.level)) throw new Error("'level' must be info|warn|success");
      if (!isStr(o.text) || o.text.trim().length === 0) throw new Error("'text' must be a non-empty string");
      host.notify(o.level, o.text);
      return {};
    }
    case 'confirm_bus_arm': {
      const o = argObj(args);
      const { busId, device, channel } = o;
      if (typeof busId !== 'number' || !Number.isInteger(busId) || busId < 0 || busId > 255
        || !isStr(device) || !isStr(channel) || !host.confirmBusArm) {
        throw new Error('Invalid Active Bus approval request');
      }
      return { confirmed: await host.confirmBusArm(busId, device, channel) };
    }
    case 'confirm': {
      const o = argObj(args);
      if (!isStr(o.title)) throw new Error("'title' must be a string");
      if (!isStr(o.message)) throw new Error("'message' must be a string");
      if (o.confirmLabel !== undefined && o.confirmLabel !== null && !isStr(o.confirmLabel)) {
        throw new Error("'confirmLabel' must be a string");
      }
      const confirmed = await host.confirm(o.title, o.message, isStr(o.confirmLabel) ? o.confirmLabel : null);
      return { confirmed };
    }
    default:
      throw new Error(`unknown UI request kind '${kind}'`);
  }
}

/** Runs one request; never throws. Handler errors become `ok:false`. */
export async function handleUiRequest(host: UiHost, req: UiRequestDto): Promise<UiResponse> {
  try {
    const result = await run(host, req.kind, req.args);
    return { requestId: req.requestId, ok: true, result: result ?? null, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'handler failed';
    return { requestId: req.requestId, ok: false, result: null, error: msg };
  }
}
