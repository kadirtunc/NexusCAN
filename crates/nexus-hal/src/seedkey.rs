//! WP-2 (CRIT-03): UDS SecurityAccess seed/key computation for the HMI over IPC.
//!
//! Replaces the frontend's `new Function` custom algorithm: keys are computed in the backend by
//! the portable providers of `nexus_protocols::uds::security` (`builtin`, `table`, sandboxed
//! Rhai `script`). Native providers (`library`, `external_process`, `http`) are NOT available
//! in v0.1 and are refused on every transport (Tauri and bridge).
//!
//! Contract: `planning/contracts/seedkey-v1.md` §2 (`cmd_seedkey_capabilities`,
//! `cmd_seedkey_compute_adhoc`). Errors use `SeedKeyError::to_ipc_string`
//! (`"[seedkey:<code>] <message>"`). Calls can run up to the provider timeout, so transports
//! must invoke [`compute_adhoc`] on a blocking worker.

use nexus_protocols::uds::security::{
    build_portable_provider, is_valid_request_seed_level, parse_hex, to_hex, ComputeKeyResultDto,
    KeyProviderSpecDto, SeedKeyCapabilitiesDto, SeedKeyError, SeedKeyRequest, MAX_SEED_LEN,
};
use std::sync::OnceLock;
use std::time::Instant;

/// Whether the Rhai `script` provider is compiled into `nexus-protocols`.
fn script_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let probe = KeyProviderSpecDto::Script {
            source: "fn calculate_key(seed, level) { seed }".to_string(),
            timeout_ms: 1_000,
        };
        !matches!(
            build_portable_provider(&probe),
            Err(SeedKeyError::Unsupported(_))
        )
    })
}

/// `cmd_seedkey_capabilities`: native providers are never allowed in v0.1.
pub fn capabilities() -> SeedKeyCapabilitiesDto {
    SeedKeyCapabilitiesDto {
        native_providers_allowed: false,
        script_available: script_available(),
        host_os: std::env::consts::OS.to_string(),
        host_arch: std::env::consts::ARCH.to_string(),
    }
}

/// `cmd_seedkey_compute_adhoc`: computes a key with an unsaved provider spec.
///
/// Blocking (script providers run up to their `timeoutMs`).
pub fn compute_adhoc(
    provider: &KeyProviderSpecDto,
    level: u8,
    seed_hex: &str,
) -> Result<ComputeKeyResultDto, SeedKeyError> {
    if provider.is_native() {
        return Err(SeedKeyError::Unsupported(format!(
            "'{}' seed/key provider is not available in v0.1",
            provider.kind()
        )));
    }
    if !is_valid_request_seed_level(level) {
        return Err(SeedKeyError::InvalidInput(format!(
            "level 0x{level:02X} is not a requestSeed level (odd, 0x01..=0x7D)"
        )));
    }
    let seed = parse_hex(seed_hex)?;
    if seed.is_empty() || seed.len() > MAX_SEED_LEN {
        return Err(SeedKeyError::InvalidInput(format!(
            "seed must be 1..={MAX_SEED_LEN} bytes, got {}",
            seed.len()
        )));
    }
    let started = Instant::now();
    let key_provider = build_portable_provider(provider)?;
    let key = key_provider.compute_key(&SeedKeyRequest { seed: &seed, level })?;
    Ok(ComputeKeyResultDto {
        key_hex: to_hex(&key),
        provider_kind: provider.kind().to_string(),
        elapsed_us: u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_protocols::uds::security::{BuiltinAlgorithm, SeedKeyErrorCode};

    const XOR_A5_SCRIPT: &str = r#"
        fn calculate_key(seed, level) {
            let key = blob();
            for b in seed { key.push(b ^ 0xA5); }
            key
        }
    "#;

    #[test]
    fn rhai_script_xor_a5_matches_ecusim_level1_vector() {
        let spec = KeyProviderSpecDto::Script {
            source: XOR_A5_SCRIPT.to_string(),
            timeout_ms: 1_000,
        };
        let res = compute_adhoc(&spec, 0x01, "11 22 33 44").expect("script key");
        assert_eq!(res.key_hex, "B48796E1");
        assert_eq!(res.provider_kind, "script");
        let json = serde_json::to_value(&res).expect("json");
        assert_eq!(json["keyHex"], "B48796E1");
        assert_eq!(json["providerKind"], "script");
        assert!(json.get("elapsedUs").is_some());
    }

    #[test]
    fn builtin_and_capabilities() {
        let spec = KeyProviderSpecDto::Builtin {
            algorithm: BuiltinAlgorithm::XorFf,
            constant_hex: None,
        };
        let res = compute_adhoc(&spec, 0x01, "0x00FF").expect("builtin");
        assert_eq!(res.key_hex.len(), 4);

        let caps = capabilities();
        assert!(!caps.native_providers_allowed);
        assert!(caps.script_available);
        let json = serde_json::to_value(&caps).expect("json");
        assert_eq!(json["nativeProvidersAllowed"], false);
        assert_eq!(json["scriptAvailable"], true);
    }

    #[test]
    fn native_providers_and_bad_input_are_refused() {
        let native = [
            KeyProviderSpecDto::Library {
                path: "/tmp/x.so".into(),
                variant: None,
                options: None,
                max_key_len: 64,
            },
            KeyProviderSpecDto::ExternalProcess {
                program: "/bin/sh".into(),
                args: vec![],
                timeout_ms: 100,
            },
            KeyProviderSpecDto::Http {
                url: "http://127.0.0.1:1".into(),
                headers: vec![],
                timeout_ms: 100,
            },
        ];
        for spec in &native {
            let err = compute_adhoc(spec, 0x01, "11223344").expect_err("native refused");
            assert_eq!(err.code(), SeedKeyErrorCode::Unsupported);
            let wire = err.to_ipc_string();
            assert!(wire.starts_with("[seedkey:unsupported] "), "{wire}");
            assert!(wire.contains("not available in v0.1"), "{wire}");
        }

        let xor = KeyProviderSpecDto::Builtin {
            algorithm: BuiltinAlgorithm::XorFf,
            constant_hex: None,
        };
        let err = compute_adhoc(&xor, 0x02, "11").expect_err("even level");
        assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
        let err = compute_adhoc(&xor, 0x01, "1G").expect_err("bad hex");
        assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
        let err = compute_adhoc(&xor, 0x01, "").expect_err("empty seed");
        assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
        let err = compute_adhoc(&KeyProviderSpecDto::Manual, 0x01, "11").expect_err("manual");
        assert_eq!(err.code(), SeedKeyErrorCode::ManualRequired);

        // Runaway script is stopped by the sandbox (timeout or operation limit).
        let spin = KeyProviderSpecDto::Script {
            source: "fn calculate_key(seed, level) { loop { } }".into(),
            timeout_ms: 50,
        };
        let err = compute_adhoc(&spin, 0x01, "11").expect_err("runaway");
        assert!(
            matches!(
                err.code(),
                SeedKeyErrorCode::Timeout | SeedKeyErrorCode::Script
            ),
            "{err:?}"
        );
    }
}
