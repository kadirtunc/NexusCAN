//! `nexus-seedkey-host`: loads one Vector-style seed/key library, answers one request, exits.
//!
//! Protocol: see `nexus_seedkey_host::protocol` (one JSON line on stdin, one on stdout).
//! Exit status: `0` = `ok:true`, `2` = handled error (response still written). Anything else
//! (signal, access violation, abort) means the library crashed this process.
//!
//! Packaging: shipped as `nexus-seedkey-host64[.exe]` (host-native build) and
//! `nexus-seedkey-host32[.exe]` (i686 build) next to the NexusCAN executable.
//! `nexus-seedkey-host --version` prints name, version and architecture (installer smoke test).

mod keygen;

use nexus_seedkey_host::protocol::{codes, HostRequest, HostResponse, MAX_REQUEST_BYTES};
use std::io::{Read, Write};

fn read_request() -> Result<HostRequest, HostResponse> {
    let mut raw = Vec::with_capacity(512);
    std::io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| {
            HostResponse::error(codes::INVALID_INPUT, format!("cannot read stdin: {e}"))
        })?;
    if raw.len() > MAX_REQUEST_BYTES {
        return Err(HostResponse::error(
            codes::INVALID_INPUT,
            format!("request exceeds {MAX_REQUEST_BYTES} bytes"),
        ));
    }
    let line = raw.split(|b| *b == b'\n').next().unwrap_or_default();
    serde_json::from_slice(line)
        .map_err(|e| HostResponse::error(codes::INVALID_INPUT, format!("invalid request: {e}")))
}

fn run() -> HostResponse {
    match read_request() {
        Ok(req) => keygen::handle(&req),
        Err(resp) => resp,
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "nexus-seedkey-host {} ({}-{})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        return;
    }
    let response = std::panic::catch_unwind(run)
        .unwrap_or_else(|_| HostResponse::error(codes::LIBRARY_CALL, "seed/key helper panicked"));
    let line = serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"ok":false,"code":"library_call","message":"response serialization failed"}"#.into()
    });
    let mut out = std::io::stdout().lock();
    // Leading newline: terminates any partial line a library printed without '\n'.
    let _ = out.write_all(format!("\n{line}\n").as_bytes());
    let _ = out.flush();
    drop(out);
    // The library is intentionally never unloaded (see keygen); exit right away.
    std::process::exit(if response.ok { 0 } else { 2 });
}
