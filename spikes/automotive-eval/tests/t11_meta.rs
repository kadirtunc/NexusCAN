//! Madde 11 (çalıştırılabilir kısmı): adaptör worker iş parçacığının boşta CPU maliyeti.
use automotive_eval::*;
use std::time::Duration;

fn cpu_time() -> Duration {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let tv = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
    tv(ru.ru_utime) + tv(ru.ru_stime)
}

#[test]
fn t11_idle_cpu_of_async_can_adapter() {
    let window = Duration::from_secs(2);
    let c0 = cpu_time();
    std::thread::sleep(window);
    let baseline = cpu_time() - c0;

    let adapter = adapter(); // spawns the TX/RX worker thread
    std::thread::sleep(Duration::from_millis(100));
    let c1 = cpu_time();
    std::thread::sleep(window);
    let busy = cpu_time() - c1;
    drop(adapter);

    let pct = busy.as_secs_f64() / window.as_secs_f64() * 100.0;
    println!("idle process: {baseline:?} CPU in 2 s; with 1 idle AsyncCanAdapter: {busy:?} CPU in 2 s = {pct:.0}% of one core");
    // Worker loop polls a non-blocking socket with sleep(1 us) between rounds.
    assert!(pct > 10.0, "expected busy-poll cost");
}
