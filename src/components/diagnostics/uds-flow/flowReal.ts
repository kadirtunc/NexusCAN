/**
 * REAL-mode executor of the UDS flow engine: every UDS block talks to the live diagnostic
 * session through a `FlowTransport`; data blocks operate on real block outputs. No simulated
 * values and no `Math.random` anywhere in this file. DEMO mode never reaches this code.
 */
import { t } from '../../../i18n';
import { flowStore } from './FlowStore';
import type { FlowBlock, FlowConnection, FlowDiagram } from './types';
import type { RunContext } from './FlowEngine';
import type { FlowTransport } from './flowTransport';
import { computeKey, crc16ibm, crc32 } from './flowAlgos';
import { flowFiles } from './flowFiles';
import { flowPrompt } from './flowPrompt';
import {
  DTC_COUNT_SUBFUNCTIONS,
  DTC_RECORD_SUBFUNCTIONS,
  decodeDidValue,
  formatDid,
  formatDtc3,
  udsSessionName,
} from '../../../services/udsDecode';

export interface RealOutcome {
  message: string;
  result?: unknown;
  nextPort?: string;
  /** Values on output ports (`portId -> value`), readable by downstream data connections. */
  outputs?: Record<string, unknown>;
}

const MAX_EVAL_DEPTH = 16;

/** Blocks without exec ports: evaluated lazily when a downstream block reads their output. */
const PURE_BLOCKS: ReadonlySet<string> = new Set([
  'data_const',
  'data_var',
  'data_byte_builder',
  'data_extract',
  'data_bitfield_extract',
  'data_compare',
]);

function hexB(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

function hexList(bytes: ArrayLike<number>): string {
  return Array.from(bytes).map(hexB).join(' ');
}

function u16(a: number, b: number): number {
  return ((a << 8) | b) & 0xffff;
}

function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v.every((x): x is number => typeof x === 'number')) return Uint8Array.from(v);
  return null;
}

function valueText(v: unknown): string {
  const b = asBytes(v);
  if (b) return hexList(b);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

function normText(v: unknown): string {
  const b = asBytes(v);
  if (b) return Array.from(b).map(hexB).join('');
  if (typeof v === 'string') return v.trim().replace(/^0x/i, '').replace(/\s+/g, '').toUpperCase();
  return String(v).toUpperCase();
}

function numeric(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const b = asBytes(v);
  if (b) return b.length > 0 && b.length <= 6 ? b.reduce((acc, x) => acc * 256 + x, 0) : NaN;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return NaN;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim().length > 0 && v.trim().toLowerCase() !== 'false' && v.trim() !== '0';
  const b = asBytes(v);
  return b ? b.some((x) => x !== 0) : false;
}

function compareValues(op: string, a: unknown, b: unknown): boolean {
  const an = numeric(a);
  const bn = numeric(b);
  switch (op) {
    case 'eq':
      return Number.isFinite(an) && Number.isFinite(bn) ? an === bn : normText(a) === normText(b);
    case 'neq':
      return Number.isFinite(an) && Number.isFinite(bn) ? an !== bn : normText(a) !== normText(b);
    case 'contains':
      return normText(a).includes(normText(b));
    case 'gt':
    case 'lt':
      if (!Number.isFinite(an) || !Number.isFinite(bn)) throw new Error(t('diagReal.flow.notNumeric'));
      return op === 'gt' ? an > bn : an < bn;
    default:
      throw new Error(t('diagReal.flow.badOperator', { op }));
  }
}

/** "08 00 00 00" / "0x08000000" -> bytes; odd digit counts are left-padded; empty/invalid -> Error. */
function hexField(raw: unknown, field: string): number[] {
  const s = String(raw ?? '').replace(/^\s*0x/i, '').replace(/[\s,]/g, '');
  if (s.length === 0 || !/^[0-9a-fA-F]+$/.test(s)) throw new Error(t('diagReal.flow.invalidHex', { field }));
  const even = s.length % 2 === 0 ? s : `0${s}`;
  return (even.match(/.{2}/g) ?? []).map((p) => parseInt(p, 16));
}

function byteField(raw: unknown, field: string): number {
  const b = hexField(raw, field);
  if (b.length !== 1) throw new Error(t('diagReal.flow.invalidHex', { field }));
  return b[0];
}

function didField(raw: unknown): { did: number; bytes: number[] } {
  const bytes = hexField(raw, 'DID');
  if (bytes.length !== 2) throw new Error(t('diagReal.flow.invalidHex', { field: 'DID' }));
  return { did: u16(bytes[0], bytes[1]), bytes };
}

export class RealFlowExecutor {
  private readonly outputs = new Map<string, Record<string, unknown>>();
  /** Result of the previously completed block (fallback input for byte-processing blocks). */
  prevResult: unknown = undefined;

  constructor(
    private readonly transport: FlowTransport,
    private readonly ctx: RunContext,
    private readonly log: (block: FlowBlock, msg: string) => void,
  ) {}

  reset(): void {
    this.outputs.clear();
    this.prevResult = undefined;
  }

  record(block: FlowBlock, outcome: RealOutcome): void {
    this.outputs.set(block.id, outcome.outputs ?? {});
    this.prevResult = outcome.result;
  }

  // ── Data connections ───────────────────────────────────────────────────────

  private diagram(): FlowDiagram {
    return (flowStore.getSnapshot() as { diagram: FlowDiagram }).diagram;
  }

  private findInputConn(block: FlowBlock, portId: string): FlowConnection | undefined {
    return this.diagram().connections.find((c) => c.toBlockId === block.id && c.toPortId === portId);
  }

  /** Value on a connected input port; `undefined` when the port is not connected. */
  private async optionalInput(block: FlowBlock, portId: string, depth: number): Promise<unknown> {
    const conn = this.findInputConn(block, portId);
    if (!conn) return undefined;
    return this.readOutput(conn.fromBlockId, conn.fromPortId, depth + 1);
  }

  /** Input port value; falls back to the previous block's result when allowed; otherwise an error. */
  private async need(block: FlowBlock, portId: string, allowPrev: boolean, depth = 0): Promise<unknown> {
    const v = await this.optionalInput(block, portId, depth);
    if (v !== undefined) return v;
    if (allowPrev && this.prevResult !== undefined && this.prevResult !== null) return this.prevResult;
    throw new Error(t('diagReal.flow.noInput', { block: block.label, port: portId }));
  }

  private async needBytes(block: FlowBlock, portId: string, allowPrev: boolean, depth = 0): Promise<Uint8Array> {
    const b = asBytes(await this.need(block, portId, allowPrev, depth));
    if (!b) throw new Error(t('diagReal.flow.notBytes', { block: block.label, port: portId }));
    return b;
  }

  private async readOutput(blockId: string, portId: string, depth: number): Promise<unknown> {
    if (depth > MAX_EVAL_DEPTH) throw new Error(t('diagReal.flow.cycle'));
    const outs = this.outputs.get(blockId);
    if (outs && portId in outs) return outs[portId];
    const src = this.diagram().blocks.find((b) => b.id === blockId);
    if (!src) throw new Error(t('diagReal.flow.sourceMissing'));
    if (PURE_BLOCKS.has(src.type)) return this.evalPure(src, depth);
    throw new Error(t('diagReal.flow.sourceNotRun', { block: src.label, port: portId }));
  }

  private async evalPure(block: FlowBlock, depth: number): Promise<unknown> {
    const cfg = block.config;
    switch (block.type) {
      case 'data_const': {
        const format = String(cfg['format'] ?? 'text');
        const value = cfg['value'];
        if (format === 'hex') return Uint8Array.from(hexField(value, block.label));
        if (format === 'dec') {
          const n = Number(String(value ?? '').trim());
          if (!Number.isFinite(n)) throw new Error(t('diagReal.flow.notNumeric'));
          return n;
        }
        return String(value ?? '');
      }
      case 'data_var': {
        const name = String(cfg['name'] ?? 'myVar');
        const set = await this.optionalInput(block, 'set_in', depth);
        if (set !== undefined) {
          this.ctx.variables.set(name, set);
          return set;
        }
        if (this.ctx.variables.has(name)) return this.ctx.variables.get(name);
        const initial = cfg['initial'];
        this.ctx.variables.set(name, initial);
        return initial;
      }
      case 'data_byte_builder': {
        const format = String(cfg['format'] ?? 'hex');
        const template = String(cfg['template'] ?? '');
        if (format === 'ascii') return Uint8Array.from(Array.from(template, (c) => c.charCodeAt(0) & 0xff));
        if (format === 'decimal') {
          const parts = template.split(',').map((p) => Number(p.trim()));
          if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
            throw new Error(t('diagReal.flow.invalidHex', { field: block.label }));
          }
          return Uint8Array.from(parts);
        }
        return Uint8Array.from(hexField(template, block.label));
      }
      case 'data_extract': {
        const bytes = await this.needBytes(block, 'bytes_in', true, depth);
        const offset = Number(cfg['offset'] ?? 0);
        const length = Number(cfg['length'] ?? 1);
        if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 1 || offset + length > bytes.length) {
          throw new Error(t('diagReal.flow.range', { what: `[${offset}:${offset + length}] / ${bytes.length} B` }));
        }
        return bytes.slice(offset, offset + length);
      }
      case 'data_bitfield_extract': {
        const bytes = await this.needBytes(block, 'bytes_in', true, depth);
        const byteOffset = Number(cfg['byte_offset'] ?? 0);
        const hi = Number(cfg['bit_high'] ?? 7);
        const lo = Number(cfg['bit_low'] ?? 0);
        if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset >= bytes.length || !(hi >= lo && lo >= 0 && hi <= 7)) {
          throw new Error(t('diagReal.flow.range', { what: `byte ${byteOffset} bit[${hi}:${lo}] / ${bytes.length} B` }));
        }
        return (bytes[byteOffset] >> lo) & ((1 << (hi - lo + 1)) - 1);
      }
      case 'data_compare': {
        const left = await this.need(block, 'left_in', false, depth);
        const right = await this.need(block, 'right_in', false, depth);
        return compareValues(String(cfg['operator'] ?? 'eq'), left, right);
      }
      default:
        throw new Error(t('diagEng.unknownBlock', { type: block.type }));
    }
  }

  /** Re-evaluates a bool input (used by `flow_while` before every iteration). */
  async evalBool(block: FlowBlock, portId: string): Promise<boolean> {
    return toBool(await this.need(block, portId, false));
  }

  // ── UDS helper ─────────────────────────────────────────────────────────────

  private async uds(
    block: FlowBlock,
    sid: number,
    data: readonly number[],
    name: string,
    suppressed = false,
  ): Promise<number[]> {
    this.log(block, `TX: ${hexList([sid, ...data])}  (${name})`);
    const pdu = await this.transport.request(sid, data, { suppressed });
    this.log(block, suppressed ? t('diagEng.noResponse', { baud: '-' }) : `RX: ${hexList(pdu)}`);
    return pdu;
  }

  private expect(pdu: readonly number[], index: number, expected: readonly number[], what: string): void {
    const ok = expected.every((e, i) => pdu[index + i] === e);
    if (!ok) throw new Error(t('diagReal.flow.badEcho', { what, rx: hexList(pdu) }));
  }

  // ── Block execution ────────────────────────────────────────────────────────

  async execute(block: FlowBlock): Promise<RealOutcome> {
    const cfg = block.config;
    const ctx = this.ctx;

    switch (block.type) {
      // ── Flow ────────────────────────────────────────────────────────────────
      case 'log': {
        const msg = String(cfg['message'] ?? '');
        const v = await this.optionalInput(block, 'value_in', 0);
        const text = v === undefined ? msg : `${msg}${msg ? ' ' : ''}${valueText(v)}`;
        this.log(block, `LOG: ${text || t('diagEng.empty')}`);
        return { message: text || t('diagEng.emptyMsg') };
      }

      case 'flow_timeout_guard': {
        const ms = Number(cfg['timeout_ms'] ?? 5000);
        this.log(block, t('diagReal.flow.guardPassThrough', { ms }));
        return { message: t('diagReal.flow.guardPassThrough', { ms }) };
      }

      case 'condition': {
        const value = toBool(await this.need(block, 'bool_in', false));
        return { message: String(value), result: value };
      }

      case 'assert': {
        const actual = await this.need(block, 'value_in', true);
        const op = String(cfg['operator'] ?? 'eq');
        const expected = cfg['expected'];
        const pass = compareValues(op, actual, expected);
        this.log(block, `assert ${valueText(actual)} ${op} ${valueText(expected)} → ${pass}`);
        return { message: `${valueText(actual)} ${op} ${valueText(expected)} → ${pass}`, result: pass };
      }

      // ── 0x10 ────────────────────────────────────────────────────────────────
      case 'uds_session': {
        const st = String(cfg['session_type'] ?? 'extended');
        const subFn: Record<string, number> = { default: 0x01, programming: 0x02, extended: 0x03, safety: 0x04 };
        const sf = subFn[st] ?? 0x03;
        const pdu = await this.uds(block, 0x10, [sf], 'DiagnosticSessionControl');
        this.expect(pdu, 1, [sf], 'DiagnosticSessionControl');
        let p2: number | null = null;
        let p2ext: number | null = null;
        if (pdu.length >= 6) {
          p2 = u16(pdu[2], pdu[3]);
          p2ext = u16(pdu[4], pdu[5]) * 10;
        }
        ctx.sessionType = st === 'default' || st === 'programming' || st === 'extended' || st === 'safety' ? st : 'extended';
        const timing = p2 === null ? '' : `  P2=${p2}ms P2*=${p2ext}ms`;
        this.log(block, `${udsSessionName(sf)}${timing}`);
        const result = { sessionType: st, p2, p2ext };
        return { message: `${st.toUpperCase()}${timing}`, result, outputs: { session_out: result } };
      }

      case 'uds_ecu_reset': {
        const rt = String(cfg['reset_type'] ?? 'hardReset');
        const rtBytes: Record<string, number> = { hardReset: 0x01, keyOffOnReset: 0x02, softReset: 0x03, enableRapidPowerShutDown: 0x04 };
        const sf = rtBytes[rt] ?? 0x01;
        const pdu = await this.uds(block, 0x11, [sf], 'ECUReset');
        this.expect(pdu, 1, [sf], 'ECUReset');
        ctx.sessionType = 'default';
        ctx.securityUnlocked = false;
        ctx.commControlled = false;
        return { message: `ECUReset ${rt}` };
      }

      case 'uds_clear_dtc': {
        const group = hexField(cfg['group'] ?? 'FFFFFF', 'group');
        if (group.length !== 3) throw new Error(t('diagReal.flow.invalidHex', { field: 'group' }));
        await this.uds(block, 0x14, group, 'ClearDiagnosticInformation');
        return { message: t('diagEng.dtcGroupCleared', { group: hexList(group).replace(/ /g, '') }) };
      }

      // ── 0x19 ────────────────────────────────────────────────────────────────
      case 'uds_read_dtc': {
        const sf = byteField(cfg['sub_fn'] ?? '02', 'sub_fn');
        const mask = byteField(cfg['status_mask'] ?? 'FF', 'status_mask');
        let params: number[] = [];
        if ([0x01, 0x02, 0x0f, 0x11, 0x12, 0x13].includes(sf)) params = [mask];
        else if (sf === 0x07 || sf === 0x08) params = [0xff, mask];
        const pdu = await this.uds(block, 0x19, [sf, ...params], `ReadDTCInformation 0x${hexB(sf)}`);
        this.expect(pdu, 1, [sf], 'ReadDTCInformation');
        if (DTC_COUNT_SUBFUNCTIONS.has(sf)) {
          if (pdu.length < 6) throw new Error(t('diagReal.flow.badEcho', { what: 'DTC count', rx: hexList(pdu) }));
          const count = u16(pdu[4], pdu[5]);
          return {
            message: t('diagEng.dtcCount', { count, sf: hexB(sf), mask: hexB(mask) }),
            result: count,
            outputs: { count_out: count, dtc_list_out: [] },
          };
        }
        if (DTC_RECORD_SUBFUNCTIONS.has(sf)) {
          const list: Array<{ code: string; status: number }> = [];
          for (let i = 3; i + 3 < pdu.length; i += 4) {
            list.push({ code: formatDtc3(pdu[i], pdu[i + 1], pdu[i + 2]), status: pdu[i + 3] });
          }
          for (const d of list) this.log(block, `    ${d.code}  status=0x${hexB(d.status)}`);
          return {
            message: `${list.length} DTC (subFn=0x${hexB(sf)}, mask=0x${hexB(mask)})`,
            result: list,
            outputs: { dtc_list_out: list, count_out: list.length },
          };
        }
        const raw = Uint8Array.from(pdu.slice(2));
        return { message: `ReadDTCInformation 0x${hexB(sf)}: ${raw.length} B`, result: raw, outputs: { dtc_list_out: raw } };
      }

      // ── 0x22 / 0x23 ─────────────────────────────────────────────────────────
      case 'uds_read_did': {
        const { did, bytes } = didField(cfg['did'] ?? 'F190');
        this.log(block, `TX: 22 ${hexList(bytes)}  (ReadDataByIdentifier ${formatDid(did)})`);
        const record = await this.transport.readDid(did);
        const decoded = decodeDidValue(did, record);
        this.log(block, `RX: 62 ${hexList(bytes)} ${hexList(record)}`);
        this.log(block, `    ${formatDid(did)}: "${decoded}"`);
        const data = Uint8Array.from(record);
        return {
          message: `${formatDid(did)} = "${decoded}"`,
          result: data,
          outputs: { data_out: data },
        };
      }

      case 'uds_read_memory': {
        const addr = hexField(cfg['memory_address'], 'memory_address');
        const size = hexField(cfg['memory_size'], 'memory_size');
        const fmt = ((addr.length & 0xf) << 4) | (size.length & 0xf);
        const pdu = await this.uds(block, 0x23, [fmt, ...addr, ...size], 'ReadMemoryByAddress');
        const data = Uint8Array.from(pdu.slice(1));
        return {
          message: t('diagEng.memRead', { addr: hexList(addr).replace(/ /g, ''), size: data.length }),
          result: data,
          outputs: { data_out: data },
        };
      }

      // ── 0x27 ────────────────────────────────────────────────────────────────
      case 'uds_security_access': {
        const odd = byteField(cfg['access_level'] ?? '01', 'access_level');
        const even = odd + 1;
        const algorithm = String(cfg['algorithm'] ?? 'xor_ff');
        const constantHex = String(cfg['constant'] ?? '5A3C1E8F');
        const script = String(cfg['script'] ?? '');

        const seedPdu = await this.uds(block, 0x27, [odd], `SecurityAccess requestSeed 0x${hexB(odd)}`);
        this.expect(seedPdu, 1, [odd], 'SecurityAccess seed');
        const seed = Uint8Array.from(seedPdu.slice(2));
        if (seed.length === 0) throw new Error(t('diagReal.flow.noSeed'));
        this.log(block, `seed=${hexList(seed)}`);
        if (seed.every((b) => b === 0)) {
          ctx.securityUnlocked = true;
          ctx.unlockedLevel = odd;
          return {
            message: t('diagEng.secAlreadyOpen', { level: hexB(odd) }),
            result: { seed, key: new Uint8Array(0), level: odd },
            nextPort: 'success_out',
            outputs: { seed_out: seed },
          };
        }

        let key: Uint8Array;
        const keyIn = await this.optionalInput(block, 'key_in', 0);
        if (keyIn !== undefined) {
          const b = asBytes(keyIn);
          if (!b) throw new Error(t('diagReal.flow.notBytes', { block: block.label, port: 'key_in' }));
          key = b;
        } else {
          try {
            key = await computeKey(algorithm, seed, odd, constantHex, script);
          } catch (e) {
            throw new Error(t('diagEng.scriptError', { msg: e instanceof Error ? e.message : String(e) }));
          }
        }
        this.log(block, `key=${hexList(key)}`);

        const keyPdu = await this.uds(block, 0x27, [even, ...key], `SecurityAccess sendKey 0x${hexB(even)}`);
        this.expect(keyPdu, 1, [even], 'SecurityAccess key');
        ctx.securityUnlocked = true;
        ctx.unlockedLevel = odd;
        return {
          message: `Security Access 0x${hexB(odd)} [${algorithm}]  seed=${hexList(seed)}  key=${hexList(key)}`,
          result: { seed, key, level: odd },
          nextPort: 'success_out',
          outputs: { seed_out: seed },
        };
      }

      case 'uds_seed_validator': {
        const key = await this.needBytes(block, 'key_in', true);
        const seedIn = await this.optionalInput(block, 'seed_in', 0);
        const seed = asBytes(seedIn);
        let expected: Uint8Array;
        if (seed) {
          expected = await computeKey(String(cfg['algorithm'] ?? 'xor_ff'), seed, 0, String(cfg['constant'] ?? '5A3C1E8F'), String(cfg['script'] ?? ''));
        } else {
          expected = Uint8Array.from(hexField(cfg['expected_key'], 'expected_key'));
        }
        const valid = hexList(key) === hexList(expected);
        this.log(block, `key=${hexList(key)} expected=${hexList(expected)} → ${valid ? 'match' : 'MISMATCH'}`);
        return {
          message: valid ? t('diagEng.keyVerified') : t('diagReal.flow.keyMismatch', { key: hexList(key), expected: hexList(expected) }),
          result: { valid, expected: hexList(expected) },
          nextPort: valid ? 'pass_out' : 'fail_out',
          outputs: { result_out: { valid, expected: hexList(expected) } },
        };
      }

      // ── 0x28 / 0x2E / 0x2F / 0x31 ───────────────────────────────────────────
      case 'uds_comm_control': {
        const ctrl = byteField(cfg['control_type'] ?? '03', 'control_type');
        const comm = byteField(cfg['comm_type'] ?? '01', 'comm_type');
        const pdu = await this.uds(block, 0x28, [ctrl, comm], 'CommunicationControl');
        this.expect(pdu, 1, [ctrl], 'CommunicationControl');
        ctx.commControlled = ctrl === 0x03;
        return { message: `CommunicationControl 0x${hexB(ctrl)} 0x${hexB(comm)}` };
      }

      case 'uds_write_did': {
        const { did, bytes } = didField(cfg['did'] ?? 'F190');
        const data = await this.needBytes(block, 'data_in', false);
        const pdu = await this.uds(block, 0x2e, [...bytes, ...data], `WriteDataByIdentifier ${formatDid(did)}`);
        this.expect(pdu, 1, bytes, 'WriteDataByIdentifier');
        return { message: t('diagEng.didWritten', { did: formatDid(did).slice(2) }) };
      }

      case 'uds_io_control': {
        const { did, bytes } = didField(cfg['did'] ?? '3001');
        const opt = byteField(cfg['io_control'] ?? '03', 'io_control');
        const val = byteField(cfg['control_value'] ?? '00', 'control_value');
        const pdu = await this.uds(block, 0x2f, [...bytes, opt, val], `InputOutputControl ${formatDid(did)}`);
        this.expect(pdu, 1, bytes, 'InputOutputControl');
        const data = Uint8Array.from(pdu.slice(3));
        return { message: `IO Control ${formatDid(did)}: option 0x${hexB(opt)}`, result: data, outputs: { data_out: data } };
      }

      case 'uds_routine_ctrl': {
        const ctrl = byteField(cfg['control_type'] ?? '01', 'control_type');
        const ridSel = String(cfg['routine_id'] ?? 'FF00');
        const ridBytes = hexField(ridSel === 'custom' ? cfg['routine_id_custom'] : ridSel, 'routine_id');
        if (ridBytes.length !== 2) throw new Error(t('diagReal.flow.invalidHex', { field: 'routine_id' }));
        const pdu = await this.uds(block, 0x31, [ctrl, ...ridBytes], 'RoutineControl');
        this.expect(pdu, 1, [ctrl, ...ridBytes], 'RoutineControl');
        const status = Uint8Array.from(pdu.slice(4));
        return {
          message: `Routine 0x${hexList(ridBytes).replace(/ /g, '')} (0x${hexB(ctrl)}) → ${status.length > 0 ? hexList(status) : '—'}`,
          result: status,
          outputs: { result_out: status },
        };
      }

      // ── 0x34 / 0x35 / 0x36 / 0x37 ───────────────────────────────────────────
      case 'uds_req_download':
      case 'uds_req_upload': {
        const isDownload = block.type === 'uds_req_download';
        const addr = hexField(cfg['memory_address'], 'memory_address');
        const size = hexField(cfg['memory_size'], 'memory_size');
        const fmtByte = byteField(cfg['data_format'] ?? '00', 'data_format');
        const memFmt = ((addr.length & 0xf) << 4) | (size.length & 0xf);
        const sid = isDownload ? 0x34 : 0x35;
        const pdu = await this.uds(block, sid, [fmtByte, memFmt, ...addr, ...size], isDownload ? 'RequestDownload' : 'RequestUpload');
        const lenBytes = (pdu[1] ?? 0) >> 4;
        if (lenBytes === 0 || pdu.length < 2 + lenBytes) {
          throw new Error(t('diagReal.flow.badEcho', { what: 'maxNumberOfBlockLength', rx: hexList(pdu) }));
        }
        const maxBlockLen = pdu.slice(2, 2 + lenBytes).reduce((acc, b) => acc * 256 + b, 0);
        ctx.downloadActive = true;
        ctx.uploadActive = !isDownload;
        ctx.downloadSize = size.reduce((acc, b) => acc * 256 + b, 0);
        ctx.transferBlockSeq = 1;
        ctx.transferredBytes = 0;
        ctx.maxBlockLen = maxBlockLen;
        this.log(block, `maxBlockLen=${maxBlockLen}`);
        return {
          message: `${isDownload ? 'RequestDownload' : 'RequestUpload'} OK  maxBlockLen=${maxBlockLen}`,
          result: { size: ctx.downloadSize, maxBlockLen },
          outputs: { max_block_out: maxBlockLen },
        };
      }

      case 'uds_transfer_data': {
        if (!ctx.downloadActive) throw new Error(t('diagReal.flow.noTransfer'));
        const seq = ctx.transferBlockSeq & 0xff;
        if (ctx.uploadActive) {
          const pdu = await this.uds(block, 0x36, [seq], `TransferData upload block ${seq}`);
          this.expect(pdu, 1, [seq], 'TransferData');
          const data = Uint8Array.from(pdu.slice(2));
          ctx.transferredBytes += data.length;
          ctx.transferBlockSeq = (seq + 1) & 0xff;
          return { message: `Block ${seq}: ${data.length} B (${ctx.transferredBytes} B total)`, result: data, outputs: { data_out: data } };
        }
        const data = await this.needBytes(block, 'chunk_in', true);
        const cfgChunk = parseInt(String(cfg['chunk_size'] ?? '0800').replace(/[^0-9a-fA-F]/g, ''), 16) || 0x0800;
        const maxData = ctx.maxBlockLen > 2 ? ctx.maxBlockLen - 2 : cfgChunk;
        const chunkSize = Math.min(cfgChunk, maxData);
        const offset = ctx.transferredBytes;
        if (offset >= data.length) throw new Error(t('diagReal.flow.noDataLeft'));
        const chunk = data.subarray(offset, offset + chunkSize);
        const pdu = await this.uds(block, 0x36, [seq, ...chunk], `TransferData block ${seq} (${chunk.length} B)`);
        this.expect(pdu, 1, [seq], 'TransferData block sequence'); // real 0x76 echo
        ctx.transferredBytes += chunk.length;
        ctx.transferBlockSeq = (seq + 1) & 0xff;
        const pct = Math.min(100, Math.round((ctx.transferredBytes / data.length) * 100));
        return {
          message: t('diagEng.blockMsg', { seq, done: ctx.transferredBytes, total: data.length, pct }),
          result: { seq, transferred: ctx.transferredBytes, total: data.length, percent: pct },
        };
      }

      case 'uds_transfer_exit': {
        if (!ctx.downloadActive) throw new Error(t('diagReal.flow.noTransfer'));
        await this.uds(block, 0x37, [], 'RequestTransferExit');
        const transferred = ctx.transferredBytes;
        ctx.downloadActive = false;
        ctx.uploadActive = false;
        ctx.transferredBytes = 0;
        return { message: t('diagEng.transferDoneMsg', { n: transferred }) };
      }

      // ── 0x3D / 0x3E / 0x85 / 0x87 ───────────────────────────────────────────
      case 'uds_write_memory': {
        const addr = hexField(cfg['memory_address'], 'memory_address');
        const size = hexField(cfg['memory_size'], 'memory_size');
        const data = await this.needBytes(block, 'data_in', false);
        const sizeVal = size.reduce((acc, b) => acc * 256 + b, 0);
        if (sizeVal !== data.length) throw new Error(t('diagReal.flow.dataLen', { size: sizeVal, got: data.length }));
        const fmt = ((addr.length & 0xf) << 4) | (size.length & 0xf);
        await this.uds(block, 0x3d, [fmt, ...addr, ...size, ...data], 'WriteMemoryByAddress');
        return { message: `WriteMemory 0x${hexList(addr).replace(/ /g, '')}  ${data.length} B` };
      }

      case 'uds_tester_present': {
        const suppress = !!cfg['suppress'];
        const sf = suppress ? 0x80 : 0x00;
        await this.uds(block, 0x3e, [sf], `TesterPresent suppress=${suppress}`, suppress);
        return { message: `TesterPresent${suppress ? ' (suppress)' : ''}` };
      }

      case 'uds_dtc_setting': {
        const sf = byteField(cfg['setting_type'] ?? '02', 'setting_type');
        const pdu = await this.uds(block, 0x85, [sf], 'ControlDTCSetting');
        this.expect(pdu, 1, [sf], 'ControlDTCSetting');
        ctx.dtcSettingOff = sf === 0x02;
        return { message: `ControlDTCSetting ${sf === 0x01 ? 'ON' : sf === 0x02 ? 'OFF' : `0x${hexB(sf)}`}` };
      }

      case 'uds_link_control': {
        const lc = byteField(cfg['link_control_type'] ?? '01', 'link_control_type');
        const br = byteField(cfg['link_baudrate_id'] ?? '05', 'link_baudrate_id');
        const verify = await this.uds(block, 0x87, [lc, br], 'LinkControl verify');
        this.expect(verify, 1, [lc], 'LinkControl');
        await this.uds(block, 0x87, [0x83], 'LinkControl transitionMode (suppressed)', true);
        return { message: `LinkControl 0x${hexB(lc)} baud-id 0x${hexB(br)} → transitionMode` };
      }

      // ── Data (exec-capable) ─────────────────────────────────────────────────
      case 'data_checksum': {
        const algorithm = String(cfg['algorithm'] ?? 'crc32');
        const data = await this.needBytes(block, 'data_in', true);
        let checksum: number;
        switch (algorithm) {
          case 'crc16':
            checksum = crc16ibm(data);
            break;
          case 'xor_sum':
            checksum = data.reduce((a, b) => a ^ b, 0);
            break;
          case 'add_sum':
            checksum = data.reduce((a, b) => (a + b) & 0xff, 0);
            break;
          default:
            checksum = crc32(data);
        }
        const width = algorithm === 'crc16' ? 4 : algorithm === 'xor_sum' || algorithm === 'add_sum' ? 2 : 8;
        const hexResult = `0x${checksum.toString(16).toUpperCase().padStart(width, '0')}`;
        const fmt = String(cfg['output_format'] ?? 'hex');
        const out: unknown =
          fmt === 'number'
            ? checksum
            : fmt === 'bytes'
              ? Uint8Array.from(hexField(hexResult, 'checksum'))
              : hexResult;
        this.log(block, `${algorithm.toUpperCase()}(${data.length} B) = ${hexResult}`);
        return { message: `${algorithm.toUpperCase()} = ${hexResult}`, result: out, outputs: { checksum_out: out } };
      }

      // ── IO ──────────────────────────────────────────────────────────────────
      case 'io_file_input': {
        const file = flowFiles.get(block.id);
        if (!file) throw new Error(t('diagReal.flow.noFile'));
        this.log(block, t('diagEng.fileLine', { path: file.name, n: file.bytes.length }));
        return {
          message: t('diagEng.fileRead', { path: file.name, n: file.bytes.length }),
          result: file.bytes,
          outputs: { data_out: file.bytes },
        };
      }

      case 'io_display': {
        const v = await this.need(block, 'value_in', true);
        const text = valueText(v);
        this.log(block, `Display: ${text}`);
        return { message: text, result: v };
      }

      case 'io_user_prompt': {
        const msg = String(cfg['message'] ?? t('diagBlk.enterAValue'));
        const answer = await flowPrompt.request(msg);
        if (answer === null) throw new Error(t('diagReal.flow.promptCancelled'));
        this.log(block, `Prompt: "${msg}" → "${answer}"`);
        return { message: t('diagEng.userPrompt'), result: answer, outputs: { value_out: answer } };
      }

      default:
        throw new Error(t('diagEng.unknownBlock', { type: block.type }));
    }
  }
}
