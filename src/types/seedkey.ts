/**
 * UDS 0x27 SecurityAccess seed/key provider contract (v1).
 * Mirror of `crates/nexus-protocols/src/uds/security/mod.rs` — keep in sync.
 * Full contract: `planning/contracts/seedkey-v1.md`.
 */

export const SEEDKEY_PROFILE_SCHEMA_VERSION = 1;

export type BuiltinAlgorithm =
  | 'xor_ff'
  | 'xor_const'
  | 'sum_negate'
  | 'add_const'
  | 'right_rotate'
  | 'crc16_kermit'
  | 'crc32';

export interface SeedKeyPairDto {
  seedHex: string;
  keyHex: string;
}

export interface HttpHeaderDto {
  name: string;
  value: string;
}

export type KeyProviderSpecDto =
  | { kind: 'builtin'; algorithm: BuiltinAlgorithm; constantHex: string | null }
  | { kind: 'table'; entries: SeedKeyPairDto[] }
  /** Sandboxed Rhai: `fn calculate_key(seed, level)` — seed is Blob, returns Blob/Array. */
  | { kind: 'script'; source: string; timeoutMs: number }
  /** Vector-style `GenerateKeyEx` / `GenerateKeyExOpt` DLL / .so / .dylib. */
  | { kind: 'library'; path: string; variant: string | null; options: string | null; maxKeyLen: number }
  /** No shell. Placeholders: `{seed}`, `{level}`, `{levelDec}`. Seed hex also on stdin. */
  | { kind: 'external_process'; program: string; args: string[]; timeoutMs: number }
  /** POST `{seedHex, level}` → `{keyHex}`. */
  | { kind: 'http'; url: string; headers: HttpHeaderDto[]; timeoutMs: number }
  /** Operator enters the key in the HMI; backend always answers `manual_required`. */
  | { kind: 'manual' };

export type KeyProviderKind = KeyProviderSpecDto['kind'];

export const NATIVE_PROVIDER_KINDS: readonly KeyProviderKind[] = ['library', 'external_process', 'http'];

export interface SecurityLevelBindingDto {
  /** requestSeed sub-function, odd, 0x01..=0x7D. sendKey = level + 1. */
  level: number;
  label: string | null;
  provider: KeyProviderSpecDto;
}

export interface SeedKeyTestVectorDto {
  level: number;
  seedHex: string;
  keyHex: string;
}

export interface SeedKeyProfileDto {
  schemaVersion: number;
  /** Empty string on create; backend assigns. */
  id: string;
  name: string;
  ecuLabel: string;
  levels: SecurityLevelBindingDto[];
  testVectors: SeedKeyTestVectorDto[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ComputeKeyRequestDto {
  profileId: string;
  level: number;
  seedHex: string;
}

export interface ComputeKeyResultDto {
  /** Uppercase hex, no separators. */
  keyHex: string;
  providerKind: KeyProviderKind;
  elapsedUs: number;
}

export type SeedKeyErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'manual_required'
  | 'timeout'
  | 'unsupported'
  | 'native_not_allowed'
  | 'bitness_mismatch'
  | 'library_load'
  | 'library_call'
  | 'script'
  | 'process'
  | 'http'
  | 'storage';

export interface SeedKeyErrorDto {
  code: SeedKeyErrorCode;
  message: string;
}

export interface TestVectorOutcomeDto {
  level: number;
  seedHex: string;
  expectedKeyHex: string;
  actualKeyHex: string | null;
  passed: boolean;
  error: SeedKeyErrorDto | null;
}

export interface TestVectorReportDto {
  profileId: string;
  total: number;
  passed: number;
  outcomes: TestVectorOutcomeDto[];
}

export interface SeedKeyLibraryInfoDto {
  path: string;
  format: 'pe' | 'elf' | 'macho' | 'unknown';
  arch: 'x86' | 'x86_64' | 'aarch64' | 'arm' | 'unknown';
  loadable: boolean;
  hasGenerateKeyEx: boolean;
  hasGenerateKeyExOpt: boolean;
  note: string | null;
}

export interface SeedKeyCapabilitiesDto {
  nativeProvidersAllowed: boolean;
  scriptAvailable: boolean;
  hostOs: string;
  hostArch: string;
  /** Native provider kinds the backend can run (currently `library`, `external_process`). */
  nativeKindsAvailable: KeyProviderKind[];
  /** Out-of-process helper for 32-bit vendor DLLs (`nexus-seedkey-host32`) was found. */
  libraryHost32Found: boolean;
  /** Out-of-process helper for 64-bit vendor libraries (`nexus-seedkey-host64`) was found. */
  libraryHost64Found: boolean;
}

/**
 * IPC command names + argument shapes (identical for Tauri `invoke` and the
 * browser-mode bridge `POST /api/invoke/{cmd}`).
 */
export interface SeedKeyCommandMap {
  cmd_seedkey_capabilities: { args: Record<string, never>; result: SeedKeyCapabilitiesDto };
  cmd_seedkey_list_profiles: { args: Record<string, never>; result: SeedKeyProfileDto[] };
  cmd_seedkey_save_profile: { args: { profile: SeedKeyProfileDto }; result: SeedKeyProfileDto };
  cmd_seedkey_delete_profile: { args: { profileId: string }; result: null };
  cmd_seedkey_compute: { args: { request: ComputeKeyRequestDto }; result: ComputeKeyResultDto };
  cmd_seedkey_compute_adhoc: {
    args: { provider: KeyProviderSpecDto; level: number; seedHex: string };
    result: ComputeKeyResultDto;
  };
  cmd_seedkey_run_test_vectors: { args: { profileId: string }; result: TestVectorReportDto };
  cmd_seedkey_probe_library: { args: { path: string }; result: SeedKeyLibraryInfoDto };
}

/** Errors arrive as strings: `"[seedkey:<code>] <message>"`. */
const SEEDKEY_ERROR_RE = /^\[seedkey:([a-z_]+)\]\s*(.*)$/s;

const SEEDKEY_ERROR_CODES: readonly SeedKeyErrorCode[] = [
  'invalid_input', 'not_found', 'manual_required', 'timeout', 'unsupported',
  'native_not_allowed', 'bitness_mismatch', 'library_load', 'library_call',
  'script', 'process', 'http', 'storage',
];

export function parseSeedKeyError(raw: unknown): SeedKeyErrorDto | null {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : null;
  if (text === null) return null;
  const m = SEEDKEY_ERROR_RE.exec(text.trim());
  if (!m) return null;
  const code = SEEDKEY_ERROR_CODES.find((c) => c === m[1]);
  return code ? { code, message: m[2] } : null;
}
