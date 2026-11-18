//! `library` provider: Vector `GenerateKeyEx` / `GenerateKeyExOpt` executed out-of-process.
//!
//! Build time (pre-flight, never loads the file): absolute path, regular file, `.dll` /
//! `.so` / `.dylib` extension, header format + architecture → required helper flavour →
//! helper binary located. Compute time: one helper process per request, wall-clock timeout
//! (child killed), stdout capped, crashes reported as `library_call` faults.

use crate::child::{self, RunError};
use crate::{HostFlavor, HOST_DIR_ENV};
use nexus_protocols::uds::security::{
    parse_hex, KeyProvider, SeedKeyError, SeedKeyRequest, MAX_KEY_LEN,
};
use nexus_seedkey_host::binfmt::{inspect_file, BinArch, BinFormat, BinaryInfo};
use nexus_seedkey_host::protocol::{
    codes, find_response, to_hex, HostRequest, HostResponse, MAX_RESPONSE_BYTES,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// stderr kept from the helper for diagnostics.
const STDERR_CAP: usize = 8 * 1024;

/// Validates a user-supplied library path (local-only data; see `KeyProviderSpecDto::Library`).
pub(crate) fn validate_library_path(path: &str) -> Result<PathBuf, SeedKeyError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(SeedKeyError::InvalidInput(
            "library path must not be empty".into(),
        ));
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(SeedKeyError::InvalidInput(format!(
            "library path must be absolute: '{trimmed}'"
        )));
    }
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let ext_ok = [".dll", ".so", ".dylib"]
        .iter()
        .any(|ext| file_name.ends_with(ext))
        || file_name.contains(".so.");
    if !ext_ok {
        return Err(SeedKeyError::InvalidInput(format!(
            "'{file_name}' is not a shared library (.dll, .so, .dylib)"
        )));
    }
    let meta = std::fs::metadata(&p)
        .map_err(|e| SeedKeyError::LibraryLoad(format!("cannot access '{trimmed}': {e}")))?;
    if !meta.is_file() {
        return Err(SeedKeyError::LibraryLoad(format!(
            "'{trimmed}' is not a regular file"
        )));
    }
    Ok(p)
}

fn describe_lib(info: &BinaryInfo) -> String {
    match info.primary_arch().bits() {
        Some(bits) if info.archs.len() == 1 => format!(
            "{} ({bits}-bit {})",
            info.arch_label(),
            info.format.as_str()
        ),
        _ => format!("{} ({})", info.arch_label(), info.format.as_str()),
    }
}

/// Decides which helper flavour can run a library described by `info` on `host_os` /
/// `host_arch` (pure; unit-tested for every OS).
pub(crate) fn select_host(
    info: &BinaryInfo,
    host_os: &str,
    host_arch: BinArch,
) -> Result<(HostFlavor, BinArch), SeedKeyError> {
    let expected = BinFormat::native_for_os(host_os);
    if info.format != expected {
        return Err(SeedKeyError::LibraryLoad(format!(
            "{} is not a loadable shared library on {host_os} (expected {} format)",
            if info.format == BinFormat::Unknown {
                "file".to_string()
            } else {
                format!("{} library", info.format.as_str())
            },
            expected.as_str()
        )));
    }
    let candidates = [Some(host_arch), host_arch.companion_32()];
    for arch in candidates.into_iter().flatten() {
        if info.archs.contains(&arch) {
            if let Some(flavor) = HostFlavor::for_arch(arch) {
                return Ok((flavor, arch));
            }
        }
    }
    Err(SeedKeyError::BitnessMismatch {
        library: describe_lib(info),
        host: format!(
            "{} — no NexusCAN seed/key helper can run this architecture on {host_os}",
            host_arch.as_str()
        ),
    })
}

/// Error for a missing helper binary (actionable, names the file and the search dirs).
pub(crate) fn missing_host_error(
    info: &BinaryInfo,
    flavor: HostFlavor,
    host_arch: BinArch,
    dirs: &[PathBuf],
) -> SeedKeyError {
    let searched = if dirs.is_empty() {
        "<no directories>".to_string()
    } else {
        dirs.iter()
            .map(|d| d.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    SeedKeyError::BitnessMismatch {
        library: describe_lib(info),
        host: format!(
            "{}: the {}-bit seed/key helper '{}' was not found (searched: {searched}). \
             Install it next to the NexusCAN executable or set {HOST_DIR_ENV} to its directory",
            host_arch.as_str(),
            flavor.bits(),
            flavor.file_name()
        ),
    }
}

/// Inspects the header of an already validated path.
pub(crate) fn inspect(path: &Path) -> Result<BinaryInfo, SeedKeyError> {
    inspect_file(path)
        .map_err(|e| SeedKeyError::LibraryLoad(format!("cannot read '{}': {e}", path.display())))
}

/// Spawns the helper with one request and returns its parsed response.
pub(crate) fn run_host(
    host: &Path,
    lib_path: &Path,
    request: &HostRequest,
    timeout: Duration,
) -> Result<HostResponse, SeedKeyError> {
    let mut line = serde_json::to_vec(request)
        .map_err(|e| SeedKeyError::InvalidInput(format!("cannot encode helper request: {e}")))?;
    line.push(b'\n');

    let mut cmd = Command::new(host);
    child::harden(&mut cmd, child::PASSTHROUGH_ENV);
    // Vendor DLLs sometimes open config files relative to the working directory.
    if let Some(dir) = lib_path.parent() {
        cmd.current_dir(dir);
    }
    let out =
        child::run(cmd, line, timeout, MAX_RESPONSE_BYTES, STDERR_CAP).map_err(|e| match e {
            RunError::Timeout => SeedKeyError::Timeout {
                ms: u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX),
            },
            RunError::Spawn(e) => SeedKeyError::LibraryLoad(format!(
                "cannot start seed/key helper '{}': {e}",
                host.display()
            )),
            RunError::Wait(e) => {
                SeedKeyError::LibraryFault(format!("lost the seed/key helper process: {e}"))
            }
            RunError::StdoutOverflow => SeedKeyError::LibraryFault(format!(
                "seed/key helper wrote more than {MAX_RESPONSE_BYTES} bytes to stdout"
            )),
        })?;

    // A parseable response wins even if the library crashed later during process teardown.
    if let Some(resp) = find_response(&out.stdout) {
        return Ok(resp);
    }
    let stderr = child::snippet(&out.stderr, 300);
    let detail = if stderr.is_empty() {
        String::new()
    } else {
        format!("; stderr: {stderr}")
    };
    if out.status.success() {
        Err(SeedKeyError::LibraryFault(format!(
            "seed/key helper exited without a response{detail}"
        )))
    } else {
        Err(SeedKeyError::LibraryFault(format!(
            "the seed/key library crashed its isolated helper process ({}); NexusCAN is unaffected{detail}",
            child::describe_status(&out.status)
        )))
    }
}

/// Maps a helper error response onto the IPC error contract.
pub(crate) fn map_host_error(resp: HostResponse) -> SeedKeyError {
    let msg = resp
        .message
        .unwrap_or_else(|| "unknown helper error".into());
    match resp.code.as_deref() {
        Some(codes::LIBRARY_CALL) => match resp.library_code {
            Some(code) => SeedKeyError::LibraryCall { code },
            None => SeedKeyError::LibraryFault(msg),
        },
        Some(codes::LIBRARY_LOAD) => SeedKeyError::LibraryLoad(msg),
        Some(codes::INVALID_INPUT) => SeedKeyError::InvalidInput(msg),
        Some(codes::UNSUPPORTED) => SeedKeyError::Unsupported(msg),
        other => SeedKeyError::LibraryFault(format!(
            "seed/key helper error {}: {msg}",
            other.unwrap_or("<none>")
        )),
    }
}

/// Configured, pre-flighted `library` provider.
pub(crate) struct LibraryProvider {
    pub host: PathBuf,
    pub lib_path: PathBuf,
    pub variant: Option<String>,
    pub options: Option<String>,
    pub max_key_len: u16,
    pub timeout: Duration,
}

impl KeyProvider for LibraryProvider {
    fn kind(&self) -> &'static str {
        "library"
    }

    fn compute_key(&self, req: &SeedKeyRequest<'_>) -> Result<Vec<u8>, SeedKeyError> {
        if req.seed.is_empty() || req.seed.len() > nexus_protocols::uds::security::MAX_SEED_LEN {
            return Err(SeedKeyError::InvalidInput(format!(
                "seed must be 1..={} bytes, got {}",
                nexus_protocols::uds::security::MAX_SEED_LEN,
                req.seed.len()
            )));
        }
        let request = HostRequest::Compute {
            path: self.lib_path.to_string_lossy().into_owned(),
            variant: self.variant.clone(),
            options: self.options.clone(),
            level: u32::from(req.level),
            seed_hex: to_hex(req.seed),
            max_key_len: u32::from(self.max_key_len),
        };
        let resp = run_host(&self.host, &self.lib_path, &request, self.timeout)?;
        if !resp.ok {
            return Err(map_host_error(resp));
        }
        let key_hex = resp.key_hex.ok_or_else(|| {
            SeedKeyError::LibraryFault("seed/key helper answered ok without a key".into())
        })?;
        let key = parse_hex(&key_hex).map_err(|_| {
            SeedKeyError::LibraryFault("seed/key helper returned malformed key hex".into())
        })?;
        if key.is_empty() || key.len() > usize::from(self.max_key_len) || key.len() > MAX_KEY_LEN {
            return Err(SeedKeyError::LibraryFault(format!(
                "library returned {} key bytes (allowed 1..={})",
                key.len(),
                self.max_key_len
            )));
        }
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_seedkey_host::binfmt::fake_pe_header;
    use nexus_seedkey_host::binfmt::inspect_bytes;

    fn pe(machine: u16) -> BinaryInfo {
        inspect_bytes(&fake_pe_header(machine, true))
    }

    #[test]
    fn host_selection_matrix() {
        // 32-bit vendor DLL on 64-bit Windows -> 32-bit helper.
        let (flavor, arch) = select_host(&pe(0x014C), "windows", BinArch::X86_64).unwrap();
        assert_eq!((flavor, arch), (HostFlavor::Host32, BinArch::X86));
        // Native 64-bit DLL -> 64-bit helper.
        let (flavor, _) = select_host(&pe(0x8664), "windows", BinArch::X86_64).unwrap();
        assert_eq!(flavor, HostFlavor::Host64);
        // ARM64 DLL on x64 Windows: no helper can run it.
        let err = select_host(&pe(0xAA64), "windows", BinArch::X86_64).unwrap_err();
        assert!(matches!(err, SeedKeyError::BitnessMismatch { .. }), "{err}");
        assert!(err.to_string().contains("aarch64 (64-bit pe)"), "{err}");
        // 64-bit DLL on a 32-bit Windows host.
        let err = select_host(&pe(0x8664), "windows", BinArch::X86).unwrap_err();
        assert!(matches!(err, SeedKeyError::BitnessMismatch { .. }));
        // PE on Linux / unknown files: format error, not bitness.
        let err = select_host(&pe(0x8664), "linux", BinArch::X86_64).unwrap_err();
        assert!(matches!(err, SeedKeyError::LibraryLoad(_)), "{err}");
        let err = select_host(&inspect_bytes(b"text"), "linux", BinArch::X86_64).unwrap_err();
        assert!(matches!(err, SeedKeyError::LibraryLoad(_)), "{err}");
    }

    #[test]
    fn missing_host_message_is_actionable() {
        let err = missing_host_error(
            &pe(0x014C),
            HostFlavor::Host32,
            BinArch::X86_64,
            &[PathBuf::from("/opt/nexuscan")],
        );
        let wire = err.to_ipc_string();
        assert!(wire.starts_with("[seedkey:bitness_mismatch] "), "{wire}");
        assert!(wire.contains("x86 (32-bit pe)"), "{wire}");
        assert!(wire.contains("nexus-seedkey-host32"), "{wire}");
        assert!(wire.contains(HOST_DIR_ENV), "{wire}");
        assert!(wire.contains("/opt/nexuscan"), "{wire}");
    }

    #[test]
    fn path_validation() {
        assert!(matches!(
            validate_library_path(""),
            Err(SeedKeyError::InvalidInput(_))
        ));
        assert!(matches!(
            validate_library_path("relative/keygen.dll"),
            Err(SeedKeyError::InvalidInput(_))
        ));
        let missing = std::env::temp_dir().join("nexus-seedkey-definitely-missing.dll");
        assert!(matches!(
            validate_library_path(&missing.to_string_lossy()),
            Err(SeedKeyError::LibraryLoad(_))
        ));
        let exe = std::env::current_exe().unwrap();
        let err = validate_library_path(&exe.to_string_lossy());
        // Test executables have no shared-library extension (on Windows: .exe).
        assert!(matches!(err, Err(SeedKeyError::InvalidInput(_))), "{err:?}");
    }

    #[test]
    fn host_error_mapping() {
        let e = map_host_error(HostResponse::library_call(3, "x"));
        assert_eq!(e, SeedKeyError::LibraryCall { code: 3 });
        assert_eq!(
            e.to_ipc_string(),
            "[seedkey:library_call] library GenerateKeyEx returned error code 3"
        );
        let e = map_host_error(HostResponse::error(codes::LIBRARY_CALL, "empty key"));
        assert_eq!(e, SeedKeyError::LibraryFault("empty key".into()));
        assert_eq!(e.to_dto().code.as_str(), "library_call");
        let e = map_host_error(HostResponse::error(codes::LIBRARY_LOAD, "nope"));
        assert_eq!(e, SeedKeyError::LibraryLoad("nope".into()));
        let e = map_host_error(HostResponse::error("weird", "w"));
        assert!(matches!(e, SeedKeyError::LibraryFault(_)));
    }
}
