//! UI Bridge (co-pilot): MCP `ui_*` tools forward view/navigation requests to the NexusCAN
//! frontend, which replies through a fixed set of request kinds. View tools validate their
//! arguments here. The server builds the dedicated Active Bus prompt from the engine connection.
//!
//! `nexus-mcp` stays Tauri-free: the host (src-tauri) implements [`UiBridge`].

use crate::util::{clip, echo, fmt_id, parse_id, ToolError};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

/// Boxed future returned by [`UiBridge::call`].
pub type UiFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

/// Host-side transport to the frontend.
pub trait UiBridge: Send + Sync + 'static {
    /// Sends `kind` + JSON `args` to the frontend and resolves with its JSON result or an error
    /// text. Implementations must give up after `timeout` and then return [`UI_TIMEOUT`]; when no
    /// UI is attached they return [`UI_NOT_ATTACHED`].
    fn call(&self, kind: &str, args: Value, timeout: Duration) -> UiFuture;
    /// `true` while a frontend window is attached.
    fn attached(&self) -> bool;
}

/// Error text when no frontend is attached (also returned to the MCP client).
pub const UI_NOT_ATTACHED: &str = "NexusCAN UI is not attached (open the desktop window)";
/// Error text a bridge returns when the frontend did not answer within the timeout.
pub const UI_TIMEOUT: &str = "NexusCAN UI did not respond in time";
/// Default request timeout.
pub const UI_DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
/// Timeout of `ui_confirm` (the user has to read and click).
pub const UI_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);
/// `ui_*` calls allowed per second (in addition to the audit limiter).
pub const UI_MAX_CALLS_PER_SEC: u32 = 10;

/// Fixed-window rate limiter for `ui_*` tools.
#[derive(Debug)]
pub struct UiRateLimiter {
    window_start: Instant,
    count: u32,
}

impl UiRateLimiter {
    pub fn new(now: Instant) -> Self {
        Self {
            window_start: now,
            count: 0,
        }
    }

    /// `true` if the call may proceed.
    pub fn try_acquire(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_start) >= Duration::from_secs(1) {
            self.window_start = now;
            self.count = 0;
        }
        if self.count < UI_MAX_CALLS_PER_SEC {
            self.count += 1;
            true
        } else {
            false
        }
    }
}

// ─── Inputs (tool schemas; camelCase exactly as forwarded to the frontend) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UiView {
    Start,
    Connections,
    Rxtx,
    Trace,
    Plotter,
    Symbols,
    Panels,
    Diagnostics,
    Re,
}

impl UiView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Connections => "connections",
            Self::Rxtx => "rxtx",
            Self::Trace => "trace",
            Self::Plotter => "plotter",
            Self::Symbols => "symbols",
            Self::Panels => "panels",
            Self::Diagnostics => "diagnostics",
            Self::Re => "re",
        }
    }

    /// Valid sub-tabs of this view (empty = the view has no sub-tabs).
    pub fn sub_tabs(self) -> &'static [&'static str] {
        match self {
            Self::Diagnostics => &[
                "ecu_registry",
                "workbench",
                "session",
                "ecu_graph",
                "dtc",
                "live_pids",
                "uds_console",
                "did_inspector",
                "flow",
                "uds_panel",
            ],
            Self::Symbols => &["messages", "ecus", "diagnostics"],
            _ => &[],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UiSubTab {
    EcuRegistry,
    Workbench,
    Session,
    EcuGraph,
    Dtc,
    LivePids,
    UdsConsole,
    DidInspector,
    Flow,
    UdsPanel,
    Messages,
    Ecus,
    Diagnostics,
}

impl UiSubTab {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EcuRegistry => "ecu_registry",
            Self::Workbench => "workbench",
            Self::Session => "session",
            Self::EcuGraph => "ecu_graph",
            Self::Dtc => "dtc",
            Self::LivePids => "live_pids",
            Self::UdsConsole => "uds_console",
            Self::DidInspector => "did_inspector",
            Self::Flow => "flow",
            Self::UdsPanel => "uds_panel",
            Self::Messages => "messages",
            Self::Ecus => "ecus",
            Self::Diagnostics => "diagnostics",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NavigateArgs {
    /// Main view to show.
    pub view: UiView,
    /// Optional sub-tab. Only valid for view "diagnostics" (ecu_registry, workbench, session,
    /// ecu_graph, dtc, live_pids, uds_console, did_inspector, flow, uds_panel) and view
    /// "symbols" (messages, ecus, diagnostics).
    #[serde(default)]
    pub sub_tab: Option<UiSubTab>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelectMessageArgs {
    /// Arbitration ID to select: "0x1A0", "416", "0x18FEF100", or 8 hex digits
    /// ("0x000001A0") for a small 29-bit ID.
    pub arb_id: String,
    /// true for a 29-bit ID. Default: true above 0x7FF or with 8 hex digits.
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Optional bus (0 = Bus 1) to select the message on.
    #[serde(default)]
    pub bus_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TraceFilterArgs {
    /// Arbitration IDs to show in the Trace view (max 64, same ID rules as select_message),
    /// or null / omitted to clear the filter.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlotSignalsArgs {
    /// Signal names to add to the plotter (max 16). Use "Message.Signal" for ambiguous names.
    #[serde(default)]
    pub add: Option<Vec<String>>,
    /// Signal names to remove from the plotter (max 16).
    #[serde(default)]
    pub remove: Option<Vec<String>>,
    /// Remove every plotted signal first.
    #[serde(default)]
    pub clear: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NotifyLevel {
    Info,
    Warn,
    Success,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotifyArgs {
    /// Notification style.
    pub level: NotifyLevel,
    /// Text shown to the user (max 200 characters; longer text is clipped).
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmArgs {
    /// Dialog title (max 80 characters).
    pub title: String,
    /// Question / explanation shown to the user (max 400 characters).
    pub message: String,
    /// Optional label of the confirm button (max 24 characters), e.g. "Open Trace".
    #[serde(default)]
    pub confirm_label: Option<String>,
}

// ─── Validation: tool input -> (kind, forwarded args, timeout) ──────────────

/// A validated request ready to be forwarded.
#[derive(Debug, Clone, PartialEq)]
pub struct UiRequest {
    pub kind: &'static str,
    pub args: Value,
    pub timeout: Duration,
}

fn req(kind: &'static str, args: Value) -> UiRequest {
    UiRequest {
        kind,
        args,
        timeout: UI_DEFAULT_TIMEOUT,
    }
}

fn norm_id(raw: &str, is_extended: Option<bool>) -> Result<(String, bool), ToolError> {
    let p = parse_id(raw)?;
    let ext = p.is_extended(is_extended);
    let key = p.key(Some(ext))?;
    Ok((fmt_id(key.raw_id(), ext), ext))
}

pub fn get_state() -> UiRequest {
    req("get_state", json!({}))
}

pub fn navigate(a: &NavigateArgs) -> Result<UiRequest, ToolError> {
    let sub = match a.sub_tab {
        None => Value::Null,
        Some(st) => {
            let allowed = a.view.sub_tabs();
            if !allowed.contains(&st.as_str()) {
                return Err(ToolError::new(if allowed.is_empty() {
                    format!("view '{}' has no sub-tabs", a.view.as_str())
                } else {
                    format!(
                        "sub-tab '{}' is not valid for view '{}'; valid: {}",
                        st.as_str(),
                        a.view.as_str(),
                        allowed.join(", ")
                    )
                }));
            }
            json!(st.as_str())
        }
    };
    Ok(req(
        "navigate",
        json!({ "view": a.view.as_str(), "subTab": sub }),
    ))
}

pub fn select_message(a: &SelectMessageArgs) -> Result<UiRequest, ToolError> {
    let (id, ext) = norm_id(&a.arb_id, a.is_extended)?;
    Ok(req(
        "select_message",
        json!({ "arbId": id, "isExtended": ext, "busId": a.bus_id }),
    ))
}

pub fn trace_filter(a: &TraceFilterArgs) -> Result<UiRequest, ToolError> {
    let ids = match &a.ids {
        None => Value::Null,
        Some(list) => {
            if list.len() > 64 {
                return Err(ToolError::new("ids accepts at most 64 IDs"));
            }
            let norm = list
                .iter()
                .map(|s| norm_id(s, None).map(|(id, _)| id))
                .collect::<Result<Vec<_>, _>>()?;
            json!(norm)
        }
    };
    Ok(req("trace_filter", json!({ "ids": ids })))
}

fn names(list: &Option<Vec<String>>, what: &str) -> Result<Vec<String>, ToolError> {
    let Some(list) = list else {
        return Ok(Vec::new());
    };
    if list.len() > 16 {
        return Err(ToolError::new(format!(
            "{what} accepts at most 16 signal names"
        )));
    }
    list.iter()
        .map(|s| {
            let t = s.trim();
            if t.is_empty() {
                Err(ToolError::new(format!(
                    "{what} contains an empty signal name"
                )))
            } else if t.chars().count() > 128 {
                Err(ToolError::new(format!(
                    "{what}: signal name '{}' is too long",
                    echo(t)
                )))
            } else {
                Ok(t.to_string())
            }
        })
        .collect()
}

pub fn plot_signals(a: &PlotSignalsArgs) -> Result<UiRequest, ToolError> {
    let add = names(&a.add, "add")?;
    let remove = names(&a.remove, "remove")?;
    let clear = a.clear.unwrap_or(false);
    if add.is_empty() && remove.is_empty() && !clear {
        return Err(ToolError::new(
            "nothing to do: give add, remove and/or clear=true",
        ));
    }
    Ok(req(
        "plot_signals",
        json!({ "add": add, "remove": remove, "clear": clear }),
    ))
}

pub fn notify(a: &NotifyArgs) -> Result<UiRequest, ToolError> {
    let text = a.text.trim();
    if text.is_empty() {
        return Err(ToolError::new("text must not be empty"));
    }
    let level = match a.level {
        NotifyLevel::Info => "info",
        NotifyLevel::Warn => "warn",
        NotifyLevel::Success => "success",
    };
    Ok(req(
        "notify",
        json!({ "level": level, "text": clip(text, 200) }),
    ))
}

pub fn confirm(a: &ConfirmArgs) -> Result<UiRequest, ToolError> {
    let title = a.title.trim();
    let message = a.message.trim();
    if title.is_empty() || message.is_empty() {
        return Err(ToolError::new("title and message must not be empty"));
    }
    let label = a
        .confirm_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| clip(s, 24));
    Ok(UiRequest {
        kind: "confirm",
        args: json!({
            "title": clip(title, 80),
            "message": clip(message, 400),
            "confirmLabel": label,
        }),
        timeout: UI_CONFIRM_TIMEOUT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigate_validates_sub_tabs() {
        let ok = navigate(&NavigateArgs {
            view: UiView::Diagnostics,
            sub_tab: Some(UiSubTab::UdsConsole),
        })
        .unwrap();
        assert_eq!(
            ok.args,
            json!({ "view": "diagnostics", "subTab": "uds_console" })
        );
        assert!(navigate(&NavigateArgs {
            view: UiView::Symbols,
            sub_tab: Some(UiSubTab::Dtc)
        })
        .is_err());
        assert!(navigate(&NavigateArgs {
            view: UiView::Trace,
            sub_tab: Some(UiSubTab::Messages)
        })
        .unwrap_err()
        .0
        .contains("no sub-tabs"));
        assert_eq!(
            navigate(&NavigateArgs {
                view: UiView::Re,
                sub_tab: None
            })
            .unwrap()
            .args,
            json!({ "view": "re", "subTab": null })
        );
    }

    #[test]
    fn ids_are_normalized() {
        let r = select_message(&SelectMessageArgs {
            arb_id: "416".into(),
            is_extended: None,
            bus_id: Some(1),
        })
        .unwrap();
        assert_eq!(
            r.args,
            json!({ "arbId": "0x1A0", "isExtended": false, "busId": 1 })
        );
        let r = select_message(&SelectMessageArgs {
            arb_id: "0x000001a0".into(),
            is_extended: None,
            bus_id: None,
        })
        .unwrap();
        assert_eq!(r.args["arbId"], json!("0x000001A0"));
        assert_eq!(r.args["isExtended"], json!(true));
        let f = trace_filter(&TraceFilterArgs {
            ids: Some(vec!["0x1a0".into(), "18fef100".into()]),
        })
        .unwrap();
        assert_eq!(f.args, json!({ "ids": ["0x1A0", "0x18FEF100"] }));
        assert_eq!(
            trace_filter(&TraceFilterArgs { ids: None }).unwrap().args,
            json!({ "ids": null })
        );
        assert!(trace_filter(&TraceFilterArgs {
            ids: Some(vec!["0x1".into(); 65])
        })
        .is_err());
        assert!(select_message(&SelectMessageArgs {
            arb_id: "zz".into(),
            is_extended: None,
            bus_id: None
        })
        .is_err());
    }

    #[test]
    fn text_limits_and_plot_rules() {
        let n = notify(&NotifyArgs {
            level: NotifyLevel::Warn,
            text: "x".repeat(500),
        })
        .unwrap();
        assert_eq!(n.args["text"].as_str().unwrap().chars().count(), 201);
        let c = confirm(&ConfirmArgs {
            title: "t".repeat(100),
            message: "m".repeat(1000),
            confirm_label: Some("l".repeat(50)),
        })
        .unwrap();
        assert_eq!(c.timeout, UI_CONFIRM_TIMEOUT);
        assert_eq!(c.args["title"].as_str().unwrap().chars().count(), 81);
        assert_eq!(c.args["message"].as_str().unwrap().chars().count(), 401);
        assert_eq!(c.args["confirmLabel"].as_str().unwrap().chars().count(), 25);
        assert!(plot_signals(&PlotSignalsArgs {
            add: None,
            remove: None,
            clear: None
        })
        .is_err());
        assert!(plot_signals(&PlotSignalsArgs {
            add: Some(vec!["a".into(); 17]),
            remove: None,
            clear: None
        })
        .is_err());
        let p = plot_signals(&PlotSignalsArgs {
            add: Some(vec![" Speed ".into()]),
            remove: None,
            clear: Some(true),
        })
        .unwrap();
        assert_eq!(
            p.args,
            json!({ "add": ["Speed"], "remove": [], "clear": true })
        );
    }

    #[test]
    fn rate_limiter() {
        let t0 = Instant::now();
        let mut l = UiRateLimiter::new(t0);
        assert_eq!((0..15).filter(|_| l.try_acquire(t0)).count(), 10);
        assert!(l.try_acquire(t0 + Duration::from_millis(1001)));
    }
}
