/**
 * QA gate probes for RE Toolkit R1 binary snapshot codec (planning/contracts/re-toolkit-v1.md §2.2, §4).
 * Written BEFORE / independent of the implementer's own `test:re`. Buffers are hand-built here (NOT with
 * the codec's own encode helper) so encoder/decoder symmetry bugs cannot cancel out.
 * Assumed API: `decodeReSnapshot(buf: ArrayBuffer): ReSnapshot` from `src/services/reSnapshotCodec.ts`;
 * on malformed input it throws (or returns an object carrying `error` / `ok: false`) and never reads past the end.
 * Golden bytes: `crates/nexus-hal/tests/fixtures/re_snapshot_golden.bin` (produced by the Rust encoder).
 * Run: `npm run test:re-qa` (from the repo root).
 */
import { decodeReSnapshot } from '../../services/reSnapshotCodec';
import type { ReSnapshot, ReSnapshotRow } from '../../types/re';

// ─── Probe harness ─────────────────────────────────────────────────────────────

let currentProbe = '';
const probeFailures = new Map<string, string[]>();
let totalChecks = 0;
const results: Array<{ name: string; ok: boolean }> = [];

function check(cond: boolean, msg: string, detail = ''): void {
  totalChecks += 1;
  if (cond) return;
  const list = probeFailures.get(currentProbe) ?? [];
  list.push(`${msg}${detail !== '' ? `\n      ${detail}` : ''}`);
  probeFailures.set(currentProbe, list);
}
function eqv(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, msg, `expected: ${e}\n      actual:   ${a}`);
}
function probe(name: string, fn: () => void): void {
  currentProbe = name;
  probeFailures.set(name, []);
  try {
    fn();
  } catch (e) {
    check(false, 'probe threw', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  }
  const fails = probeFailures.get(name) ?? [];
  const ok = fails.length === 0;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  for (const f of fails) console.log(`    - ${f}`);
}

// ─── Node shims (app tsconfig has no node types: reach them through globalThis) ──

interface NodeFsShim {
  readFileSync(path: string): Uint8Array;
  existsSync(path: string): boolean;
}
interface NodeProcShim {
  exitCode?: number;
  getBuiltinModule?: (id: string) => unknown;
}
const proc = (globalThis as { process?: NodeProcShim }).process;
const fs = proc?.getBuiltinModule?.('node:fs') as NodeFsShim | undefined;

const GOLDEN = 'crates/nexus-hal/tests/fixtures/re_snapshot_golden.bin';

// ─── Independent hand-built encoder ─────────────────────────────────────────────

interface RowSpec {
  bus: number;
  flags: number;
  dlc: number;
  arbId: number;
  rx: number;
  heat?: (bit: number) => number;
  diff?: (byte: number) => number;
  constant?: (byte: number) => number;
  data?: (byte: number) => number;
}
interface HdrSpec {
  magic?: string;
  seq?: number;
  tsLo?: number;
  tsHi?: number;
  phase?: number;
  full?: number;
  rowCount?: number;
  totalRows?: number;
}

function build(h: HdrSpec, rows: RowSpec[]): ArrayBuffer {
  const size = 24 + rows.reduce((s, r) => s + 12 + r.dlc * 11, 0);
  const buf = new ArrayBuffer(size);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const magic = h.magic ?? 'NRE2';
  for (let i = 0; i < 4; i += 1) u8[i] = magic.charCodeAt(i) & 0xff;
  dv.setUint32(4, h.seq ?? 1, true);
  dv.setUint32(8, h.tsLo ?? 0, true);
  dv.setUint32(12, h.tsHi ?? 0, true);
  u8[16] = h.phase ?? 1;
  u8[17] = h.full ?? 1;
  dv.setUint16(18, h.rowCount ?? rows.length, true);
  dv.setUint16(20, h.totalRows ?? rows.length, true);
  dv.setUint16(22, 0, true);
  let off = 24;
  for (const r of rows) {
    u8[off] = r.bus;
    u8[off + 1] = r.flags;
    u8[off + 2] = r.dlc;
    u8[off + 3] = 0;
    dv.setUint32(off + 4, r.arbId >>> 0, true);
    dv.setUint32(off + 8, r.rx >>> 0, true);
    off += 12;
    for (let b = 0; b < r.dlc * 8; b += 1) u8[off + b] = (r.heat ?? ((x: number) => x & 0xff))(b);
    off += r.dlc * 8;
    for (let i = 0; i < r.dlc; i += 1) u8[off + i] = (r.diff ?? (() => 0))(i);
    off += r.dlc;
    for (let i = 0; i < r.dlc; i += 1) u8[off + i] = (r.constant ?? (() => 0xff))(i);
    off += r.dlc;
    for (let i = 0; i < r.dlc; i += 1) u8[off + i] = (r.data ?? ((x: number) => (x * 7 + 3) & 0xff))(i);
    off += r.dlc;
  }
  return buf;
}

/** True when decoding fails the contract way: a thrown non-RangeError, or a returned error marker. */
function rejects(buf: ArrayBuffer): { rejected: boolean; how: string } {
  try {
    const r = decodeReSnapshot(buf) as unknown;
    if (typeof r === 'object' && r !== null && ('error' in r || ('ok' in r && (r as { ok: unknown }).ok === false))) {
      return { rejected: true, how: 'returned error' };
    }
    return { rejected: false, how: `returned ${JSON.stringify(summary(r as ReSnapshot))}` };
  } catch (e) {
    if (e instanceof RangeError) return { rejected: false, how: `RangeError (read past end): ${e.message}` };
    return { rejected: true, how: e instanceof Error ? e.message : String(e) };
  }
}

function summary(s: ReSnapshot): unknown {
  return { seq: s.seq, rowCount: s.rowCount, rows: s.rows?.length };
}

function rowSize(r: ReSnapshotRow): number {
  return 12 + r.dlcBytes * 11;
}

// ─── Probes ─────────────────────────────────────────────────────────────────────

function main(): void {
  probe('golden: Rust-produced fixture decodes and is size-consistent', () => {
    if (!fs) {
      check(false, 'node:fs unavailable (process.getBuiltinModule missing; Node >= 20.16 required)');
      return;
    }
    if (!fs.existsSync(GOLDEN)) {
      check(false, `golden fixture missing: ${GOLDEN} (backend-dev must produce it; run from repo root)`);
      return;
    }
    const raw = fs.readFileSync(GOLDEN);
    // Node Buffers may be views into a shared pool: copy exactly the file bytes.
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const s = decodeReSnapshot(ab);
    const head = new Uint8Array(ab, 0, 4);
    eqv(String.fromCharCode(...head), 'NRE2', 'magic NRE2');
    check(['idle', 'free', 'baseline', 'action'].includes(s.phase), `phase ${String(s.phase)} in closed set`);
    eqv(s.rows.length, s.rowCount, 'rows.length == rowCount');
    check(s.rowCount <= s.totalRows, `rowCount ${s.rowCount} <= totalRows ${s.totalRows}`);
    const consumed = 24 + s.rows.reduce((a, r) => a + rowSize(r), 0);
    eqv(consumed, ab.byteLength, 'header + rows consume the file exactly (no trailing / missing bytes)');
    const dv = new DataView(ab);
    eqv(s.seq, dv.getUint32(4, true), 'seq = u32 LE @4');
    eqv(s.tsUs, dv.getUint32(8, true) + dv.getUint32(12, true) * 2 ** 32, 'tsUs = u64 LE @8');
    eqv(s.full, new Uint8Array(ab)[17] === 1, 'full = byte @17 == 1');
    for (const r of s.rows) {
      check(r.dlcBytes <= 64, `dlcBytes ${r.dlcBytes} <= 64`);
      eqv([r.heat.length, r.diff.length, r.constant.length, r.data.length], [r.dlcBytes * 8, r.dlcBytes, r.dlcBytes, r.dlcBytes], `row 0x${r.arbId.toString(16)} array sizes`);
      check(r.extended || r.arbId <= 0x7ff, `std row arbId 0x${r.arbId.toString(16)} <= 0x7FF`);
      check(r.arbId <= 0x1fffffff, `arbId 0x${r.arbId.toString(16)} <= 29 bit`);
      // A bit that is constant cannot also be a diff bit.
      for (let i = 0; i < r.dlcBytes; i += 1) {
        check((r.diff[i] & r.constant[i]) === 0, `row 0x${r.arbId.toString(16)} byte ${i}: diff & constant must be 0`);
      }
      // A constant bit never toggled -> heat 0.
      for (let b = 0; b < r.dlcBytes * 8; b += 1) {
        if ((r.constant[b >> 3] & (1 << (b & 7))) !== 0) {
          check(r.heat[b] === 0, `row 0x${r.arbId.toString(16)} bit ${b}: constant but heat ${r.heat[b]}`);
        }
      }
    }
    // Per-row `data` must equal the JSON sidecar's `dataHex` (byte 0 first).
    const jsonPath = GOLDEN.replace(/\.bin$/, '.json');
    check(fs.existsSync(jsonPath), `golden sidecar missing: ${jsonPath}`);
    const side = JSON.parse(new TextDecoder().decode(fs.readFileSync(jsonPath))) as { rows: { dataHex?: string }[] };
    eqv(side.rows.length, s.rows.length, 'sidecar row count');
    side.rows.forEach((jr, idx) => {
      check(typeof jr.dataHex === 'string', `sidecar row ${idx} has dataHex (fixture not regenerated for NRE2?)`);
      const hex = Array.from(s.rows[idx].data, (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      eqv(hex, (jr.dataHex ?? '').toUpperCase(), `row ${idx} data == sidecar dataHex`);
    });
    check(s.rows.some((r) => r.dlcBytes === 64), 'golden covers a 64-byte FD row');
    check(s.rows.some((r) => r.dlcBytes === 8), 'golden covers an 8-byte classic row');
  });

  probe('header: little-endian fields, unsigned, phase mapping', () => {
    const phases = ['idle', 'free', 'baseline', 'action'];
    for (let p = 0; p < 4; p += 1) {
      const s = decodeReSnapshot(build({ phase: p, rowCount: 0, totalRows: 7 }, []));
      eqv(s.phase, phases[p], `phase byte ${p}`);
      eqv([s.rowCount, s.totalRows, s.rows.length], [0, 7, 0], 'header-only snapshot');
    }
    const s = decodeReSnapshot(build({ seq: 0xffffffff, tsLo: 0x00000005, tsHi: 0x00000100, full: 0 }, []));
    eqv(s.seq, 0xffffffff, 'seq decoded unsigned (0xFFFFFFFF, not -1)');
    eqv(s.tsUs, 0x100 * 2 ** 32 + 5, 'tsUs u64 LE exact (2^40 + 5)');
    eqv(s.full, false, 'full byte 0 -> false');
    eqv(decodeReSnapshot(build({ full: 1 }, [])).full, true, 'full byte 1 -> true');
    // Byte-order trap: seq 0x01020304 must not decode as 0x04030201.
    eqv(decodeReSnapshot(build({ seq: 0x01020304 }, [])).seq, 0x01020304, 'seq little-endian');
  });

  probe('row: flags bits, arbId / rxCount unsigned, classic 8-byte layout', () => {
    const buf = build({}, [
      { bus: 255, flags: 0b0001, dlc: 8, arbId: 0x1fffffff, rx: 0xffffffff, diff: (i) => (i === 7 ? 0x80 : 0), constant: (i) => (i === 0 ? 0xfe : 0xff) },
      { bus: 0, flags: 0b0010, dlc: 8, arbId: 0x7ff, rx: 1 },
      { bus: 1, flags: 0b0100, dlc: 8, arbId: 0x100, rx: 2 },
      { bus: 2, flags: 0b1000, dlc: 8, arbId: 0x0, rx: 3 },
    ]);
    const s = decodeReSnapshot(buf);
    eqv(s.rows.length, 4, '4 rows');
    const [a, b, c, d] = s.rows;
    eqv([a.bus, a.extended, a.fd, a.hasDiff, a.isNew], [255, true, false, false, false], 'row0 flags b0 = extended');
    eqv([b.extended, b.fd, b.hasDiff, b.isNew], [false, true, false, false], 'row1 flags b1 = fd');
    eqv([c.extended, c.fd, c.hasDiff, c.isNew], [false, false, true, false], 'row2 flags b2 = hasDiff');
    eqv([d.extended, d.fd, d.hasDiff, d.isNew], [false, false, false, true], 'row3 flags b3 = new');
    eqv(a.arbId, 0x1fffffff, 'arbId u32 unsigned');
    eqv(a.rxCount, 0xffffffff, 'rxCount u32 unsigned (not negative)');
    eqv(Array.from(a.heat), Array.from({ length: 64 }, (_, i) => i), 'heat[64] in bit order');
    eqv(Array.from(a.diff), [0, 0, 0, 0, 0, 0, 0, 0x80], 'diff[8]');
    eqv(Array.from(a.constant), [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 'constant[8]');
    eqv([b.arbId, b.rxCount, c.rxCount, d.rxCount], [0x7ff, 1, 2, 3], 'offsets advance by 12 + dlc*11');
  });

  probe('row: dlcBytes 64 (CAN-FD) — heat[512], diff[64], constant[64], next row aligned', () => {
    const buf = build({}, [
      { bus: 3, flags: 0b0011, dlc: 64, arbId: 0x18ff0001, rx: 42, heat: (b) => (b === 511 ? 255 : b === 0 ? 1 : 0), diff: (i) => (i === 63 ? 0x80 : 0), constant: (i) => (i === 63 ? 0x7f : 0xff) },
      { bus: 4, flags: 0, dlc: 0, arbId: 0x123, rx: 9 },
      { bus: 5, flags: 0, dlc: 2, arbId: 0x124, rx: 10, heat: () => 7, diff: () => 1, constant: () => 0x0f },
    ]);
    eqv(buf.byteLength, 24 + (12 + 704) + 12 + (12 + 22), 'test buffer size');
    const s = decodeReSnapshot(buf);
    const r = s.rows[0];
    eqv([r.dlcBytes, r.heat.length, r.diff.length, r.constant.length, r.data.length], [64, 512, 64, 64, 64], 'FD array sizes');
    eqv([r.heat[0], r.heat[1], r.heat[510], r.heat[511]], [1, 0, 0, 255], 'heat[511] = last heat byte');
    eqv([r.diff[62], r.diff[63], r.constant[62], r.constant[63]], [0, 0x80, 0xff, 0x7f], 'diff/constant byte 63');
    eqv([r.extended, r.fd, r.arbId, r.rxCount, r.bus], [true, true, 0x18ff0001, 42, 3], 'FD row header');
    const z = s.rows[1];
    eqv([z.dlcBytes, z.heat.length, z.diff.length, z.constant.length, z.arbId, z.rxCount], [0, 0, 0, 0, 0x123, 9], 'dlcBytes 0 row = 12 bytes');
    const t = s.rows[2];
    eqv([t.arbId, Array.from(t.heat), Array.from(t.diff), Array.from(t.constant)], [0x124, Array(16).fill(7), [1, 1], [0x0f, 0x0f]], 'row after FD + empty row aligned');
  });

  probe('wrong magic rejected', () => {
    for (const m of ['NRE1', 'nre2', '2ERN', '\0\0\0\0']) {
      const r = rejects(build({ magic: m }, [{ bus: 0, flags: 0, dlc: 8, arbId: 1, rx: 1 }]));
      check(r.rejected, `magic ${JSON.stringify(m)} must be rejected`, r.how);
    }
  });

  probe('truncated: every strict prefix of a valid buffer is rejected (never reads past end)', () => {
    const buf = build({}, [
      { bus: 0, flags: 0, dlc: 8, arbId: 0x10, rx: 1 },
      { bus: 1, flags: 3, dlc: 64, arbId: 0x18ff0001, rx: 2 },
      { bus: 2, flags: 0, dlc: 1, arbId: 0x11, rx: 3 },
    ]);
    let bad = 0;
    const firstBad: string[] = [];
    for (let n = 0; n < buf.byteLength; n += 1) {
      const r = rejects(buf.slice(0, n));
      if (!r.rejected) {
        bad += 1;
        if (firstBad.length < 3) firstBad.push(`len ${n}: ${r.how}`);
      }
    }
    check(bad === 0, `${bad}/${buf.byteLength} truncated prefixes accepted`, firstBad.join('\n      '));
    check(!rejects(buf).rejected, 'the untruncated buffer must decode');
  });

  probe('hostile header: huge rowCount / dlcBytes > 64 rejected fast', () => {
    const r1 = rejects(build({ rowCount: 65535 }, [{ bus: 0, flags: 0, dlc: 8, arbId: 1, rx: 1 }]));
    check(r1.rejected, 'rowCount 65535 with 1 row of bytes must be rejected', r1.how);
    const b = build({}, [{ bus: 0, flags: 0, dlc: 64, arbId: 1, rx: 1 }]);
    new Uint8Array(b)[24 + 2] = 65; // dlcBytes 65 (buffer large enough for 64 only)
    const r2 = rejects(b);
    check(r2.rejected, 'dlcBytes 65 must be rejected', r2.how);
    const big = new ArrayBuffer(24 + 12 + 255 * 11);
    new Uint8Array(big).set(new Uint8Array(build({ rowCount: 1 }, [])).subarray(0, 24));
    new Uint8Array(big)[24 + 2] = 255; // dlcBytes 255 with enough bytes present: still > 64
    const r3 = rejects(big);
    check(r3.rejected, 'dlcBytes 255 must be rejected even when bytes are present', r3.how);
    for (const n of [0, 1, 3, 4, 23]) {
      const r = rejects(new ArrayBuffer(n));
      check(r.rejected, `${n}-byte buffer must be rejected`, r.how);
    }
  });

  probe('decoder is pure: input bytes unchanged', () => {
    const buf = build({}, [{ bus: 0, flags: 15, dlc: 8, arbId: 0x55, rx: 5 }]);
    const before = Array.from(new Uint8Array(buf));
    decodeReSnapshot(buf);
    decodeReSnapshot(buf);
    eqv(Array.from(new Uint8Array(buf)), before, 'input buffer not mutated');
  });

  const failed = results.filter((x) => !x.ok);
  console.log(`\nre.qa: ${results.length - failed.length}/${results.length} probes PASS (${totalChecks} checks)`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((x) => x.name).join(', ')}`);
    if (proc) proc.exitCode = 1;
  }
}

main();
