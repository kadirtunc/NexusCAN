/**
 * ISO 15765-2 frame description + FF/CF reassembly for the ISO-TP Monitor (pure, no React).
 * Input is the backend `IsoTpFrameDto` (`data` = whole CAN payload incl. PCI and padding).
 */
import type { IsoTpFrameType } from '../types/diagnostics';
import type { IsoTpFrameDto, IsoTpFrameKind } from '../types/udsClient';
import type { IsoTpFrameEntry } from '../types/diagnostics';

const KIND_TO_TYPE: Readonly<Record<IsoTpFrameKind, IsoTpFrameType>> = {
  single: 'SF',
  first: 'FF',
  consecutive: 'CF',
  flowControl: 'FC',
  unknown: 'UNK',
};

const FC_STATUS: Readonly<Record<number, string>> = { 0: 'CTS', 1: 'WAIT', 2: 'OVFLW' };

/** STmin byte -> text (0x00..0x7F ms, 0xF1..0xF9 100..900 µs). */
function stMinText(b: number): string {
  if (b <= 0x7f) return `${b} ms`;
  if (b >= 0xf1 && b <= 0xf9) return `${(b - 0xf0) * 100} us`;
  return `0x${b.toString(16).toUpperCase()} (reserved)`;
}

/**
 * STmin byte -> minimum CF separation in microseconds (ISO 15765-2: 0x00..0x7F = ms,
 * 0xF1..0xF9 = 100..900 us, any reserved value is treated as the maximum 127 ms).
 */
export function stMinToUs(b: number): number {
  if (b <= 0x7f) return b * 1000;
  if (b >= 0xf1 && b <= 0xf9) return (b - 0xf0) * 100;
  return 127_000;
}

interface Pci {
  /** First payload byte index (after the PCI bytes). */
  payloadStart: number;
  /** SF: payload length; FF: total message length; CF: sequence number; FC: flow status. */
  value: number;
}

function parsePci(kind: IsoTpFrameKind, d: readonly number[]): Pci | null {
  if (d.length === 0) return null;
  switch (kind) {
    case 'single': {
      const len = d[0] & 0x0f;
      if (len === 0 && d.length >= 2) return { payloadStart: 2, value: d[1] }; // CAN-FD escape
      return { payloadStart: 1, value: len };
    }
    case 'first': {
      if (d.length < 2) return null;
      const total = ((d[0] & 0x0f) << 8) | d[1];
      if (total === 0 && d.length >= 6) {
        return { payloadStart: 6, value: ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0 };
      }
      return { payloadStart: 2, value: total };
    }
    case 'consecutive':
      return { payloadStart: 1, value: d[0] & 0x0f };
    case 'flowControl':
      return { payloadStart: 3, value: d[0] & 0x0f };
    case 'unknown':
      return null;
  }
}

function hexBytes(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Per-direction FF + CF* reassembly. A CF without a preceding FF, or a wrong SN, drops that message. */
export class IsoTpReassembler {
  private readonly state: Record<'tx' | 'rx', { buf: number[]; total: number; nextSn: number } | null> = {
    tx: null,
    rx: null,
  };

  reset(): void {
    this.state.tx = null;
    this.state.rx = null;
  }

  /** Feeds one frame; returns the complete message when this frame finishes one (FF/CF only). */
  feed(dir: 'tx' | 'rx', kind: IsoTpFrameKind, data: readonly number[]): number[] | null {
    const pci = parsePci(kind, data);
    if (kind === 'first') {
      if (pci === null) return null;
      const buf = data.slice(pci.payloadStart);
      if (buf.length >= pci.value) {
        this.state[dir] = null;
        return buf.slice(0, pci.value);
      }
      this.state[dir] = { buf: [...buf], total: pci.value, nextSn: 1 };
      return null;
    }
    if (kind === 'consecutive') {
      const st = this.state[dir];
      if (st === null || pci === null) return null;
      if (pci.value !== st.nextSn) {
        this.state[dir] = null; // sequence error: message is incomplete, never guess
        return null;
      }
      st.buf.push(...data.slice(pci.payloadStart));
      st.nextSn = (st.nextSn + 1) & 0x0f;
      if (st.buf.length >= st.total) {
        this.state[dir] = null;
        return st.buf.slice(0, st.total);
      }
    }
    return null;
  }
}

export function describeIsoTpFrame(f: IsoTpFrameDto): string {
  const pci = parsePci(f.kind, f.data);
  if (pci === null) return f.kind === 'unknown' ? 'not an ISO-TP PCI' : 'empty frame';
  switch (f.kind) {
    case 'single':
      return `SF len=${pci.value} ${hexBytes(f.data.slice(pci.payloadStart, pci.payloadStart + pci.value))}`;
    case 'first':
      return `FF total=${pci.value} B`;
    case 'consecutive':
      return `CF SN=${pci.value}`;
    case 'flowControl': {
      const bs = f.data.length > 1 ? f.data[1] : 0;
      const st = f.data.length > 2 ? stMinText(f.data[2]) : '?';
      return `FC ${FC_STATUS[pci.value] ?? `FS=${pci.value}`} BS=${bs} STmin=${st}`;
    }
    case 'unknown':
      return '';
  }
}

/** Maps a backend frame to a monitor row; `reasm` is fed in arrival order per direction. */
export function isoTpEntryFromDto(
  f: IsoTpFrameDto,
  uid: number,
  epoch: number,
  reasm: IsoTpReassembler,
): IsoTpFrameEntry {
  const assembled = reasm.feed(f.direction, f.kind, f.data);
  const entry: IsoTpFrameEntry = {
    id: `tp-${uid}`,
    uid,
    seq: f.seq,
    epoch,
    requestSeq: f.requestSeq,
    timestampMs: Math.floor(f.timestampUs / 1000),
    timestampUs: f.timestampUs,
    canId: f.canId,
    isExtended: f.isExtended,
    frameType: KIND_TO_TYPE[f.kind],
    rawBytes: f.data,
    description: describeIsoTpFrame(f),
    direction: f.direction,
  };
  if (assembled !== null) entry.assembledPayload = assembled;
  return entry;
}
