//! End-to-end: `NativeProviderFactory` → `nexus-seedkey-host` process → fixture cdylib
//! (`crates/nexus-seedkey-fixture`, key = seed ^ 0xA5, plus error / crash / hang levels).
//!
//! The helper and fixture are built on demand with a nested `cargo build` into the same target
//! directory as this test (a no-op when `cargo test --workspace` already built them).
//!
//! Opt-in 32-bit run (Linux with i686 multilib): `NEXUS_SEEDKEY_TEST_I686=1 cargo test -p
//! nexus-seedkey-native --test end_to_end i686` — builds the i686 helper + a cdecl and a
//! stdcall fixture and computes keys through `nexus-seedkey-host32`.

use nexus_protocols::uds::security::{
    KeyProviderSpecDto, SeedKeyError, SeedKeyErrorCode, SeedKeyRequest,
};
use nexus_seedkey_native::{HostFlavor, NativeProviderConfig, NativeProviderFactory, HOST_DIR_ENV};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const SEED: [u8; 4] = [0x11, 0x22, 0x33, 0x44];
const KEY_XOR_A5: [u8; 4] = [0xB4, 0x87, 0x96, 0xE1];

struct Artifacts {
    /// `target/<profile>` (contains `nexus-seedkey-host`).
    profile_dir: PathBuf,
    fixture: PathBuf,
}

fn workspace_manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml")
}

fn profile_dir() -> PathBuf {
    // <target>/<profile>/deps/<test-exe>
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent()
        .and_then(Path::parent)
        .expect("target/<profile> dir")
        .to_path_buf()
}

fn cargo_build(extra: &[&str], target_dir: &Path) {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut cmd = Command::new(cargo);
    cmd.arg("build")
        .arg("--manifest-path")
        .arg(workspace_manifest())
        .arg("--target-dir")
        .arg(target_dir)
        .args(extra);
    let status = cmd.status().expect("spawn cargo");
    assert!(status.success(), "nested cargo build {extra:?} failed");
}

fn fixture_file_name() -> String {
    format!(
        "{}nexus_seedkey_fixture{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    )
}

fn artifacts() -> &'static Artifacts {
    static ART: OnceLock<Artifacts> = OnceLock::new();
    ART.get_or_init(|| {
        let profile_dir = profile_dir();
        let profile = profile_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("debug")
            .to_string();
        let target_dir = profile_dir.parent().expect("target dir").to_path_buf();
        let mut args = vec!["-p", "nexus-seedkey-host", "-p", "nexus-seedkey-fixture"];
        if profile == "release" {
            args.push("--release");
        }
        cargo_build(&args, &target_dir);
        let fixture = profile_dir.join(fixture_file_name());
        assert!(fixture.is_file(), "fixture missing: {}", fixture.display());
        Artifacts {
            profile_dir,
            fixture,
        }
    })
}

fn factory_with(dirs: Vec<PathBuf>, timeout: Duration) -> NativeProviderFactory {
    NativeProviderFactory::new(NativeProviderConfig {
        host_dirs: dirs,
        library_timeout: timeout,
    })
}

fn factory() -> NativeProviderFactory {
    factory_with(
        vec![artifacts().profile_dir.clone()],
        Duration::from_secs(10),
    )
}

fn lib_spec(path: &Path, variant: Option<&str>, options: Option<&str>) -> KeyProviderSpecDto {
    KeyProviderSpecDto::Library {
        path: path.to_string_lossy().into_owned(),
        variant: variant.map(str::to_string),
        options: options.map(str::to_string),
        max_key_len: 64,
    }
}

fn compute(
    f: &NativeProviderFactory,
    spec: &KeyProviderSpecDto,
    level: u8,
) -> Result<Vec<u8>, SeedKeyError> {
    f.build(spec)?
        .compute_key(&SeedKeyRequest { seed: &SEED, level })
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexus-seedkey-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn generate_key_ex_ok_path() {
    let f = factory();
    let spec = lib_spec(&artifacts().fixture, None, None);
    assert_eq!(compute(&f, &spec, 0x01).unwrap(), KEY_XOR_A5);
    // Library printing to stdout before our response line.
    assert_eq!(compute(&f, &spec, 0x0D).unwrap(), KEY_XOR_A5);
    assert!(f.host_status().host64.is_some() || f.host_status().host32.is_some());
}

#[test]
fn generate_key_ex_opt_path_and_variant() {
    let f = factory();
    let spec = lib_spec(&artifacts().fixture, Some("ECU_A"), Some("pw"));
    // key = seed ^ 0xA5 ^ "pw"[i % 2]
    assert_eq!(compute(&f, &spec, 0x01).unwrap(), [0xC4, 0xF0, 0xE6, 0x96]);
    // Variant is passed through: the fixture rejects "BAD" with KGRE_VariantInvalid (3).
    let bad = lib_spec(&artifacts().fixture, Some("BAD"), None);
    assert_eq!(
        compute(&f, &bad, 0x01).unwrap_err(),
        SeedKeyError::LibraryCall { code: 3 }
    );
}

#[test]
fn library_error_code_is_mapped() {
    let f = factory();
    let err = compute(&f, &lib_spec(&artifacts().fixture, None, None), 0x03).unwrap_err();
    assert_eq!(err, SeedKeyError::LibraryCall { code: 3 });
    assert_eq!(
        err.to_ipc_string(),
        "[seedkey:library_call] library GenerateKeyEx returned error code 3"
    );
    // Key longer than maxKeyLen reported by the library.
    let err = compute(&f, &lib_spec(&artifacts().fixture, None, None), 0x0B).unwrap_err();
    assert!(
        matches!(&err, SeedKeyError::LibraryFault(m) if m.contains("maxKeyLen")),
        "{err}"
    );
    assert_eq!(err.code(), SeedKeyErrorCode::LibraryCall);
    // Buffer too small (maxKeyLen 2 < seed 4) -> KGRE_BufferToSmall.
    let small = KeyProviderSpecDto::Library {
        path: artifacts().fixture.to_string_lossy().into_owned(),
        variant: None,
        options: None,
        max_key_len: 2,
    };
    assert_eq!(
        compute(&f, &small, 0x01).unwrap_err(),
        SeedKeyError::LibraryCall { code: 1 }
    );
}

#[test]
fn crashing_library_only_kills_the_helper() {
    let f = factory();
    let spec = lib_spec(&artifacts().fixture, None, None);
    for level in [0x05u8, 0x09] {
        let err = compute(&f, &spec, level).unwrap_err();
        assert_eq!(err.code(), SeedKeyErrorCode::LibraryCall, "{err}");
        let msg = err.to_string();
        assert!(msg.contains("crashed"), "{msg}");
        assert!(msg.contains("NexusCAN is unaffected"), "{msg}");
        #[cfg(unix)]
        assert!(
            msg.contains("SIGSEGV") || msg.contains("SIGABRT") || msg.contains("SIGBUS"),
            "{msg}"
        );
    }
    // The test process (= the app) survived and the next call works.
    assert_eq!(compute(&f, &spec, 0x01).unwrap(), KEY_XOR_A5);
}

#[test]
fn hanging_library_is_killed_on_timeout() {
    let f = factory_with(
        vec![artifacts().profile_dir.clone()],
        Duration::from_millis(700),
    );
    let spec = lib_spec(&artifacts().fixture, None, None);
    let started = Instant::now();
    let err = compute(&f, &spec, 0x07).unwrap_err();
    let elapsed = started.elapsed();
    assert_eq!(err, SeedKeyError::Timeout { ms: 700 });
    assert!(
        elapsed < Duration::from_secs(5),
        "helper not killed in time: {elapsed:?}"
    );
}

#[test]
fn missing_helper_binary_is_bitness_mismatch() {
    let empty = temp_dir("nohost");
    let f = factory_with(vec![empty.clone()], Duration::from_secs(5));
    let err = f
        .build(&lib_spec(&artifacts().fixture, None, None))
        .err()
        .expect("must fail without helper");
    assert_eq!(err.code(), SeedKeyErrorCode::BitnessMismatch);
    let msg = err.to_string();
    let flavor = HostFlavor::native().unwrap();
    assert!(msg.contains(&flavor.file_name()), "{msg}");
    assert!(msg.contains(HOST_DIR_ENV), "{msg}");
    let _ = std::fs::remove_dir_all(&empty);
}

#[test]
fn bitness_preflight_on_fake_32bit_libraries() {
    let dir = temp_dir("fake32");
    let f = factory();

    // Fake 32-bit (i386) Windows DLL header.
    let pe = dir.join("vendor_keygen32.dll");
    std::fs::write(
        &pe,
        nexus_seedkey_host::binfmt::fake_pe_header(0x014C, true),
    )
    .unwrap();
    let err = f.build(&lib_spec(&pe, None, None)).err().unwrap();
    if cfg!(all(windows, target_arch = "x86_64")) {
        // 32-bit DLL on x64 Windows needs nexus-seedkey-host32, which is not built here.
        assert_eq!(err.code(), SeedKeyErrorCode::BitnessMismatch, "{err}");
        assert!(err.to_string().contains("x86 (32-bit pe)"), "{err}");
        assert!(err.to_string().contains("nexus-seedkey-host32"), "{err}");
    } else if !cfg!(windows) {
        // A PE file is never loadable on Linux / macOS.
        assert_eq!(err.code(), SeedKeyErrorCode::LibraryLoad, "{err}");
    }

    // Fake 32-bit ELF (i386) shared object: on x86_64 Linux it needs the 32-bit helper.
    let mut elf = vec![0u8; 64];
    elf[0..4].copy_from_slice(b"\x7FELF");
    elf[4] = 1;
    elf[5] = 1;
    elf[16..18].copy_from_slice(&3u16.to_le_bytes());
    elf[18..20].copy_from_slice(&3u16.to_le_bytes());
    let so = dir.join("libvendor_keygen32.so");
    std::fs::write(&so, &elf).unwrap();
    let err = f.build(&lib_spec(&so, None, None)).err().unwrap();
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        assert_eq!(err.code(), SeedKeyErrorCode::BitnessMismatch, "{err}");
        let wire = err.to_ipc_string();
        assert!(wire.starts_with("[seedkey:bitness_mismatch] "), "{wire}");
        assert!(wire.contains("x86 (32-bit elf)"), "{wire}");
        assert!(wire.contains("nexus-seedkey-host32"), "{wire}");
    }

    // Probe never fails on architecture problems; it explains them in `note`.
    let info = f.probe_library(&so.to_string_lossy()).unwrap();
    assert!(!info.loadable);
    assert!(info.note.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn path_preflight_rejects_bad_paths() {
    let f = factory();
    let err = f
        .build(&lib_spec(Path::new("keygen.dll"), None, None))
        .err()
        .unwrap();
    assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
    let dir = temp_dir("badpath");
    let txt = dir.join("keygen.txt");
    std::fs::write(&txt, b"x").unwrap();
    let err = f.build(&lib_spec(&txt, None, None)).err().unwrap();
    assert_eq!(err.code(), SeedKeyErrorCode::InvalidInput);
    let err = f
        .build(&lib_spec(&dir.join("missing.so"), None, None))
        .err()
        .unwrap();
    assert_eq!(err.code(), SeedKeyErrorCode::LibraryLoad);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn probe_reports_exports() {
    let info = factory()
        .probe_library(&artifacts().fixture.to_string_lossy())
        .unwrap();
    assert!(info.loadable, "{info:?}");
    assert!(info.has_generate_key_ex);
    assert!(info.has_generate_key_ex_opt);
    assert_eq!(info.arch, std::env::consts::ARCH);
}

/// Opt-in: 32-bit helper + 32-bit cdecl and stdcall fixtures (Linux x86_64 with multilib).
#[test]
fn i686_helper_runs_cdecl_and_stdcall_libraries() {
    if std::env::var("NEXUS_SEEDKEY_TEST_I686").as_deref() != Ok("1")
        || !cfg!(all(target_os = "linux", target_arch = "x86_64"))
    {
        eprintln!("skipped (set NEXUS_SEEDKEY_TEST_I686=1 on x86_64 Linux with i686 multilib)");
        return;
    }
    let target_dir = artifacts().profile_dir.parent().unwrap().to_path_buf();
    let triple = "i686-unknown-linux-gnu";
    let out = target_dir.join(triple).join("debug");
    let work = temp_dir("i686");

    cargo_build(
        &[
            "--target",
            triple,
            "-p",
            "nexus-seedkey-host",
            "-p",
            "nexus-seedkey-fixture",
        ],
        &target_dir,
    );
    std::fs::copy(
        out.join("nexus-seedkey-host"),
        work.join(HostFlavor::Host32.file_name()),
    )
    .unwrap();
    let cdecl = work.join("libkeygen32_cdecl.so");
    std::fs::copy(out.join(fixture_file_name()), &cdecl).unwrap();
    cargo_build(
        &[
            "--target",
            triple,
            "-p",
            "nexus-seedkey-fixture",
            "--features",
            "stdcall",
        ],
        &target_dir,
    );
    let stdcall = work.join("libkeygen32_stdcall.so");
    std::fs::copy(out.join(fixture_file_name()), &stdcall).unwrap();

    let f = factory_with(vec![work.clone()], Duration::from_secs(10));
    assert!(f.host_status().host32.is_some());
    for lib in [&cdecl, &stdcall] {
        assert_eq!(
            compute(&f, &lib_spec(lib, None, None), 0x01).unwrap(),
            KEY_XOR_A5,
            "{}",
            lib.display()
        );
        assert_eq!(
            compute(&f, &lib_spec(lib, None, Some("pw")), 0x01).unwrap(),
            [0xC4, 0xF0, 0xE6, 0x96]
        );
        assert_eq!(
            compute(&f, &lib_spec(lib, None, None), 0x03).unwrap_err(),
            SeedKeyError::LibraryCall { code: 3 }
        );
        let info = f.probe_library(&lib.to_string_lossy()).unwrap();
        assert_eq!(info.arch, "x86");
        assert!(info.loadable && info.has_generate_key_ex, "{info:?}");
    }
    let _ = std::fs::remove_dir_all(&work);
}
