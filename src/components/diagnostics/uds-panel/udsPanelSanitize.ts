/**
 * Diagnostic Simulation panels: pure sanitizer + panel file exchange (diag-simulation-v1 §2).
 *
 * A project file / `.nexusdiagpanel.json` is untrusted input. Every function here NEVER throws:
 * malformed widgets are dropped (and counted so the UI can show a visible notice), numbers are
 * clamped, hex fields are validated, prototype-pollution keys are stripped. A loaded panel is only
 * data: nothing here starts polling or writes.
 */
import type {
  SimulationAccentColor,
  SimulationWidgetConfigDto,
  SimulationWidgetKind,
} from '../../../types/simulation';
import type {
  UdsByteLen,
  UdsIoOption,
  UdsPanelDto,
  UdsReadBinding,
  UdsReadService,
  UdsWidgetDto,
  UdsWriteBinding,
  UdsWriteService,
} from '../../../types/uds';
import { createClientUid } from '../../simulation/virtualCanPacking';
import { parseObdPid, sanitizeHex, sanitizeObdPid, withDerivedBinding } from './udsBinding';

export const MAX_DIAG_PANELS = 256;
export const MAX_DIAG_WIDGETS = 512;
export const DIAG_PANEL_FILE_KIND = 'nexus-diagnostic-panel';
export const DIAG_PANEL_FILE_SUFFIX = '.nexusdiagpanel.json';

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const WIDGET_KINDS: ReadonlySet<string> = new Set<SimulationWidgetKind>([
  'gauge', 'bar', 'numeric', 'led', 'enum_badge', 'graph', 'button', 'checkbox', 'combobox',
  'slider', 'textbox', 'group',
]);
const ACCENTS: ReadonlySet<string> = new Set<SimulationAccentColor>([
  'steel', 'cyan', 'emerald', 'amber', 'red', 'blue',
]);
const READ_SERVICES: ReadonlySet<string> = new Set<UdsReadService>(['read_did', 'read_mem', 'obd_pid']);
const WRITE_SERVICES: ReadonlySet<string> = new Set<UdsWriteService>(['write_did', 'write_mem', 'io_control']);
const IO_OPTIONS: ReadonlySet<string> = new Set<UdsIoOption>(['00', '01', '02', '03']);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, n));
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  return Math.round(num(v, fallback, lo, hi));
}

function str(v: unknown, fallback: string, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

/** Plain-JSON deep copy without prototype-pollution keys; depth limited, never throws. */
function clean(value: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (Array.isArray(value)) return value.slice(0, 4096).map((v) => clean(v, depth + 1));
  if (isRec(value)) {
    const out: Rec = {};
    for (const key of Object.keys(value)) {
      if (!FORBIDDEN_KEYS.has(key)) out[key] = clean(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 0;
  return value;
}

// ─── Bindings ────────────────────────────────────────────────────────────────

function sanitizeRead(raw: unknown): UdsReadBinding | null | 'bad' {
  if (raw === null || raw === undefined) return null;
  if (!isRec(raw)) return 'bad';
  const service = raw['service'];
  if (typeof service !== 'string' || !READ_SERVICES.has(service)) return 'bad';
  const byteLen = raw['byteLen'];
  if (byteLen !== 1 && byteLen !== 2 && byteLen !== 4) return 'bad';
  const out: UdsReadBinding = {
    service: service as UdsReadService,
    did: sanitizeHex(str(raw['did'], 'F190', 16)),
    address: sanitizeHex(str(raw['address'], '20004800', 16)),
    byteOffset: int(raw['byteOffset'], 0, 0, 4095),
    byteLen: byteLen as UdsByteLen,
    signed: raw['signed'] === true,
    factor: num(raw['factor'], 1, -1e9, 1e9) === 0 ? 1 : num(raw['factor'], 1, -1e9, 1e9),
    offset: num(raw['offset'], 0, -1e12, 1e12),
    unit: str(raw['unit'], '', 16),
    min: num(raw['min'], 0, -1e12, 1e12),
    max: num(raw['max'], 65535, -1e12, 1e12),
    decimals: int(raw['decimals'], 0, 0, 6),
    pollMs: int(raw['pollMs'], 0, 0, 3_600_000),
  };
  if (service === 'obd_pid') {
    const pid = sanitizeObdPid(str(raw['obdPid'], '', 8));
    if (parseObdPid(pid) === null) return 'bad';
    out.obdPid = pid;
  }
  if (out.max < out.min) out.max = out.min;
  return out;
}

function sanitizeWrite(raw: unknown): UdsWriteBinding | null | 'bad' {
  if (raw === null || raw === undefined) return null;
  if (!isRec(raw)) return 'bad';
  const service = raw['service'];
  if (typeof service !== 'string' || !WRITE_SERVICES.has(service)) return 'bad';
  const byteLen = raw['byteLen'];
  if (byteLen !== 1 && byteLen !== 2 && byteLen !== 4) return 'bad';
  const io = typeof raw['ioOption'] === 'string' && IO_OPTIONS.has(raw['ioOption']) ? raw['ioOption'] : '03';
  const out: UdsWriteBinding = {
    service: service as UdsWriteService,
    did: sanitizeHex(str(raw['did'], 'F190', 16)),
    address: sanitizeHex(str(raw['address'], '20004800', 16)),
    ioOption: io as UdsIoOption,
    byteOffset: int(raw['byteOffset'], 0, 0, 4095),
    byteLen: byteLen as UdsByteLen,
    factor: num(raw['factor'], 1, -1e9, 1e9) === 0 ? 1 : num(raw['factor'], 1, -1e9, 1e9),
    offset: num(raw['offset'], 0, -1e12, 1e12),
  };
  if (typeof raw['min'] === 'number' && Number.isFinite(raw['min'])) out.min = num(raw['min'], 0, -1e12, 1e12);
  if (typeof raw['max'] === 'number' && Number.isFinite(raw['max'])) out.max = num(raw['max'], 0, -1e12, 1e12);
  return out;
}

// ─── Widgets / panels ────────────────────────────────────────────────────────

function sanitizeWidget(raw: unknown, gridCols: number): UdsWidgetDto | null {
  if (!isRec(raw)) return null;
  const id = raw['id'];
  const kind = raw['kind'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
  if (typeof kind !== 'string' || !WIDGET_KINDS.has(kind)) return null;
  const layout = raw['layout'];
  if (!isRec(layout)) return null;
  const read = sanitizeRead(raw['udsRead']);
  const write = sanitizeWrite(raw['udsWrite']);
  if (read === 'bad' || write === 'bad') return null;

  const w = int(layout['w'], 4, 1, gridCols);
  const widget: UdsWidgetDto = {
    id,
    kind: kind as SimulationWidgetKind,
    title: str(raw['title'], '', 128),
    accentColor: (typeof raw['accentColor'] === 'string' && ACCENTS.has(raw['accentColor'])
      ? raw['accentColor']
      : 'cyan') as SimulationAccentColor,
    layout: {
      col: int(layout['col'], 0, 0, Math.max(0, gridCols - w)),
      row: int(layout['row'], 0, 0, 399),
      w,
      h: int(layout['h'], 3, 1, 60),
    },
    binding: null,
    config: (isRec(raw['config']) ? clean(raw['config']) : {}) as SimulationWidgetConfigDto,
    udsRead: read,
    udsWrite: write,
  };
  return withDerivedBinding(widget);
}

export interface UdsPanelSanitizeOne {
  panel: UdsPanelDto | null;
  droppedWidgets: number;
}

export function sanitizeUdsPanel(raw: unknown): UdsPanelSanitizeOne {
  if (!isRec(raw)) return { panel: null, droppedWidgets: 0 };
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return { panel: null, droppedWidgets: 0 };
  const rawWidgets = Array.isArray(raw['widgets']) ? raw['widgets'] : [];
  const gridCols = int(raw['gridCols'], 24, 1, 48);
  const widgets: UdsWidgetDto[] = [];
  const seen = new Set<string>();
  let dropped = Math.max(0, rawWidgets.length - MAX_DIAG_WIDGETS);
  for (const rw of rawWidgets.slice(0, MAX_DIAG_WIDGETS)) {
    const w = sanitizeWidget(rw, gridCols);
    if (w === null || seen.has(w.id)) {
      dropped += 1;
      continue;
    }
    seen.add(w.id);
    widgets.push(w);
  }
  const now = new Date().toISOString();
  return {
    panel: {
      id,
      name: str(raw['name'], 'Diagnostic Panel', 128) || 'Diagnostic Panel',
      description: str(raw['description'], '', 1024),
      gridCols,
      rowHeightPx: int(raw['rowHeightPx'], 42, 16, 200),
      targetDatabaseId: null,
      widgets,
      generators: [],
      createdAt: str(raw['createdAt'], now, 64),
      updatedAt: str(raw['updatedAt'], now, 64),
    },
    droppedWidgets: dropped,
  };
}

export interface UdsPanelsSanitizeResult {
  panels: UdsPanelDto[];
  droppedWidgets: number;
  droppedPanels: number;
}

/** `undefined` / non-array (old project files) -> `[]`. */
export function sanitizeUdsPanels(raw: unknown): UdsPanelsSanitizeResult {
  if (!Array.isArray(raw)) return { panels: [], droppedWidgets: 0, droppedPanels: 0 };
  const panels: UdsPanelDto[] = [];
  const seen = new Set<string>();
  let droppedWidgets = 0;
  let droppedPanels = Math.max(0, raw.length - MAX_DIAG_PANELS);
  for (const rp of raw.slice(0, MAX_DIAG_PANELS)) {
    const one = sanitizeUdsPanel(rp);
    droppedWidgets += one.droppedWidgets;
    if (one.panel === null || seen.has(one.panel.id)) {
      droppedPanels += 1;
      continue;
    }
    seen.add(one.panel.id);
    panels.push(one.panel);
  }
  return { panels, droppedWidgets, droppedPanels };
}

// ─── Clone / file exchange ───────────────────────────────────────────────────

/** Deep copy with a fresh panel id and fresh widget ids (duplicate / import). */
export function cloneUdsPanelWithNewIds(panel: UdsPanelDto, name?: string): UdsPanelDto {
  const now = new Date().toISOString();
  const copy = JSON.parse(JSON.stringify(panel)) as UdsPanelDto;
  return {
    ...copy,
    id: createClientUid('uds-pan'),
    name: name ?? copy.name,
    widgets: copy.widgets.map((w) => ({ ...w, id: createClientUid(`w-${w.kind}`) })),
    createdAt: now,
    updatedAt: now,
  };
}

export interface NexusDiagPanelFileV1 {
  schemaVersion: 1;
  kind: typeof DIAG_PANEL_FILE_KIND;
  exportedAt: string;
  panel: UdsPanelDto;
}

export function buildDiagPanelFile(panel: UdsPanelDto): NexusDiagPanelFileV1 {
  return {
    schemaVersion: 1,
    kind: DIAG_PANEL_FILE_KIND,
    exportedAt: new Date().toISOString(),
    panel,
  };
}

export type DiagPanelImportResult =
  | { ok: true; panel: UdsPanelDto; droppedWidgets: number }
  | { ok: false; error: 'json' | 'shape' };

/** Parses + sanitizes an exported file (envelope or a bare panel object). The panel gets fresh ids. */
export function parseDiagPanelFile(text: string): DiagPanelImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'json' };
  }
  const candidate = isRec(parsed) && isRec(parsed['panel']) ? parsed['panel'] : parsed;
  if (!isRec(candidate) || !Array.isArray(candidate['widgets'])) return { ok: false, error: 'shape' };
  // Ids of an imported file are never trusted: sanitize against a placeholder id, then re-key.
  const one = sanitizeUdsPanel({ ...candidate, id: 'import' });
  if (one.panel === null) return { ok: false, error: 'shape' };
  return { ok: true, panel: cloneUdsPanelWithNewIds(one.panel), droppedWidgets: one.droppedWidgets };
}
