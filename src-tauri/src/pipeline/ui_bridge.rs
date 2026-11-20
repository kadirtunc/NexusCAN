//! Host side of the MCP UI Bridge (co-pilot): forwards whitelisted `ui_*` requests from
//! `nexus-mcp` to the attached frontend over a `tauri::ipc::Channel` and resolves them when the
//! frontend answers via `cmd_mcp_ui_respond`. Display/navigation only; no bus access.

use nexus_mcp::{UiBridge, UiFuture, UI_NOT_ATTACHED, UI_TIMEOUT};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::oneshot;

/// Request pushed to the frontend (`cmd_mcp_ui_attach` channel).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRequestDto {
    pub request_id: u64,
    pub kind: String,
    pub args: Value,
}

type UiResult = Result<Value, String>;
type Sink = Box<dyn Fn(UiRequestDto) -> bool + Send + Sync>;

#[derive(Default)]
struct Inner {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<UiResult>>>,
    /// Delivers a request to the attached UI; `false` = delivery failed (window gone).
    sink: Mutex<Option<Sink>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Shared bridge (cheap clone).
#[derive(Clone, Default)]
pub struct TauriUiBridge {
    inner: Arc<Inner>,
}

impl TauriUiBridge {
    /// Attaches a UI (replaces any previous one; its pending requests fail immediately).
    pub fn attach_sink(&self, sink: Sink) {
        *lock(&self.inner.sink) = Some(sink);
        for (_, tx) in lock(&self.inner.pending).drain() {
            let _ = tx.send(Err("NexusCAN UI was re-attached; retry".to_string()));
        }
    }

    pub fn detach(&self) {
        *lock(&self.inner.sink) = None;
    }

    /// Resolves a pending request. Unknown / late ids are ignored (returns `false`).
    pub fn respond(&self, request_id: u64, result: UiResult) -> bool {
        match lock(&self.inner.pending).remove(&request_id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    pub fn pending_count(&self) -> usize {
        lock(&self.inner.pending).len()
    }
}

/// Removes its pending entry when dropped: completion, timeout, or the MCP call future being
/// dropped (client cancellation / server stop) all clean up the map. Request ids are unique,
/// so a guard can only ever remove its own entry.
struct PendingGuard {
    inner: Arc<Inner>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        lock(&self.inner.pending).remove(&self.id);
    }
}

impl UiBridge for TauriUiBridge {
    fn call(&self, kind: &str, args: Value, timeout: Duration) -> UiFuture {
        let inner = Arc::clone(&self.inner);
        let id = inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        lock(&inner.pending).insert(id, tx);
        let guard = PendingGuard {
            inner: Arc::clone(&inner),
            id,
        };
        let delivered = lock(&inner.sink).as_ref().is_some_and(|sink| {
            sink(UiRequestDto {
                request_id: id,
                kind: kind.to_string(),
                args,
            })
        });
        if !delivered {
            drop(guard);
            return Box::pin(async { Err(UI_NOT_ATTACHED.to_string()) });
        }
        Box::pin(async move {
            let _guard = guard;
            match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(res)) => res,
                Ok(Err(_)) => Err("NexusCAN UI request was cancelled".to_string()),
                Err(_) => Err(UI_TIMEOUT.to_string()),
            }
        })
    }

    fn attached(&self) -> bool {
        lock(&self.inner.sink).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn pending_map_lifecycle() {
        let b = TauriUiBridge::default();
        assert!(!b.attached());
        assert_eq!(
            b.call("get_state", json!({}), Duration::from_secs(1)).await,
            Err(UI_NOT_ATTACHED.to_string())
        );
        let seen = Arc::new(Mutex::new(Vec::<u64>::new()));
        let s2 = Arc::clone(&seen);
        b.attach_sink(Box::new(move |r| {
            lock(&s2).push(r.request_id);
            true
        }));
        let fut = b.call("get_state", json!({}), Duration::from_secs(5));
        let id = lock(&seen)[0];
        assert_eq!(b.pending_count(), 1);
        assert!(b.respond(id, Ok(json!({ "activeView": "trace" }))));
        assert_eq!(fut.await, Ok(json!({ "activeView": "trace" })));
        assert!(!b.respond(id, Ok(json!(null))), "late respond is ignored");
        // Timeout clears the pending entry.
        let r = b
            .call("confirm", json!({}), Duration::from_millis(20))
            .await;
        assert_eq!(r, Err(UI_TIMEOUT.to_string()));
        assert_eq!(b.pending_count(), 0);
        b.detach();
        assert!(!b.attached());
    }

    #[tokio::test]
    async fn dropped_call_future_clears_pending() {
        let b = TauriUiBridge::default();
        b.attach_sink(Box::new(|_| true));
        // Dropped before being polled (e.g. server stop right after dispatch).
        let fut = b.call("get_state", json!({}), Duration::from_secs(30));
        assert_eq!(b.pending_count(), 1);
        drop(fut);
        assert_eq!(b.pending_count(), 0);
        // Cancelled while awaiting (client cancellation): the outer timeout drops the future.
        let fut = b.call("confirm", json!({}), Duration::from_secs(30));
        assert_eq!(b.pending_count(), 1);
        assert!(tokio::time::timeout(Duration::from_millis(20), fut)
            .await
            .is_err());
        assert_eq!(b.pending_count(), 0);
        // Undeliverable request leaves nothing behind.
        b.attach_sink(Box::new(|_| false));
        assert_eq!(
            b.call("get_state", json!({}), Duration::from_secs(1)).await,
            Err(UI_NOT_ATTACHED.to_string())
        );
        assert_eq!(b.pending_count(), 0);
    }
}
