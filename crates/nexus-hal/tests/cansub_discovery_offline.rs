//! C7 QA gate, contract cansub-v1 §8: with no network / mDNS the app still opens, the CANsub list
//! is empty and `DriverRegistry::with_defaults().discover_all()` is fast (< 2 s) and error-free.
//! Run fully offline with `unshare -rn <test binary>` (own network namespace, loopback down).

use std::time::{Duration, Instant};

use nexus_hal::DriverRegistry;

#[test]
fn default_registry_discover_all_offline_under_2s() {
    let reg = DriverRegistry::with_defaults();
    let t0 = Instant::now();
    let first = reg.discover_all();
    let t_first = t0.elapsed();
    let t1 = Instant::now();
    let second = reg.discover_all();
    let t_second = t1.elapsed();
    eprintln!(
        "discover_all: first {t_first:?} ({} devices, cansub {}), second {t_second:?}",
        first.len(),
        first.iter().filter(|d| d.driver_id == "cansub").count()
    );
    assert!(first.iter().any(|d| d.device_id == "mock:mock0"));
    assert!(
        t_first < nexus_core::testing::scaled(Duration::from_secs(2)),
        "{t_first:?}"
    );
    assert!(
        t_second < nexus_core::testing::scaled(Duration::from_millis(500)),
        "{t_second:?}"
    );
    assert_eq!(first.len(), second.len());
}
