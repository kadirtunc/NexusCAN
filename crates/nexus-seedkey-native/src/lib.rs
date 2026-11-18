//! Native UDS 0x27 seed/key providers for NexusCAN (contract `planning/contracts/seedkey-v1.md` §4).
//!
//! [`NativeProviderFactory::build`] turns any [`KeyProviderSpecDto`] into a [`KeyProvider`]:
//! * `builtin` / `table` / `script` / `manual` → delegated to
//!   [`nexus_protocols::uds::security::build_portable_provider`].
//! * `library` → **out-of-process**: vendor seed/key DLLs are often 32-bit Windows DLLs, may
//!   crash and run arbitrary initialisers, so they are never loaded into NexusCAN. Each key
//!   computation spawns `nexus-seedkey-host32` / `nexus-seedkey-host64` (crate
//!   `nexus-seedkey-host`), chosen from the library's PE / ELF / Mach-O header.
//! * `external_process` → program without a shell, cleared environment, timeout + kill.
//! * `http` → `Unsupported` for now. To add it, implement a provider next to
//!   `process.rs` (POST JSON with the workspace `ureq` + rustls, `timeoutMs`, response ≤ 64 KiB)
//!   and route `KeyProviderSpecDto::Http` to it in [`NativeProviderFactory::build`]; then add
//!   `"http"` to [`NATIVE_KINDS_AVAILABLE`].
//!
//! Policy (who may use native kinds) is NOT decided here; the engine checks it first.
//!
//! # Helper binaries / packaging
//! Cargo builds a single binary `nexus-seedkey-host[.exe]` for the build target. Installers
//! ship it twice, renamed:
//! * `nexus-seedkey-host64[.exe]` — host-native 64-bit build (x86_64 or aarch64);
//! * `nexus-seedkey-host32[.exe]` — 32-bit build (`--target i686-pc-windows-msvc` on Windows),
//!   required for 32-bit vendor DLLs.
//!
//! With Tauri: `bundle.externalBin = ["binaries/nexus-seedkey-host64", "binaries/nexus-seedkey-host32"]`
//! (files named `<name>-<target-triple>[.exe]` at build time; Tauri places them next to the
//! main executable). Lookup order: directory of `current_exe()`, then `$NEXUS_SEEDKEY_HOST_DIR`.
//! The unsuffixed development name `nexus-seedkey-host` is accepted for the host-native flavour.
//!
//! # Security
//! * Library paths are local-only data (they reveal the operator's machine / OEM tooling):
//!   never put them into cloud sync payloads or info-level logs.
//! * Keys are returned to the caller only; this crate never logs.

mod child;
mod library;
mod process;

use library::LibraryProvider;
use nexus_protocols::uds::security::{
    build_portable_provider, KeyProvider, KeyProviderSpecDto, SeedKeyError, SeedKeyLibraryInfoDto,
    MAX_KEY_LEN,
};
use nexus_seedkey_host::binfmt::BinArch;
use nexus_seedkey_host::protocol::HostRequest;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Environment variable naming an extra directory that contains the helper binaries.
pub const HOST_DIR_ENV: &str = "NEXUS_SEEDKEY_HOST_DIR";
/// Default wall-clock limit for one `library` key computation (helper start-up included).
/// The `library` spec has no timeout field in contract v1.
pub const DEFAULT_LIBRARY_TIMEOUT: Duration = Duration::from_millis(5_000);
/// Native kinds this crate can execute.
pub const NATIVE_KINDS_AVAILABLE: &[&str] = &["library", "external_process"];

/// Which helper binary runs a library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HostFlavor {
    Host32,
    Host64,
}

impl HostFlavor {
    /// Flavour for a CPU architecture (by pointer width).
    pub fn for_arch(arch: BinArch) -> Option<Self> {
        match arch.bits()? {
            32 => Some(Self::Host32),
            64 => Some(Self::Host64),
            _ => None,
        }
    }

    /// Flavour of the running process (its own helper build is the unsuffixed dev binary).
    pub fn native() -> Option<Self> {
        Self::for_arch(BinArch::current())
    }

    pub fn bits(self) -> u8 {
        match self {
            Self::Host32 => 32,
            Self::Host64 => 64,
        }
    }

    /// Packaged file name, e.g. `nexus-seedkey-host32.exe`.
    pub fn file_name(self) -> String {
        let stem = match self {
            Self::Host32 => "nexus-seedkey-host32",
            Self::Host64 => "nexus-seedkey-host64",
        };
        format!("{stem}{}", std::env::consts::EXE_SUFFIX)
    }

    fn candidate_names(self) -> Vec<String> {
        let mut names = vec![self.file_name()];
        if Self::native() == Some(self) {
            names.push(format!(
                "nexus-seedkey-host{}",
                std::env::consts::EXE_SUFFIX
            ));
        }
        names
    }
}

/// Factory configuration.
#[derive(Debug, Clone)]
pub struct NativeProviderConfig {
    /// Directories searched (in order) for the helper binaries.
    pub host_dirs: Vec<PathBuf>,
    /// Wall-clock limit for one `library` computation (helper killed afterwards).
    pub library_timeout: Duration,
}

impl NativeProviderConfig {
    /// Directory of `current_exe()`, then `$NEXUS_SEEDKEY_HOST_DIR`.
    pub fn from_env() -> Self {
        let mut host_dirs = Vec::new();
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
        {
            host_dirs.push(dir);
        }
        if let Some(dir) = std::env::var_os(HOST_DIR_ENV).filter(|v| !v.is_empty()) {
            host_dirs.push(PathBuf::from(dir));
        }
        Self {
            host_dirs,
            library_timeout: DEFAULT_LIBRARY_TIMEOUT,
        }
    }
}

/// Located helper binaries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostStatus {
    pub host32: Option<PathBuf>,
    pub host64: Option<PathBuf>,
}

/// Builds providers for every spec kind (portable kinds are delegated).
#[derive(Debug, Clone)]
pub struct NativeProviderFactory {
    config: NativeProviderConfig,
}

impl NativeProviderFactory {
    pub fn new(config: NativeProviderConfig) -> Self {
        Self { config }
    }

    pub fn from_env() -> Self {
        Self::new(NativeProviderConfig::from_env())
    }

    pub fn config(&self) -> &NativeProviderConfig {
        &self.config
    }

    /// First existing helper binary for `flavor` in the configured directories.
    pub fn locate_host(&self, flavor: HostFlavor) -> Option<PathBuf> {
        let names = flavor.candidate_names();
        self.config.host_dirs.iter().find_map(|dir| {
            names
                .iter()
                .map(|n| dir.join(n))
                .find(|candidate| candidate.is_file())
        })
    }

    pub fn host_status(&self) -> HostStatus {
        HostStatus {
            host32: self.locate_host(HostFlavor::Host32),
            host64: self.locate_host(HostFlavor::Host64),
        }
    }

    /// Builds a provider. Native kinds must already have passed the caller's policy check.
    pub fn build(&self, spec: &KeyProviderSpecDto) -> Result<Box<dyn KeyProvider>, SeedKeyError> {
        match spec {
            KeyProviderSpecDto::Library {
                path,
                variant,
                options,
                max_key_len,
            } => Ok(Box::new(self.build_library(
                path,
                variant.as_deref(),
                options.as_deref(),
                *max_key_len,
            )?)),
            KeyProviderSpecDto::ExternalProcess {
                program,
                args,
                timeout_ms,
            } => Ok(Box::new(process::ExternalProcessProvider::new(
                program,
                args,
                *timeout_ms,
            )?)),
            KeyProviderSpecDto::Http { .. } => Err(SeedKeyError::Unsupported(
                "'http' seed/key provider is not implemented yet".into(),
            )),
            portable => build_portable_provider(portable),
        }
    }

    fn build_library(
        &self,
        path: &str,
        variant: Option<&str>,
        options: Option<&str>,
        max_key_len: u16,
    ) -> Result<LibraryProvider, SeedKeyError> {
        if max_key_len == 0 || usize::from(max_key_len) > MAX_KEY_LEN {
            return Err(SeedKeyError::InvalidInput(format!(
                "maxKeyLen {max_key_len} outside 1..={MAX_KEY_LEN}"
            )));
        }
        let lib_path = library::validate_library_path(path)?;
        let info = library::inspect(&lib_path)?;
        let host_arch = BinArch::current();
        let (flavor, _) = library::select_host(&info, std::env::consts::OS, host_arch)?;
        let host = self.locate_host(flavor).ok_or_else(|| {
            library::missing_host_error(&info, flavor, host_arch, &self.config.host_dirs)
        })?;
        Ok(LibraryProvider {
            host,
            lib_path,
            variant: variant.map(str::to_string),
            options: options.map(str::to_string),
            max_key_len,
            timeout: self.config.library_timeout,
        })
    }

    /// `cmd_seedkey_probe_library` backend. The file header is parsed in-process (never
    /// loaded); export detection runs in the isolated helper (which does load the library).
    /// Only path validation errors are returned as `Err`; everything else goes into `note`.
    pub fn probe_library(&self, path: &str) -> Result<SeedKeyLibraryInfoDto, SeedKeyError> {
        let lib_path = library::validate_library_path(path)?;
        let info = library::inspect(&lib_path)?;
        let mut dto = SeedKeyLibraryInfoDto {
            path: lib_path.to_string_lossy().into_owned(),
            format: info.format.as_str().to_string(),
            arch: info.primary_arch().as_str().to_string(),
            loadable: false,
            has_generate_key_ex: false,
            has_generate_key_ex_opt: false,
            note: None,
        };
        let host_arch = BinArch::current();
        let flavor = match library::select_host(&info, std::env::consts::OS, host_arch) {
            Ok((flavor, arch)) => {
                dto.arch = arch.as_str().to_string();
                flavor
            }
            Err(e) => {
                dto.note = Some(e.to_string());
                return Ok(dto);
            }
        };
        let Some(host) = self.locate_host(flavor) else {
            dto.note = Some(
                library::missing_host_error(&info, flavor, host_arch, &self.config.host_dirs)
                    .to_string(),
            );
            return Ok(dto);
        };
        let request = HostRequest::Probe {
            path: dto.path.clone(),
        };
        match library::run_host(&host, &lib_path, &request, self.config.library_timeout) {
            Ok(resp) if resp.ok => {
                let probe = resp.probe.map(|p| *p).unwrap_or_else(|| empty_probe(&dto));
                dto.has_generate_key_ex = probe.has_generate_key_ex;
                dto.has_generate_key_ex_opt = probe.has_generate_key_ex_opt;
                dto.loadable = true;
                dto.note = Some(
                    match (probe.has_generate_key_ex, probe.has_generate_key_ex_opt) {
                        (false, false) => {
                            "library loads but exports neither GenerateKeyEx nor GenerateKeyExOpt"
                                .to_string()
                        }
                        _ => format!(
                            "runs in the {}-bit isolated helper{}",
                            flavor.bits(),
                            probe
                                .generate_key_ex_symbol
                                .filter(|s| s != "GenerateKeyEx")
                                .map(|s| format!(" (export '{s}')"))
                                .unwrap_or_default()
                        ),
                    },
                );
            }
            Ok(resp) => dto.note = Some(library::map_host_error(resp).to_string()),
            Err(e) => dto.note = Some(e.to_string()),
        }
        Ok(dto)
    }
}

/// A helper that says `ok` without a probe body is treated as "no exports found".
fn empty_probe(dto: &SeedKeyLibraryInfoDto) -> nexus_seedkey_host::protocol::HostProbeDto {
    nexus_seedkey_host::protocol::HostProbeDto {
        format: dto.format.clone(),
        arch: dto.arch.clone(),
        host_arch: BinArch::current().as_str().to_string(),
        has_generate_key_ex: false,
        has_generate_key_ex_opt: false,
        generate_key_ex_symbol: None,
        generate_key_ex_opt_symbol: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_protocols::uds::security::{BuiltinAlgorithm, SeedKeyErrorCode, SeedKeyRequest};
    use nexus_seedkey_host::protocol::codes;

    #[test]
    fn host_error_codes_match_contract() {
        for code in [
            codes::INVALID_INPUT,
            codes::LIBRARY_LOAD,
            codes::LIBRARY_CALL,
            codes::UNSUPPORTED,
        ] {
            let parsed: SeedKeyErrorCode =
                serde_json::from_value(serde_json::Value::String(code.into())).unwrap();
            assert_eq!(parsed.as_str(), code);
        }
    }

    #[test]
    fn portable_kinds_are_delegated_and_http_is_unsupported() {
        let factory = NativeProviderFactory::new(NativeProviderConfig {
            host_dirs: vec![],
            library_timeout: DEFAULT_LIBRARY_TIMEOUT,
        });
        let p = factory
            .build(&KeyProviderSpecDto::Builtin {
                algorithm: BuiltinAlgorithm::XorFf,
                constant_hex: None,
            })
            .unwrap();
        assert_eq!(
            p.compute_key(&SeedKeyRequest {
                seed: &[0x0F],
                level: 1
            })
            .unwrap(),
            vec![0xF0]
        );
        assert!(matches!(
            factory.build(&KeyProviderSpecDto::Manual),
            Err(SeedKeyError::ManualRequired)
        ));
        let err = factory
            .build(&KeyProviderSpecDto::Http {
                url: "https://127.0.0.1".into(),
                headers: vec![],
                timeout_ms: 100,
            })
            .err()
            .unwrap();
        assert_eq!(err.code(), SeedKeyErrorCode::Unsupported);
        assert_eq!(factory.host_status(), HostStatus::default());
    }

    #[test]
    fn flavor_names() {
        assert!(HostFlavor::Host32
            .file_name()
            .starts_with("nexus-seedkey-host32"));
        assert_eq!(HostFlavor::for_arch(BinArch::X86), Some(HostFlavor::Host32));
        assert_eq!(
            HostFlavor::for_arch(BinArch::Aarch64),
            Some(HostFlavor::Host64)
        );
        let native = HostFlavor::native().unwrap();
        assert!(native
            .candidate_names()
            .iter()
            .any(|n| n.starts_with("nexus-seedkey-host")
                && !n.contains("host6")
                && !n.contains("host3")));
    }
}
