//! UDS 0x27 SecurityAccess — pluggable seed/key provider contract (v1).
//!
//! The ECU's seed→key algorithm is unknown to NexusCAN. Instead of
//! hard-coding algorithms, every key computation goes through a
//! [`KeyProvider`] built from a serializable [`KeyProviderSpecDto`].
//!
//! * Portable providers (`builtin`, `table`, `script`) live in this crate and
//!   are built by [`build_portable_provider`].
//! * Native providers (`library`, `external_process`, `http`) live in
//!   `nexus-seedkey-native`, which delegates portable kinds back here.
//! * `manual` never computes in the backend: it yields
//!   [`SeedKeyError::ManualRequired`] and the HMI asks the operator.
//!
//! Full contract: `planning/contracts/seedkey-v1.md`.
//! Not a hot path (one call per unlock), so `Vec<u8>` / `String` are fine here.

use serde::{Deserialize, Serialize};

pub mod providers;

pub use providers::build_portable_provider;

/// Current on-disk / IPC schema version of [`SeedKeyProfileDto`].
pub const SEEDKEY_PROFILE_SCHEMA_VERSION: u32 = 1;
/// Upper bound for seed and key lengths accepted anywhere in the pipeline.
pub const MAX_SEED_LEN: usize = 256;
/// Upper bound for seed and key lengths accepted anywhere in the pipeline.
pub const MAX_KEY_LEN: usize = 256;

// ─── Provider specification ─────────────────────────────────────────────────

/// Built-in example algorithms. They are demo/training algorithms only and are
/// bit-exact with the legacy TypeScript `calculateKey` in
/// `src/components/flow/FlowEngine.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltinAlgorithm {
    /// `key[i] = seed[i] ^ 0xFF`
    XorFf,
    /// `key[i] = seed[i] ^ C[i % 4]`, C = big-endian u32 constant.
    XorConst,
    /// 2-byte BE `(!sum(seed)) & 0xFFFF`.
    SumNegate,
    /// BE u32(seed[0..4]) wrapping_add C → 4 bytes; seed < 4 bytes: `seed[i] + (C & 0xFF)`.
    AddConst,
    /// `ror32(BE u32(seed[0..4]), 2) ^ C` → 4 bytes; seed < 4 bytes: `ror32(seed[i], 2) & 0xFF` (legacy quirk).
    RightRotate,
    /// CRC-16/KERMIT-style (reflected 0x8408, init 0) as implemented by legacy TS `crc16ibm` → 2 bytes BE.
    Crc16Kermit,
    /// CRC-32/ISO-HDLC (zlib) → 4 bytes BE.
    Crc32,
}

/// One known seed→key pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedKeyPairDto {
    pub seed_hex: String,
    pub key_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeaderDto {
    pub name: String,
    pub value: String,
}

pub const DEFAULT_SCRIPT_TIMEOUT_MS: u32 = 1_000;
pub const DEFAULT_PROCESS_TIMEOUT_MS: u32 = 5_000;
pub const DEFAULT_HTTP_TIMEOUT_MS: u32 = 5_000;
pub const DEFAULT_LIBRARY_MAX_KEY_LEN: u16 = 64;

fn default_script_timeout() -> u32 {
    DEFAULT_SCRIPT_TIMEOUT_MS
}
fn default_process_timeout() -> u32 {
    DEFAULT_PROCESS_TIMEOUT_MS
}
fn default_http_timeout() -> u32 {
    DEFAULT_HTTP_TIMEOUT_MS
}
fn default_max_key_len() -> u16 {
    DEFAULT_LIBRARY_MAX_KEY_LEN
}

/// Serializable description of how to turn a seed into a key.
///
/// JSON shape: `{"kind":"builtin","algorithm":"xor_ff","constantHex":null}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum KeyProviderSpecDto {
    /// Demo algorithms (see [`BuiltinAlgorithm`]).
    Builtin {
        algorithm: BuiltinAlgorithm,
        /// Hex u32 constant for `xor_const` / `add_const` / `right_rotate`. Default `5A3C1E8F`.
        #[serde(default)]
        constant_hex: Option<String>,
    },
    /// Exact seed lookup (case/whitespace-insensitive hex compare).
    Table { entries: Vec<SeedKeyPairDto> },
    /// Sandboxed Rhai script defining `fn calculate_key(seed, level)`;
    /// `seed` is a Rhai `Blob`, `level` an INT; returns `Blob` or `Array` of 0..=255.
    Script {
        source: String,
        #[serde(default = "default_script_timeout")]
        timeout_ms: u32,
    },
    /// Native seed/key DLL / .so / .dylib exporting the Vector-style
    /// `GenerateKeyEx` (or `GenerateKeyExOpt` when `options` is set).
    ///
    /// Executed out-of-process by `nexus-seedkey-native` (never loaded into the app).
    Library {
        /// Absolute local file-system path. LOCAL-ONLY DATA: it reveals the operator's
        /// machine layout and OEM tooling, so it must never be included in cloud sync
        /// payloads, telemetry or info-level logs.
        path: String,
        #[serde(default)]
        variant: Option<String>,
        #[serde(default)]
        options: Option<String>,
        #[serde(default = "default_max_key_len")]
        max_key_len: u16,
    },
    /// External program (no shell). Placeholders in `args`: `{seed}` (uppercase hex),
    /// `{level}` (2-digit hex), `{levelDec}`. Seed hex + '\n' is also written to stdin.
    /// First non-empty stdout line is parsed as hex key.
    ExternalProcess {
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default = "default_process_timeout")]
        timeout_ms: u32,
    },
    /// HTTP POST `{"seedHex":"..","level":N}` → `{"keyHex":".."}`.
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<HttpHeaderDto>,
        #[serde(default = "default_http_timeout")]
        timeout_ms: u32,
    },
    /// Operator types the key in the HMI. Backend always returns `ManualRequired`.
    Manual,
}

impl KeyProviderSpecDto {
    /// Stable snake_case kind string (same as the serde tag).
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Builtin { .. } => "builtin",
            Self::Table { .. } => "table",
            Self::Script { .. } => "script",
            Self::Library { .. } => "library",
            Self::ExternalProcess { .. } => "external_process",
            Self::Http { .. } => "http",
            Self::Manual => "manual",
        }
    }

    /// Kinds that execute native code, spawn processes or open network
    /// connections. Gated by policy (see contract §4).
    pub fn is_native(&self) -> bool {
        matches!(
            self,
            Self::Library { .. } | Self::ExternalProcess { .. } | Self::Http { .. }
        )
    }
}

// ─── Profiles ───────────────────────────────────────────────────────────────

/// Binds one requestSeed level (odd sub-function, 0x01..=0x7D) to a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityLevelBindingDto {
    pub level: u8,
    #[serde(default)]
    pub label: Option<String>,
    pub provider: KeyProviderSpecDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedKeyTestVectorDto {
    pub level: u8,
    pub seed_hex: String,
    pub key_hex: String,
}

/// Per-ECU seed/key profile. Flow files reference profiles by `id` only;
/// paths, scripts and URLs never live inside a flow file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedKeyProfileDto {
    pub schema_version: u32,
    /// Empty on create; backend assigns.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub ecu_label: String,
    pub levels: Vec<SecurityLevelBindingDto>,
    #[serde(default)]
    pub test_vectors: Vec<SeedKeyTestVectorDto>,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
}

// ─── Requests / results ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeKeyRequestDto {
    pub profile_id: String,
    pub level: u8,
    pub seed_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeKeyResultDto {
    /// Uppercase hex, no separators.
    pub key_hex: String,
    pub provider_kind: String,
    pub elapsed_us: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestVectorOutcomeDto {
    pub level: u8,
    pub seed_hex: String,
    pub expected_key_hex: String,
    pub actual_key_hex: Option<String>,
    pub passed: bool,
    pub error: Option<SeedKeyErrorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestVectorReportDto {
    pub profile_id: String,
    pub total: u32,
    pub passed: u32,
    pub outcomes: Vec<TestVectorOutcomeDto>,
}

/// Result of inspecting a seed/key library file without loading it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedKeyLibraryInfoDto {
    pub path: String,
    /// `"pe" | "elf" | "macho" | "unknown"`
    pub format: String,
    /// `"x86" | "x86_64" | "aarch64" | "arm" | "unknown"`
    pub arch: String,
    /// Format + arch match the running host and the file could be opened.
    pub loadable: bool,
    pub has_generate_key_ex: bool,
    pub has_generate_key_ex_opt: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedKeyCapabilitiesDto {
    /// `false` when the caller may not use / save `library`, `external_process`, `http`.
    pub native_providers_allowed: bool,
    pub script_available: bool,
    pub host_os: String,
    pub host_arch: String,
    /// Native kinds this build can execute (`"library"`, `"external_process"`, later `"http"`),
    /// independent of `native_providers_allowed` (the per-caller policy).
    #[serde(default)]
    pub native_kinds_available: Vec<String>,
    /// The 32-bit out-of-process seed/key helper (`nexus-seedkey-host32`) was found. Needed for
    /// 32-bit (x86) Windows DLLs on a 64-bit host.
    #[serde(default)]
    pub library_host32_found: bool,
    /// The 64-bit (host-native) seed/key helper (`nexus-seedkey-host64`, or the unsuffixed
    /// development build `nexus-seedkey-host`) was found.
    #[serde(default)]
    pub library_host64_found: bool,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedKeyErrorCode {
    InvalidInput,
    NotFound,
    ManualRequired,
    Timeout,
    Unsupported,
    NativeNotAllowed,
    BitnessMismatch,
    LibraryLoad,
    LibraryCall,
    Script,
    Process,
    Http,
    Storage,
}

impl SeedKeyErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::NotFound => "not_found",
            Self::ManualRequired => "manual_required",
            Self::Timeout => "timeout",
            Self::Unsupported => "unsupported",
            Self::NativeNotAllowed => "native_not_allowed",
            Self::BitnessMismatch => "bitness_mismatch",
            Self::LibraryLoad => "library_load",
            Self::LibraryCall => "library_call",
            Self::Script => "script",
            Self::Process => "process",
            Self::Http => "http",
            Self::Storage => "storage",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedKeyErrorDto {
    pub code: SeedKeyErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SeedKeyError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("manual key entry required")]
    ManualRequired,
    #[error("timed out after {ms} ms")]
    Timeout { ms: u32 },
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("native seed/key provider not allowed: {0}")]
    NativeNotAllowed(String),
    #[error("library architecture {library} does not match host {host}")]
    BitnessMismatch { library: String, host: String },
    #[error("library load failed: {0}")]
    LibraryLoad(String),
    #[error("library GenerateKeyEx returned error code {code}")]
    LibraryCall { code: i64 },
    /// The library call failed without a GenerateKeyEx return code: the library crashed (its
    /// isolated helper process died), returned an invalid key length, or the helper answered
    /// garbage. Wire code is `library_call` (no new code on the IPC contract).
    #[error("library call failed: {0}")]
    LibraryFault(String),
    #[error("script error: {0}")]
    Script(String),
    #[error("external process error: {0}")]
    Process(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("storage error: {0}")]
    Storage(String),
}

impl SeedKeyError {
    pub fn code(&self) -> SeedKeyErrorCode {
        match self {
            Self::InvalidInput(_) => SeedKeyErrorCode::InvalidInput,
            Self::NotFound(_) => SeedKeyErrorCode::NotFound,
            Self::ManualRequired => SeedKeyErrorCode::ManualRequired,
            Self::Timeout { .. } => SeedKeyErrorCode::Timeout,
            Self::Unsupported(_) => SeedKeyErrorCode::Unsupported,
            Self::NativeNotAllowed(_) => SeedKeyErrorCode::NativeNotAllowed,
            Self::BitnessMismatch { .. } => SeedKeyErrorCode::BitnessMismatch,
            Self::LibraryLoad(_) => SeedKeyErrorCode::LibraryLoad,
            Self::LibraryCall { .. } | Self::LibraryFault(_) => SeedKeyErrorCode::LibraryCall,
            Self::Script(_) => SeedKeyErrorCode::Script,
            Self::Process(_) => SeedKeyErrorCode::Process,
            Self::Http(_) => SeedKeyErrorCode::Http,
            Self::Storage(_) => SeedKeyErrorCode::Storage,
        }
    }

    pub fn to_dto(&self) -> SeedKeyErrorDto {
        SeedKeyErrorDto {
            code: self.code(),
            message: self.to_string(),
        }
    }

    /// Wire format for IPC error strings (Tauri `Err(String)` and bridge 400 body):
    /// `"[seedkey:<code>] <message>"`. The HMI parses the prefix.
    pub fn to_ipc_string(&self) -> String {
        format!("[seedkey:{}] {}", self.code().as_str(), self)
    }
}

// ─── Provider trait ─────────────────────────────────────────────────────────

/// Input of a single key computation.
#[derive(Debug, Clone, Copy)]
pub struct SeedKeyRequest<'a> {
    pub seed: &'a [u8],
    /// requestSeed sub-function (odd).
    pub level: u8,
}

/// A configured seed→key strategy. Implementations must be deterministic for
/// a given (seed, level) and must enforce their own timeout.
pub trait KeyProvider: Send + Sync {
    /// Same string as [`KeyProviderSpecDto::kind`].
    fn kind(&self) -> &'static str;
    fn compute_key(&self, req: &SeedKeyRequest<'_>) -> Result<Vec<u8>, SeedKeyError>;
}

// ─── Hex helpers (shared by all crates) ─────────────────────────────────────

/// Parses hex ignoring ASCII whitespace, `-`, `:` and an optional `0x` prefix.
pub fn parse_hex(input: &str) -> Result<Vec<u8>, SeedKeyError> {
    let trimmed = input.trim();
    let body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let digits: Vec<u8> = body
        .bytes()
        .filter(|b| !(b.is_ascii_whitespace() || *b == b'-' || *b == b':'))
        .collect();
    if !digits.len().is_multiple_of(2) {
        return Err(SeedKeyError::InvalidInput(format!(
            "odd number of hex digits in '{input}'"
        )));
    }
    let (pairs, _) = digits.as_chunks::<2>();
    pairs
        .iter()
        .map(|&[h, l]| {
            let hi = hex_val(h);
            let lo = hex_val(l);
            match (hi, lo) {
                (Some(h), Some(l)) => Ok((h << 4) | l),
                _ => Err(SeedKeyError::InvalidInput(format!(
                    "invalid hex digit in '{input}'"
                ))),
            }
        })
        .collect()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Uppercase hex without separators.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0F) as usize] as char);
    }
    out
}

/// requestSeed levels are odd sub-functions in 0x01..=0x7D.
pub fn is_valid_request_seed_level(level: u8) -> bool {
    level % 2 == 1 && (0x01..=0x7D).contains(&level)
}

/// Structural validation of a profile (levels, duplicate levels, hex fields,
/// lengths, non-empty native fields, script size). Implemented by protocol-specialist.
pub fn validate_profile(profile: &SeedKeyProfileDto) -> Result<(), SeedKeyError> {
    providers::validate_profile_impl(profile)
}

/// Runs every test vector of `profile` through providers produced by `resolve`
/// (native crate passes its own factory). Never short-circuits.
pub fn run_test_vectors<F>(profile: &SeedKeyProfileDto, resolve: F) -> TestVectorReportDto
where
    F: Fn(&KeyProviderSpecDto) -> Result<Box<dyn KeyProvider>, SeedKeyError>,
{
    providers::run_test_vectors_impl(profile, resolve)
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        assert_eq!(
            parse_hex("0x12 ab-CD:ef").unwrap(),
            vec![0x12, 0xAB, 0xCD, 0xEF]
        );
        assert_eq!(to_hex(&[0x01, 0xAF]), "01AF");
        assert!(parse_hex("123").is_err());
        assert!(parse_hex("zz").is_err());
    }

    #[test]
    fn spec_json_shape_is_stable() {
        let spec = KeyProviderSpecDto::Builtin {
            algorithm: BuiltinAlgorithm::XorFf,
            constant_hex: None,
        };
        let json = serde_json::to_string(&spec).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"builtin","algorithm":"xor_ff","constantHex":null}"#
        );
        let manual: KeyProviderSpecDto = serde_json::from_str(r#"{"kind":"manual"}"#).unwrap();
        assert_eq!(manual, KeyProviderSpecDto::Manual);
        let lib: KeyProviderSpecDto =
            serde_json::from_str(r#"{"kind":"library","path":"a.dll"}"#).unwrap();
        assert!(lib.is_native());
    }

    #[test]
    fn ipc_error_prefix() {
        assert_eq!(
            SeedKeyError::ManualRequired.to_ipc_string(),
            "[seedkey:manual_required] manual key entry required"
        );
    }
}
