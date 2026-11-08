import type { MessageSchemaDto, SignalSchemaDto } from '../types/netdb';

/**
 * Formats CAN-ID in clean uppercase hex without '0x' prefix
 * (e.g. `101`, `620`, `18FF50E5`).
 */
export function formatPcanIdHex(arbId: number, isExtended: boolean): string {
  const clean = arbId >>> 0;
  if (isExtended) {
    return clean.toString(16).toUpperCase().padStart(8, '0');
  }
  return clean.toString(16).toUpperCase().padStart(3, '0');
}

/**
 * Formats CAN-ID with `0x` prefix for tooltips / BitLayout headers.
 */
export function formatCanId(arbId: number, isExtended: boolean): string {
  return `0x${formatPcanIdHex(arbId, isExtended)}`;
}

/**
 * Extracts SAE J1939-21 PGN and Source Address from a 29-bit Extended CAN ID.
 */
export function extractJ1939Fields(
  arbId: number,
  isExtended: boolean,
): { pgnHex: string; saHex: string } {
  if (!isExtended) {
    return { pgnHex: '—', saHex: '—' };
  }
  const id = arbId >>> 0;
  const sa = id & 0xff;
  const ps = (id >>> 8) & 0xff;
  const pf = (id >>> 16) & 0xff;
  const dpEdp = (id >>> 24) & 0x03;
  const pgn =
    pf < 240 ? (dpEdp << 16) | (pf << 8) : (dpEdp << 16) | (pf << 8) | ps;
  return {
    pgnHex: pgn.toString(16).toUpperCase().padStart(4, '0'),
    saHex: sa.toString(16).toUpperCase().padStart(2, '0'),
  };
}

/**
 * Formats a single byte (0..255) as 2-char uppercase hex.
 */
export function formatByteHex(byteVal: number): string {
  return (byteVal & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Checks whether byte `byteIdx` (0..63) has changed within the last 300ms
 * using the two 32-bit halves (`changedBytesLo`, `changedBytesHi`) of the 64-bit mask.
 */
export function isByteRecentlyChanged(
  byteIdx: number,
  changedBytesLo: number,
  changedBytesHi: number,
): boolean {
  if (byteIdx < 0 || byteIdx >= 64) return false;
  if (byteIdx < 32) {
    return ((changedBytesLo >>> byteIdx) & 1) === 1;
  }
  return ((changedBytesHi >>> (byteIdx - 32)) & 1) === 1;
}

/**
 * Formats a physical signal value with deterministic decimal places matching its factor/type
 * so digits never jump horizontally at 60 FPS.
 */
export function formatPhysicalValue(
  value: number,
  sigSchema?: SignalSchemaDto | null,
): string {
  if (!Number.isFinite(value)) return 'NaN';

  if (!sigSchema) {
    return Number.isInteger(value) ? value.toString() : value.toFixed(3);
  }

  if (sigSchema.valueType === 'float32' || sigSchema.valueType === 'float64') {
    const abs = Math.abs(value);
    if (abs > 0 && abs < 0.01) return value.toFixed(5);
    if (abs < 10) return value.toFixed(4);
    return value.toFixed(2);
  }

  const factor = Math.abs(sigSchema.factor);
  if (factor >= 1 && Number.isInteger(sigSchema.factor) && Number.isInteger(sigSchema.offset)) {
    return Math.round(value).toString();
  }
  if (factor >= 0.1) return value.toFixed(1);
  if (factor >= 0.01) return value.toFixed(2);
  if (factor >= 0.001) return value.toFixed(3);
  return value.toFixed(4);
}

/**
 * Formats raw integer value in hex according to bit length.
 */
export function formatRawHex(rawInt: number, bitLength: number): string {
  const hexDigits = Math.max(1, Math.min(16, Math.ceil(bitLength / 4)));
  if (rawInt < 0) {
    if (bitLength <= 32) {
      const mask = bitLength === 32 ? 0xffffffff : (1 << bitLength) - 1;
      const unsigned = (rawInt & mask) >>> 0;
      return `0x${unsigned.toString(16).toUpperCase().padStart(hexDigits, '0')}`;
    }
    return `${rawInt}`;
  }
  return `0x${Math.trunc(rawInt).toString(16).toUpperCase().padStart(hexDigits, '0')}`;
}

/**
 * Converts a File's ArrayBuffer safely into a Base64 string in 32KB chunks.
 */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return window.btoa(chunks.join(''));
}

/**
 * Formats relative timestamp in Industrial Trace style `SSS.mmmm` (seconds with 0.1ms precision).
 */
export function formatRelativeTimeSec(timestampUs: number, originUs = 0): string {
  const relUs = Math.max(0, timestampUs - originUs);
  const sec = relUs / 1_000_000;
  return sec.toFixed(4).padStart(9, ' ');
}

/**
 * Formats mux ranges like `[[0, 0]]` -> `0` or `[[2, 3], [10, 12]]` -> `2..3, 10..12`.
 */
export function formatMuxRanges(ranges: [number, number][]): string {
  if (ranges.length === 0) return '';
  return ranges
    .map(([start, end]) => (start === end ? `${start}` : `${start}..${end}`))
    .join(', ');
}

/**
 * Preview-packs engineering signal values into a byte array of length `msg.dlc`
 * using ONLY pre-computed `msg.bitLayout` (zero Motorola math in JS!).
 */
export function previewPackSymbolicBytes(
  msg: MessageSchemaDto,
  signalsById: readonly (SignalSchemaDto | undefined)[],
  signalValues: Readonly<Record<number, number>>,
): number[] {
  const dlc = Math.max(0, Math.min(64, msg.dlc));
  const out = new Array<number>(dlc).fill(0);

  const isSignalActive = (sig: SignalSchemaDto, depth: number): boolean => {
    if (depth > 10) return false;
    if (sig.muxRole === 'static' || sig.muxRole === 'masterSwitch') return true;
    if (sig.switchSignalId === null) return true;
    const sw = signalsById[sig.switchSignalId];
    if (!sw || !isSignalActive(sw, depth + 1)) return false;
    const swPhys = signalValues[sw.signalId] ?? sw.initialValue ?? 0;
    const swRaw =
      sw.factor !== 0
        ? Math.round((swPhys - sw.offset) / sw.factor)
        : Math.round(swPhys);
    return sig.muxRanges.some(([s, e]) => swRaw >= s && swRaw <= e);
  };

  const rawBitsBySignal = new Map<number, bigint>();
  const dvBuf = new ArrayBuffer(8);
  const dv = new DataView(dvBuf);

  for (const sigId of msg.signalIds) {
    const sig = signalsById[sigId];
    if (!sig || !isSignalActive(sig, 0)) continue;

    let phys = signalValues[sigId] ?? sig.initialValue ?? 0;
    if (!Number.isFinite(phys)) phys = 0;
    if (sig.max > sig.min) {
      phys = Math.max(sig.min, Math.min(sig.max, phys));
    }

    const scaled = sig.factor !== 0 ? (phys - sig.offset) / sig.factor : phys - sig.offset;
    let rawUnsigned = 0n;

    if (sig.valueType === 'float32' && sig.bitLength === 32) {
      dv.setFloat32(0, scaled, true);
      rawUnsigned = BigInt(dv.getUint32(0, true));
    } else if (sig.valueType === 'float64' && sig.bitLength === 64) {
      dv.setFloat64(0, scaled, true);
      rawUnsigned = dv.getBigUint64(0, true);
    } else {
      const rounded = BigInt(Math.round(scaled));
      rawUnsigned = BigInt.asUintN(sig.bitLength, rounded);
    }

    rawBitsBySignal.set(sigId, rawUnsigned);
  }

  for (const cell of msg.bitLayout) {
    const raw = rawBitsBySignal.get(cell.signalId);
    if (raw === undefined || cell.byteIndex >= dlc) continue;
    const bit = Number((raw >> BigInt(cell.signalBitIndex)) & 1n);
    if (bit === 1) {
      out[cell.byteIndex] |= 1 << cell.bitInByte;
    }
  }

  return out;
}

/**
 * Deterministic 12-slot industrial signal color palette for BitLayoutMatrix.
 */
export interface SignalColorToken {
  bg: string;
  bgActive: string;
  border: string;
  text: string;
  hex: string;
}

export const SIGNAL_PALETTE: readonly SignalColorToken[] = [
  {
    bg: 'bg-cyan-500/10',
    bgActive: 'bg-cyan-500/25',
    border: 'border-cyan-500/40',
    text: 'text-cyan-500',
    hex: '#38aebf',
  },
  {
    bg: 'bg-emerald-500/10',
    bgActive: 'bg-emerald-500/25',
    border: 'border-emerald-500/40',
    text: 'text-emerald-500',
    hex: '#3fb980',
  },
  {
    bg: 'bg-amber-500/10',
    bgActive: 'bg-amber-500/25',
    border: 'border-amber-500/40',
    text: 'text-amber-500',
    hex: '#d99b26',
  },
  {
    bg: 'bg-violet-500/10',
    bgActive: 'bg-violet-500/25',
    border: 'border-violet-500/40',
    text: 'text-violet-400',
    hex: '#9478d6',
  },
  {
    bg: 'bg-sky-500/10',
    bgActive: 'bg-sky-500/25',
    border: 'border-sky-500/40',
    text: 'text-sky-500',
    hex: '#4ca6e8',
  },
  {
    bg: 'bg-rose-500/10',
    bgActive: 'bg-rose-500/25',
    border: 'border-rose-500/40',
    text: 'text-rose-400',
    hex: '#d96679',
  },
  {
    bg: 'bg-teal-500/10',
    bgActive: 'bg-teal-500/25',
    border: 'border-teal-500/40',
    text: 'text-teal-500',
    hex: '#3aa89b',
  },
  {
    bg: 'bg-indigo-500/10',
    bgActive: 'bg-indigo-500/25',
    border: 'border-indigo-500/40',
    text: 'text-indigo-400',
    hex: '#757ce0',
  },
  {
    bg: 'bg-lime-500/10',
    bgActive: 'bg-lime-500/25',
    border: 'border-lime-500/40',
    text: 'text-lime-500',
    hex: '#82b536',
  },
  {
    bg: 'bg-orange-500/10',
    bgActive: 'bg-orange-500/25',
    border: 'border-orange-500/40',
    text: 'text-orange-400',
    hex: '#d98245',
  },
  {
    bg: 'bg-fuchsia-500/10',
    bgActive: 'bg-fuchsia-500/25',
    border: 'border-fuchsia-500/40',
    text: 'text-fuchsia-400',
    hex: '#c46dd4',
  },
  {
    bg: 'bg-blue-500/10',
    bgActive: 'bg-blue-500/25',
    border: 'border-blue-500/40',
    text: 'text-blue-400',
    hex: '#578ee0',
  },
];

export function getSignalColor(indexOrSignalId: number): SignalColorToken {
  const idx = Math.abs(indexOrSignalId) % SIGNAL_PALETTE.length;
  return SIGNAL_PALETTE[idx];
}
