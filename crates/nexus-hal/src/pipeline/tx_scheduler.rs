//! Periodic TX job scheduler and signal range clamping inspector.

use crate::dto::PeriodicTxJobDto;
use crate::error::HalError;
use nexus_core::{BusId, CanIdKey, RawCanFrame};
use nexus_netdb::{CompiledDatabase, SignalId};
use std::time::{Duration, Instant};

/// Internal periodic TX job entry managed by [`TxScheduler`].
#[derive(Clone, Debug)]
pub struct PeriodicJobEntry {
    pub job_id: u64,
    pub label: String,
    pub bus_id: BusId,
    pub can_id: CanIdKey,
    pub message_key: String,
    pub interval_ms: u32,
    pub template_frame: RawCanFrame,
    pub next_due: Instant,
    pub sent_count: u64,
}

/// Deterministic periodic CAN / CAN-FD transmission table with instant Panic-Stop wipe.
#[derive(Debug, Default)]
pub struct TxScheduler {
    next_job_id: u64,
    jobs: Vec<PeriodicJobEntry>,
}

impl TxScheduler {
    /// Creates an empty [`TxScheduler`].
    pub fn new() -> Self {
        Self {
            next_job_id: 1,
            jobs: Vec::new(),
        }
    }

    /// Registers or updates (upserts) a periodic TX job for `(bus_id, can_id)`
    /// (assuming the initial frame was already transmitted once).
    ///
    /// If an active periodic job already exists on the same `(bus_id, can_id)`,
    /// its payload, label, and interval are updated in-place and its existing `job_id`
    /// is returned so duplicate concurrent timers cannot pile up on the same CAN ID.
    pub fn register_job(
        &mut self,
        label: String,
        bus_id: BusId,
        can_id: CanIdKey,
        interval_ms: u32,
        template_frame: RawCanFrame,
    ) -> u64 {
        let clamped_interval = interval_ms.max(1);
        let next_due = Instant::now() + Duration::from_millis(u64::from(clamped_interval));

        if let Some(existing) = self
            .jobs
            .iter_mut()
            .find(|j| j.bus_id == bus_id && j.can_id == can_id)
        {
            existing.label = label;
            existing.interval_ms = clamped_interval;
            existing.template_frame = template_frame;
            existing.next_due = next_due;
            existing.sent_count = existing.sent_count.wrapping_add(1);
            return existing.job_id;
        }

        let id = if self.next_job_id == 0 {
            1
        } else {
            self.next_job_id
        };
        self.next_job_id = id + 1;

        self.jobs.push(PeriodicJobEntry {
            job_id: id,
            label,
            bus_id,
            can_id,
            message_key: can_id.schema_key(),
            interval_ms: clamped_interval,
            template_frame,
            next_due,
            sent_count: 1,
        });
        id
    }

    /// Stops and removes a single periodic TX job by `job_id`.
    pub fn stop_job(&mut self, job_id: u64) -> Result<(), HalError> {
        let prev_len = self.jobs.len();
        self.jobs.retain(|j| j.job_id != job_id);
        if self.jobs.len() == prev_len {
            return Err(HalError::PeriodicJobNotFound(job_id));
        }
        Ok(())
    }

    /// Removes all periodic TX jobs targeting a disconnected `bus_id`.
    pub fn remove_jobs_for_bus(&mut self, bus_id: BusId) -> usize {
        let prev_len = self.jobs.len();
        self.jobs.retain(|j| j.bus_id != bus_id);
        prev_len - self.jobs.len()
    }

    /// Cancels all active periodic TX jobs immediately (Panic Stop) and returns count stopped.
    pub fn clear_all(&mut self) -> usize {
        let count = self.jobs.len();
        self.jobs.clear();
        count
    }

    /// Returns whether there are any active periodic jobs.
    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Lists all active periodic TX jobs in DTO format.
    pub fn list_jobs(&self) -> Vec<PeriodicTxJobDto> {
        self.jobs
            .iter()
            .map(|j| PeriodicTxJobDto {
                job_id: j.job_id,
                label: j.label.clone(),
                bus_id: j.bus_id,
                message_key: j.message_key.clone(),
                arb_id: j.can_id.raw_id(),
                is_extended: j.can_id.is_extended(),
                is_fd: j.template_frame.is_fd(),
                dlc: j.template_frame.dlc.min(64),
                raw_bytes: j.template_frame.payload().to_vec(),
                interval_ms: j.interval_ms,
                sent_count: j.sent_count,
            })
            .collect()
    }

    /// Collects frames due at `now` and advances their next scheduled fire instants.
    pub fn collect_due_frames(&mut self, now: Instant, now_us: u64) -> Vec<(BusId, RawCanFrame)> {
        let mut due = Vec::new();
        for job in &mut self.jobs {
            if now >= job.next_due {
                let mut frame = job.template_frame;
                frame.timestamp_us = now_us;
                due.push((job.bus_id, frame));
                job.sent_count = job.sent_count.wrapping_add(1);

                let step = Duration::from_millis(u64::from(job.interval_ms));
                job.next_due += step;
                if job.next_due <= now {
                    job.next_due = now + step;
                }
            }
        }
        due
    }
}

/// Identifies all signal IDs in `signal_values` whose requested physical values exceed `[min, max]`
/// engineering bounds and will therefore be clamped during TX encoding.
pub fn find_clamped_signals(db: &CompiledDatabase, signal_values: &[(SignalId, f64)]) -> Vec<u32> {
    let mut clamped = Vec::new();
    for &(sig_id, requested_phys) in signal_values {
        if let Some(sig) = db.get_signal(sig_id) {
            if sig.has_bounds
                && (requested_phys < sig.min - 1e-9 || requested_phys > sig.max + 1e-9)
                && !clamped.contains(&sig_id)
            {
                clamped.push(sig_id);
            }
        }
    }
    clamped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_job_upserts_duplicate_bus_and_can_id() {
        let mut sched = TxScheduler::new();
        let can_id = CanIdKey::new_standard(0x7DF).expect("valid standard id");

        let f1 = RawCanFrame::new_classical(0, can_id, &[0x02, 0x01, 0x0C], 0).expect("frame 1");
        let id1 = sched.register_job("OBD_Req_1".to_string(), 0, can_id, 100, f1);

        let f2 = RawCanFrame::new_classical(0, can_id, &[0x02, 0x01, 0x0D], 0).expect("frame 2");
        let id2 = sched.register_job("OBD_Req_Updated".to_string(), 0, can_id, 50, f2);

        assert_eq!(id1, id2, "same (bus_id, can_id) must upsert in-place");
        let jobs = sched.list_jobs();
        assert_eq!(jobs.len(), 1, "must not spawn duplicate periodic jobs");
        assert_eq!(jobs[0].interval_ms, 50);
        assert_eq!(jobs[0].raw_bytes, vec![0x02, 0x01, 0x0D]);
        assert_eq!(jobs[0].sent_count, 2);

        // Different bus_id creates an independent job
        let id_bus1 = sched.register_job("OBD_Bus1".to_string(), 1, can_id, 100, f1);
        assert_ne!(id1, id_bus1);
        assert_eq!(sched.list_jobs().len(), 2);
    }
}
