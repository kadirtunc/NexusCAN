/**
 * Dependency-free checks for the MCP store (polling policy, start/stop, errors).
 * Run: `npm run test:mcp` (esbuild bundle -> node; throws on the first failure).
 */
import { buildClaudeCodeCommand, createMcpStore, parseMcpPort } from './mcpStore';
import type { McpApi, McpTimers } from './mcpStore';
import type { McpServerStatusDto } from '../types/mcp';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function dto(running: boolean, extra: Partial<McpServerStatusDto> = {}): McpServerStatusDto {
  return {
    running,
    port: running ? 47800 : null,
    endpointUrl: running ? 'http://127.0.0.1:47800/mcp' : null,
    token: running ? 'tok' : null,
    connectedClients: 0,
    totalCalls: 0,
    readOnly: true,
    lastError: null,
    uiAttached: false,
    ...extra,
  };
}

assert(parseMcpPort('47800') === 47800, 'valid port');
assert(parseMcpPort('1023') === null, 'below range');
assert(parseMcpPort('65536') === null, 'above range');
assert(parseMcpPort('12ab') === null, 'non numeric');
assert(parseMcpPort('') === null, 'empty');
assert(
  buildClaudeCodeCommand('http://127.0.0.1:47800/mcp', 't') ===
    'claude mcp add --transport http nexuscan http://127.0.0.1:47800/mcp --header "Authorization: Bearer t"',
  'claude command',
);

let intervals = 0;
const timers: McpTimers = {
  setInterval: () => {
    intervals += 1;
    return intervals;
  },
  clearInterval: () => {
    intervals -= 1;
  },
};
let failStart = false;
let running = false;
const api: McpApi = {
  start: async () => {
    if (failStart) throw 'port busy';
    running = true;
    return dto(true);
  },
  stop: async () => {
    running = false;
    return dto(false);
  },
  status: async () => dto(running),
};

async function main(): Promise<void> {
  const s = createMcpStore(api, timers, true);
  assert(!s.isPolling(), 'no polling initially');
  await s.refresh();
  assert(s.getState().status?.running === false && !s.isPolling(), 'refresh while stopped: no poll');

  s.setPanelOpen(true);
  assert(s.isPolling() && intervals === 1, 'poll while panel open');
  s.setPanelOpen(false);
  assert(!s.isPolling() && intervals === 0, 'stop poll when panel closed and stopped');

  failStart = true;
  await s.start(47800);
  assert(s.getState().error === 'port busy' && !s.getState().busy, 'start error surfaced');
  assert(!s.isPolling(), 'no poll after failed start');

  failStart = false;
  await s.start(null);
  assert(s.getState().status?.running === true && s.getState().error === null, 'started');
  assert(s.isPolling(), 'poll while running');

  await s.stop();
  assert(s.getState().status?.running === false && !s.isPolling(), 'stopped, poll cleared');

  // Claude UI action log: newest first, capped at 10, activity label set.
  const u = createMcpStore(api, timers, true);
  for (let i = 0; i < 12; i++) {
    u.recordUiAction({ kind: 'navigate', summary: `n${i}`, label: 'Claude → Plotter', ok: true, atMs: i });
  }
  assert(u.getState().uiActions.length === 10, 'ui actions capped');
  assert(u.getState().uiActions[0].summary === 'n11', 'ui actions newest first');
  assert(u.getState().activity === 'Claude → Plotter', 'activity label set');

  // Browser mode: available=false -> no invoke, no polling, no error state.
  let calls = 0;
  const countingApi: McpApi = {
    start: async () => {
      calls += 1;
      return dto(true);
    },
    stop: async () => {
      calls += 1;
      return dto(false);
    },
    status: async () => {
      calls += 1;
      return dto(false);
    },
  };
  const b = createMcpStore(countingApi, timers, false);
  assert(b.getState().available === false, 'unavailable flag');
  await b.refresh();
  b.setPanelOpen(true);
  assert(!b.isPolling(), 'no polling when unavailable (panel open)');
  await b.start(47800);
  await b.stop();
  assert(calls === 0, 'no invoke when unavailable');
  assert(b.getState().error === null && b.getState().status === null && !b.getState().busy, 'no state written');
  assert(b.getState().panelOpen === true, 'panel still opens');
  console.log('mcpStore tests OK');
}

void main();
