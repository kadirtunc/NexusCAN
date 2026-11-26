//! [`Device`]: REST control plane of one CANsub.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::rest::{Response, Rest};
use super::tls::{css_root_der, TlsTarget};
use super::{ws, Channel, ChannelStatus, ConnectOptions, DeviceInfo, Error, PhyConfig};
use crate::timing::BitTiming;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// State shared between a [`Device`] and its open [`Channel`]s (the channel needs the REST
/// connection for the §2.7 `DELETE /ws` fallback, also from `Drop`).
#[derive(Debug)]
pub(crate) struct DeviceInner {
    pub(crate) target: Arc<TlsTarget>,
    rest: Mutex<Rest>,
}

impl DeviceInner {
    pub(crate) fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<Response, Error> {
        lock(&self.rest).request(method, path, body)
    }

    fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        let body = self.request("GET", path, None)?.ok()?;
        serde_json::from_slice(&body).map_err(|e| Error::Protocol(format!("GET {path}: {e}")))
    }

    /// `DELETE /api/can/{ch}/ws`; 404 (no WebSocket open) counts as success.
    pub(crate) fn abort_ws(&self, ch: u8) -> Result<(), Error> {
        let r = self.request("DELETE", &format!("/api/can/{ch}/ws"), None)?;
        if r.status == 404 {
            return Ok(());
        }
        r.ok().map(|_| ())
    }
}

#[derive(Deserialize)]
struct InfoDto {
    id: String,
    hw_ver: String,
    fw_ver: String,
}

#[derive(Deserialize)]
struct PtpDto {
    state: String,
}

#[derive(Serialize)]
struct TimingDto {
    brp: u16,
    seg1: u16,
    seg2: u16,
    sjw: u16,
}

impl From<BitTiming> for TimingDto {
    fn from(t: BitTiming) -> Self {
        Self {
            brp: t.brp,
            seg1: t.seg1,
            seg2: t.seg2,
            sjw: t.sjw,
        }
    }
}

#[derive(Serialize)]
struct PhyDto {
    listen_only: bool,
    auto_reset: bool,
    error_frames: bool,
    tx_ack_frames: bool,
    timing: TimingDto,
    timing_data: TimingDto,
}

/// One connected CANsub (REST control connection, keep-alive). `Send + Sync`: all methods take
/// `&self` and serialize on an internal lock, so a health thread can share it with the data path.
#[derive(Debug)]
pub struct Device {
    inner: Arc<DeviceInner>,
    info: DeviceInfo,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Device>();
};

impl Device {
    /// Connects (TLS per §2.6, trusting only the embedded CSS root), checks `GET /api/version`
    /// (major `05`, else [`Error::UnsupportedApi`]) and reads `/api/info` + `/api/can`.
    pub fn connect(opts: ConnectOptions) -> Result<Device, Error> {
        let root = css_root_der()?;
        Self::connect_impl(&opts, &root)
    }

    /// Test-only: like [`Device::connect`] but trusting `root_der` (e.g. the `cansub-sim` run-time
    /// root CA) instead of the CSS root. Not available in production builds (needs the `sim` or
    /// development-only `dev-root` feature).
    #[cfg(any(test, feature = "sim", feature = "dev-root"))]
    pub fn connect_with_root(opts: ConnectOptions, root_der: &[u8]) -> Result<Device, Error> {
        Self::connect_impl(&opts, root_der)
    }

    fn connect_impl(opts: &ConnectOptions, root_der: &[u8]) -> Result<Device, Error> {
        let target = Arc::new(TlsTarget::new(opts, root_der)?);
        let inner = Arc::new(DeviceInner {
            target: target.clone(),
            rest: Mutex::new(Rest::new(target)),
        });
        let raw = inner.request("GET", "/api/version", None)?.ok()?;
        let api = String::from_utf8_lossy(&raw)
            .trim()
            .trim_matches('"')
            .to_string();
        if api.split('.').next() != Some("05") {
            return Err(Error::UnsupportedApi(format!(
                "CANsub API {api}; this SDK requires 05.x"
            )));
        }
        let info: InfoDto = inner.get_json("/api/info")?;
        if let Some(want) = &opts.device_id {
            if !info.id.eq_ignore_ascii_case(want.trim()) {
                return Err(Error::Tls(format!(
                    "device reports ID {} but Device ID {} was requested",
                    info.id,
                    want.trim()
                )));
            }
        }
        let list: Vec<u32> = inner.get_json("/api/can")?;
        let channels = u8::try_from(list.len())
            .ok()
            .filter(|&n| n > 0)
            .ok_or_else(|| Error::Protocol(format!("GET /api/can: {} channels", list.len())))?;
        Ok(Device {
            inner,
            info: DeviceInfo {
                id: info.id.to_ascii_lowercase(),
                variant: format!("CANsub.{channels}"),
                hw: info.hw_ver,
                fw: info.fw_ver,
                api,
                channels,
            },
        })
    }

    /// Identity read at connect time.
    pub fn info(&self) -> &DeviceInfo {
        &self.info
    }

    fn check_ch(&self, ch: u8) -> Result<(), Error> {
        if (1..=self.info.channels).contains(&ch) {
            Ok(())
        } else {
            Err(Error::Protocol(format!(
                "channel {ch} out of range 1..={}",
                self.info.channels
            )))
        }
    }

    /// `GET /api/can/{ch}`: controller state, counters, frame rate and bus load.
    pub fn channel_status(&self, ch: u8) -> Result<ChannelStatus, Error> {
        self.check_ch(ch)?;
        self.inner.get_json(&format!("/api/can/{ch}"))
    }

    /// Writes the host's UTC time to the device (`PUT /api/time`, `rate_ppb: 0`). No-op when
    /// `GET /api/time/ptp` reports `tracking` (PTP-locked); a 404 there means "no PTP".
    /// Note: a manual set disables PTP on the device.
    pub fn set_time_now(&self) -> Result<(), Error> {
        match self.inner.get_json::<PtpDto>("/api/time/ptp") {
            Ok(p) if p.state == "tracking" => return Ok(()),
            Ok(_) | Err(Error::Http { status: 404, .. }) => {}
            Err(e) => return Err(e),
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Protocol("host clock before 1970".into()))?;
        let body = format!(
            r#"{{"utc":"{}","rate_ppb":0}}"#,
            format_utc(now.as_micros() as u64)
        );
        self.inner
            .request("PUT", "/api/time", Some(body.as_bytes()))?
            .ok()
            .map(|_| ())
    }

    /// `PUT /api/can/{ch}/phy` with the complete configuration (all six fields).
    pub fn configure(&self, ch: u8, phy: &PhyConfig) -> Result<(), Error> {
        self.check_ch(ch)?;
        let dto = PhyDto {
            listen_only: phy.listen_only,
            auto_reset: phy.auto_reset,
            error_frames: phy.error_frames,
            tx_ack_frames: phy.tx_ack_frames,
            timing: phy.timing.into(),
            timing_data: phy.timing_data.into(),
        };
        let body = serde_json::to_vec(&dto).map_err(|e| Error::Protocol(e.to_string()))?;
        self.inner
            .request("PUT", &format!("/api/can/{ch}/phy"), Some(&body))?
            .ok()
            .map(|_| ())
    }

    /// Panic-stop helper: lists `GET /api/can/{ch}/transmit` and deletes every sequence.
    /// Returns the number deleted (ids that vanished concurrently, 404, are not counted).
    pub fn delete_transmit_jobs(&self, ch: u8) -> Result<usize, Error> {
        self.check_ch(ch)?;
        let ids: Vec<u32> = self.inner.get_json(&format!("/api/can/{ch}/transmit"))?;
        let mut deleted = 0;
        for id in ids {
            let r = self
                .inner
                .request("DELETE", &format!("/api/can/{ch}/transmit/{id}"), None)?;
            match r.status {
                200..=299 => deleted += 1,
                404 => {}
                _ => {
                    r.ok()?;
                }
            }
        }
        Ok(deleted)
    }

    /// `DELETE /api/can/{ch}/ws`: discards the device TX queue and ends the channel's WebSocket
    /// session immediately (Panic Stop, §2.7 close fallback). Succeeds when no session is open.
    pub fn abort_ws(&self, ch: u8) -> Result<(), Error> {
        self.check_ch(ch)?;
        self.inner.abort_ws(ch)
    }

    /// Opens the channel WebSocket (one client per channel; HTTP 409 → [`Error::Busy`]).
    pub fn open(&self, ch: u8) -> Result<Channel, Error> {
        self.check_ch(ch)?;
        let ws = ws::open(&self.inner.target, ch)?;
        Ok(Channel::new(self.inner.clone(), ch, ws))
    }

    pub(crate) fn inner(&self) -> &DeviceInner {
        &self.inner
    }

    /// Test hook: raw REST request on the device connection, returns `(status, body)`.
    #[cfg(any(test, feature = "sim"))]
    #[doc(hidden)]
    pub fn raw_request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), Error> {
        let r = self.inner.request(method, path, body.map(str::as_bytes))?;
        Ok((r.status, String::from_utf8_lossy(&r.body).into_owned()))
    }
}

/// Unix µs → `YYYY-MM-DDTHH:MM:SS.sssZ` (OpenAPI `time.utc`).
fn format_utc(unix_us: u64) -> String {
    let secs = unix_us / 1_000_000;
    let ms = (unix_us % 1_000_000) / 1000;
    // Civil-from-days (H. Hinnant).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let rem = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_format() {
        assert_eq!(
            format_utc(1_735_689_600_000_000),
            "2025-01-01T00:00:00.000Z"
        );
        assert_eq!(format_utc(951_782_400_123_456), "2000-02-29T00:00:00.123Z");
        assert_eq!(
            format_utc(1_795_440_065_999_000),
            "2026-11-23T13:21:05.999Z"
        );
    }

    #[test]
    fn phy_dto_has_all_openapi_fields() {
        let p = PhyConfig::default();
        let v: serde_json::Value = serde_json::to_value(PhyDto {
            listen_only: p.listen_only,
            auto_reset: p.auto_reset,
            error_frames: p.error_frames,
            tx_ack_frames: p.tx_ack_frames,
            timing: p.timing.into(),
            timing_data: p.timing_data.into(),
        })
        .unwrap();
        for k in [
            "listen_only",
            "auto_reset",
            "error_frames",
            "tx_ack_frames",
            "timing",
            "timing_data",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
        for k in ["brp", "seg1", "seg2", "sjw"] {
            assert!(v["timing"].get(k).is_some() && v["timing_data"].get(k).is_some());
        }
    }
}
