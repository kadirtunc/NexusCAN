//! TEST FIXTURE — a fake vendor seed/key library exporting the Vector interface
//! (`GenerateKeyEx`, `GenerateKeyExOpt`, C ABI) for `nexus-seedkey-native` end-to-end tests.
//! It deliberately crashes / hangs on some levels to prove out-of-process isolation.
//! Never ship or load this library in production.
//!
//! Behaviour by `iSecurityLevel`:
//! * default: `key[i] = seed[i] ^ 0xA5` (`GenerateKeyExOpt`: additionally `^ options[i % len]`)
//! * `0x03`: returns `3` (`KGRE_VariantInvalid`) — error code mapping
//! * `0x05`: writes through a null pointer (SIGSEGV / access violation)
//! * `0x07`: sleeps 60 s — timeout + kill
//! * `0x09`: `abort()`
//! * `0x0B`: reports `iMaxKeyArraySize + 1` key bytes — invalid result
//! * `0x0D`: prints noise to stdout, then behaves like default
//! * variant `"BAD"`: returns `3`
//! * seed longer than the key buffer: returns `1` (`KGRE_BufferToSmall`)
#![allow(non_snake_case)]

use std::ffi::{c_char, c_int, c_uint, CStr};

const KGRE_OK: c_int = 0;
const KGRE_BUFFER_TO_SMALL: c_int = 1;
const KGRE_VARIANT_INVALID: c_int = 3;
const KGRE_UNSPECIFIED: c_int = 4;

#[allow(clippy::too_many_arguments)]
unsafe fn generate(
    seed: *const u8,
    seed_len: c_uint,
    level: c_uint,
    variant: *const c_char,
    options: Option<&[u8]>,
    key: *mut u8,
    max_key_len: c_uint,
    actual: *mut c_uint,
) -> c_int {
    if seed.is_null() || key.is_null() || actual.is_null() || variant.is_null() {
        return KGRE_UNSPECIFIED;
    }
    // SAFETY: the caller passes a NUL-terminated variant string.
    if unsafe { CStr::from_ptr(variant) }.to_bytes() == b"BAD" {
        return KGRE_VARIANT_INVALID;
    }
    match level {
        0x03 => return KGRE_VARIANT_INVALID,
        0x05 => {
            let p = std::ptr::without_provenance_mut::<u8>(std::hint::black_box(0));
            // SAFETY: none — this is the deliberate crash.
            unsafe { p.write_volatile(0x42) };
            return KGRE_UNSPECIFIED;
        }
        0x07 => std::thread::sleep(std::time::Duration::from_secs(60)),
        0x09 => std::process::abort(),
        0x0B => {
            // SAFETY: caller-provided out pointer.
            unsafe { *actual = max_key_len + 1 };
            return KGRE_OK;
        }
        0x0D => println!("vendor dll debug: computing key"),
        _ => {}
    }
    if seed_len > max_key_len {
        return KGRE_BUFFER_TO_SMALL;
    }
    // SAFETY: lengths are the caller's declared buffer sizes.
    let seed = unsafe { std::slice::from_raw_parts(seed, seed_len as usize) };
    let out = unsafe { std::slice::from_raw_parts_mut(key, seed.len()) };
    for (i, (o, s)) in out.iter_mut().zip(seed).enumerate() {
        *o = s ^ 0xA5;
        if let Some(opts) = options {
            *o ^= opts[i % opts.len()];
        }
    }
    unsafe { *actual = seed_len };
    KGRE_OK
}

/// Defines both exports with the given ABI string. Feature `stdcall` (x86 only) switches to
/// `__stdcall` (callee pops) to exercise the helper's convention-agnostic x86 trampoline.
macro_rules! exports {
    ($abi:literal) => {
        /// # Safety
        /// Vector `GenerateKeyEx` contract.
        #[no_mangle]
        pub unsafe extern $abi fn GenerateKeyEx(
            ipSeedArray: *const u8,
            iSeedArraySize: c_uint,
            iSecurityLevel: c_uint,
            ipVariant: *const c_char,
            iopKeyArray: *mut u8,
            iMaxKeyArraySize: c_uint,
            oActualKeyArraySize: *mut c_uint,
        ) -> c_int {
            unsafe {
                generate(
                    ipSeedArray,
                    iSeedArraySize,
                    iSecurityLevel,
                    ipVariant,
                    None,
                    iopKeyArray,
                    iMaxKeyArraySize,
                    oActualKeyArraySize,
                )
            }
        }

        /// # Safety
        /// Vector `GenerateKeyExOpt` contract.
        #[no_mangle]
        pub unsafe extern $abi fn GenerateKeyExOpt(
            ipSeedArray: *const u8,
            iSeedArraySize: c_uint,
            iSecurityLevel: c_uint,
            ipVariant: *const c_char,
            ipOptions: *const c_char,
            iopKeyArray: *mut u8,
            iMaxKeyArraySize: c_uint,
            oActualKeyArraySize: *mut c_uint,
        ) -> c_int {
            if ipOptions.is_null() {
                return KGRE_UNSPECIFIED;
            }
            // SAFETY: NUL-terminated options string.
            let opts = unsafe { CStr::from_ptr(ipOptions) }.to_bytes();
            if opts.is_empty() {
                return KGRE_UNSPECIFIED;
            }
            unsafe {
                generate(
                    ipSeedArray,
                    iSeedArraySize,
                    iSecurityLevel,
                    ipVariant,
                    Some(opts),
                    iopKeyArray,
                    iMaxKeyArraySize,
                    oActualKeyArraySize,
                )
            }
        }
    };
}

#[cfg(not(all(feature = "stdcall", target_arch = "x86")))]
exports!("C");
#[cfg(all(feature = "stdcall", target_arch = "x86"))]
exports!("stdcall");
