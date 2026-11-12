use crate::compiler::{CompiledDatabase, MAX_MUX_DEPTH};
use crate::error::EncodeError;
use crate::ir::mux::{MuxRole, SignalId};
use crate::ir::SignalValueType;
use nexus_core::{quantize_canfd_payload_len, BusId, CanIdKey, RawCanFrame};
use smallvec::SmallVec;

impl CompiledDatabase {
    /// Zero-allocation TX frame packer.
    /// Packs the specified engineering values into `out_payload`, ensuring automatic switch
    /// resolution, range clamping, and conflict detection.
    /// Returns the active DLC in bytes.
    pub fn encode_payload_into(
        &self,
        can_id: CanIdKey,
        signal_values: &[(SignalId, f64)],
        out_payload: &mut [u8; 64],
    ) -> Result<usize, EncodeError> {
        let msg = self
            .get_message(&can_id)
            .ok_or(EncodeError::MessageNotFound(can_id))?;

        // 1. Verify that all provided signal IDs belong to this message
        for &(sig_id, _) in signal_values {
            if !msg.all_signal_ids.contains(&sig_id) {
                return Err(EncodeError::SignalNotInMessage {
                    signal_id: sig_id,
                    message_key: msg.can_id.schema_key(),
                });
            }
        }

        // 1b. Industrial TX Safety Rule: never transmit NaN / ±Inf. Clamping cannot repair a NaN and
        //     `NaN as int` silently becomes 0 (a plausible-looking but wrong command).
        for &(sig_id, val) in signal_values {
            if !val.is_finite() {
                let signal_name = self
                    .get_signal(sig_id)
                    .map(|s| s.name.clone())
                    .unwrap_or_default();
                return Err(EncodeError::NonFiniteValue {
                    signal_name,
                    value: val,
                });
            }
        }

        // 2. Resolve multiplexer switch requirements & detect conflicts (zero-alloc SmallVec)
        let mut resolved_values: SmallVec<[(SignalId, f64); 32]> = SmallVec::new();
        for &(sig_id, val) in signal_values {
            if let Some(entry) = resolved_values.iter_mut().find(|(s, _)| *s == sig_id) {
                entry.1 = val;
            } else {
                resolved_values.push((sig_id, val));
            }
        }

        // Check each multiplexed signal in the input and enforce/auto-populate its switch hierarchy (multi-hop ancestor walk)
        for &(sig_id, _) in signal_values {
            let mut cur_sig_id = sig_id;
            let mut mux_hops = 0usize;
            while let Some(cur_sig) = self.get_signal(cur_sig_id) {
                if let MuxRole::Multiplexed {
                    switch_signal,
                    ranges,
                    ..
                } = &cur_sig.mux_role
                {
                    mux_hops += 1;
                    if mux_hops > MAX_MUX_DEPTH {
                        // Compile never yields a deeper tree, so this is a cycle without a master
                        // switch or a hand-built database: refuse instead of silently truncating.
                        return Err(EncodeError::MuxTooDeep {
                            signal_id: sig_id,
                            max: MAX_MUX_DEPTH,
                        });
                    }
                    let target_switch_id = *switch_signal;
                    if !msg.all_signal_ids.contains(&target_switch_id) {
                        return Err(EncodeError::SignalNotInMessage {
                            signal_id: target_switch_id,
                            message_key: msg.can_id.schema_key(),
                        });
                    }
                    let required_range = ranges.first().copied().unwrap_or_default();

                    if let Some(existing_sw_val) = resolved_values
                        .iter()
                        .find(|(s, _)| *s == target_switch_id)
                        .map(|(_, v)| *v)
                    {
                        let sw_int = existing_sw_val.round() as i64;
                        if !ranges.iter().any(|r| r.contains(sw_int)) {
                            return Err(EncodeError::ConflictingMuxBranches {
                                message_key: msg.can_id.schema_key(),
                                switch_id: target_switch_id,
                                branch_a: sw_int,
                                branch_b: required_range.start,
                            });
                        }
                    } else {
                        // Auto-populate parent switch selector value with range.start
                        resolved_values.push((target_switch_id, required_range.start as f64));
                    }

                    // Walk up to parent switch
                    cur_sig_id = target_switch_id;
                } else {
                    break;
                }
            }
        }

        // 3. Clear payload buffer
        *out_payload = [0u8; 64];

        // 4. Initialize signals with initial_value (GenSigStartValue) if defined and not explicitly set
        for sig in &msg.all_signals {
            if let Some(init_phys) = sig.initial_value {
                // Defaults of signals whose scaling cannot be inverted are left at raw 0 rather than
                // failing every encode of the message; an explicit value for them still errors.
                if sig.factor == 0.0 || !sig.factor.is_finite() || !sig.offset.is_finite() {
                    continue;
                }
                if !resolved_values.iter().any(|(s, _)| *s == sig.id) {
                    match &sig.mux_role {
                        MuxRole::Static | MuxRole::MasterSwitch => {
                            self.pack_signal_value(sig.id, init_phys, out_payload)?;
                        }
                        MuxRole::Multiplexed {
                            switch_signal,
                            ranges,
                            ..
                        } => {
                            if let Some(sw_val) = resolved_values
                                .iter()
                                .find(|(s, _)| *s == *switch_signal)
                                .map(|(_, v)| *v)
                            {
                                let sw_int = sw_val.round() as i64;
                                if ranges.iter().any(|r| r.contains(sw_int)) {
                                    self.pack_signal_value(sig.id, init_phys, out_payload)?;
                                }
                            }
                        }
                    }
                }
            }
        }

        // 5. Pack resolved signal values
        for &(sig_id, phys_val) in &resolved_values {
            self.pack_signal_value(sig_id, phys_val, out_payload)?;
        }

        // 6. Compute DLC
        let dlc = if msg.protocol.is_can_fd() || msg.dlc > 8 {
            quantize_canfd_payload_len(msg.dlc as usize) as usize
        } else {
            msg.dlc.min(8) as usize
        };

        Ok(dlc)
    }

    /// Packs physical value of a single signal into payload buffer with range clamping.
    fn pack_signal_value(
        &self,
        signal_id: SignalId,
        phys_val: f64,
        out_payload: &mut [u8; 64],
    ) -> Result<(), EncodeError> {
        let sig = self
            .get_signal(signal_id)
            .ok_or(EncodeError::SignalNotFound(signal_id))?;

        if !phys_val.is_finite() {
            return Err(EncodeError::NonFiniteValue {
                signal_name: sig.name.clone(),
                value: phys_val,
            });
        }
        // factor == 0 (or non-finite factor/offset) makes physical -> raw non-invertible: dividing would
        // yield ±Inf/NaN which the integer casts below silently turn into 0 / saturated raw values.
        if sig.factor == 0.0 || !sig.factor.is_finite() || !sig.offset.is_finite() {
            return Err(EncodeError::InvalidScaling {
                signal_name: sig.name.clone(),
                factor: sig.factor,
                offset: sig.offset,
            });
        }

        // Industrial TX Safety Rule: Clamp physical value to engineering bounds.
        // `min <= max` and non-NaN are guaranteed by `compiler::normalize_bounds`; use max/min instead
        // of `f64::clamp` anyway so a hand-built `CompiledSignal` can never trigger its panic.
        let clamped_phys = if sig.has_bounds {
            phys_val.max(sig.min).min(sig.max)
        } else {
            phys_val
        };

        let raw = match sig.value_type {
            SignalValueType::Float32 => {
                // Saturate to the finite f32 range instead of letting `as f32` produce ±Inf.
                let f_val = ((clamped_phys - sig.offset) / sig.factor)
                    .clamp(f32::MIN as f64, f32::MAX as f64) as f32;
                f_val.to_bits() as u64
            }
            SignalValueType::Float64 => {
                let f_val = (clamped_phys - sig.offset) / sig.factor;
                if !f_val.is_finite() {
                    return Err(EncodeError::NonFiniteValue {
                        signal_name: sig.name.clone(),
                        value: phys_val,
                    });
                }
                f_val.to_bits()
            }
            SignalValueType::Signed => {
                let raw_int = ((clamped_phys - sig.offset) / sig.factor).round() as i64;
                let min_val = if sig.bit_len >= 64 {
                    i64::MIN
                } else {
                    -(1i64 << (sig.bit_len - 1))
                };
                let max_val = if sig.bit_len >= 64 {
                    i64::MAX
                } else {
                    (1i64 << (sig.bit_len - 1)) - 1
                };
                let clamped_int = raw_int.clamp(min_val, max_val);
                let mask = if sig.bit_len >= 64 {
                    u64::MAX
                } else {
                    (1u64 << sig.bit_len) - 1
                };
                (clamped_int as u64) & mask
            }
            SignalValueType::Unsigned => {
                let raw_float = ((clamped_phys - sig.offset) / sig.factor).round();
                let max_val = if sig.bit_len >= 64 {
                    u64::MAX
                } else {
                    (1u64 << sig.bit_len) - 1
                };
                if raw_float <= 0.0 {
                    0u64
                } else if raw_float >= max_val as f64 {
                    max_val
                } else {
                    raw_float as u64
                }
            }
        };

        sig.bit_span.pack_raw_u64(raw, out_payload);
        Ok(())
    }

    /// Packs signals into a ready-to-transmit `RawCanFrame`.
    pub fn encode_raw_frame(
        &self,
        bus_id: BusId,
        can_id: CanIdKey,
        signal_values: &[(SignalId, f64)],
        timestamp_us: u64,
    ) -> Result<RawCanFrame, EncodeError> {
        let msg = self
            .get_message(&can_id)
            .ok_or(EncodeError::MessageNotFound(can_id))?;

        let mut payload = [0u8; 64];
        let dlc = self.encode_payload_into(can_id, signal_values, &mut payload)?;

        if msg.protocol.is_can_fd() {
            RawCanFrame::new_fd(bus_id, can_id, &payload[..dlc], true, timestamp_us).map_err(|_e| {
                EncodeError::BitPlan(crate::error::BitPlanError::SpanExceedsPayload {
                    start_bit: 0,
                    bit_len: dlc as u8,
                    max_bits: 512,
                })
            })
        } else {
            RawCanFrame::new_classical(bus_id, can_id, &payload[..dlc], timestamp_us).map_err(
                |_e| {
                    EncodeError::BitPlan(crate::error::BitPlanError::SpanExceedsPayload {
                        start_bit: 0,
                        bit_len: dlc as u8,
                        max_bits: 64,
                    })
                },
            )
        }
    }
}
