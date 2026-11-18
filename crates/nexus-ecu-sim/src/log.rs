//! Event logger: human-readable text or JSON lines (`--log jsonl`).

use std::io::Write;
use std::str::FromStr;
use std::time::Instant;

use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Text,
    Jsonl,
    Off,
}

impl FromStr for LogFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "text" => Ok(LogFormat::Text),
            "jsonl" | "json" => Ok(LogFormat::Jsonl),
            "off" | "none" => Ok(LogFormat::Off),
            _ => Err(format!("unknown log format '{s}' (text|jsonl|off)")),
        }
    }
}

pub struct Logger {
    fmt: LogFormat,
    out: Box<dyn Write + Send>,
    t0: Instant,
}

pub fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 3);
    for (i, x) in b.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{x:02X}"));
    }
    s
}

/// Truncated hex dump for large PDUs (TransferData).
pub fn hex_short(b: &[u8]) -> String {
    if b.len() <= 24 {
        hex(b)
    } else {
        format!("{} … ({} bytes)", hex(&b[..16]), b.len())
    }
}

impl Logger {
    pub fn new(fmt: LogFormat, out: Box<dyn Write + Send>) -> Self {
        Self {
            fmt,
            out,
            t0: Instant::now(),
        }
    }

    pub fn event(&mut self, kind: &str, fields: Value) {
        let t_ms = self.t0.elapsed().as_secs_f64() * 1000.0;
        let line = match self.fmt {
            LogFormat::Off => return,
            LogFormat::Jsonl => {
                let mut v = json!({ "tMs": (t_ms * 1000.0).round() / 1000.0, "event": kind });
                if let (Some(m), Value::Object(f)) = (v.as_object_mut(), fields) {
                    m.extend(f);
                }
                v.to_string()
            }
            LogFormat::Text => {
                let detail = match fields {
                    Value::Object(m) => m
                        .iter()
                        .map(|(k, v)| match v {
                            Value::String(s) => format!("{k}={s}"),
                            o => format!("{k}={o}"),
                        })
                        .collect::<Vec<_>>()
                        .join(" "),
                    Value::Null => String::new(),
                    o => o.to_string(),
                };
                format!("[{t_ms:10.3} ms] {kind:<8} {detail}")
            }
        };
        let _ = writeln!(self.out, "{line}");
        let _ = self.out.flush();
    }
}
