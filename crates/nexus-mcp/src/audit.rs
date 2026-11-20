//! Audit rate limiting (MCP-QA-03). The engine debug hub is a 5,000-event ring shared with
//! connection / safety / TX events, so an MCP client hammering tools must not flush it. At most
//! [`AUDIT_MAX_PER_WINDOW`] tool calls per [`AUDIT_WINDOW`] are logged individually; the rest are
//! counted per tool and written later as one summary event (on the next call after the window
//! rolls over, from the periodic flush task, or when the server stops). `total_calls` is not
//! affected.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// Individual audit events allowed per window (~10/s).
pub const AUDIT_MAX_PER_WINDOW: u32 = 10;
/// Rate-limit window.
pub const AUDIT_WINDOW: Duration = Duration::from_secs(1);
/// Interval of the background summary flush.
pub const AUDIT_FLUSH_INTERVAL: Duration = Duration::from_secs(2);

/// Summary of tool calls that were not logged individually.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuppressedSummary {
    pub total: u64,
    pub errors: u64,
    /// Seconds since the first suppressed call (rounded up, at least 1).
    pub span_secs: u64,
    /// Per-tool counts, sorted by tool name.
    pub per_tool: Vec<(&'static str, u64)>,
}

impl SuppressedSummary {
    pub fn title(&self) -> String {
        format!(
            "MCP: {} tool calls not individually logged in last {}s",
            self.total, self.span_secs
        )
    }

    pub fn details(&self) -> String {
        let tools = self
            .per_tool
            .iter()
            .map(|(t, n)| format!("{t}={n}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{tools}; errors={}; limit={AUDIT_MAX_PER_WINDOW}/s",
            self.errors
        )
    }
}

/// Decision for one tool call.
#[derive(Debug, PartialEq, Eq)]
pub struct Admission {
    /// Write the individual `mcp.tool_call` event.
    pub log_individual: bool,
    /// Write this summary first (pending suppressed calls from earlier windows).
    pub summary: Option<SuppressedSummary>,
}

#[derive(Debug)]
pub struct AuditLimiter {
    window_start: Instant,
    logged_in_window: u32,
    suppressed: BTreeMap<&'static str, u64>,
    suppressed_errors: u64,
    suppressed_since: Option<Instant>,
}

impl AuditLimiter {
    pub fn new(now: Instant) -> Self {
        Self {
            window_start: now,
            logged_in_window: 0,
            suppressed: BTreeMap::new(),
            suppressed_errors: 0,
            suppressed_since: None,
        }
    }

    fn roll(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_start) >= AUDIT_WINDOW {
            self.window_start = now;
            self.logged_in_window = 0;
            true
        } else {
            false
        }
    }

    /// Registers one tool call.
    pub fn admit(&mut self, now: Instant, tool: &'static str, is_error: bool) -> Admission {
        let rolled = self.roll(now);
        let summary = if rolled { self.take_summary(now) } else { None };
        if self.logged_in_window < AUDIT_MAX_PER_WINDOW {
            self.logged_in_window += 1;
            Admission {
                log_individual: true,
                summary,
            }
        } else {
            *self.suppressed.entry(tool).or_insert(0) += 1;
            self.suppressed_errors += u64::from(is_error);
            self.suppressed_since.get_or_insert(now);
            Admission {
                log_individual: false,
                summary,
            }
        }
    }

    /// Takes the pending summary if the current window is over (periodic flush).
    pub fn flush_due(&mut self, now: Instant) -> Option<SuppressedSummary> {
        if self.roll(now) {
            self.take_summary(now)
        } else {
            None
        }
    }

    /// Unconditionally takes the pending summary (server stop).
    pub fn take_summary(&mut self, now: Instant) -> Option<SuppressedSummary> {
        let since = self.suppressed_since.take()?;
        let per_tool: Vec<(&'static str, u64)> =
            std::mem::take(&mut self.suppressed).into_iter().collect();
        let total = per_tool.iter().map(|(_, n)| n).sum();
        let errors = std::mem::take(&mut self.suppressed_errors);
        let span = now.saturating_duration_since(since);
        let span_secs = span.as_secs() + u64::from(span.subsec_nanos() > 0);
        Some(SuppressedSummary {
            total,
            errors,
            span_secs: span_secs.max(1),
            per_tool,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_to_ten_per_window_and_summarises_the_rest() {
        let t0 = Instant::now();
        let mut l = AuditLimiter::new(t0);
        let mut logged = 0;
        for i in 0..1_000u32 {
            let tool = if i % 2 == 0 { "db_info" } else { "trace_query" };
            let a = l.admit(t0 + Duration::from_micros(u64::from(i)), tool, i % 10 == 0);
            assert!(a.summary.is_none());
            logged += u32::from(a.log_individual);
        }
        assert_eq!(logged, AUDIT_MAX_PER_WINDOW);
        // Not due within the window.
        assert!(l.flush_due(t0 + Duration::from_millis(500)).is_none());
        // Next call after the window: summary first, then the call itself is logged again.
        let a = l.admit(t0 + Duration::from_millis(1_200), "db_info", false);
        assert!(a.log_individual);
        let s = a.summary.expect("summary");
        assert_eq!(s.total, 990);
        assert_eq!(s.per_tool, vec![("db_info", 495), ("trace_query", 495)]);
        assert_eq!(s.errors, 99); // i % 10 == 0 among suppressed i in 10..1000
        assert!(s.title().contains("990 tool calls not individually logged"));
        assert!(s.details().contains("db_info=495"));
        assert!(l.take_summary(t0 + Duration::from_secs(2)).is_none());
    }

    #[test]
    fn periodic_flush_and_stop_flush() {
        let t0 = Instant::now();
        let mut l = AuditLimiter::new(t0);
        for _ in 0..15 {
            l.admit(t0, "trace_list", false);
        }
        let s = l.flush_due(t0 + Duration::from_secs(3)).expect("due");
        assert_eq!(s.total, 5);
        for _ in 0..12 {
            l.admit(t0 + Duration::from_secs(3), "db_info", false);
        }
        let s = l
            .take_summary(t0 + Duration::from_secs(3))
            .expect("stop flush");
        assert_eq!(s.total, 2);
        assert_eq!(s.span_secs, 1);
    }
}
