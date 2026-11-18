//! Library loading and the `GenerateKeyEx` / `GenerateKeyExOpt` calls.
//!
//! Vector interface (Application Note AN-IDG-1-017 "Security Access", v1.1):
//! ```c
//! VKeyGenResultEx GenerateKeyEx(const unsigned char* ipSeedArray, unsigned int iSeedArraySize,
//!     const unsigned int iSecurityLevel, const char* ipVariant, unsigned char* iopKeyArray,
//!     unsigned int iMaxKeyArraySize, unsigned int& oActualKeyArraySize);
//! VKeyGenResultExOpt GenerateKeyExOpt(..., const char* ipVariant, const char* ipOptions,
//!     unsigned char* iopKeyArray, unsigned int iMaxKeyArraySize, unsigned int& oActualKeyArraySize);
//! ```
//! `VKeyGenResultEx`: 0 Ok, 1 BufferToSmall, 2 SecurityLevelInvalid, 3 VariantInvalid,
//! 4 UnspecifiedError. `unsigned int&` is passed as a pointer.
//!
//! Calling convention: Vector's sample (`KeyGenAlgoInterfaceEx.h`) exports with
//! `extern "C" __declspec(dllexport)` and no `WINAPI`, i.e. `__cdecl` with the undecorated
//! export name. Some OEM DLLs use `__stdcall` instead (decorated `_GenerateKeyEx@28` /
//! `_GenerateKeyExOpt@32`, or undecorated via a `.def` file, which is indistinguishable by
//! name). On 32-bit x86 the call therefore goes through a trampoline that restores `esp`
//! from a callee-saved register after the call, which is correct for both conventions (the
//! only difference is who pops the arguments). On every 64-bit target there is a single C ABI.

use nexus_seedkey_host::binfmt::{inspect_file, BinArch};
use nexus_seedkey_host::protocol::{
    codes, from_hex, to_hex, HostProbeDto, HostRequest, HostResponse, MAX_BUFFER_LEN,
    MAX_STRING_ARG_LEN,
};
use std::ffi::{c_char, c_int, c_uint, CString};
use std::path::Path;

use libloading::Library;

type GenerateKeyExFn = unsafe extern "C" fn(
    *const u8,
    c_uint,
    c_uint,
    *const c_char,
    *mut u8,
    c_uint,
    *mut c_uint,
) -> c_int;

type GenerateKeyExOptFn = unsafe extern "C" fn(
    *const u8,
    c_uint,
    c_uint,
    *const c_char,
    *const c_char,
    *mut u8,
    c_uint,
    *mut c_uint,
) -> c_int;

/// Export names tried in order (undecorated cdecl first, then stdcall decorations).
#[cfg(target_arch = "x86")]
const KEY_EX_NAMES: &[&str] = &["GenerateKeyEx", "_GenerateKeyEx@28", "GenerateKeyEx@28"];
#[cfg(not(target_arch = "x86"))]
const KEY_EX_NAMES: &[&str] = &["GenerateKeyEx"];
#[cfg(target_arch = "x86")]
const KEY_EX_OPT_NAMES: &[&str] = &[
    "GenerateKeyExOpt",
    "_GenerateKeyExOpt@32",
    "GenerateKeyExOpt@32",
];
#[cfg(not(target_arch = "x86"))]
const KEY_EX_OPT_NAMES: &[&str] = &["GenerateKeyExOpt"];

pub fn handle(req: &HostRequest) -> HostResponse {
    match req {
        HostRequest::Compute {
            path,
            variant,
            options,
            level,
            seed_hex,
            max_key_len,
        } => compute(
            path,
            variant.as_deref(),
            options.as_deref(),
            *level,
            seed_hex,
            *max_key_len,
        )
        .unwrap_or_else(|e| e),
        HostRequest::Probe { path } => probe(path).unwrap_or_else(|e| e),
    }
}

fn invalid(msg: impl Into<String>) -> HostResponse {
    HostResponse::error(codes::INVALID_INPUT, msg)
}

fn c_string(value: Option<&str>, field: &str) -> Result<CString, HostResponse> {
    let value = value.unwrap_or("");
    if value.len() > MAX_STRING_ARG_LEN {
        return Err(invalid(format!(
            "{field} exceeds {MAX_STRING_ARG_LEN} bytes"
        )));
    }
    CString::new(value).map_err(|_| invalid(format!("{field} contains a NUL byte")))
}

/// Loads the library. On Windows, `LOAD_WITH_ALTERED_SEARCH_PATH` makes dependent DLLs that
/// sit next to the seed/key DLL resolvable (the path is absolute, checked by the parent).
fn load(path: &str) -> Result<Library, HostResponse> {
    if path.trim().is_empty() {
        return Err(invalid("library path is empty"));
    }
    #[cfg(windows)]
    // SAFETY: loading a user-selected library runs its initialisers; that is the purpose of
    // this isolated helper process. Any crash only terminates the helper.
    let loaded = unsafe {
        libloading::os::windows::Library::load_with_flags(
            path,
            libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH,
        )
    }
    .map(Library::from);
    #[cfg(not(windows))]
    // SAFETY: see above — isolated helper process.
    let loaded = unsafe { Library::new(path) };

    loaded.map_err(|e| {
        let hint = match inspect_file(Path::new(path)) {
            Ok(info) if !info.archs.contains(&BinArch::current()) => format!(
                " (library is {} {}, this helper is {})",
                info.format.as_str(),
                info.arch_label(),
                BinArch::current().as_str()
            ),
            _ => String::new(),
        };
        HostResponse::error(
            codes::LIBRARY_LOAD,
            format!("cannot load library: {e}{hint}"),
        )
    })
}

/// Resolves the first export of `names` that exists.
fn resolve<F: Copy>(lib: &Library, names: &[&'static str]) -> Option<(F, &'static str)> {
    names.iter().find_map(|name| {
        // SAFETY: `F` is the documented Vector signature for this export name; the symbol is
        // only used while `lib` is alive (it is never unloaded, see `compute`).
        unsafe { lib.get::<F>(name.as_bytes()) }
            .ok()
            .map(|sym| (*sym, *name))
    })
}

fn result_name(code: c_int) -> &'static str {
    match code {
        1 => "BufferToSmall",
        2 => "SecurityLevelInvalid",
        3 => "VariantInvalid",
        4 => "UnspecifiedError",
        _ => "vendor-specific",
    }
}

fn compute(
    path: &str,
    variant: Option<&str>,
    options: Option<&str>,
    level: u32,
    seed_hex: &str,
    max_key_len: u32,
) -> Result<HostResponse, HostResponse> {
    let seed = from_hex(seed_hex).ok_or_else(|| invalid("seedHex is not valid hex"))?;
    if seed.is_empty() || seed.len() > MAX_BUFFER_LEN {
        return Err(invalid(format!(
            "seed must be 1..={MAX_BUFFER_LEN} bytes, got {}",
            seed.len()
        )));
    }
    let max = usize::try_from(max_key_len).unwrap_or(usize::MAX);
    if max == 0 || max > MAX_BUFFER_LEN {
        return Err(invalid(format!(
            "maxKeyLen {max_key_len} outside 1..={MAX_BUFFER_LEN}"
        )));
    }
    let variant = c_string(variant, "variant")?;
    let options = options.map(|o| c_string(Some(o), "options")).transpose()?;

    let lib = load(path)?;
    let mut key = vec![0u8; max];
    let mut actual: c_uint = 0;
    // Lengths are bounded by MAX_BUFFER_LEN above, so the casts are lossless.
    let seed_len = seed.len() as c_uint;
    let key_cap = max as c_uint;

    let (rc, symbol) = match &options {
        Some(opts) => {
            let (f, symbol) =
                resolve::<GenerateKeyExOptFn>(&lib, KEY_EX_OPT_NAMES).ok_or_else(|| {
                    HostResponse::error(
                        codes::LIBRARY_LOAD,
                        format!(
                            "library does not export GenerateKeyExOpt (tried {}); \
                             clear 'options' to use GenerateKeyEx",
                            KEY_EX_OPT_NAMES.join(", ")
                        ),
                    )
                })?;
            // SAFETY: buffers are valid for the declared lengths; strings are NUL-terminated.
            let rc = unsafe {
                call::generate_key_ex_opt(
                    f,
                    &seed,
                    level,
                    &variant,
                    opts,
                    &mut key,
                    seed_len,
                    key_cap,
                    &mut actual,
                )
            };
            (rc, symbol)
        }
        None => {
            let (f, symbol) = resolve::<GenerateKeyExFn>(&lib, KEY_EX_NAMES).ok_or_else(|| {
                HostResponse::error(
                    codes::LIBRARY_LOAD,
                    format!(
                        "library does not export GenerateKeyEx (tried {})",
                        KEY_EX_NAMES.join(", ")
                    ),
                )
            })?;
            // SAFETY: as above.
            let rc = unsafe {
                call::generate_key_ex(
                    f,
                    &seed,
                    level,
                    &variant,
                    &mut key,
                    seed_len,
                    key_cap,
                    &mut actual,
                )
            };
            (rc, symbol)
        }
    };
    // Never unload: some vendor DLLs crash in DLL_PROCESS_DETACH / static destructors after
    // FreeLibrary. The process exits right after the response is written.
    std::mem::forget(lib);

    if rc != 0 {
        return Err(HostResponse::library_call(
            i64::from(rc),
            format!("{symbol} returned {rc} ({})", result_name(rc)),
        ));
    }
    let actual = usize::try_from(actual).unwrap_or(usize::MAX);
    if actual == 0 {
        return Err(HostResponse::error(
            codes::LIBRARY_CALL,
            format!("{symbol} returned OK but an empty key"),
        ));
    }
    if actual > max {
        return Err(HostResponse::error(
            codes::LIBRARY_CALL,
            format!("{symbol} reported {actual} key bytes but maxKeyLen is {max}"),
        ));
    }
    Ok(HostResponse::key(to_hex(&key[..actual])))
}

fn probe(path: &str) -> Result<HostResponse, HostResponse> {
    let info = inspect_file(Path::new(path))
        .map_err(|e| HostResponse::error(codes::LIBRARY_LOAD, format!("cannot read file: {e}")))?;
    let lib = load(path)?;
    let ex = resolve::<GenerateKeyExFn>(&lib, KEY_EX_NAMES).map(|(_, n)| n.to_string());
    let opt = resolve::<GenerateKeyExOptFn>(&lib, KEY_EX_OPT_NAMES).map(|(_, n)| n.to_string());
    std::mem::forget(lib);
    Ok(HostResponse::probe(HostProbeDto {
        format: info.format.as_str().to_string(),
        arch: info.arch_label(),
        host_arch: BinArch::current().as_str().to_string(),
        has_generate_key_ex: ex.is_some(),
        has_generate_key_ex_opt: opt.is_some(),
        generate_key_ex_symbol: ex,
        generate_key_ex_opt_symbol: opt,
    }))
}

/// The actual foreign calls.
mod call {
    use super::{GenerateKeyExFn, GenerateKeyExOptFn};
    use std::ffi::{c_int, c_uint, CStr};

    /// # Safety
    /// `f` must point to a function with the `GenerateKeyEx` signature; `key.len() >= key_cap`.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn generate_key_ex(
        f: GenerateKeyExFn,
        seed: &[u8],
        level: u32,
        variant: &CStr,
        key: &mut [u8],
        seed_len: c_uint,
        key_cap: c_uint,
        actual: &mut c_uint,
    ) -> c_int {
        #[cfg(target_arch = "x86")]
        {
            let args = [
                seed.as_ptr() as u32,
                seed_len,
                level,
                variant.as_ptr() as u32,
                key.as_mut_ptr() as u32,
                key_cap,
                actual as *mut c_uint as u32,
            ];
            // SAFETY: forwarded from the caller; 7 x 4-byte arguments as declared.
            unsafe { x86::call_any_convention(f as usize, &args) as c_int }
        }
        #[cfg(not(target_arch = "x86"))]
        {
            // SAFETY: forwarded from the caller.
            unsafe {
                f(
                    seed.as_ptr(),
                    seed_len,
                    level,
                    variant.as_ptr(),
                    key.as_mut_ptr(),
                    key_cap,
                    actual,
                )
            }
        }
    }

    /// # Safety
    /// `f` must point to a function with the `GenerateKeyExOpt` signature; `key.len() >= key_cap`.
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn generate_key_ex_opt(
        f: GenerateKeyExOptFn,
        seed: &[u8],
        level: u32,
        variant: &CStr,
        options: &CStr,
        key: &mut [u8],
        seed_len: c_uint,
        key_cap: c_uint,
        actual: &mut c_uint,
    ) -> c_int {
        #[cfg(target_arch = "x86")]
        {
            let args = [
                seed.as_ptr() as u32,
                seed_len,
                level,
                variant.as_ptr() as u32,
                options.as_ptr() as u32,
                key.as_mut_ptr() as u32,
                key_cap,
                actual as *mut c_uint as u32,
            ];
            // SAFETY: forwarded from the caller; 8 x 4-byte arguments as declared.
            unsafe { x86::call_any_convention(f as usize, &args) as c_int }
        }
        #[cfg(not(target_arch = "x86"))]
        {
            // SAFETY: forwarded from the caller.
            unsafe {
                f(
                    seed.as_ptr(),
                    seed_len,
                    level,
                    variant.as_ptr(),
                    options.as_ptr(),
                    key.as_mut_ptr(),
                    key_cap,
                    actual,
                )
            }
        }
    }

    #[cfg(target_arch = "x86")]
    mod x86 {
        /// Calls `f` with 4-byte stack arguments and returns `eax`, independent of whether `f`
        /// is `__cdecl` (caller pops) or `__stdcall` (callee pops): `esp` is saved in the
        /// callee-saved `edi` before pushing and restored after the call. The stack is
        /// 16-byte aligned at the call (i386 System V requirement; harmless on Windows).
        ///
        /// # Safety
        /// `f` must be a function taking exactly `args.len()` 4-byte stack arguments and
        /// returning its result in `eax`; `1 <= args.len() <= 8`.
        pub unsafe fn call_any_convention(f: usize, args: &[u32]) -> u32 {
            assert!((1..=8).contains(&args.len()));
            let argc = args.len();
            let pad = (16 - (argc * 4) % 16) % 16;
            let ret: u32;
            // SAFETY: see function contract. The block only touches the stack below `esp`
            // (restored before leaving) and the registers declared here.
            unsafe {
                core::arch::asm!(
                    "mov edi, esp",
                    "and esp, -16",
                    "sub esp, ebx",
                    "2:",
                    "push dword ptr [ecx + edx*4 - 4]",
                    "dec edx",
                    "jnz 2b",
                    "call eax",
                    "mov esp, edi",
                    inout("eax") f => ret,
                    in("ecx") args.as_ptr(),
                    in("edx") argc,
                    in("ebx") pad,
                    out("edi") _,
                    clobber_abi("C"),
                );
            }
            ret
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_inputs_are_rejected_before_loading() {
        let r = compute("/nonexistent.so", None, None, 1, "zz", 8).unwrap_err();
        assert_eq!(r.code.as_deref(), Some(codes::INVALID_INPUT));
        let r = compute("/nonexistent.so", None, None, 1, "11", 0).unwrap_err();
        assert_eq!(r.code.as_deref(), Some(codes::INVALID_INPUT));
        let r = compute("/nonexistent.so", Some("a\0b"), None, 1, "11", 8).unwrap_err();
        assert_eq!(r.code.as_deref(), Some(codes::INVALID_INPUT));
        let r = compute("/nonexistent.so", None, None, 1, "11", 8).unwrap_err();
        assert_eq!(r.code.as_deref(), Some(codes::LIBRARY_LOAD));
    }

    #[test]
    fn c_string_default_is_empty() {
        assert_eq!(c_string(None, "variant").unwrap().as_bytes(), b"");
    }
}
