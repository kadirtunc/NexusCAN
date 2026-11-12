import { t } from '../../../i18n';
import { apiSeedKeyComputeAdhoc } from '../../../services/ipcClient';
import { parseSeedKeyError } from '../../../types/seedkey';

// ─── Security key algorithms ──────────────────────────────────────────────────

export function crc16ibm(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    let b = byte ^ (crc & 0xFF);
    b ^= (b << 4) & 0xFF;
    crc = ((crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4)) & 0xFFFF;
  }
  return crc;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function ror32(val: number, shift: number): number {
  return ((val >>> shift) | (val << (32 - shift))) >>> 0;
}

/**
 * Built-in algorithms only (pure TS, no code execution). `custom` is NOT handled here: use
 * `computeKey`, which delegates to the sandboxed Rhai provider in the backend.
 */
export function calculateBuiltinKey(
  algorithm: string,
  seed: Uint8Array,
  constantHex: string,
): Uint8Array {
  const constVal = parseInt(constantHex.replace(/[^0-9a-fA-F]/g, '') || '5A3C1E8F', 16) >>> 0;

  switch (algorithm) {
    case 'xor_ff': {
      return seed.map((b) => b ^ 0xFF);
    }

    case 'xor_const': {
      // XOR seed bytes with 4-byte constant (cyclic)
      const constBytes = new Uint8Array(4);
      constBytes[0] = (constVal >> 24) & 0xFF;
      constBytes[1] = (constVal >> 16) & 0xFF;
      constBytes[2] = (constVal >> 8)  & 0xFF;
      constBytes[3] =  constVal        & 0xFF;
      return seed.map((b, i) => b ^ constBytes[i % 4]);
    }

    case 'sum_negate': {
      // key = uint16 of (~sum of seed bytes) & 0xFFFF
      const sum = seed.reduce((a, b) => a + b, 0);
      const neg = (~sum) & 0xFFFF;
      return new Uint8Array([(neg >> 8) & 0xFF, neg & 0xFF]);
    }

    case 'add_const': {
      // Treat seed as big-endian uint32, add constant, return 4 bytes
      if (seed.length >= 4) {
        const seedVal = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
        const keyVal  = (seedVal + constVal) >>> 0;
        return new Uint8Array([
          (keyVal >> 24) & 0xFF,
          (keyVal >> 16) & 0xFF,
          (keyVal >> 8)  & 0xFF,
           keyVal        & 0xFF,
        ]);
      }
      // short seed fallback
      return seed.map((b) => (b + (constVal & 0xFF)) & 0xFF);
    }

    case 'right_rotate': {
      // ROR(uint32(seed), 2) XOR constant
      if (seed.length >= 4) {
        const seedVal = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
        const keyVal  = ror32(seedVal, 2) ^ constVal;
        return new Uint8Array([
          (keyVal >> 24) & 0xFF,
          (keyVal >> 16) & 0xFF,
          (keyVal >> 8)  & 0xFF,
           keyVal        & 0xFF,
        ]);
      }
      return seed.map((b) => ror32(b, 2) & 0xFF);
    }

    case 'crc16': {
      const c = crc16ibm(seed);
      return new Uint8Array([(c >> 8) & 0xFF, c & 0xFF]);
    }

    case 'crc32': {
      const c = crc32(seed);
      return new Uint8Array([
        (c >> 24) & 0xFF, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF,
      ]);
    }

    case 'custom':
      throw new Error(t('flow.customNeedsBackend'));

    default:
      return seed.map((b) => b ^ 0xFF);
  }
}


/**
 * A pre-v0.1 custom block holds JavaScript (`function calculateKey(seed, level) {...}`). That code is
 * never executed any more; the block fails with a rewrite hint.
 */
export function isLegacyJsKeyScript(script: string): boolean {
  if (/\bfn\s+calculate_key\b/.test(script)) return false;
  return /\bfunction\b|\bUint8Array\b|=>|\bnew\s/.test(script);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}

const CUSTOM_SCRIPT_TIMEOUT_MS = 1000;

/**
 * Key for a flow SecurityAccess block. Built-ins are computed locally; `custom` runs the Rhai
 * script in the backend sandbox (`cmd_seedkey_compute_adhoc`, provider kind `script`).
 */
export async function computeKey(
  algorithm: string,
  seed: Uint8Array,
  level: number,
  constantHex: string,
  script: string,
): Promise<Uint8Array> {
  if (algorithm !== 'custom') {
    return calculateBuiltinKey(algorithm, seed, constantHex);
  }
  if (isLegacyJsKeyScript(script)) {
    throw new Error(t('flow.legacyJsKey'));
  }
  try {
    const res = await apiSeedKeyComputeAdhoc(
      { kind: 'script', source: script, timeoutMs: CUSTOM_SCRIPT_TIMEOUT_MS },
      level,
      bytesToHex(seed),
    );
    return hexToBytes(res.keyHex);
  } catch (e) {
    const parsed = parseSeedKeyError(e);
    if (parsed !== null) throw new Error(parsed.message);
    throw e instanceof Error ? e : new Error(String(e));
  }
}
