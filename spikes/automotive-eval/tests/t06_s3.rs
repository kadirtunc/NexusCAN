//! Madde 6: S3 / TesterPresent. Crate arka planda 3E göndermez; sarmalayıcı ile ekleriz.
use automotive::protocols::uds::{SessionType, UDSClient, UDSConfig};
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn t06_session_drops_after_s3_without_keepalive() {
    let ecu = EcuSim::start("t06_s3", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);

    uds.diagnostic_session_control(SessionType::ExtendedDiagnostic).await.unwrap();
    let dump = Candump::start("t06_s3_idle", &[CLASSIC.req]);
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let idle_frames = dump.stop();
    println!("client frames on {:#x} during 3.5 s idle: {}", CLASSIC.req, idle_frames.len());
    assert!(idle_frames.is_empty(), "crate sends no automatic TesterPresent");

    let s = uds.read_data_by_identifier(0xF186u16).await.unwrap();
    println!("F186 after idle = {s:02X?}; ECU s3 events = {:?}", ecu.events_of("s3_timeout"));
    assert_eq!(s, [0x01]);
    assert_eq!(ecu.events_of("s3_timeout").len(), 1);
}

#[test]
fn t06_session_kept_by_wrapper_keepalive() {
    let ecu = EcuSim::start("t06_keepalive", "default", CLASSIC, false);
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async {
        let adapter = Arc::new(adapter());
        let isotp = Arc::new(IsoTP::new_owned(adapter.clone(), isotp_config(CLASSIC, false)));
        let client: SharedClient = Arc::new(tokio::sync::Mutex::new(
            UDSClient::with_owned_transport(isotp, UDSConfig::default()),
        ));
        client
            .lock()
            .await
            .diagnostic_session_control(SessionType::ExtendedDiagnostic)
            .await
            .unwrap();

        let (handle, stop) = spawn_keepalive(client.clone(), Duration::from_millis(2000));
        // Foreground requests interleave safely because both sides take the lock.
        for _ in 0..7 {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            let v = client.lock().await.read_data_by_identifier(0xF190u16).await.unwrap();
            assert_eq!(v.len(), 17);
        }
        tokio::time::sleep(Duration::from_millis(3200)).await; // idle > S3, keepalive only
        let s = client.lock().await.read_data_by_identifier(0xF186u16).await.unwrap();
        stop.send(true).unwrap();
        let sent = handle.await.unwrap();
        println!("keepalive sent {sent} x 3E80; F186 = {s:02X?}");
        assert_eq!(s, [0x03]);
        assert!(sent >= 4);
    });
    let tp = ecu.rx_data().iter().filter(|d| *d == "3E80").count();
    println!("ECU rx 3E80 = {tp}; s3_timeout = {}", ecu.events_of("s3_timeout").len());
    assert!(ecu.events_of("s3_timeout").is_empty());
}
