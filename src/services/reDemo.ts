/**
 * RE sniffer DEMO engine: a pure, deterministic synthetic CAN traffic generator used ONLY when no Tauri backend is
 * present (browser preview). Everything it produces is flagged `demo: true` by reClient and the UI shows a DEMO badge.
 * It implements the same per-row semantics as the Rust analyzer (toggle counts, window heat decay, constant mask,
 * baseline/action diff) so the view behaves like the real thing, but the data is never live bus data.
 *
 * Synthetic IDs (100 frames per virtual second of base time):
 *  0x100 std 8B  : byte0 low nibble = 4-bit counter, byte1 const, bytes2-3 slow ramp (16-bit Intel @16),
 *                  byte4 bit0 = flag toggled only during the "action" phase, byte7 = XOR8 of bytes 0..6
 *  0x200 std 8B  : byte0 = 8-bit counter, rest const (50 Hz)
 *  0x3A0 std 8B  : fully static (1 Hz)
 *  0x18FF1234 ext 4B : bytes 0-1 ramp (20 Hz)
 *  0x400 FD 16B  : byte 3 pseudo-random noise, rest const (10 Hz)
 */
import { decodeReSnapshot, encodeReSnapshotForTest } from './reSnapshotCodec';
import type {
  ReClassificationDto,
  ReFieldDto,
  ReMarkerDto,
  RePhase,
  ReRowDetailDto,
  ReRowKey,
  ReSettablePhase,
  ReSnapshot,
  ReSnapshotRow,
  ReStatusDto,
} from '../types/re';

const MAX_BITS = 512;
const HIST = 64;
const FRAME_US = 10_000; // base tick: 100 Hz
const FRAMES_PER_SNAPSHOT = 10; // 10 Hz snapshots

interface DemoRowSpec {
  bus: number;
  arbId: number;
  extended: boolean;
  fd: boolean;
  dlcBytes: number;
  periodFrames: number;
}

const SPECS: readonly DemoRowSpec[] = [
  { bus: 0, arbId: 0x100, extended: false, fd: false, dlcBytes: 8, periodFrames: 1 },
  { bus: 0, arbId: 0x200, extended: false, fd: false, dlcBytes: 8, periodFrames: 2 },
  { bus: 0, arbId: 0x3a0, extended: false, fd: false, dlcBytes: 8, periodFrames: 100 },
  { bus: 0, arbId: 0x18ff1234, extended: true, fd: false, dlcBytes: 4, periodFrames: 5 },
  { bus: 1, arbId: 0x400, extended: false, fd: true, dlcBytes: 16, periodFrames: 10 },
];

/**
 * Planted Value-Scan signals (opt-in via `new ReDemoEngine(clock, true)`; the app demo uses it, the R1 tests do not):
 *  0x1A0 std 8B (50 Hz): vehicle speed, 16-bit Motorola `15|16`, factor 0.01 km/h (10..100 km/h triangle, 15 s period)
 *  0x2B0 std 4B (50 Hz): pedal position, 8-bit Intel `0|8`, factor 0.4 % (0..100 % triangle, same period)
 */
const PLANTED_SPECS: readonly DemoRowSpec[] = [
  { bus: 0, arbId: 0x1a0, extended: false, fd: false, dlcBytes: 8, periodFrames: 2 },
  { bus: 0, arbId: 0x2b0, extended: false, fd: false, dlcBytes: 4, periodFrames: 2 },
];

/** Triangle 0..1 over `period` frames. */
function demoTriangle(n: number, period: number): number {
  const ph = (n % period) / period;
  return ph < 0.5 ? ph * 2 : 2 - ph * 2;
}

interface DemoRow {
  spec: DemoRowSpec;
  n: number;
  prev: Uint8Array;
  hasPrev: boolean;
  toggles: Uint32Array;
  windowToggles: Uint16Array;
  seenOne: Uint8Array;
  seenZero: Uint8Array;
  baselineActive: Uint8Array;
  actionActive: Uint8Array;
  history: Uint8Array[];
  histTs: number[];
  rxCount: number;
  firstUs: number;
  lastUs: number;
  dirty: boolean;
  isNew: boolean;
  rng: number;
}

export function demoRowKey(bus: number, arbId: number, ext: boolean): string {
  return `${bus}:${ext ? 'x' : 's'}:${arbId}`;
}

function newRow(spec: DemoRowSpec): DemoRow {
  return {
    spec,
    n: 0,
    prev: new Uint8Array(64),
    hasPrev: false,
    toggles: new Uint32Array(MAX_BITS),
    windowToggles: new Uint16Array(MAX_BITS),
    seenOne: new Uint8Array(64),
    seenZero: new Uint8Array(64),
    baselineActive: new Uint8Array(64),
    actionActive: new Uint8Array(64),
    history: [],
    histTs: [],
    rxCount: 0,
    firstUs: 0,
    lastUs: 0,
    dirty: false,
    isNew: true,
    rng: (spec.arbId * 2654435761) >>> 0,
  };
}

function nextRng(row: DemoRow): number {
  row.rng = (Math.imul(row.rng, 1664525) + 1013904223) >>> 0;
  return row.rng;
}

function buildPayload(row: DemoRow, phase: RePhase): Uint8Array {
  const spec = row.spec;
  const p = new Uint8Array(spec.dlcBytes);
  const n = row.n;
  switch (spec.arbId) {
    case 0x100: {
      p[0] = 0xa0 | (n & 0x0f);
      p[1] = 0x55;
      const ramp = (1000 + Math.floor(n / 10)) & 0xffff;
      p[2] = ramp & 0xff;
      p[3] = ramp >> 8;
      p[4] = 0x40 | (phase === 'action' ? (n >> 2) & 1 : 0);
      p[5] = 0x12;
      p[6] = 0x34;
      p[7] = p[0] ^ p[1] ^ p[2] ^ p[3] ^ p[4] ^ p[5] ^ p[6];
      break;
    }
    case 0x200:
      p[0] = n & 0xff;
      p[1] = 0xde;
      p[2] = 0xad;
      p.fill(0x00, 3);
      break;
    case 0x3a0:
      p.set([0xca, 0xfe, 0x00, 0x01, 0x80, 0x00, 0x00, 0xff]);
      break;
    case 0x18ff1234: {
      const v = (n * 3) & 0xffff;
      p[0] = v & 0xff;
      p[1] = v >> 8;
      p[2] = 0x7d;
      p[3] = 0x00;
      break;
    }
    case 0x1a0: {
      const raw = Math.round((10 + 90 * demoTriangle(n, 750)) * 100); // km/h x 100
      p[0] = 0x5a;
      p[1] = (raw >> 8) & 0xff; // Motorola 15|16 (sawtooth 15..8 -> 23..16): byte 1 = high byte, byte 2 = low byte
      p[2] = raw & 0xff;
      p.fill(0x5a, 3);
      break;
    }
    case 0x2b0:
      p[0] = Math.round(demoTriangle(n, 750) * 250); // % x 2.5
      p[1] = 0x00;
      p[2] = 0x7f;
      p[3] = 0x01;
      break;
    default:
      p.fill(0x11);
      p[3] = nextRng(row) >>> 24;
      break;
  }
  return p;
}

function bitAt(buf: Uint8Array, bit: number): number {
  return (buf[bit >> 3] >> (bit & 7)) & 1;
}

function toHex(buf: Uint8Array, n: number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

export type DemoClock = () => number;

export interface DemoScanRow {
  bus: number;
  arbId: number;
  isExtended: boolean;
  dlcBytes: number;
  latest: Uint8Array;
  /** last <= 64 payloads, oldest first */
  historyData: readonly Uint8Array[];
  historyTs: readonly number[];
}

export class ReDemoEngine {
  private rows = new Map<string, DemoRow>();
  private order: DemoRow[] = [];
  private markers: ReMarkerDto[] = [];
  private markerSeq = 1;
  private enabled = false;
  private phase: RePhase = 'idle';
  private frames = 0;
  private framesIngested = 0;
  private seq = 0;
  private startedAtUs: number | null = null;
  private phaseStartedAtUs: number | null = null;
  private jitterRng = 12345;
  private forceFull = true;

  private readonly specs: readonly DemoRowSpec[];

  /** `clockUs` supplies the virtual-time origin (Date.now()*1000 in the app, fixed in tests). */
  constructor(
    private readonly clockUs: DemoClock,
    planted = false,
  ) {
    this.specs = planted ? [...SPECS, ...PLANTED_SPECS] : SPECS;
  }

  /** Read-only view of the rows for the demo Value Scan (latest payload + sample history). */
  scanRows(): DemoScanRow[] {
    return this.order.map((r) => ({
      bus: r.spec.bus,
      arbId: r.spec.arbId,
      isExtended: r.spec.extended,
      dlcBytes: r.spec.dlcBytes,
      latest: r.prev.slice(0, r.spec.dlcBytes),
      historyData: r.history,
      historyTs: r.histTs,
    }));
  }

  private nowUs(): number {
    return this.clockUs() + this.frames * FRAME_US;
  }

  status(): ReStatusDto {
    return {
      enabled: this.enabled,
      phase: this.phase,
      rows: this.rows.size,
      overflowRows: 0,
      framesIngested: this.framesIngested,
      startedAtUs: this.startedAtUs,
      phaseStartedAtUs: this.phaseStartedAtUs,
    };
  }

  start(buses: number[] | null): ReStatusDto {
    this.enabled = true;
    if (this.phase === 'idle') this.phase = 'free';
    this.busFilter = buses;
    this.startedAtUs ??= this.nowUs();
    this.phaseStartedAtUs ??= this.nowUs();
    return this.status();
  }

  private busFilter: number[] | null = null;

  stop(): ReStatusDto {
    this.enabled = false;
    return this.status();
  }

  reset(): ReStatusDto {
    this.rows.clear();
    this.order = [];
    this.markers = [];
    this.framesIngested = 0;
    this.phase = this.enabled ? 'free' : 'idle';
    this.startedAtUs = this.enabled ? this.nowUs() : null;
    this.phaseStartedAtUs = this.startedAtUs;
    this.forceFull = true;
    return this.status();
  }

  setPhase(phase: ReSettablePhase): ReStatusDto {
    this.phase = phase;
    this.phaseStartedAtUs = this.nowUs();
    for (const r of this.order) {
      if (phase === 'baseline') r.baselineActive.fill(0);
      if (phase === 'action') r.actionActive.fill(0);
    }
    return this.status();
  }

  mark(label: string): ReMarkerDto {
    const m: ReMarkerDto = {
      id: this.markerSeq,
      tsUs: this.nowUs(),
      label: label.slice(0, 64),
      phase: this.phase,
    };
    this.markerSeq += 1;
    this.markers.push(m);
    if (this.markers.length > 1024) this.markers.shift();
    return m;
  }

  listMarkers(): ReMarkerDto[] {
    return this.markers.slice();
  }

  requestFull(): void {
    this.forceFull = true;
  }

  private ingest(row: DemoRow, payload: Uint8Array, tsUs: number): void {
    const nbits = row.spec.dlcBytes * 8;
    for (let bit = 0; bit < nbits; bit += 1) {
      const cur = bitAt(payload, bit);
      const mask = 1 << (bit & 7);
      if (cur === 1) row.seenOne[bit >> 3] |= mask;
      else row.seenZero[bit >> 3] |= mask;
      if (row.hasPrev && cur !== bitAt(row.prev, bit)) {
        row.toggles[bit] = Math.min(0xffffffff, row.toggles[bit] + 1);
        row.windowToggles[bit] = Math.min(0xffff, row.windowToggles[bit] + 1);
        if (this.phase === 'baseline') row.baselineActive[bit >> 3] |= mask;
        else if (this.phase === 'action') row.actionActive[bit >> 3] |= mask;
      }
    }
    row.prev.set(payload);
    row.hasPrev = true;
    row.rxCount += 1;
    if (row.rxCount === 1) row.firstUs = tsUs;
    row.lastUs = tsUs;
    row.history.push(payload.slice());
    row.histTs.push(tsUs);
    if (row.history.length > HIST) {
      row.history.shift();
      row.histTs.shift();
    }
    row.dirty = true;
    this.framesIngested += 1;
  }

  /** Advance virtual time by one snapshot period; returns the encoded snapshot or null when stopped. */
  tick(): ArrayBuffer | null {
    if (!this.enabled) return null;
    for (let f = 0; f < FRAMES_PER_SNAPSHOT; f += 1) {
      this.frames += 1;
      for (const spec of this.specs) {
        if (this.frames % spec.periodFrames !== 0) continue;
        if (this.busFilter !== null && !this.busFilter.includes(spec.bus)) continue;
        const key = demoRowKey(spec.bus, spec.arbId, spec.extended);
        let row = this.rows.get(key);
        if (row === undefined) {
          row = newRow(spec);
          this.rows.set(key, row);
          this.order.push(row);
        }
        row.n += 1;
        this.jitterRng = (Math.imul(this.jitterRng, 1103515245) + 12345) >>> 0;
        const jitter = ((this.jitterRng >>> 16) % 401) - 200; // +-200 us
        this.ingest(row, buildPayload(row, this.phase), this.nowUs() + jitter);
      }
    }
    // 1 s window decay: x -> x / 2
    if (this.frames % 100 === 0) {
      for (const r of this.order) {
        for (let i = 0; i < r.spec.dlcBytes * 8; i += 1) r.windowToggles[i] >>= 1;
      }
    }
    const full = this.forceFull;
    this.forceFull = false;
    const rows: ReSnapshotRow[] = [];
    for (const r of this.order) {
      if (!full && !r.dirty) continue;
      rows.push(this.snapshotRow(r));
      r.dirty = false;
      r.isNew = false;
    }
    this.seq += 1;
    const snap: ReSnapshot = {
      seq: this.seq,
      tsUs: this.nowUs(),
      phase: this.phase,
      full,
      rowCount: rows.length,
      totalRows: this.order.length,
      rows,
    };
    // Round-trip through the real codec so the demo exercises the same decode path as live data.
    return encodeReSnapshotForTest(snap);
  }

  private snapshotRow(r: DemoRow): ReSnapshotRow {
    const n = r.spec.dlcBytes;
    const heat = new Uint8Array(n * 8);
    const diff = new Uint8Array(n);
    const constant = new Uint8Array(n);
    let hasDiff = false;
    const denom = Math.log2(1 + 128);
    for (let bit = 0; bit < n * 8; bit += 1) {
      const w = r.windowToggles[bit];
      heat[bit] = w === 0 ? 0 : Math.min(255, Math.max(1, Math.round((255 * Math.log2(1 + w)) / denom)));
    }
    for (let i = 0; i < n; i += 1) {
      diff[i] = r.actionActive[i] & ~r.baselineActive[i] & 0xff;
      if (diff[i] !== 0) hasDiff = true;
      constant[i] = ~(r.seenOne[i] & r.seenZero[i]) & 0xff;
    }
    return {
      bus: r.spec.bus,
      extended: r.spec.extended,
      fd: r.spec.fd,
      hasDiff,
      isNew: r.isNew,
      dlcBytes: n,
      arbId: r.spec.arbId,
      rxCount: r.rxCount,
      heat,
      diff,
      constant,
      data: r.prev.slice(0, n),
    };
  }

  private find(key: ReRowKey): DemoRow | undefined {
    return this.rows.get(demoRowKey(key.bus, key.arbId, key.isExtended));
  }

  rowDetail(key: ReRowKey): ReRowDetailDto {
    const r = this.find(key);
    if (r === undefined) throw new Error('RE row not found');
    const n = r.spec.dlcBytes;
    const constant = new Uint8Array(n);
    const diff = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      constant[i] = ~(r.seenOne[i] & r.seenZero[i]) & 0xff;
      diff[i] = r.actionActive[i] & ~r.baselineActive[i] & 0xff;
    }
    return {
      bus: key.bus,
      arbId: key.arbId,
      isExtended: key.isExtended,
      dlcBytes: n,
      rxCount: r.rxCount,
      toggles: Array.from(r.toggles.subarray(0, n * 8)),
      constantMask: toHex(constant, n),
      baselineMask: toHex(r.baselineActive, n),
      actionMask: toHex(r.actionActive, n),
      diffMask: toHex(diff, n),
      firstUs: r.firstUs,
      lastUs: r.lastUs,
      historyLen: r.history.length,
    };
  }

  /**
   * DEMO classification: entropy / period / jitter are measured from the synthetic history; the field list is the
   * known construction of the synthetic IDs (this is not a classifier, it is ground truth for the demo traffic).
   */
  classify(key: ReRowKey): ReClassificationDto {
    const r = this.find(key);
    if (r === undefined) throw new Error('RE row not found');
    const n = r.spec.dlcBytes;
    const samples = r.history.length;
    const bitEntropy: number[] = [];
    for (let bit = 0; bit < n * 8; bit += 1) {
      let ones = 0;
      for (const h of r.history) ones += bitAt(h, bit);
      const p = samples === 0 ? 0 : ones / samples;
      bitEntropy.push(p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));
    }
    let periodMs: number | null = null;
    let jitterMs: number | null = null;
    if (r.histTs.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < r.histTs.length; i += 1) deltas.push((r.histTs[i] - r.histTs[i - 1]) / 1000);
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const variance = deltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / deltas.length;
      periodMs = mean;
      jitterMs = Math.sqrt(variance);
    }
    const fields: ReFieldDto[] = samples < 16 ? [] : this.demoFields(r);
    return { bus: key.bus, arbId: key.arbId, isExtended: key.isExtended, samples, bitEntropy, fields, periodMs, jitterMs };
  }

  private demoFields(r: DemoRow): ReFieldDto[] {
    const intel = 'intel' as const;
    switch (r.spec.arbId) {
      case 0x100:
        return [
          { startBit: 0, bitLength: 4, byteOrder: intel, kind: 'counter', confidence: 1, counterModulo: 16, counterStep: 1 },
          { startBit: 4, bitLength: 12, byteOrder: intel, kind: 'constant', confidence: 1 },
          { startBit: 16, bitLength: 16, byteOrder: intel, kind: 'physical', confidence: 0.9, min: 1000, max: 1000 + Math.floor(r.n / 10) },
          { startBit: 32, bitLength: 1, byteOrder: intel, kind: 'flag', confidence: 0.85 },
          { startBit: 33, bitLength: 23, byteOrder: intel, kind: 'constant', confidence: 1 },
          { startBit: 56, bitLength: 8, byteOrder: intel, kind: 'checksum', confidence: 1, checksumAlgo: 'xor8', checksumInit: 0, checksumCoverage: '0-6' },
        ];
      case 0x200:
        return [
          { startBit: 0, bitLength: 8, byteOrder: intel, kind: 'counter', confidence: 1, counterModulo: 256, counterStep: 1 },
          { startBit: 8, bitLength: 56, byteOrder: intel, kind: 'constant', confidence: 1 },
        ];
      case 0x18ff1234:
        return [
          { startBit: 0, bitLength: 16, byteOrder: intel, kind: 'physical', confidence: 0.9, min: 0, max: 65535 },
          { startBit: 16, bitLength: 16, byteOrder: intel, kind: 'constant', confidence: 1 },
        ];
      case 0x400:
        return [
          { startBit: 0, bitLength: 24, byteOrder: intel, kind: 'constant', confidence: 1 },
          { startBit: 24, bitLength: 8, byteOrder: intel, kind: 'unknown', confidence: 0.4 },
          { startBit: 32, bitLength: 96, byteOrder: intel, kind: 'constant', confidence: 1 },
        ];
      default:
        return [{ startBit: 0, bitLength: r.spec.dlcBytes * 8, byteOrder: intel, kind: 'constant', confidence: 1 }];
    }
  }
}

/** Convenience for tests/UI: decode a demo tick. */
export function decodeDemoTick(engine: ReDemoEngine): ReSnapshot | null {
  const buf = engine.tick();
  return buf === null ? null : decodeReSnapshot(buf);
}
