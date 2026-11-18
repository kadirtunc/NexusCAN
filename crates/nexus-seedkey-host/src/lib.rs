//! Shared pieces of the NexusCAN out-of-process seed/key helper.
//!
//! Vendor seed/key DLLs are frequently 32-bit Windows DLLs, may crash, and may run arbitrary
//! initialisation code. NexusCAN therefore never loads them into the application process.
//! `nexus-seedkey-native` spawns the `nexus-seedkey-host` binary (one request per process),
//! which loads the library with `libloading`, calls `GenerateKeyEx` / `GenerateKeyExOpt` and
//! exits. A crash, hang or heap corruption inside the library only kills the helper.
//!
//! This library target contains only code that is safe to link into the application:
//! * [`protocol`] — the single-line JSON request / response wire format.
//! * [`binfmt`] — PE / ELF / Mach-O header sniffing (format + CPU architecture) without
//!   loading or executing the file.
//!
//! The actual loading / calling lives in the binary target (`src/main.rs`, `src/keygen.rs`).

pub mod binfmt;
pub mod protocol;
