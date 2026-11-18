//! Fault-injection specifications (`--fault <spec>`, repeatable).
//!
//! | spec | behaviour |
//! | :--- | :--- |
//! | `pending78:<sid>:<count>` | send `count` × NRC 0x78 before every answer to `sid` |
//! | `slow:<sid>:<ms>` | delay every answer to `sid` by `ms` (no 0x78 → tests client P2 timeout) |
//! | `silent-after-block:<n>` | answer TransferData block `n`, then never answer anything again |
//! | `nrc:<sid>:<nrc>:<once\|always>` | answer `sid` with NRC `nrc` (no processing) |
//! | `wrong-seq-once:<block>` | answer NRC 0x73 once when block `block` arrives (not written) |
//! | `drop-response-once:<block>` | write block `block` but send no response, once |
//! | `max-block-len:<n>` | override advertised `maxNumberOfBlockLength` |
//! | `reset-during-transfer:<block>` | ECU resets (no answer, state lost) on receipt of block `block` |
//! | `erase-time:<ms>` | eraseMemory routine duration |
//! | `precondition-fail` | routine 0x0203 checkProgrammingPreconditions answers status 0x01 |
//!
//! `<sid>` / `<nrc>` are hex (`0x36` or `36`); counts / ms / block indices
//! are decimal or `0x` hex. A *block index* is the 1-based ordinal of a new
//! (non-repeated) TransferData block within the current download — it is not
//! the wrapping blockSequenceCounter.

use std::fmt;
use std::str::FromStr;

use crate::config::{parse_hex_u8, parse_num};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    Pending78 { sid: u8, count: u32 },
    Slow { sid: u8, ms: u64 },
    SilentAfterBlock(u32),
    Nrc { sid: u8, nrc: u8, once: bool },
    WrongSeqOnce(u32),
    DropResponseOnce(u32),
    MaxBlockLen(u32),
    ResetDuringTransfer(u32),
    EraseTime(u64),
    PreconditionFail,
}

fn num_u32(s: &str) -> Result<u32, String> {
    let v = parse_num(s)?;
    u32::try_from(v).map_err(|_| format!("'{s}' out of range"))
}

impl FromStr for Fault {
    type Err = String;

    fn from_str(spec: &str) -> Result<Self, Self::Err> {
        let parts: Vec<&str> = spec.trim().split(':').collect();
        let bad = || format!("invalid fault spec '{spec}'");
        let f = match parts.as_slice() {
            ["pending78", sid, count] => Fault::Pending78 {
                sid: parse_hex_u8(sid)?,
                count: num_u32(count)?,
            },
            ["slow", sid, ms] => Fault::Slow {
                sid: parse_hex_u8(sid)?,
                ms: parse_num(ms)?,
            },
            ["silent-after-block", n] => Fault::SilentAfterBlock(num_u32(n)?),
            ["nrc", sid, nrc, mode] => Fault::Nrc {
                sid: parse_hex_u8(sid)?,
                nrc: parse_hex_u8(nrc)?,
                once: match *mode {
                    "once" => true,
                    "always" => false,
                    _ => return Err(format!("{}: mode must be once|always", bad())),
                },
            },
            ["wrong-seq-once", n] => Fault::WrongSeqOnce(num_u32(n)?),
            ["drop-response-once", n] => Fault::DropResponseOnce(num_u32(n)?),
            ["max-block-len", n] => {
                let v = num_u32(n)?;
                if v < 3 {
                    return Err(format!("{}: max-block-len must be >= 3", bad()));
                }
                Fault::MaxBlockLen(v)
            }
            ["reset-during-transfer", n] => Fault::ResetDuringTransfer(num_u32(n)?),
            ["erase-time", ms] => Fault::EraseTime(parse_num(ms)?),
            ["precondition-fail"] => Fault::PreconditionFail,
            _ => return Err(bad()),
        };
        match f {
            Fault::SilentAfterBlock(0)
            | Fault::WrongSeqOnce(0)
            | Fault::DropResponseOnce(0)
            | Fault::ResetDuringTransfer(0) => Err(format!("{}: block indices are 1-based", bad())),
            Fault::Nrc { nrc: 0x78, .. } => Err(format!(
                "{}: use pending78:<sid>:<count> for NRC 0x78",
                bad()
            )),
            _ => Ok(f),
        }
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Fault::Pending78 { sid, count } => write!(f, "pending78:0x{sid:02X}:{count}"),
            Fault::Slow { sid, ms } => write!(f, "slow:0x{sid:02X}:{ms}"),
            Fault::SilentAfterBlock(n) => write!(f, "silent-after-block:{n}"),
            Fault::Nrc { sid, nrc, once } => write!(
                f,
                "nrc:0x{sid:02X}:0x{nrc:02X}:{}",
                if once { "once" } else { "always" }
            ),
            Fault::WrongSeqOnce(n) => write!(f, "wrong-seq-once:{n}"),
            Fault::DropResponseOnce(n) => write!(f, "drop-response-once:{n}"),
            Fault::MaxBlockLen(n) => write!(f, "max-block-len:{n}"),
            Fault::ResetDuringTransfer(n) => write!(f, "reset-during-transfer:{n}"),
            Fault::EraseTime(ms) => write!(f, "erase-time:{ms}"),
            Fault::PreconditionFail => write!(f, "precondition-fail"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_all_specs() {
        let cases = [
            (
                "pending78:0x31:3",
                Fault::Pending78 {
                    sid: 0x31,
                    count: 3,
                },
            ),
            (
                "pending78:36:2",
                Fault::Pending78 {
                    sid: 0x36,
                    count: 2,
                },
            ),
            ("slow:0x34:120", Fault::Slow { sid: 0x34, ms: 120 }),
            ("silent-after-block:5", Fault::SilentAfterBlock(5)),
            (
                "nrc:0x34:0x22:once",
                Fault::Nrc {
                    sid: 0x34,
                    nrc: 0x22,
                    once: true,
                },
            ),
            (
                "nrc:36:72:always",
                Fault::Nrc {
                    sid: 0x36,
                    nrc: 0x72,
                    once: false,
                },
            ),
            ("wrong-seq-once:7", Fault::WrongSeqOnce(7)),
            ("drop-response-once:3", Fault::DropResponseOnce(3)),
            ("max-block-len:0x102", Fault::MaxBlockLen(0x102)),
            ("reset-during-transfer:4", Fault::ResetDuringTransfer(4)),
            ("erase-time:1500", Fault::EraseTime(1500)),
            ("precondition-fail", Fault::PreconditionFail),
        ];
        for (s, want) in cases {
            let got: Fault = s.parse().unwrap_or_else(|e| panic!("{s}: {e}"));
            assert_eq!(got, want, "{s}");
            // Display round-trips.
            assert_eq!(got.to_string().parse::<Fault>().unwrap(), want);
        }
    }

    #[test]
    fn reject_bad_specs() {
        for s in [
            "",
            "pending78:0x31",
            "nrc:0x34:0x22:sometimes",
            "nrc:0x34:0x78:once",
            "silent-after-block:0",
            "max-block-len:2",
            "unknown:1",
            "slow:0x1234:5",
            "precondition-fail:1",
        ] {
            assert!(s.parse::<Fault>().is_err(), "{s} must be rejected");
        }
    }
}
