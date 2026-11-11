#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::super::*;
use super::builtin::{self, legacy_constant, DEFAULT_CONSTANT};
use super::*;

#[path = "ts_parity_vectors.rs"]
mod ts_parity_vectors;
use ts_parity_vectors::{TS_CONSTANT_VECTORS, TS_PARITY_VECTORS};

fn algo(name: &str) -> BuiltinAlgorithm {
    serde_json::from_value(serde_json::Value::String(name.to_string())).unwrap()
}

fn builtin_spec(name: &str, constant: Option<&str>) -> KeyProviderSpecDto {
    KeyProviderSpecDto::Builtin {
        algorithm: algo(name),
        constant_hex: constant.map(str::to_string),
    }
}

fn compute(spec: &KeyProviderSpecDto, seed: &[u8], level: u8) -> Result<Vec<u8>, SeedKeyError> {
    build_portable_provider(spec)?.compute_key(&SeedKeyRequest { seed, level })
}

// ─── builtin: TS parity ─────────────────────────────────────────────────────

#[test]
fn builtin_matches_legacy_ts_vectors() {
    let mut algos_seen = HashSet::new();
    for &(name, seed_hex, constant, expected) in TS_PARITY_VECTORS {
        algos_seen.insert(name);
        let seed = parse_hex(seed_hex).unwrap();
        // '' in the TS harness == missing constant in the DTO.
        let c = if constant.is_empty() {
            None
        } else {
            Some(constant)
        };
        let key = compute(&builtin_spec(name, c), &seed, 1).unwrap();
        assert_eq!(
            to_hex(&key),
            expected,
            "algo={name} seed={seed_hex} const={constant:?}"
        );
    }
    assert_eq!(algos_seen.len(), 7, "every builtin algorithm has vectors");
}

#[test]
fn legacy_constant_matches_js_parse_int() {
    for &(input, expected) in TS_CONSTANT_VECTORS {
        assert_eq!(legacy_constant(input), expected, "input={input:?}");
    }
    // node: values ≥ 2^86 (incl. Infinity) → 0.
    for long in [
        format!("1{}", "0".repeat(255)),
        "F".repeat(256),
        format!("1{}", "0".repeat(256)),
        "F".repeat(300),
    ] {
        assert_eq!(legacy_constant(&long), 0);
    }
    assert_eq!(legacy_constant("   "), DEFAULT_CONSTANT);
}

#[test]
fn builtin_short_seed_quirks() {
    // right_rotate on < 4 bytes: ror32(b, 2) & 0xFF == b >> 2.
    assert_eq!(
        builtin::compute(BuiltinAlgorithm::RightRotate, &[0xFF, 0x03, 0x80], 0),
        vec![0x3F, 0x00, 0x20]
    );
    // add_const on < 4 bytes: + low byte of constant.
    assert_eq!(
        builtin::compute(BuiltinAlgorithm::AddConst, &[0x80], DEFAULT_CONSTANT),
        vec![0x0F]
    );
    // CRC check values ("123456789").
    assert_eq!(
        builtin::compute(BuiltinAlgorithm::Crc32, b"123456789", 0),
        vec![0xCB, 0xF4, 0x39, 0x26]
    );
    // CRC-16/KERMIT check value 0x2189 (node: crc16ibm("123456789") == 0x2189), emitted big-endian.
    assert_eq!(
        builtin::compute(BuiltinAlgorithm::Crc16Kermit, b"123456789", 0),
        vec![0x21, 0x89]
    );
}

#[test]
fn builtin_rejects_oversized_seed() {
    let err = compute(&builtin_spec("xor_ff", None), &[0u8; MAX_SEED_LEN + 1], 1).unwrap_err();
    assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
    assert!(compute(&builtin_spec("xor_ff", None), &[0u8; MAX_SEED_LEN], 1).is_ok());
}

// ─── factory ────────────────────────────────────────────────────────────────

#[test]
fn factory_kind_routing() {
    assert_eq!(
        build_portable_provider(&KeyProviderSpecDto::Manual).err(),
        Some(SeedKeyError::ManualRequired)
    );
    for spec in [
        KeyProviderSpecDto::Library {
            path: "a.dll".into(),
            variant: None,
            options: None,
            max_key_len: 64,
        },
        KeyProviderSpecDto::ExternalProcess {
            program: "x".into(),
            args: vec![],
            timeout_ms: 100,
        },
        KeyProviderSpecDto::Http {
            url: "http://x".into(),
            headers: vec![],
            timeout_ms: 100,
        },
    ] {
        match build_portable_provider(&spec) {
            Err(SeedKeyError::Unsupported(msg)) => {
                assert!(msg.contains("requires nexus-seedkey-native"), "{msg}")
            }
            other => panic!("unexpected {:?}", other.map(|p| p.kind())),
        }
    }
    assert_eq!(
        build_portable_provider(&builtin_spec("crc32", None))
            .unwrap()
            .kind(),
        "builtin"
    );
    let table = KeyProviderSpecDto::Table { entries: vec![] };
    assert_eq!(build_portable_provider(&table).unwrap().kind(), "table");
}

// ─── table ──────────────────────────────────────────────────────────────────

fn pair(seed: &str, key: &str) -> SeedKeyPairDto {
    SeedKeyPairDto {
        seed_hex: seed.into(),
        key_hex: key.into(),
    }
}

#[test]
fn table_hit_and_miss() {
    let spec = KeyProviderSpecDto::Table {
        entries: vec![
            pair("11 22 33 44", "aa-bb"),
            pair("0xDEADBEEF", "01:02:03:04"),
        ],
    };
    assert_eq!(
        compute(&spec, &[0x11, 0x22, 0x33, 0x44], 1).unwrap(),
        vec![0xAA, 0xBB]
    );
    assert_eq!(
        compute(&spec, &[0xDE, 0xAD, 0xBE, 0xEF], 3).unwrap(),
        vec![1, 2, 3, 4]
    );
    let err = compute(&spec, &[0x00], 1).unwrap_err();
    assert_eq!(err.code(), SeedKeyErrorCode::NotFound);
    // Prefix must not match.
    assert_eq!(
        compute(&spec, &[0x11, 0x22, 0x33], 1).unwrap_err().code(),
        SeedKeyErrorCode::NotFound
    );
}

#[test]
fn table_rejects_bad_entries_at_build() {
    for entries in [
        vec![pair("zz", "00")],
        vec![pair("00", "123")],
        vec![pair("", "00")],
        vec![pair("00", "")],
        vec![pair(&"00".repeat(MAX_SEED_LEN + 1), "00")],
    ] {
        let err = build_portable_provider(&KeyProviderSpecDto::Table { entries })
            .err()
            .unwrap();
        assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput, "{err}");
    }
    let too_many = vec![pair("00", "00"); MAX_TABLE_ENTRIES + 1];
    let err = build_portable_provider(&KeyProviderSpecDto::Table { entries: too_many })
        .err()
        .unwrap();
    assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
}

// ─── script ─────────────────────────────────────────────────────────────────

#[cfg(feature = "script")]
mod script_tests {
    use super::*;

    fn script(source: &str, timeout_ms: u32) -> KeyProviderSpecDto {
        KeyProviderSpecDto::Script {
            source: source.into(),
            timeout_ms,
        }
    }

    fn err_of(source: &str, seed: &[u8]) -> SeedKeyError {
        compute(&script(source, 1000), seed, 1).unwrap_err()
    }

    #[test]
    fn script_returns_blob() {
        let src = r#"
            fn calculate_key(seed, level) {
                let key = blob();
                for b in seed { key.push(b ^ 0xFF); }
                key.push(level);
                key
            }
        "#;
        assert_eq!(
            compute(&script(src, 1000), &[0x00, 0x0F], 0x05).unwrap(),
            vec![0xFF, 0xF0, 0x05]
        );
    }

    #[test]
    fn script_returns_int_array_and_matches_builtin() {
        // Re-implementation of builtin add_const in Rhai.
        let src = r#"
            fn calculate_key(seed, level) {
                let v = (seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3];
                let k = (v + 0x5A3C1E8F) & 0xFFFFFFFF;
                [(k >> 24) & 0xFF, (k >> 16) & 0xFF, (k >> 8) & 0xFF, k & 0xFF]
            }
        "#;
        let seed = [0xDE, 0xAD, 0xBE, 0xEF];
        let expected = compute(&builtin_spec("add_const", None), &seed, 1).unwrap();
        assert_eq!(compute(&script(src, 1000), &seed, 1).unwrap(), expected);
    }

    #[test]
    fn script_invalid_returns() {
        for body in [
            "42",
            "\"abc\"",
            "[1, 256]",
            "[1, -1]",
            "[1, \"x\"]",
            "[]",
            "blob()",
            "blob(300)",
        ] {
            let src = format!("fn calculate_key(seed, level) {{ {body} }}");
            let err = err_of(&src, &[1, 2]);
            assert_eq!(
                err.code(),
                SeedKeyErrorCode::Script,
                "body={body} err={err}"
            );
        }
    }

    #[test]
    fn script_compile_errors() {
        for src in [
            "fn calculate_key(seed, level) { let }",
            "fn other(seed, level) { seed }",
            "fn calculate_key(seed) { seed }",
        ] {
            let err = build_portable_provider(&script(src, 1000)).err().unwrap();
            assert_eq!(err.code(), SeedKeyErrorCode::Script, "src={src} err={err}");
        }
        // Size / timeout bounds checked before compiling.
        let big = format!(
            "fn calculate_key(seed, level) {{ seed }} //{}",
            "x".repeat(MAX_SCRIPT_SOURCE_LEN)
        );
        assert_eq!(
            build_portable_provider(&script(&big, 1000))
                .err()
                .unwrap()
                .code(),
            SeedKeyErrorCode::InvalidInput
        );
        let ok = "fn calculate_key(seed, level) { seed }";
        assert_eq!(
            build_portable_provider(&script(ok, 0))
                .err()
                .unwrap()
                .code(),
            SeedKeyErrorCode::InvalidInput
        );
        assert_eq!(
            build_portable_provider(&script(ok, 60_001))
                .err()
                .unwrap()
                .code(),
            SeedKeyErrorCode::InvalidInput
        );
    }

    #[test]
    fn script_infinite_loop_times_out() {
        let src = "fn calculate_key(seed, level) { loop {} }";
        let start = std::time::Instant::now();
        let err = compute(&script(src, 100), &[1], 1).unwrap_err();
        assert_eq!(err, SeedKeyError::Timeout { ms: 100 });
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        // Top-level code is also bounded.
        let src = "loop {} fn calculate_key(seed, level) { seed }";
        assert_eq!(
            compute(&script(src, 50), &[1], 1).unwrap_err(),
            SeedKeyError::Timeout { ms: 50 }
        );
    }

    #[test]
    fn script_sandbox_restrictions() {
        // eval is a disabled symbol → compile error.
        let err = build_portable_provider(&script(
            r#"fn calculate_key(seed, level) { eval("seed") }"#,
            1000,
        ))
        .err()
        .unwrap();
        assert_eq!(err.code(), SeedKeyErrorCode::Script);
        // ...and cannot be reached dynamically either.
        let err = err_of(
            r#"fn calculate_key(seed, level) { call(Fn("eval"), "seed") }"#,
            &[1],
        );
        assert_eq!(err.code(), SeedKeyErrorCode::Script, "{err}");
        // No modules.
        let err = build_portable_provider(&script(
            r#"import "x" as y; fn calculate_key(seed, level) { seed }"#,
            1000,
        ))
        .err()
        .unwrap();
        assert_eq!(err.code(), SeedKeyErrorCode::Script);
        // sleep / timestamp / exit are not registered.
        for call in ["sleep(10)", "timestamp()", "exit(1)"] {
            let src = format!("fn calculate_key(seed, level) {{ {call}; seed }}");
            let err = err_of(&src, &[1]);
            assert!(
                matches!(&err, SeedKeyError::Script(m) if m.contains("Function not found")),
                "{call}: {err}"
            );
        }
        // Unbounded recursion → call depth limit.
        let err = err_of(
            "fn calculate_key(seed, level) { calculate_key(seed, level) }",
            &[1],
        );
        assert!(
            matches!(&err, SeedKeyError::Script(m) if m.contains("Stack overflow")),
            "{err}"
        );
        // String / array / blob growth limits (hit before the 1 s deadline).
        for body in [
            r#"let s = "x"; loop { s += s; }"#,
            "let a = []; loop { a.push(1); }",
            "let b = blob(); loop { b.push(1); }",
        ] {
            let src = format!("fn calculate_key(seed, level) {{ {body} }}");
            let err = err_of(&src, &[1]);
            assert!(
                matches!(&err, SeedKeyError::Script(m) if m.contains("too large")),
                "{body}: {err}"
            );
        }
        // print/debug are swallowed (no stdout) and do not fail.
        let src = r#"fn calculate_key(seed, level) { print("hi"); debug(seed); seed }"#;
        assert_eq!(compute(&script(src, 1000), &[7], 1).unwrap(), vec![7]);
    }

    #[test]
    fn script_provider_is_shareable_across_threads() {
        let provider: std::sync::Arc<dyn KeyProvider> = std::sync::Arc::from(
            build_portable_provider(&script("fn calculate_key(seed, level) { seed }", 1000))
                .unwrap(),
        );
        let handles: Vec<_> = (0u8..4)
            .map(|i| {
                let p = provider.clone();
                std::thread::spawn(move || {
                    p.compute_key(&SeedKeyRequest {
                        seed: &[i],
                        level: 1,
                    })
                    .unwrap()
                })
            })
            .collect();
        for (i, h) in handles.into_iter().enumerate() {
            assert_eq!(h.join().unwrap(), vec![i as u8]);
        }
    }
}

#[cfg(not(feature = "script"))]
#[test]
fn script_unsupported_without_feature() {
    let spec = KeyProviderSpecDto::Script {
        source: "fn calculate_key(s, l) { s }".into(),
        timeout_ms: 100,
    };
    assert_eq!(
        build_portable_provider(&spec).err().unwrap().code(),
        SeedKeyErrorCode::Unsupported
    );
}

// ─── validate_profile ───────────────────────────────────────────────────────

fn valid_profile() -> SeedKeyProfileDto {
    SeedKeyProfileDto {
        schema_version: SEEDKEY_PROFILE_SCHEMA_VERSION,
        id: String::new(),
        name: "BMS".into(),
        ecu_label: "BMS_Master".into(),
        levels: vec![
            SecurityLevelBindingDto {
                level: 0x01,
                label: None,
                provider: builtin_spec("xor_ff", None),
            },
            SecurityLevelBindingDto {
                level: 0x03,
                label: Some("Programming".into()),
                provider: builtin_spec("add_const", Some("0x5A3C1E8F")),
            },
            SecurityLevelBindingDto {
                level: 0x05,
                label: None,
                provider: KeyProviderSpecDto::Table {
                    entries: vec![pair("0102", "0A0B")],
                },
            },
            SecurityLevelBindingDto {
                level: 0x07,
                label: None,
                provider: KeyProviderSpecDto::Library {
                    path: "/opt/sk.so".into(),
                    variant: None,
                    options: None,
                    max_key_len: 64,
                },
            },
            SecurityLevelBindingDto {
                level: 0x09,
                label: None,
                provider: KeyProviderSpecDto::Manual,
            },
        ],
        test_vectors: vec![SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "0011".into(),
            key_hex: "FFEE".into(),
        }],
        created_at_ms: 0,
        updated_at_ms: 0,
    }
}

fn expect_invalid(profile: &SeedKeyProfileDto, field: &str) {
    match validate_profile(profile) {
        Err(SeedKeyError::InvalidInput(msg)) => {
            assert!(msg.starts_with(field), "expected field {field}, got: {msg}")
        }
        other => panic!("expected InvalidInput for {field}, got {other:?}"),
    }
}

fn with_provider(provider: KeyProviderSpecDto) -> SeedKeyProfileDto {
    let mut p = valid_profile();
    p.levels[0].provider = provider;
    p.test_vectors.clear();
    p
}

#[test]
fn validate_accepts_valid_profile() {
    validate_profile(&valid_profile()).unwrap();
    let mut p = valid_profile();
    p.levels.push(SecurityLevelBindingDto {
        level: 0x7D,
        label: None,
        provider: KeyProviderSpecDto::ExternalProcess {
            program: "sk".into(),
            args: vec![],
            timeout_ms: 60_000,
        },
    });
    p.levels.push(SecurityLevelBindingDto {
        level: 0x0B,
        label: None,
        provider: KeyProviderSpecDto::Http {
            url: "http://127.0.0.1/k".into(),
            headers: vec![],
            timeout_ms: 1,
        },
    });
    validate_profile(&p).unwrap();
}

#[test]
fn validate_rejects_each_rule() {
    let mut p = valid_profile();
    p.schema_version = 2;
    expect_invalid(&p, "schemaVersion");

    let mut p = valid_profile();
    p.name = "  ".into();
    expect_invalid(&p, "name");

    let mut p = valid_profile();
    p.levels.clear();
    p.test_vectors.clear();
    expect_invalid(&p, "levels");

    for bad in [0x00, 0x02, 0x7F, 0xFF] {
        let mut p = valid_profile();
        p.levels[1].level = bad;
        expect_invalid(&p, "levels[1].level");
    }

    let mut p = valid_profile();
    p.levels[2].level = 0x01;
    expect_invalid(&p, "levels[2].level");

    let mut p = valid_profile();
    p.test_vectors[0].level = 0x0B;
    expect_invalid(&p, "testVectors[0].level");

    let mut p = valid_profile();
    p.test_vectors[0].seed_hex = "xyz".into();
    expect_invalid(&p, "testVectors[0].seedHex");

    let mut p = valid_profile();
    p.test_vectors[0].key_hex = "00".repeat(MAX_KEY_LEN + 1);
    expect_invalid(&p, "testVectors[0].keyHex");

    let mut p = valid_profile();
    p.test_vectors[0].key_hex = String::new();
    expect_invalid(&p, "testVectors[0].keyHex");

    expect_invalid(
        &with_provider(builtin_spec("xor_const", Some("zz"))),
        "levels[0].provider.constantHex",
    );
    expect_invalid(
        &with_provider(builtin_spec("xor_const", Some("123456789"))),
        "levels[0].provider.constantHex",
    );
    validate_profile(&with_provider(builtin_spec("xor_const", Some("")))).unwrap();

    expect_invalid(
        &with_provider(KeyProviderSpecDto::Table {
            entries: vec![pair("00", "0")],
        }),
        "levels[0].provider.entries[0].keyHex",
    );
    expect_invalid(
        &with_provider(KeyProviderSpecDto::Table {
            entries: vec![pair(&"AB".repeat(MAX_SEED_LEN + 1), "00")],
        }),
        "levels[0].provider.entries[0].seedHex",
    );
    expect_invalid(
        &with_provider(KeyProviderSpecDto::Table {
            entries: vec![pair("00", "00"); MAX_TABLE_ENTRIES + 1],
        }),
        "levels[0].provider.entries",
    );

    let script_spec =
        |source: String, timeout_ms| KeyProviderSpecDto::Script { source, timeout_ms };
    let ok_src = "fn calculate_key(seed, level) { seed }".to_string();
    expect_invalid(
        &with_provider(script_spec(String::new(), 100)),
        "levels[0].provider.source",
    );
    expect_invalid(
        &with_provider(script_spec("x".repeat(MAX_SCRIPT_SOURCE_LEN + 1), 100)),
        "levels[0].provider.source",
    );
    expect_invalid(
        &with_provider(script_spec(ok_src.clone(), 0)),
        "levels[0].provider.timeoutMs",
    );
    expect_invalid(
        &with_provider(script_spec(ok_src.clone(), 60_001)),
        "levels[0].provider.timeoutMs",
    );
    #[cfg(feature = "script")]
    expect_invalid(
        &with_provider(script_spec("fn nope() {}".into(), 100)),
        "levels[0].provider.source",
    );

    let lib = |path: &str, max_key_len| KeyProviderSpecDto::Library {
        path: path.into(),
        variant: None,
        options: None,
        max_key_len,
    };
    expect_invalid(&with_provider(lib(" ", 64)), "levels[0].provider.path");
    expect_invalid(
        &with_provider(lib("a.dll", 0)),
        "levels[0].provider.maxKeyLen",
    );
    expect_invalid(
        &with_provider(lib("a.dll", 257)),
        "levels[0].provider.maxKeyLen",
    );
    validate_profile(&with_provider(lib("a.dll", 256))).unwrap();

    let proc_spec = |program: &str, timeout_ms| KeyProviderSpecDto::ExternalProcess {
        program: program.into(),
        args: vec![],
        timeout_ms,
    };
    expect_invalid(
        &with_provider(proc_spec("", 100)),
        "levels[0].provider.program",
    );
    expect_invalid(
        &with_provider(proc_spec("sk", 0)),
        "levels[0].provider.timeoutMs",
    );

    let http = |url: &str, timeout_ms| KeyProviderSpecDto::Http {
        url: url.into(),
        headers: vec![],
        timeout_ms,
    };
    expect_invalid(&with_provider(http("", 100)), "levels[0].provider.url");
    expect_invalid(
        &with_provider(http("http://x", 70_000)),
        "levels[0].provider.timeoutMs",
    );
}

// ─── run_test_vectors ───────────────────────────────────────────────────────

#[test]
fn run_test_vectors_mixed_outcomes() {
    let mut p = valid_profile();
    p.id = "p1".into();
    p.test_vectors = vec![
        // pass (xor_ff), lower-case + separators normalized
        SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "00 11".into(),
            key_hex: "ff-ee".into(),
        },
        // fail: wrong expected key
        SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "0011".into(),
            key_hex: "0000".into(),
        },
        // pass: add_const (TS parity vector)
        SeedKeyTestVectorDto {
            level: 0x03,
            seed_hex: "12345678".into(),
            key_hex: "6C707507".into(),
        },
        // pass: table hit
        SeedKeyTestVectorDto {
            level: 0x05,
            seed_hex: "0102".into(),
            key_hex: "0A0B".into(),
        },
        // error: table miss
        SeedKeyTestVectorDto {
            level: 0x05,
            seed_hex: "0103".into(),
            key_hex: "0A0B".into(),
        },
        // error: native kind via portable resolver
        SeedKeyTestVectorDto {
            level: 0x07,
            seed_hex: "01".into(),
            key_hex: "01".into(),
        },
        // error: manual
        SeedKeyTestVectorDto {
            level: 0x09,
            seed_hex: "01".into(),
            key_hex: "01".into(),
        },
        // error: unbound level
        SeedKeyTestVectorDto {
            level: 0x11,
            seed_hex: "01".into(),
            key_hex: "01".into(),
        },
        // error: bad hex (does not stop the run)
        SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "0".into(),
            key_hex: "01".into(),
        },
        // pass after errors
        SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "FF".into(),
            key_hex: "00".into(),
        },
    ];
    let report = run_test_vectors(&p, build_portable_provider);
    assert_eq!(report.profile_id, "p1");
    assert_eq!(report.total, 10);
    assert_eq!(report.passed, 4);
    let o = &report.outcomes;
    assert!(o[0].passed && o[0].error.is_none());
    assert_eq!(o[0].seed_hex, "0011");
    assert_eq!(o[0].expected_key_hex, "FFEE");
    assert_eq!(o[0].actual_key_hex.as_deref(), Some("FFEE"));
    assert!(!o[1].passed && o[1].error.is_none());
    assert_eq!(o[1].actual_key_hex.as_deref(), Some("FFEE"));
    assert!(o[2].passed && o[3].passed && o[9].passed);
    let code = |i: usize| o[i].error.as_ref().map(|e| e.code);
    assert_eq!(code(4), Some(SeedKeyErrorCode::NotFound));
    assert_eq!(code(5), Some(SeedKeyErrorCode::Unsupported));
    assert_eq!(code(6), Some(SeedKeyErrorCode::ManualRequired));
    assert_eq!(code(7), Some(SeedKeyErrorCode::NotFound));
    assert_eq!(code(8), Some(SeedKeyErrorCode::InvalidInput));
    for outcome in &o[4..=8] {
        assert!(!outcome.passed && outcome.actual_key_hex.is_none());
    }
}

#[test]
fn run_test_vectors_resolves_once_per_level() {
    use std::cell::Cell;
    let calls = Cell::new(0);
    let mut p = valid_profile();
    p.test_vectors = vec![
        SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "00".into(),
            key_hex: "FF".into(),
        },
        SeedKeyTestVectorDto {
            level: 0x01,
            seed_hex: "01".into(),
            key_hex: "FE".into(),
        },
        SeedKeyTestVectorDto {
            level: 0x09,
            seed_hex: "01".into(),
            key_hex: "FE".into(),
        },
        SeedKeyTestVectorDto {
            level: 0x09,
            seed_hex: "01".into(),
            key_hex: "FE".into(),
        },
    ];
    let report = run_test_vectors(&p, |spec| {
        calls.set(calls.get() + 1);
        build_portable_provider(spec)
    });
    assert_eq!(calls.get(), 2);
    assert_eq!(report.passed, 2);
}

#[test]
fn run_test_vectors_empty() {
    let mut p = valid_profile();
    p.test_vectors.clear();
    let r = run_test_vectors(&p, build_portable_provider);
    assert_eq!((r.total, r.passed, r.outcomes.len()), (0, 0, 0));
}

// ─── serde: JSON as sent by the TS HMI ──────────────────────────────────────

const TS_PROFILE_JSON: &str = r#"{
  "schemaVersion": 1,
  "id": "",
  "name": "Demo BMS",
  "ecuLabel": "BMS",
  "levels": [
    { "level": 1, "label": "Extended", "provider": { "kind": "builtin", "algorithm": "crc16_kermit", "constantHex": null } },
    { "level": 3, "provider": { "kind": "builtin", "algorithm": "right_rotate", "constantHex": "0x11223344" } },
    { "level": 5, "label": null, "provider": { "kind": "table", "entries": [ { "seedHex": "DEADBEEF", "keyHex": "CAFEBABE" } ] } },
    { "level": 7, "provider": { "kind": "script", "source": "fn calculate_key(seed, level) { seed }", "timeoutMs": 500 } },
    { "level": 9, "provider": { "kind": "library", "path": "C:\\sk\\SeedKey.dll", "variant": "ECU1", "options": null, "maxKeyLen": 32 } },
    { "level": 11, "provider": { "kind": "external_process", "program": "/usr/bin/sk", "args": ["{seed}", "{level}"], "timeoutMs": 2000 } },
    { "level": 13, "provider": { "kind": "http", "url": "https://sk.local/key", "headers": [ { "name": "X-Token", "value": "t" } ], "timeoutMs": 3000 } },
    { "level": 15, "provider": { "kind": "manual" } }
  ],
  "testVectors": [
    { "level": 1, "seedHex": "31 32 33 34 35 36 37 38 39", "keyHex": "2189" },
    { "level": 3, "seedHex": "12345678", "keyHex": "15AF26DA" },
    { "level": 5, "seedHex": "deadbeef", "keyHex": "cafebabe" },
    { "level": 15, "seedHex": "01", "keyHex": "02" }
  ],
  "createdAtMs": 0,
  "updatedAtMs": 0
}"#;

#[test]
fn serde_roundtrip_ts_profile() {
    let profile: SeedKeyProfileDto = serde_json::from_str(TS_PROFILE_JSON).unwrap();
    assert_eq!(profile.levels.len(), 8);
    validate_profile(&profile).unwrap();

    let back = serde_json::to_value(&profile).unwrap();
    let again: SeedKeyProfileDto = serde_json::from_value(back.clone()).unwrap();
    assert_eq!(again, profile);
    assert_eq!(back["levels"][3]["provider"]["timeoutMs"], 500);
    assert_eq!(back["levels"][4]["provider"]["maxKeyLen"], 32);
    assert_eq!(
        back["testVectors"][0]["seedHex"],
        "31 32 33 34 35 36 37 38 39"
    );

    let report = run_test_vectors(&profile, build_portable_provider);
    assert_eq!(report.total, 4);
    assert_eq!(report.passed, 3, "{:#?}", report.outcomes);
    assert_eq!(
        report.outcomes[3].error.as_ref().unwrap().code,
        SeedKeyErrorCode::ManualRequired
    );
    // Report serializes camelCase for the HMI.
    let r = serde_json::to_value(&report).unwrap();
    assert!(r["outcomes"][0]["expectedKeyHex"].is_string());
    assert!(r["outcomes"][3]["actualKeyHex"].is_null());
    assert_eq!(r["outcomes"][3]["error"]["code"], "manual_required");
}

#[test]
fn serde_defaults_for_minimal_ts_json() {
    let spec: KeyProviderSpecDto =
        serde_json::from_str(r#"{"kind":"script","source":"fn calculate_key(s, l) { s }"}"#)
            .unwrap();
    assert_eq!(
        spec,
        KeyProviderSpecDto::Script {
            source: "fn calculate_key(s, l) { s }".into(),
            timeout_ms: DEFAULT_SCRIPT_TIMEOUT_MS
        }
    );
    let spec: KeyProviderSpecDto =
        serde_json::from_str(r#"{"kind":"builtin","algorithm":"xor_const"}"#).unwrap();
    assert_eq!(spec, builtin_spec("xor_const", None));
}
