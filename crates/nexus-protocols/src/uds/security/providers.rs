//! Portable seed/key providers: `builtin`, `table`, `script` (Rhai), plus
//! profile validation and the test-vector runner.
//!
//! Contract: `planning/contracts/seedkey-v1.md` §3. Public signatures are frozen.
//!
//! * [`build_portable_provider`] — `builtin` / `table` / `script` → provider;
//!   `manual` → `ManualRequired`; native kinds → `Unsupported("… requires
//!   nexus-seedkey-native")` (the native crate relies on this distinction).
//! * `validate_profile_impl` — structural checks; every error is
//!   `InvalidInput` and names the offending field with a camelCase JSON path
//!   (e.g. `levels[1].provider.timeoutMs`).
//! * `run_test_vectors_impl` — evaluates every vector (never short-circuits);
//!   providers are resolved once per level.

use std::collections::{HashMap, HashSet};

use super::{
    is_valid_request_seed_level, parse_hex, to_hex, KeyProvider, KeyProviderSpecDto, SeedKeyError,
    SeedKeyProfileDto, SeedKeyRequest, TestVectorOutcomeDto, TestVectorReportDto, MAX_KEY_LEN,
    MAX_SEED_LEN, SEEDKEY_PROFILE_SCHEMA_VERSION,
};

mod builtin;
#[cfg(feature = "script")]
mod script;
mod table;
#[cfg(test)]
mod tests;

/// Maximum Rhai script source size in bytes.
pub const MAX_SCRIPT_SOURCE_LEN: usize = 64 * 1024;
/// Maximum number of entries in a `table` provider.
pub const MAX_TABLE_ENTRIES: usize = 4096;
/// Allowed range for every provider timeout (ms).
pub const MIN_TIMEOUT_MS: u32 = 1;
/// Allowed range for every provider timeout (ms).
pub const MAX_TIMEOUT_MS: u32 = 60_000;

/// Builds a provider for portable kinds.
/// * `builtin` / `table` / `script` → provider
/// * `manual` → `Err(ManualRequired)`
/// * `library` / `external_process` / `http` → `Err(Unsupported(..))`
///   (handled by `nexus-seedkey-native`)
pub fn build_portable_provider(
    spec: &KeyProviderSpecDto,
) -> Result<Box<dyn KeyProvider>, SeedKeyError> {
    match spec {
        KeyProviderSpecDto::Manual => Err(SeedKeyError::ManualRequired),
        other if other.is_native() => Err(SeedKeyError::Unsupported(format!(
            "'{}' provider requires nexus-seedkey-native",
            other.kind()
        ))),
        KeyProviderSpecDto::Builtin {
            algorithm,
            constant_hex,
        } => Ok(Box::new(builtin::BuiltinProvider::new(
            *algorithm,
            constant_hex.as_deref(),
        ))),
        KeyProviderSpecDto::Table { entries } => Ok(Box::new(table::TableProvider::new(entries)?)),
        KeyProviderSpecDto::Script { source, timeout_ms } => build_script(source, *timeout_ms),
        other => Err(SeedKeyError::Unsupported(format!(
            "'{}' provider is not portable",
            other.kind()
        ))),
    }
}

#[cfg(feature = "script")]
fn build_script(source: &str, timeout_ms: u32) -> Result<Box<dyn KeyProvider>, SeedKeyError> {
    check_script_source(source, "source")?;
    check_timeout(timeout_ms, "timeoutMs")?;
    Ok(Box::new(script::ScriptProvider::new(source, timeout_ms)?))
}

#[cfg(not(feature = "script"))]
fn build_script(_source: &str, _timeout_ms: u32) -> Result<Box<dyn KeyProvider>, SeedKeyError> {
    Err(SeedKeyError::Unsupported(
        "'script' provider requires nexus-protocols feature `script`".into(),
    ))
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

fn check_seed_len(seed: &[u8]) -> Result<(), SeedKeyError> {
    if seed.len() > MAX_SEED_LEN {
        return Err(SeedKeyError::InvalidInput(format!(
            "seed is {} bytes (max {MAX_SEED_LEN})",
            seed.len()
        )));
    }
    Ok(())
}

/// Parses a seed/key hex field: must decode, be non-empty and ≤ 256 bytes.
fn parse_bounded_hex(value: &str, field: &str) -> Result<Vec<u8>, SeedKeyError> {
    let bytes = parse_hex(value).map_err(|e| invalid(field, &e.to_string()))?;
    if bytes.is_empty() {
        return Err(invalid(field, "must not be empty"));
    }
    let max = MAX_SEED_LEN.max(MAX_KEY_LEN);
    if bytes.len() > max {
        return Err(invalid(
            field,
            &format!("{} bytes exceed the limit of {max}", bytes.len()),
        ));
    }
    Ok(bytes)
}

fn invalid(field: &str, msg: &str) -> SeedKeyError {
    SeedKeyError::InvalidInput(format!("{field}: {msg}"))
}

fn check_timeout(ms: u32, field: &str) -> Result<(), SeedKeyError> {
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&ms) {
        return Err(invalid(
            field,
            &format!("{ms} ms outside {MIN_TIMEOUT_MS}..={MAX_TIMEOUT_MS}"),
        ));
    }
    Ok(())
}

fn check_script_source(source: &str, field: &str) -> Result<(), SeedKeyError> {
    if source.trim().is_empty() {
        return Err(invalid(field, "must not be empty"));
    }
    if source.len() > MAX_SCRIPT_SOURCE_LEN {
        return Err(invalid(
            field,
            &format!(
                "{} bytes exceed the limit of {MAX_SCRIPT_SOURCE_LEN}",
                source.len()
            ),
        ));
    }
    Ok(())
}

fn check_non_empty(value: &str, field: &str) -> Result<(), SeedKeyError> {
    if value.trim().is_empty() {
        return Err(invalid(field, "must not be empty"));
    }
    Ok(())
}

/// Saved profiles must carry a real u32 constant (1..=8 hex digits after
/// optional `0x`, separators allowed). The runtime itself stays lenient for
/// legacy parity (see `builtin`), but garbage is rejected at save time.
fn check_builtin_constant(value: &str, field: &str) -> Result<(), SeedKeyError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(()); // → default constant
    }
    let body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let mut digits = 0usize;
    for c in body.chars() {
        if c.is_ascii_hexdigit() {
            digits += 1;
        } else if !(c.is_ascii_whitespace() || c == '-' || c == ':' || c == '_') {
            return Err(invalid(
                field,
                &format!("invalid hex digit '{c}' in '{value}'"),
            ));
        }
    }
    if !(1..=8).contains(&digits) {
        return Err(invalid(
            field,
            &format!("'{value}' is not a 32-bit hex constant"),
        ));
    }
    Ok(())
}

// ─── Validation ─────────────────────────────────────────────────────────────

fn validate_spec(spec: &KeyProviderSpecDto, path: &str) -> Result<(), SeedKeyError> {
    match spec {
        KeyProviderSpecDto::Builtin { constant_hex, .. } => {
            if let Some(c) = constant_hex {
                check_builtin_constant(c, &format!("{path}.constantHex"))?;
            }
        }
        KeyProviderSpecDto::Table { entries } => {
            if entries.len() > MAX_TABLE_ENTRIES {
                return Err(invalid(
                    &format!("{path}.entries"),
                    &format!(
                        "{} entries exceed the limit of {MAX_TABLE_ENTRIES}",
                        entries.len()
                    ),
                ));
            }
            for (i, e) in entries.iter().enumerate() {
                parse_bounded_hex(&e.seed_hex, &format!("{path}.entries[{i}].seedHex"))?;
                parse_bounded_hex(&e.key_hex, &format!("{path}.entries[{i}].keyHex"))?;
            }
        }
        KeyProviderSpecDto::Script { source, timeout_ms } => {
            check_script_source(source, &format!("{path}.source"))?;
            check_timeout(*timeout_ms, &format!("{path}.timeoutMs"))?;
            #[cfg(feature = "script")]
            script::compile(source)
                .map_err(|e| invalid(&format!("{path}.source"), &e.to_string()))?;
        }
        KeyProviderSpecDto::Library {
            path: lib_path,
            max_key_len,
            ..
        } => {
            check_non_empty(lib_path, &format!("{path}.path"))?;
            if *max_key_len == 0 || usize::from(*max_key_len) > MAX_KEY_LEN {
                return Err(invalid(
                    &format!("{path}.maxKeyLen"),
                    &format!("{max_key_len} outside 1..={MAX_KEY_LEN}"),
                ));
            }
        }
        KeyProviderSpecDto::ExternalProcess {
            program,
            timeout_ms,
            ..
        } => {
            check_non_empty(program, &format!("{path}.program"))?;
            check_timeout(*timeout_ms, &format!("{path}.timeoutMs"))?;
        }
        KeyProviderSpecDto::Http {
            url, timeout_ms, ..
        } => {
            check_non_empty(url, &format!("{path}.url"))?;
            check_timeout(*timeout_ms, &format!("{path}.timeoutMs"))?;
        }
        KeyProviderSpecDto::Manual => {}
    }
    Ok(())
}

pub(super) fn validate_profile_impl(profile: &SeedKeyProfileDto) -> Result<(), SeedKeyError> {
    if profile.schema_version != SEEDKEY_PROFILE_SCHEMA_VERSION {
        return Err(invalid(
            "schemaVersion",
            &format!(
                "{} is not supported (expected {SEEDKEY_PROFILE_SCHEMA_VERSION})",
                profile.schema_version
            ),
        ));
    }
    check_non_empty(&profile.name, "name")?;
    if profile.levels.is_empty() {
        return Err(invalid("levels", "at least one security level is required"));
    }
    let mut seen = HashSet::new();
    for (i, binding) in profile.levels.iter().enumerate() {
        let path = format!("levels[{i}]");
        if !is_valid_request_seed_level(binding.level) {
            return Err(invalid(
                &format!("{path}.level"),
                &format!(
                    "0x{:02X} is not a requestSeed level (odd, 0x01..=0x7D)",
                    binding.level
                ),
            ));
        }
        if !seen.insert(binding.level) {
            return Err(invalid(
                &format!("{path}.level"),
                &format!("duplicate level 0x{:02X}", binding.level),
            ));
        }
        validate_spec(&binding.provider, &format!("{path}.provider"))?;
    }
    for (i, tv) in profile.test_vectors.iter().enumerate() {
        let path = format!("testVectors[{i}]");
        if !seen.contains(&tv.level) {
            return Err(invalid(
                &format!("{path}.level"),
                &format!("level 0x{:02X} has no binding in levels", tv.level),
            ));
        }
        parse_bounded_hex(&tv.seed_hex, &format!("{path}.seedHex"))?;
        parse_bounded_hex(&tv.key_hex, &format!("{path}.keyHex"))?;
    }
    Ok(())
}

// ─── Test vectors ───────────────────────────────────────────────────────────

/// Normalizes a hex string for display; keeps the original if it does not parse.
fn normalize_hex(value: &str) -> String {
    parse_hex(value)
        .map(|b| to_hex(&b))
        .unwrap_or_else(|_| value.to_string())
}

pub(super) fn run_test_vectors_impl<F>(
    profile: &SeedKeyProfileDto,
    resolve: F,
) -> TestVectorReportDto
where
    F: Fn(&KeyProviderSpecDto) -> Result<Box<dyn KeyProvider>, SeedKeyError>,
{
    // Built lazily, once per level; errors are cached and repeated per vector.
    let mut providers: HashMap<u8, Result<Box<dyn KeyProvider>, SeedKeyError>> = HashMap::new();
    let mut outcomes = Vec::with_capacity(profile.test_vectors.len());

    for tv in &profile.test_vectors {
        let provider = providers.entry(tv.level).or_insert_with(|| {
            profile
                .levels
                .iter()
                .find(|b| b.level == tv.level)
                .ok_or_else(|| {
                    SeedKeyError::NotFound(format!("no provider bound to level 0x{:02X}", tv.level))
                })
                .and_then(|b| resolve(&b.provider))
        });

        let result = (|| {
            let seed = parse_hex(&tv.seed_hex)?;
            let expected = parse_hex(&tv.key_hex)?;
            let provider = provider.as_ref().map_err(Clone::clone)?;
            let actual = provider.compute_key(&SeedKeyRequest {
                seed: &seed,
                level: tv.level,
            })?;
            Ok::<_, SeedKeyError>((actual, expected))
        })();

        let outcome = match result {
            Ok((actual, expected)) => TestVectorOutcomeDto {
                level: tv.level,
                seed_hex: normalize_hex(&tv.seed_hex),
                expected_key_hex: to_hex(&expected),
                actual_key_hex: Some(to_hex(&actual)),
                passed: actual == expected,
                error: None,
            },
            Err(e) => TestVectorOutcomeDto {
                level: tv.level,
                seed_hex: normalize_hex(&tv.seed_hex),
                expected_key_hex: normalize_hex(&tv.key_hex),
                actual_key_hex: None,
                passed: false,
                error: Some(e.to_dto()),
            },
        };
        outcomes.push(outcome);
    }

    let passed = outcomes.iter().filter(|o| o.passed).count();
    TestVectorReportDto {
        profile_id: profile.id.clone(),
        total: u32::try_from(outcomes.len()).unwrap_or(u32::MAX),
        passed: u32::try_from(passed).unwrap_or(u32::MAX),
        outcomes,
    }
}
