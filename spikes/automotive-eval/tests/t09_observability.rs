//! Madde 9: Konuşma geçmişi için gözlemlenebilirlik. Crate'te hook/callback yok.
//! Elimizdeki üç yol: (a) Transport dekoratörü, (b) `tracing` olayları, (c) ham çerçeve dinleme.
use automotive::protocols::uds::UDSClient;
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<(Instant, String, String, String)>>>);
struct Msg(String);
impl Visit for Msg {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        } else {
            self.0.push_str(&format!(" {}={value:?}", field.name()));
        }
    }
}
impl<S: tracing::Subscriber> Layer<S> for Capture {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let mut m = Msg(String::new());
        event.record(&mut m);
        let md = event.metadata();
        self.0.lock().unwrap().push((
            Instant::now(),
            md.level().to_string(),
            md.target().to_string(),
            m.0,
        ));
    }
}

#[tokio::test]
async fn t09_a_transport_decorator_conversation_log() {
    let ecu = EcuSim::start("t09_log", "eval.json", CLASSIC, false);
    let adapter = adapter();
    let tp = LoggingTransport::new(IsoTP::new(&adapter, isotp_config(CLASSIC, false)));
    let uds = UDSClient::new(&tp);
    uds.read_data_by_identifier(0xF190u16).await.unwrap();
    uds.read_data_by_identifier(0xFA02u16).await.unwrap();
    let _ = uds.read_data_by_identifier(0xFA04u16).await; // no response
    let log = tp.take();
    println!("PDU-level conversation log (timestamps taken in our decorator):");
    print_pdu_log(&log);
    // Request, 2 x 0x78 and final response are all visible with timing.
    let pend = log.iter().filter(|e| e.data == [0x7F, 0x22, 0x78]).count();
    assert_eq!(pend, 2);
    // A P2 timeout leaves NO trace in the PDU log (the client just stops polling):
    let last = log.last().unwrap();
    assert!(matches!(last.dir, Dir::Tx), "timeout invisible at transport level");
    assert!(ecu.events_of("tx_drop").len() == 1);
}

#[tokio::test]
async fn t09_b_tracing_events_are_strings_only() {
    let _ecu = EcuSim::start("t09_tracing", "eval.json", CLASSIC, false);
    let cap = Capture::default();
    let subscriber = tracing_subscriber::registry().with(cap.clone());
    let _guard = tracing::subscriber::set_default(subscriber);

    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    uds.read_data_by_identifier(0xF190u16).await.unwrap();
    uds.read_data_by_identifier(0xFA02u16).await.unwrap();

    let events = cap.0.lock().unwrap().clone();
    let t0 = events.first().map(|e| e.0).unwrap();
    for (t, lvl, target, msg) in &events {
        println!("  +{:>8.3} ms {lvl:5} {target}: {msg}", t.duration_since(t0).as_secs_f64() * 1e3);
    }
    // What exists: TX SF/FF/CF/FC debug strings and an info "Received Response Pending".
    assert!(events.iter().any(|e| e.3.contains("TX FC")));
    assert!(events.iter().any(|e| e.3.contains("Received Response Pending")));
    // What does not: received frames, completed RX PDUs, FC received, timeouts.
    assert!(!events.iter().any(|e| e.3.starts_with("RX")));
}

#[tokio::test]
async fn t09_c_raw_frame_tap_has_no_timestamps() {
    let _ecu = EcuSim::start("t09_tap", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let (frames, vin) = tokio::join!(
        tap_frames(&adapter, &[CLASSIC.req, CLASSIC.resp], Duration::from_millis(300)),
        async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            uds.read_data_by_identifier(0xF190u16).await
        }
    );
    vin.unwrap();
    let t0 = frames[0].0;
    for (t, f) in &frames {
        println!(
            "  +{:>8.3} ms {:03X} loopback={} {}",
            t.duration_since(t0).as_secs_f64() * 1e3,
            u32::from(f.id().unwrap()),
            f.loopback,
            hex::encode_upper(f.data())
        );
    }
    // Own TX frames come back as loopback=true (emulated on vcan: IFF_ECHO off).
    assert!(frames.iter().any(|(_, f)| f.loopback && f.data()[0] == 0x30));
    assert_eq!(frames.len(), 5);
}
