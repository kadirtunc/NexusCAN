/**
 * Diagnostic Simulation v1 unit tests (diag-simulation-v1 §5), headless, no Tauri.
 * Run: `npm run test:diagsim`.
 * Covers: panel sanitizer (malformed widgets dropped + counted, clamps, hex validation, never throws),
 * old project file without the field -> [], project round-trip (export -> JSON -> sanitize -> restore -> deep-equal),
 * duplicate / import give new ids, dirty tracking + mutation hook, `obd_pid` catalog decode (0x0C / 0x05), unknown-PID raw
 * path, and the poll engine issuing `01 0C` on the injected session transport (one in flight, deduped, DEMO = no TX,
 * Design mode never polls).
 */
import type { UdsPanelDto, UdsReadBinding, UdsWidgetDto } from '../../../types/uds';
import { sanitizeProject } from '../../../utils/projectSanitize';
import { SimulationRuntimeBus } from '../../simulation/simulationRuntimeBus';
import {
  buildReadRequests,
  decodeReadValue,
  obdReadDefaults,
  udsWidgetReadKey,
} from './udsBinding';
import { addUdsWidget } from './udsPanelActions';
import { computeUdsDirtyById, defaultUdsRead, udsPanelStore } from './udsInstrumentStore';
import {
  buildDiagPanelFile,
  cloneUdsPanelWithNewIds,
  parseDiagPanelFile,
  sanitizeUdsPanel,
  sanitizeUdsPanels,
} from './udsPanelSanitize';
import { UdsPollEngine, udsPollAllowed, type UdsReadTransport } from './udsPollEngine';

let failures = 0;
let checks = 0;
function ok(cond: boolean, msg: string, detail = ''): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.log(`  FAIL ${msg}${detail !== '' ? ` :: ${detail}` : ''}`);
  }
}
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
function same(a: unknown, b: unknown, msg: string): void {
  checks += 1;
  if (!deepEq(a, b)) {
    failures += 1;
    console.log(`  FAIL ${msg} :: ${JSON.stringify(a)?.slice(0, 200)} != ${JSON.stringify(b)?.slice(0, 200)}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
  const before = failures;
  try {
    await fn();
  } catch (e) {
    failures += 1;
    console.log(`  THROW ${e instanceof Error ? e.stack : String(e)}`);
  }
  console.log(`${failures === before ? 'PASS' : 'FAIL'} ${name}`);
}

/** Builds a real panel through the store actions (same code path as the editor). */
function buildPanel(name: string): UdsPanelDto {
  const id = udsPanelStore.createPanel(name, 'desc');
  udsPanelStore.enterPanel(id, 'design');
  addUdsWidget('gauge', { title: 'RPM', readOverride: obdReadDefaults(0x0c) });
  addUdsWidget('numeric', { title: 'Coolant', readOverride: obdReadDefaults(0x05) });
  addUdsWidget('numeric', { title: 'DID', readOverride: { did: 'F190' } });
  const p = udsPanelStore.getSnapshot().panels.find((x) => x.id === id);
  if (!p) throw new Error('panel not created');
  return p;
}

function obdWidget(pid: string, pollMs = 0): UdsWidgetDto {
  const p = udsPanelStore.getSnapshot().panels[0];
  if (!p) throw new Error('no panel');
  const before = p.widgets.length;
  addUdsWidget('numeric', { readOverride: { ...obdReadDefaults(Number.parseInt(pid, 16)), pollMs } });
  const after = udsPanelStore.getSnapshot().panels[0]?.widgets ?? [];
  const w = after[before];
  if (!w) throw new Error('widget not created');
  return w;
}

async function main(): Promise<void> {
  await section('sanitizer: malformed widgets dropped with a count, never throws', () => {
    const good = buildPanel('S1');
    const raw = JSON.parse(JSON.stringify(good)) as UdsPanelDto;
    const w0 = raw.widgets[0] as unknown as Record<string, unknown>;
    const bad: unknown[] = [
      null,
      42,
      'x',
      { id: 'a', kind: 'bogus', layout: { col: 0, row: 0, w: 1, h: 1 }, config: {} },
      { ...w0, id: 'no-layout', layout: undefined },
      { ...w0, id: 'bad-len', udsRead: { ...(w0['udsRead'] as object), byteLen: 3 } },
      { ...w0, id: 'bad-svc', udsRead: { ...(w0['udsRead'] as object), service: 'nope' } },
      { ...w0, id: 'bad-pid', udsRead: { ...(w0['udsRead'] as object), service: 'obd_pid', obdPid: 'zz' } },
      { ...w0, id: 'bad-write', udsWrite: { service: 'write_did', byteLen: 8 } },
    ];
    const res = sanitizeUdsPanel({ ...raw, widgets: [...raw.widgets, ...bad] });
    ok(res.panel !== null, 'panel survives');
    ok(res.droppedWidgets === bad.length, 'every malformed widget counted', String(res.droppedWidgets));
    ok(res.panel?.widgets.length === raw.widgets.length, 'valid widgets kept');
    for (const junk of [null, undefined, 5, 'str', [], [null, 1, {}], { widgets: 5 }]) {
      let threw = false;
      try {
        sanitizeUdsPanels(junk);
        sanitizeUdsPanel(junk);
      } catch {
        threw = true;
      }
      ok(!threw, `no throw on ${JSON.stringify(junk)}`);
    }
  });

  await section('sanitizer: clamps numbers, validates hex, strips proto keys', () => {
    const p = buildPanel('S2');
    const raw = JSON.parse(JSON.stringify(p)) as UdsPanelDto;
    const w = raw.widgets[2] as unknown as Record<string, unknown>;
    w['layout'] = { col: 9999, row: 99999, w: 999, h: -5 };
    w['udsRead'] = {
      ...(w['udsRead'] as object),
      did: 'zz12-G',
      decimals: 99,
      pollMs: -50,
      factor: 0,
      min: 10,
      max: -10,
      byteOffset: -3,
    };
    w['config'] = JSON.parse('{"min":1,"__proto__":{"polluted":true},"nested":{"constructor":1,"ok":2}}');
    const res = sanitizeUdsPanel(raw);
    const sw = res.panel?.widgets[2];
    ok(sw !== undefined, 'widget kept');
    if (!sw || !sw.udsRead) return;
    ok(sw.layout.w === 24 && sw.layout.col === 0 && sw.layout.h === 1 && sw.layout.row === 399, 'layout clamped', JSON.stringify(sw.layout));
    ok(sw.udsRead.did === '12', 'hex sanitized', sw.udsRead.did);
    ok(sw.udsRead.decimals === 6 && sw.udsRead.pollMs === 0 && sw.udsRead.factor === 1, 'numbers clamped');
    ok(sw.udsRead.max >= sw.udsRead.min && sw.udsRead.byteOffset === 0, 'range / offset repaired');
    ok(!('polluted' in sw.config) && !Object.prototype.hasOwnProperty.call(sw.config, '__proto__'), 'proto key stripped');
    const cfg = sw.config as unknown as { nested?: Record<string, unknown> };
    ok(cfg.nested !== undefined && cfg.nested['ok'] === 2 && !('constructor' in (cfg.nested ?? {}) && Object.prototype.hasOwnProperty.call(cfg.nested, 'constructor')), 'nested constructor stripped');
  });

  await section('old project file without diagnosticPanels loads unchanged ([])', () => {
    const old = { version: 1, name: 'Old', simulationPanels: [] };
    const sp = sanitizeProject(old, 'external');
    ok(sp.project.diagnosticPanels === undefined, 'field absent stays absent');
    const res = sanitizeUdsPanels(sp.project.diagnosticPanels);
    same(res, { panels: [], droppedWidgets: 0, droppedPanels: 0 }, 'undefined -> []');
  });

  await section('project round-trip: export -> JSON -> sanitize -> restore -> deep-equal', () => {
    udsPanelStore.clearAll();
    const p = buildPanel('RT');
    const exported = udsPanelStore.exportForProject();
    same(exported[0], p, 'export equals store panel');
    const file = { version: 1, name: 'P', simulationPanels: [], diagnosticPanels: exported };
    const sp = sanitizeProject(JSON.parse(JSON.stringify(file)), 'own');
    const res = sanitizeUdsPanels(sp.project.diagnosticPanels);
    ok(res.droppedWidgets === 0 && res.droppedPanels === 0, 'nothing dropped');
    udsPanelStore.restoreFromProject(res.panels);
    same(udsPanelStore.exportForProject(), exported, 'deep-equal after load');
    const st = udsPanelStore.getSnapshot();
    ok(st.view === 'list' && st.mode === 'design' && st.activePanelId === null, 'lands on the list in Design mode');
    ok(Object.values(computeUdsDirtyById(st.panels, st.savedSnapshots)).every((d) => !d), 'clean after load');
  });

  await section('dirty tracking + mutation hook (project dirty) + markSaved', () => {
    udsPanelStore.clearAll();
    let mutations = 0;
    const off = udsPanelStore.onMutation(() => {
      mutations += 1;
    });
    const p = buildPanel('D');
    ok(mutations > 0, 'edits notify the project');
    const m0 = mutations;
    udsPanelStore.restoreFromProject(udsPanelStore.exportForProject());
    udsPanelStore.markSaved(udsPanelStore.exportForProject());
    udsPanelStore.clearAll();
    ok(mutations === m0, 'restore / markSaved / clear do not mark dirty');
    udsPanelStore.restoreFromProject([p]);
    let st = udsPanelStore.getSnapshot();
    ok(computeUdsDirtyById(st.panels, st.savedSnapshots)[p.id] === false, 'clean');
    udsPanelStore.renamePanel(p.id, 'D2');
    st = udsPanelStore.getSnapshot();
    ok(computeUdsDirtyById(st.panels, st.savedSnapshots)[p.id] === true, 'dirty after rename');
    udsPanelStore.markSaved(udsPanelStore.exportForProject());
    st = udsPanelStore.getSnapshot();
    ok(computeUdsDirtyById(st.panels, st.savedSnapshots)[p.id] === false, 'clean after save');
    off();
  });

  await section('duplicate / import give new ids; export file round-trip', () => {
    udsPanelStore.clearAll();
    const p = buildPanel('DUP');
    udsPanelStore.duplicatePanel(p.id);
    const panels = udsPanelStore.getSnapshot().panels;
    ok(panels.length === 2, 'two panels');
    const copy = panels[1];
    if (!copy) return;
    ok(copy.id !== p.id && copy.name === 'DUP (Copy)', 'new panel id + name');
    const ids = new Set(p.widgets.map((w) => w.id));
    ok(copy.widgets.length === p.widgets.length && copy.widgets.every((w) => !ids.has(w.id)), 'new widget ids');
    same(copy.widgets.map((w) => w.udsRead), p.widgets.map((w) => w.udsRead), 'bindings preserved');

    const text = JSON.stringify(buildDiagPanelFile(p));
    const imp = parseDiagPanelFile(text);
    ok(imp.ok, 'import ok');
    if (imp.ok) {
      ok(imp.panel.id !== p.id && imp.panel.widgets.every((w) => !ids.has(w.id)), 'imported ids are fresh');
      ok(imp.panel.widgets.length === p.widgets.length && imp.droppedWidgets === 0, 'widgets kept');
    }
    const broken = JSON.parse(text) as { panel: { widgets: unknown[] } };
    broken.panel.widgets.push({ id: 'x', kind: 'bogus' });
    const imp2 = parseDiagPanelFile(JSON.stringify(broken));
    ok(imp2.ok && imp2.droppedWidgets === 1, 'malformed widget dropped on import');
    ok(!parseDiagPanelFile('{not json').ok && !parseDiagPanelFile('{"a":1}').ok, 'invalid files rejected');
    const c2 = cloneUdsPanelWithNewIds(p);
    ok(c2.id !== p.id, 'cloneUdsPanelWithNewIds');
  });

  await section('obd_pid decode via PID_CATALOG + catalog defaults', () => {
    const rpm: UdsReadBinding = { ...defaultUdsRead(), ...obdReadDefaults(0x0c) };
    ok(rpm.service === 'obd_pid' && rpm.obdPid === '0C', 'binding fields');
    ok(rpm.unit === 'rpm' && rpm.min === 0 && rpm.max === 16383 && rpm.decimals === 0, 'catalog defaults (rpm)', JSON.stringify(rpm));
    ok(decodeReadValue(rpm, [0x1a, 0xf8]) === 1726, 'PID 0x0C [1A F8] = 1726 rpm');
    ok(decodeReadValue(rpm, [0x1a]) === null, 'short payload -> null');
    const cool: UdsReadBinding = { ...defaultUdsRead(), ...obdReadDefaults(0x05) };
    ok(decodeReadValue(cool, [0x5a]) === 50, 'PID 0x05 0x5A = 50 degC');
    ok(cool.unit === '°C' && cool.min === -40 && cool.max === 215, 'catalog defaults (coolant)');
    const speed: UdsReadBinding = { ...defaultUdsRead(), ...obdReadDefaults(0x0d) };
    ok(decodeReadValue(speed, [0x37]) === 55, 'PID 0x0D = 55 km/h');
  });

  await section('obd_pid unknown PID: raw bytes with factor/offset', () => {
    const r: UdsReadBinding = {
      ...defaultUdsRead(),
      service: 'obd_pid',
      obdPid: 'A4',
      byteOffset: 1,
      byteLen: 2,
      factor: 0.5,
      offset: -10,
    };
    ok(decodeReadValue(r, [0xff, 0x01, 0x00]) === 118, 'raw 0x0100 * 0.5 - 10 = 118');
    r.signed = true;
    ok(decodeReadValue(r, [0x00, 0xff, 0xfe]) === -11, 'signed raw path (0xFFFE = -2)');
    ok(decodeReadValue(r, [0x00]) === null, 'short -> null');
    const w: UdsWidgetDto = { ...(udsPanelStore.getSnapshot().panels[0]?.widgets[0] as UdsWidgetDto), udsRead: r };
    const { requests, invalid } = buildReadRequests([w], 1000);
    ok(invalid.length === 0 && requests[0]?.service === 'obd_pid' && requests[0]?.pid === 0xa4 && requests[0].id === 'PID:A4', 'request grouped by PID');
    const badW: UdsWidgetDto = { ...w, udsRead: { ...r, obdPid: '' } };
    ok(buildReadRequests([badW], 1000).invalid.length === 1, 'empty PID invalid');
  });

  await section('poll engine: `01 0C` on the injected session transport, serialized + deduped', async () => {
    udsPanelStore.clearAll();
    buildPanel('POLL');
    const wRpm = obdWidget('0C', 50);
    const wRpm2 = obdWidget('0C', 50);
    const wSpeed = obdWidget('0D', 50);

    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const transport: UdsReadTransport = {
      readDid: async () => {
        calls.push('did');
        return [0];
      },
      readMemory: async () => {
        calls.push('mem');
        return [0];
      },
      readObdPid: async (pid: number) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push(`01 ${pid.toString(16).toUpperCase().padStart(2, '0')}`);
        await sleep(4);
        inFlight -= 1;
        return pid === 0x0c ? [0x1a, 0xf8] : [0x37];
      },
    };
    const bus = new SimulationRuntimeBus();
    const engine = new UdsPollEngine(bus, transport);
    const widgets = [wRpm, wRpm2, wSpeed];
    engine.configure(widgets, { defaultPollMs: 1000, mock: false });
    ok(!engine.isRunning() && calls.length === 0, 'configure alone never polls');

    ok(!udsPollAllowed('design', true), 'Design mode never polls');
    ok(!udsPollAllowed('run', false), 'Run without a panel never polls');
    ok(udsPollAllowed('run', true), 'explicit Run polls');

    engine.start();
    await sleep(220);
    engine.stop();
    ok(calls.includes('01 0C') && calls.includes('01 0D'), 'requests issued', calls.join(','));
    ok(calls.every((c) => c.startsWith('01 ')), 'only OBD requests');
    ok(maxInFlight === 1, 'one request in flight', String(maxInFlight));
    const kRpm = udsWidgetReadKey(wRpm);
    const kRpm2 = udsWidgetReadKey(wRpm2);
    const kSpeed = udsWidgetReadKey(wSpeed);
    ok(kRpm !== null && kRpm === kRpm2, 'same PID shares one key (single request)');
    ok(kRpm !== null && bus.getValue(kRpm, -1) === 1726, 'RPM published 1726', String(kRpm !== null ? bus.getValue(kRpm, -1) : 'n/a'));
    ok(kSpeed !== null && bus.getValue(kSpeed, -1) === 55, 'speed published 55');
    ok(engine.getStatus(kRpm ?? '').state === 'ok', 'status ok');
    const after = calls.length;
    await sleep(120);
    ok(calls.length === after, 'no TX after stop');

    // Transport failure -> per-key error status, no fabricated value
    const failing = new UdsPollEngine(new SimulationRuntimeBus(), {
      ...transport,
      readObdPid: async () => {
        throw new Error('negative response');
      },
    });
    failing.configure([wRpm], { defaultPollMs: 50, mock: false });
    failing.start();
    await sleep(80);
    failing.stop();
    ok(failing.getStatus(kRpm ?? '').state === 'error', 'transport error surfaces as status');
  });

  await section('poll engine DEMO path: clearly mock, no transport calls', async () => {
    udsPanelStore.clearAll();
    buildPanel('DEMO');
    const w = obdWidget('0C', 50);
    const calls: string[] = [];
    const transport: UdsReadTransport = {
      readDid: async () => {
        calls.push('did');
        return [];
      },
      readMemory: async () => {
        calls.push('mem');
        return [];
      },
      readObdPid: async () => {
        calls.push('obd');
        return [];
      },
    };
    const bus = new SimulationRuntimeBus();
    const engine = new UdsPollEngine(bus, transport);
    engine.configure([w], { defaultPollMs: 50, mock: true });
    engine.start();
    await sleep(60);
    engine.stop();
    const key = udsWidgetReadKey(w);
    const v = key !== null ? bus.getValue(key, Number.NaN) : Number.NaN;
    ok(calls.length === 0, 'DEMO sends nothing');
    ok(Number.isFinite(v) && v >= 0 && v <= 16383, 'DEMO value inside catalog range', String(v));
  });

  console.log(`\ndiagsim: ${checks - failures}/${checks} checks`);
  if (failures > 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc) proc.exitCode = 1;
  }
}

await main();
