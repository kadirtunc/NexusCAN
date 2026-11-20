/**
 * Dependency-free checks for the MCP UI bridge request handlers (pure; no stores / Tauri).
 * Run: esbuild src/services/mcpUiBridge.test.ts --bundle --platform=node --format=esm | node --input-type=module
 */
import {
  describeUiAction,
  handleUiRequest,
  parseArbId,
  parseNavigateArgs,
  parseTraceIds,
  formatTraceId,
  type UiHost,
} from './mcpUiHandlers';
import type { UiNotifyLevel, UiRequestDto, UiStateSnapshot, UiView } from '../types/mcp';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const calls: string[] = [];
const known = new Set(['EngineSpeed', 'VehicleSpeed']);
let plotted: string[] = [];
let confirmAnswer = true;

const host: UiHost = {
  getState(): UiStateSnapshot {
    return {
      activeView: 'plotter',
      subTab: null,
      selectedMessage: null,
      plotSignals: plotted,
      traceFilterIds: null,
      activeTraceSession: 'trace-1',
      theme: 'dark',
    };
  },
  navigate(view: UiView, subTab: string | null) {
    calls.push(`navigate:${view}:${subTab ?? ''}`);
  },
  selectMessage(arbId, isExtended, busId) {
    calls.push(`select:${arbId}:${String(isExtended)}:${String(busId)}`);
    return arbId === 0x1a0 ? { found: true, name: 'ENGINE' } : { found: false, name: null };
  },
  setTraceFilter(ids) {
    calls.push(`filter:${ids === null ? 'null' : ids.map(formatTraceId).join(',')}`);
    return ids === null ? null : ids.map(formatTraceId);
  },
  plotSignals(add, remove, clear) {
    if (clear) plotted = [];
    const unknown: string[] = [];
    for (const r of remove) {
      if (!plotted.includes(r)) unknown.push(r);
      plotted = plotted.filter((p) => p !== r);
    }
    for (const a of add) {
      if (!known.has(a)) unknown.push(a);
      else if (!plotted.includes(a)) plotted.push(a);
    }
    return { plotSignals: plotted, unknown };
  },
  notify(level: UiNotifyLevel, text: string) {
    calls.push(`notify:${level}:${text}`);
  },
  async confirm(title, message, label) {
    calls.push(`confirm:${title}:${message}:${label ?? ''}`);
    return confirmAnswer;
  },
};

function req(kind: string, args: unknown, requestId = 1): UiRequestDto {
  return { requestId, kind, args };
}

async function main(): Promise<void> {
  // arbId / id list parsing
  assert(parseArbId('0x1A0') === 0x1a0, 'arb 0x');
  assert(parseArbId('1a0') === 0x1a0, 'arb bare');
  assert(parseArbId('EXT:0x18FEF100') === 0x18fef100, 'arb ext');
  assert(parseArbId('zz') === null, 'arb invalid');
  assert(parseArbId('0x3FFFFFFF') === null, 'arb too large');
  assert(
    JSON.stringify(parseTraceIds(['0x200', '0x1A0', '1a0'])) ===
      '[{"arbId":416,"isExtended":false},{"arbId":512,"isExtended":false}]',
    'ids dedupe+sort',
  );
  // STD 0x1A0 vs EXT 0x000001A0 stay distinct; > 0x7FF and EXT: prefix are extended
  const mixed = parseTraceIds(['0x1A0', '0x000001A0', '0x18FEF100', 'EXT:0x1A0', 'STD:0x1A0']);
  assert(mixed !== null && mixed.length === 3, 'STD/EXT same value kept distinct + deduped');
  assert(
    JSON.stringify(mixed?.map(formatTraceId)) === '["0x1A0","0x000001A0","0x18FEF100"]',
    'mixed ids formatted STD 3 / EXT 8 digits',
  );
  let stdBig = false;
  try { parseTraceIds(['STD:0x800']); } catch { stdBig = true; }
  assert(stdBig, 'STD prefix with id > 0x7FF rejected');
  assert(parseTraceIds([]) === null && parseTraceIds(null) === null, 'empty -> clear');
  let threw = false;
  try { parseTraceIds(['nope']); } catch { threw = true; }
  assert(threw, 'invalid id throws');

  // navigate validation
  assert(parseNavigateArgs({ view: 'trace' }).subTab === null, 'nav no subtab');
  assert(parseNavigateArgs({ view: 'diagnostics', subTab: 'dtc' }).subTab === 'dtc', 'diag subtab');
  assert(parseNavigateArgs({ view: 'symbols', subTab: 'ecus' }).subTab === 'ecus', 'symbols subtab');
  for (const bad of [
    { view: 'nope' },
    { view: 'diagnostics', subTab: 'bogus' },
    { view: 'symbols', subTab: 'dtc' },
    { view: 'trace', subTab: 'x' },
    { view: 'cloud' },
    'str',
  ]) {
    let t = false;
    try { parseNavigateArgs(bad); } catch { t = true; }
    assert(t, `navigate rejects ${JSON.stringify(bad)}`);
  }

  // dispatch
  let r = await handleUiRequest(host, req('bogus_kind', {}));
  assert(!r.ok && r.error !== null && r.error.includes('unknown'), 'unknown kind');

  r = await handleUiRequest(host, req('navigate', { view: 'diagnostics', subTab: 'nope' }, 2));
  assert(!r.ok && r.requestId === 2, 'navigate invalid subTab -> ok:false');
  assert(!calls.some((c) => c.startsWith('navigate')), 'invalid navigate does not reach host');

  r = await handleUiRequest(host, req('navigate', { view: 'plotter' }));
  assert(r.ok && JSON.stringify(r.result) === '{"activeView":"plotter","subTab":null}', 'navigate result');

  r = await handleUiRequest(host, req('get_state', undefined));
  assert(r.ok && (r.result as UiStateSnapshot).theme === 'dark', 'get_state');

  r = await handleUiRequest(host, req('select_message', { arbId: '0x1A0', busId: 0 }));
  assert(r.ok && JSON.stringify(r.result) === '{"found":true,"name":"ENGINE"}', 'select found');
  assert(calls.includes('select:416:null:0'), 'select args forwarded');
  r = await handleUiRequest(host, req('select_message', { arbId: '0x7FF' }));
  assert(r.ok && JSON.stringify(r.result) === '{"found":false,"name":null}', 'select not found is ok');
  r = await handleUiRequest(host, req('select_message', { arbId: 5 }));
  assert(!r.ok, 'select non-string arbId');
  r = await handleUiRequest(host, req('select_message', { arbId: '0x1', busId: -1 }));
  assert(!r.ok, 'select negative busId');

  r = await handleUiRequest(host, req('trace_filter', { ids: ['0x1A0', '0x200'] }));
  assert(r.ok && JSON.stringify(r.result) === '{"applied":["0x1A0","0x200"]}', 'trace_filter apply');
  r = await handleUiRequest(host, req('trace_filter', { ids: ['0x1A0', '0x000001A0'] }));
  assert(
    r.ok && JSON.stringify(r.result) === '{"applied":["0x1A0","0x000001A0"]}' && calls.includes('filter:0x1A0,0x000001A0'),
    'trace_filter STD vs EXT preserved end-to-end',
  );
  r = await handleUiRequest(host, req('trace_filter', { ids: null }));
  assert(r.ok && JSON.stringify(r.result) === '{"applied":null}', 'trace_filter clear');
  r = await handleUiRequest(host, req('trace_filter', {}));
  assert(!r.ok, 'trace_filter requires ids');

  r = await handleUiRequest(host, req('plot_signals', { add: ['EngineSpeed', 'Ghost'], remove: ['Nope'] }));
  assert(
    r.ok && JSON.stringify(r.result) === '{"plotSignals":["EngineSpeed"],"unknown":["Nope","Ghost"]}',
    'plot_signals unknown list',
  );
  r = await handleUiRequest(host, req('plot_signals', { clear: true }));
  assert(r.ok && JSON.stringify(r.result) === '{"plotSignals":[],"unknown":[]}', 'plot_signals clear');
  r = await handleUiRequest(host, req('plot_signals', { add: 'EngineSpeed' }));
  assert(!r.ok, 'plot_signals add must be array');

  r = await handleUiRequest(host, req('notify', { level: 'warn', text: 'hello' }));
  assert(r.ok && calls.includes('notify:warn:hello'), 'notify');
  r = await handleUiRequest(host, req('notify', { level: 'fatal', text: 'x' }));
  assert(!r.ok, 'notify bad level');
  r = await handleUiRequest(host, req('notify', { level: 'info', text: '  ' }));
  assert(!r.ok, 'notify empty text');

  r = await handleUiRequest(host, req('confirm', { title: 'T', message: 'M', confirmLabel: 'Go' }));
  assert(r.ok && JSON.stringify(r.result) === '{"confirmed":true}', 'confirm yes');
  confirmAnswer = false;
  r = await handleUiRequest(host, req('confirm', { title: 'T', message: 'M' }));
  assert(r.ok && JSON.stringify(r.result) === '{"confirmed":false}', 'confirm no');
  r = await handleUiRequest(host, req('confirm', { title: 'T' }));
  assert(!r.ok, 'confirm missing message');

  // handler exceptions become ok:false
  const boom: UiHost = { ...host, navigate: () => { throw new Error('boom'); } };
  r = await handleUiRequest(boom, req('navigate', { view: 'trace' }));
  assert(!r.ok && r.error === 'boom', 'host error -> ok:false');

  // activity labels
  assert(describeUiAction('get_state', {}) === null, 'get_state silent');
  assert(describeUiAction('navigate', { view: 'plotter' })?.label === 'Claude → Plotter', 'label navigate');
  assert(describeUiAction('navigate', { view: 'rxtx' })?.label === 'Claude → RX/TX', 'label rxtx');
  assert(describeUiAction('select_message', { arbId: '1a0' })?.label === 'Claude → 0x1A0', 'label select');

  console.log('mcpUiBridge tests OK');
}

void main();
