//! `external_process` provider (contract §4): `std::process::Command` without a shell,
//! environment cleared except `PATH` / `SystemRoot`, placeholders in `args`
//! (`{seed}` uppercase hex, `{level}` 2-digit hex, `{levelDec}`), seed hex + `'\n'` on stdin,
//! timeout + kill, stdout ≤ 64 KiB, first non-empty stdout line parsed as hex key.

use crate::child::{self, RunError};
use nexus_protocols::uds::security::{
    parse_hex, to_hex, KeyProvider, SeedKeyError, SeedKeyRequest, MAX_KEY_LEN, MAX_SEED_LEN,
};
use std::process::Command;
use std::time::Duration;

const STDOUT_CAP: usize = 64 * 1024;
const STDERR_CAP: usize = 8 * 1024;
/// Upper bound on the number of arguments (sanity limit for stored profiles).
pub(crate) const MAX_ARGS: usize = 64;

pub(crate) struct ExternalProcessProvider {
    pub program: String,
    pub args: Vec<String>,
    pub timeout_ms: u32,
}

impl ExternalProcessProvider {
    pub(crate) fn new(
        program: &str,
        args: &[String],
        timeout_ms: u32,
    ) -> Result<Self, SeedKeyError> {
        if program.trim().is_empty() {
            return Err(SeedKeyError::InvalidInput(
                "external process program must not be empty".into(),
            ));
        }
        if !(1..=60_000).contains(&timeout_ms) {
            return Err(SeedKeyError::InvalidInput(format!(
                "timeoutMs {timeout_ms} outside 1..=60000"
            )));
        }
        if args.len() > MAX_ARGS {
            return Err(SeedKeyError::InvalidInput(format!(
                "{} arguments exceed the limit of {MAX_ARGS}",
                args.len()
            )));
        }
        Ok(Self {
            program: program.trim().to_string(),
            args: args.to_vec(),
            timeout_ms,
        })
    }
}

pub(crate) fn substitute(arg: &str, seed_hex: &str, level: u8) -> String {
    arg.replace("{seed}", seed_hex)
        .replace("{levelDec}", &level.to_string())
        .replace("{level}", &format!("{level:02X}"))
}

impl KeyProvider for ExternalProcessProvider {
    fn kind(&self) -> &'static str {
        "external_process"
    }

    fn compute_key(&self, req: &SeedKeyRequest<'_>) -> Result<Vec<u8>, SeedKeyError> {
        if req.seed.is_empty() || req.seed.len() > MAX_SEED_LEN {
            return Err(SeedKeyError::InvalidInput(format!(
                "seed must be 1..={MAX_SEED_LEN} bytes, got {}",
                req.seed.len()
            )));
        }
        let seed_hex = to_hex(req.seed);
        let mut cmd = Command::new(&self.program);
        cmd.args(
            self.args
                .iter()
                .map(|a| substitute(a, &seed_hex, req.level)),
        );
        child::harden(&mut cmd, &["PATH", "SystemRoot"]);
        let stdin = format!("{seed_hex}\n").into_bytes();
        let timeout = Duration::from_millis(u64::from(self.timeout_ms));
        let out = child::run(cmd, stdin, timeout, STDOUT_CAP, STDERR_CAP).map_err(|e| match e {
            RunError::Timeout => SeedKeyError::Timeout {
                ms: self.timeout_ms,
            },
            RunError::Spawn(e) => {
                SeedKeyError::Process(format!("cannot start '{}': {e}", self.program))
            }
            RunError::Wait(e) => SeedKeyError::Process(format!("lost '{}': {e}", self.program)),
            RunError::StdoutOverflow => SeedKeyError::Process(format!(
                "'{}' wrote more than {STDOUT_CAP} bytes to stdout",
                self.program
            )),
        })?;
        if !out.status.success() {
            let stderr = child::snippet(&out.stderr, 300);
            return Err(SeedKeyError::Process(format!(
                "'{}' failed with {}{}",
                self.program,
                child::describe_status(&out.status),
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr}")
                }
            )));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .ok_or_else(|| SeedKeyError::Process(format!("'{}' printed no key", self.program)))?;
        let key = parse_hex(line).map_err(|_| {
            SeedKeyError::Process(format!(
                "'{}' printed a first line that is not hex",
                self.program
            ))
        })?;
        if key.is_empty() || key.len() > MAX_KEY_LEN {
            return Err(SeedKeyError::Process(format!(
                "'{}' returned {} key bytes (allowed 1..={MAX_KEY_LEN})",
                self.program,
                key.len()
            )));
        }
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders() {
        assert_eq!(
            substitute("--seed={seed} -l {level} -d {levelDec}", "A1B2", 0x11),
            "--seed=A1B2 -l 11 -d 17"
        );
    }

    #[test]
    fn construction_limits() {
        assert!(ExternalProcessProvider::new(" ", &[], 100).is_err());
        assert!(ExternalProcessProvider::new("x", &[], 0).is_err());
        assert!(
            ExternalProcessProvider::new("x", &vec![String::new(); MAX_ARGS + 1], 100).is_err()
        );
        assert!(ExternalProcessProvider::new("x", &[], 100).is_ok());
    }

    #[cfg(unix)]
    fn sh(script: &str, timeout_ms: u32) -> ExternalProcessProvider {
        ExternalProcessProvider::new("sh", &["-c".into(), script.into()], timeout_ms).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn unix_program_roundtrip_and_failures() {
        let req = SeedKeyRequest {
            seed: &[0x11, 0x22],
            level: 0x03,
        };
        // Arg placeholder + stdin both available; env is cleared.
        let p = sh("read s; echo \"\"; echo {seed}; test -z \"$HOME\"", 5_000);
        assert_eq!(p.compute_key(&req).unwrap(), vec![0x11, 0x22]);
        let p = sh("read s; echo $s", 5_000);
        assert_eq!(p.compute_key(&req).unwrap(), vec![0x11, 0x22]);

        let err = sh("echo boom >&2; exit 4", 5_000)
            .compute_key(&req)
            .unwrap_err();
        assert!(
            matches!(&err, SeedKeyError::Process(m) if m.contains("exit code 4") && m.contains("boom")),
            "{err}"
        );
        let err = sh("echo zz", 5_000).compute_key(&req).unwrap_err();
        assert!(matches!(err, SeedKeyError::Process(_)));

        let started = std::time::Instant::now();
        let err = sh("sleep 10", 200).compute_key(&req).unwrap_err();
        assert_eq!(err, SeedKeyError::Timeout { ms: 200 });
        assert!(started.elapsed() < Duration::from_secs(5));

        let err = sh("yes AB", 5_000).compute_key(&req).unwrap_err();
        assert!(
            matches!(&err, SeedKeyError::Process(m) if m.contains("more than")),
            "{err}"
        );

        let err = ExternalProcessProvider::new("/nonexistent/keygen", &[], 100)
            .unwrap()
            .compute_key(&req)
            .unwrap_err();
        assert!(matches!(err, SeedKeyError::Process(_)));
    }
}
