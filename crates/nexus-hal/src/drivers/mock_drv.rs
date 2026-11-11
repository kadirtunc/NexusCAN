//! Deterministic high-speed (`100..=100,000 fps`) synthetic EV Powertrain + Multi-Bank BMS
//! CAN / CAN-FD driver (`mock0`), available on every operating system without kernel modules.
//!
//! Generates animated waveforms matching both `scripts/sample_vehicle.dbc` and
//! `scripts/sample_bms.kcd`, including 64-byte CAN-FD frames, IEEE-754 `f32`/`f64` signals,
//! Motorola sawtooth cross-byte spans, 29-bit SAE J1939 PGNs, 4-bank KCD cell voltages (`0x301`),
//! and cascaded DBC multiplexer domains (`0x105`).

use crate::dto::{AdapterCapabilitiesDto, DeviceDescriptorDto};
use crate::error::AdapterError;
use crate::traits::{
    AdapterCapabilities, AdapterDriver, BusHealthSnapshot, BusState, CanChannel, CanFilter,
    ChannelConfig, DeviceDescriptor, ListenOnlyEnforcement,
};
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use nexus_core::{
    now_monotonic_us, BusId, CanIdKey, RawCanFrame, FLAG_BRS, FLAG_EXTENDED, FLAG_FD,
    FLAG_HW_TIMESTAMP, FLAG_TX,
};
use rustc_hash::FxHashMap;
use std::f64::consts::TAU;
use std::thread;
use std::time::{Duration, Instant};

/// Canonical device ID for the primary virtual EV Powertrain + BMS bus (`mock0`).
pub const MOCK0_DEVICE_ID: &str = "mock:mock0";

/// Canonical device ID for the secondary virtual Auxiliary / Charger bus (`mock1`).
pub const MOCK1_DEVICE_ID: &str = "mock:mock1";

/// Hold window (`3.0 s`) suppressing synthetic `mock0`/`mock1` frames on a `CanIdKey` after user TX.
const TX_OVERRIDE_HOLD_US: u64 = 3_000_000;

/// Built-in cross-OS synthetic CAN / CAN-FD adapter driver.
#[derive(Clone, Copy, Debug, Default)]
pub struct MockCanDriver;

impl MockCanDriver {
    /// Creates a new [`MockCanDriver`].
    pub const fn new() -> Self {
        Self
    }

    /// Returns the static descriptor for `mock0` (Primary EV Powertrain + BMS Bus).
    pub fn mock0_descriptor() -> DeviceDescriptorDto {
        DeviceDescriptorDto {
            device_id: MOCK0_DEVICE_ID.to_string(),
            driver_id: "mock".to_string(),
            channel_name: "mock0".to_string(),
            display_name: "mock0 — Virtual EV Powertrain + BMS Bus".to_string(),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: true,
                max_bitrate: 8_000_000,
                is_virtual: true,
            },
        }
    }

    /// Returns the static descriptor for `mock1` (Secondary Auxiliary / DC Fast-Charger Bus).
    pub fn mock1_descriptor() -> DeviceDescriptorDto {
        DeviceDescriptorDto {
            device_id: MOCK1_DEVICE_ID.to_string(),
            driver_id: "mock".to_string(),
            channel_name: "mock1".to_string(),
            display_name: "mock1 — Virtual Auxiliary / Charger Bus".to_string(),
            capabilities: AdapterCapabilitiesDto {
                supports_fd: true,
                supports_listen_only: true,
                supports_hw_timestamps: true,
                max_bitrate: 8_000_000,
                is_virtual: true,
            },
        }
    }
}

impl AdapterDriver for MockCanDriver {
    fn driver_id(&self) -> &'static str {
        "mock"
    }

    fn display_name(&self) -> &'static str {
        "NexusCAN Virtual EV + BMS Bus Generator"
    }

    fn discover_devices(&self) -> Result<Vec<DeviceDescriptor>, AdapterError> {
        Ok(vec![Self::mock0_descriptor(), Self::mock1_descriptor()])
    }

    fn open_channel(
        &self,
        device: &DeviceDescriptor,
        config: &ChannelConfig,
    ) -> Result<Box<dyn CanChannel>, AdapterError> {
        let is_valid_mock = device.driver_id == "mock"
            || device.device_id.starts_with("mock:")
            || device.channel_name.starts_with("mock");
        if !is_valid_mock {
            return Err(AdapterError::DeviceNotFound(device.device_id.clone()));
        }
        Ok(Box::new(MockCanChannel::new(device.clone(), config.clone())))
    }
}

/// Human-trackable calm ECU cycle periods in microseconds (`~15–17 msg/s` total, default mode):
/// - `0`: `0x201` (`INV_FastTelemetryFD`, 64B CAN-FD) -> `250_000 us` (`250 ms`, `4 Hz`)
/// - `1`: `0x101` (`INV_MotorStatus`, 8B) -> `250_000 us` (`250 ms`, `4 Hz`)
/// - `2`: `0x105` (`BMS_MuxDiagnostics`, 8B Cascaded Mux) -> `500_000 us` (`500 ms`, `2 Hz`)
/// - `3`: `0x302` (`BMS_PackPowerAndLimits`, 8B) -> `400_000 us` (`400 ms`, `2.5 Hz`)
/// - `4`: `0x301` (`CMC_CellVoltagesMux`, 8B 4-Bank Mux) -> `500_000 us` (`500 ms`, `2 Hz`)
/// - `5`: `0x303` (`Thermal_CoolantFloatMetrics`, 8B) -> `1_000_000 us` (`1000 ms`, `1 Hz`)
/// - `6`: `0x18FF50E5` (`DCFC_ChargerStatus`, 8B J1939) -> `1_000_000 us` (`1000 ms`, `1 Hz`)
/// - `7`: `0x18F00900` (`BMS_AccumulatedEnergyExt`, 8B) -> `2_000_000 us` (`2000 ms`, `0.5 Hz`)
const CALM_ECU_PERIODS_US: [u64; 8] = [
    250_000,
    250_000,
    500_000,
    400_000,
    500_000,
    1_000_000,
    1_000_000,
    2_000_000,
];

/// Nominal real-time `.dbc` / `.kcd` ECU cycle periods in microseconds (`~475 msg/s`, `Some(475)`):
/// - `0`: `0x201` (`5 ms`), `1`: `0x101` (`10 ms`), `2`: `0x105` (`20 ms`), `3`: `0x302` (`20 ms`),
/// - `4`: `0x301` (`25 ms`), `5`: `0x303` (`50 ms`), `6`: `0x18FF50E5` (`100 ms`), `7`: `0x18F00900` (`200 ms`)
const NOMINAL_ECU_PERIODS_US: [u64; 8] = [
    5_000,
    10_000,
    20_000,
    20_000,
    25_000,
    50_000,
    100_000,
    200_000,
];

/// Staggered initial ECU phase offsets (`0..3.5 ms`) preventing artificial t=0 bus collisions.
const ECU_INITIAL_OFFSETS_US: [u64; 8] = [0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500];

/// Auxiliary / Charger bus (`mock1`) initial phase offsets focusing on `0x302`, `0x303`, `0x18FF50E5`, `0x18F00900`.
const AUX_ECU_INITIAL_OFFSETS_US: [u64; 8] = [
    u64::MAX,
    u64::MAX,
    u64::MAX,
    1_200,
    u64::MAX,
    2_400,
    3_600,
    4_800,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MockPacingMode {
    /// Default human-trackable calm schedule (`None | Some(0)`, `~15–17 msg/s`, `45 s` drive cycle).
    CalmTrackableSchedule,
    /// Nominal real-time `.dbc` / `.kcd` ECU cycle schedule (`Some(475)`, `~475 msg/s`, `20 s` drive cycle).
    NominalEcuSchedule,
    /// High-speed synthetic stress-test burst generator (`Some(fps)`, `100..=100,000 fps`).
    BurstFps(u64),
}

impl MockPacingMode {
    #[inline]
    const fn drive_cycle_period_sec(self) -> f64 {
        match self {
            Self::CalmTrackableSchedule => 45.0,
            Self::NominalEcuSchedule | Self::BurstFps(_) => 20.0,
        }
    }
}

/// Active synthetic `mock0` / `mock1` channel instance with monotonic microsecond pacing and TX loopback.
pub struct MockCanChannel {
    descriptor: DeviceDescriptor,
    bus_id: BusId,
    is_aux_bus: bool,
    enable_fd: bool,
    listen_only: bool,
    closed: bool,
    pacing: MockPacingMode,
    ecu_next_due_us: [u64; 8],
    start_instant: Instant,
    base_timestamp_us: u64,
    emitted_frames: u64,
    fd_frame_counter: u64,
    mux_105_step: u8,
    mux_301_bank: u8,
    fd_alive_counter: u8,
    cmc_rolling_counter: u8,
    filters: Vec<CanFilter>,
    tx_override_until_us: FxHashMap<CanIdKey, u64>,
    loopback_tx: Sender<RawCanFrame>,
    loopback_rx: Receiver<RawCanFrame>,
}

impl MockCanChannel {
    /// Constructs a new paced `mock0` or `mock1` channel.
    pub fn new(descriptor: DeviceDescriptor, config: ChannelConfig) -> Self {
        let pacing = match config.mock_fps_preset {
            None | Some(0) => MockPacingMode::CalmTrackableSchedule,
            Some(475) => MockPacingMode::NominalEcuSchedule,
            Some(fps) => MockPacingMode::BurstFps(u64::from(fps.clamp(100, 100_000))),
        };
        let is_aux_bus =
            descriptor.device_id == MOCK1_DEVICE_ID || descriptor.channel_name == "mock1";
        let mut ecu_next_due_us = if is_aux_bus {
            AUX_ECU_INITIAL_OFFSETS_US
        } else {
            ECU_INITIAL_OFFSETS_US
        };
        if !config.enable_fd {
            // Skip 0x201 (64B CAN-FD) when channel is opened in Classical CAN-only mode
            ecu_next_due_us[0] = u64::MAX;
        }
        let (loopback_tx, loopback_rx) = bounded(1_024);
        Self {
            descriptor,
            bus_id: config.bus_id,
            is_aux_bus,
            enable_fd: config.enable_fd,
            listen_only: config.listen_only,
            closed: false,
            pacing,
            ecu_next_due_us,
            start_instant: Instant::now(),
            base_timestamp_us: now_monotonic_us().max(1),
            emitted_frames: 0,
            fd_frame_counter: 0,
            mux_105_step: 0,
            mux_301_bank: 0,
            fd_alive_counter: 0,
            cmc_rolling_counter: 0,
            filters: Vec::new(),
            tx_override_until_us: FxHashMap::default(),
            loopback_tx,
            loopback_rx,
        }
    }

    #[inline]
    fn elapsed_us(&self) -> u64 {
        self.start_instant
            .elapsed()
            .as_micros()
            .min(u128::from(u64::MAX)) as u64
    }

    #[inline]
    fn is_suppressed_by_tx_override(&self, can_id: CanIdKey, now_elapsed_us: u64) -> bool {
        !self.tx_override_until_us.is_empty()
            && self
                .tx_override_until_us
                .get(&can_id)
                .is_some_and(|&until_us| now_elapsed_us < until_us)
    }

    #[inline]
    fn passes_filters(&self, frame: &RawCanFrame) -> bool {
        if self.filters.is_empty() {
            return true;
        }
        let is_ext = frame.is_extended();
        self.filters.iter().any(|flt| {
            let ext_ok = match flt.extended {
                Some(req_ext) => req_ext == is_ext,
                None => true,
            };
            ext_ok && ((frame.arb_id & flt.mask) == (flt.id & flt.mask))
        })
    }

    #[inline]
    fn drain_loopback(&self, out_batch: &mut [RawCanFrame], written: &mut usize) {
        while *written < out_batch.len() {
            match self.loopback_rx.try_recv() {
                Ok(tx_echo) => {
                    if self.passes_filters(&tx_echo) {
                        out_batch[*written] = tx_echo;
                        *written += 1;
                    }
                }
                Err(_) => break,
            }
        }
    }

    /// Synthesizes a specific ECU slot (`0..8`) at its exact scheduled microsecond timestamp.
    #[inline]
    fn synthesize_ecu_slot(&mut self, slot: usize, timestamp_us: u64) -> RawCanFrame {
        self.emitted_frames = self.emitted_frames.wrapping_add(1);
        let t_sec = (timestamp_us.saturating_sub(self.base_timestamp_us) as f64) * 1e-6;
        let drive_period_sec = self.pacing.drive_cycle_period_sec();

        match slot {
            0 => self.build_0x201_fast_telemetry_fd(timestamp_us, t_sec, drive_period_sec),
            1 => self.build_0x101_motor_status(timestamp_us, t_sec, drive_period_sec),
            2 => self.build_0x105_bms_mux_diagnostics(timestamp_us, t_sec, drive_period_sec),
            3 => self.build_0x302_bms_pack_power_limits(timestamp_us, t_sec, drive_period_sec),
            4 => self.build_0x301_cmc_cell_voltages_mux(timestamp_us, t_sec, drive_period_sec),
            5 => self.build_0x303_thermal_coolant_floats(timestamp_us, t_sec),
            6 => self.build_0x18ff50e5_dcfc_status(timestamp_us, t_sec),
            _ => self.build_0x18f00900_accumulated_energy_ext(timestamp_us, t_sec),
        }
    }

    /// Generates the next deterministic synthetic CAN / CAN-FD frame in high-speed round-robin burst mode.
    #[inline]
    fn synthesize_next_burst_frame(&mut self, fps: u64) -> RawCanFrame {
        let seq = self.emitted_frames;
        self.emitted_frames = self.emitted_frames.wrapping_add(1);

        let timestamp_us = self
            .base_timestamp_us
            .saturating_add(((u128::from(seq) * 1_000_000) / u128::from(fps)) as u64);

        let t_sec = (timestamp_us.saturating_sub(self.base_timestamp_us) as f64) * 1e-6;
        let drive_period_sec = self.pacing.drive_cycle_period_sec();
        if self.is_aux_bus {
            return match (seq % 4) as u8 {
                0 => self.build_0x18ff50e5_dcfc_status(timestamp_us, t_sec),
                1 => self.build_0x302_bms_pack_power_limits(timestamp_us, t_sec, drive_period_sec),
                2 => self.build_0x303_thermal_coolant_floats(timestamp_us, t_sec),
                _ => self.build_0x18f00900_accumulated_energy_ext(timestamp_us, t_sec),
            };
        }

        let slot = (seq % 8) as u8;
        match slot {
            0 => self.build_0x101_motor_status(timestamp_us, t_sec, drive_period_sec),
            1 => self.build_0x105_bms_mux_diagnostics(timestamp_us, t_sec, drive_period_sec),
            2 if self.enable_fd => {
                self.build_0x201_fast_telemetry_fd(timestamp_us, t_sec, drive_period_sec)
            }
            2 => self.build_0x101_motor_status(timestamp_us, t_sec, drive_period_sec),
            3 => self.build_0x18ff50e5_dcfc_status(timestamp_us, t_sec),
            4 => self.build_0x301_cmc_cell_voltages_mux(timestamp_us, t_sec, drive_period_sec),
            5 => self.build_0x302_bms_pack_power_limits(timestamp_us, t_sec, drive_period_sec),
            6 => self.build_0x303_thermal_coolant_floats(timestamp_us, t_sec),
            _ => self.build_0x18f00900_accumulated_energy_ext(timestamp_us, t_sec),
        }
    }

    /// `0x101` (`INV_MotorStatus`, 8B Classical CAN):
    /// Smooth dynamometer drive-cycle (`-400..6800 rpm`), Motorola sawtooth Torque (`-150..240 Nm`)
    /// & load-compensated DC Bus (`780..804 V`).
    #[inline]
    fn build_0x101_motor_status(
        &self,
        timestamp_us: u64,
        t_sec: f64,
        drive_period_sec: f64,
    ) -> RawCanFrame {
        let mut data = [0u8; 64];
        let drive_omega = TAU / drive_period_sec;
        let speed_wave = (t_sec * drive_omega).sin();
        let accel_wave = (t_sec * drive_omega).cos();

        // MotorSpeedRpm: [-400 .. +6800 rpm], factor 0.5
        let rpm = 3_200.0 + 3_600.0 * speed_wave;
        let raw_rpm = ((rpm / 0.5).round() as i16) as u16;
        pack_intel(&mut data, 0, 16, u64::from(raw_rpm));

        // MotorTorqueNm: [-150 .. +240 Nm], factor 0.1, Motorola MSB 19
        let torque_nm = 45.0 + 195.0 * accel_wave;
        let raw_torque = ((torque_nm / 0.1).round() as i16) as u16;
        pack_motorola_sawtooth(&mut data, 19, 16, u64::from(raw_torque));

        // InverterState: 3 = TorqueControl when torque >= 0, 5 = RegenBraking when torque < 0
        let inv_state: u64 = if torque_nm >= 0.0 { 3 } else { 5 };
        pack_motorola_sawtooth(&mut data, 23, 4, inv_state);

        // DcBusVoltage: [780 .. 804 V], slight sag under traction load & rise under regen, factor 0.25, Motorola MSB 35
        let dc_bus_v = 792.0 - 12.0 * accel_wave;
        let raw_dc_v = ((dc_bus_v / 0.25).round() as u16) & 0x0FFF;
        pack_motorola_sawtooth(&mut data, 35, 12, u64::from(raw_dc_v));

        // DriveGearState: 3 = Drive when rpm >= 0, 1 = Reverse when rpm < 0
        let gear: u64 = if rpm >= 0.0 { 3 } else { 1 };
        pack_intel(&mut data, 48, 4, gear);

        // PhaseCurrentAmp: [-150 .. +280 A], factor 0.5, 11-bit signed Intel at bit 52
        let current_a = 65.0 + 215.0 * accel_wave;
        let raw_curr = ((current_a / 0.5).round() as i16) as u16 & 0x07FF;
        pack_intel(&mut data, 52, 11, u64::from(raw_curr));

        // ActiveFaultFlag: bit 63 = 0 (Normal)
        RawCanFrame {
            timestamp_us,
            arb_id: 0x101,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x105` (`BMS_MuxDiagnostics`, 8B Classical CAN):
    /// Cycles `MuxDomainSwitch` and `SubBankSwitch` across all 5 cascaded paths
    /// (`(0,0) -> (0,1) -> (1,0) -> (1,1) -> (2)`) with gradual SOC evolution and `~0.1 °C/s` thermal drift.
    #[inline]
    fn build_0x105_bms_mux_diagnostics(
        &mut self,
        timestamp_us: u64,
        t_sec: f64,
        drive_period_sec: f64,
    ) -> RawCanFrame {
        let mut data = [0u8; 64];
        let step = self.mux_105_step;
        self.mux_105_step = (self.mux_105_step + 1) % 5;

        let accel_wave = (t_sec * (TAU / drive_period_sec)).cos();
        let thermal_omega = TAU / 125.0; // max dT/dt = 2.0 * (2*pi/125) = 0.10 degC/s

        // Static PackSocPct: 78.5% +/- 2.5% over a 180s horizon, factor 0.5 -> raw 0..200
        let soc_pct = 78.5 - 2.5 * (t_sec * (TAU / 180.0)).sin();
        let raw_soc = (soc_pct / 0.5).round().clamp(0.0, 200.0) as u64;
        pack_intel(&mut data, 8, 8, raw_soc);

        let sag_mv = -8.0 * accel_wave;
        match step {
            0 => {
                // MuxDomainSwitch = 0, SubBankSwitch = 0 -> Domain 0 / Bank 0 cells
                pack_intel(&mut data, 0, 4, 0);
                pack_intel(&mut data, 4, 4, 0);
                let min_mv = ((3_686.0 + sag_mv) / 0.1).round() as u64;
                let max_mv = ((3_714.0 + sag_mv) / 0.1).round() as u64;
                let temp_raw =
                    (((28.4 + 2.0 * (t_sec * thermal_omega).sin()) / 0.01).round() as i16) as u16;
                pack_intel(&mut data, 16, 16, min_mv);
                pack_intel(&mut data, 32, 16, max_mv);
                pack_intel(&mut data, 48, 16, u64::from(temp_raw));
            }
            1 => {
                // MuxDomainSwitch = 0, SubBankSwitch = 1 -> Domain 0 / Bank 1 cells
                pack_intel(&mut data, 0, 4, 0);
                pack_intel(&mut data, 4, 4, 1);
                let min_mv = ((3_691.0 + sag_mv) / 0.1).round() as u64;
                let max_mv = ((3_720.0 + sag_mv) / 0.1).round() as u64;
                let temp_raw =
                    (((29.0 + 2.0 * (t_sec * thermal_omega).cos()) / 0.01).round() as i16) as u16;
                pack_intel(&mut data, 16, 16, min_mv);
                pack_intel(&mut data, 32, 16, max_mv);
                pack_intel(&mut data, 48, 16, u64::from(temp_raw));
            }
            2 => {
                // MuxDomainSwitch = 1, SubBankSwitch = 0 -> Domain 1 / Bank 0 cells (+3.0 mV offset)
                pack_intel(&mut data, 0, 4, 1);
                pack_intel(&mut data, 4, 4, 0);
                let min_mv = ((3_689.0 + sag_mv) / 0.1).round() as u64;
                let max_mv = ((3_717.0 + sag_mv) / 0.1).round() as u64;
                let temp_raw =
                    (((28.8 + 2.0 * (t_sec * thermal_omega).sin()) / 0.01).round() as i16) as u16;
                pack_intel(&mut data, 16, 16, min_mv);
                pack_intel(&mut data, 32, 16, max_mv);
                pack_intel(&mut data, 48, 16, u64::from(temp_raw));
            }
            3 => {
                // MuxDomainSwitch = 1, SubBankSwitch = 1 -> Domain 1 / Bank 1 cells (+3.0 mV offset)
                pack_intel(&mut data, 0, 4, 1);
                pack_intel(&mut data, 4, 4, 1);
                let min_mv = ((3_694.0 + sag_mv) / 0.1).round() as u64;
                let max_mv = ((3_723.0 + sag_mv) / 0.1).round() as u64;
                let temp_raw =
                    (((29.4 + 2.0 * (t_sec * thermal_omega).cos()) / 0.01).round() as i16) as u16;
                pack_intel(&mut data, 16, 16, min_mv);
                pack_intel(&mut data, 32, 16, max_mv);
                pack_intel(&mut data, 48, 16, u64::from(temp_raw));
            }
            _ => {
                // MuxDomainSwitch = 2 -> Contactor, Isolation, Pack Voltage, FaultCode, HVIL
                pack_intel(&mut data, 0, 4, 2);
                pack_intel(&mut data, 4, 4, 2); // ContactorState = 2 (AllClosed_HVActive)
                let iso_raw = (2_480.0 / 0.5) as u64; // 2480 kOhm
                let pack_v_raw = ((792.0 - 10.0 * accel_wave) / 0.05).round() as u64;
                pack_intel(&mut data, 16, 16, iso_raw);
                pack_intel(&mut data, 32, 16, pack_v_raw);
                pack_intel(&mut data, 48, 8, 0); // BmsFaultCode = 0 (NoFault)
                pack_intel(&mut data, 56, 1, 1); // HvInterlockClosed = 1 (Closed_OK)
            }
        }

        RawCanFrame {
            timestamp_us,
            arb_id: 0x105,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x201` (`INV_FastTelemetryFD`, 64B CAN-FD + BRS):
    /// Exercises bits `0..511`, `f32` `FluxLinkageWb`, `f64` `TotalEnergyKwh`, Motorola sawtooth
    /// `ShaftTorqueFineNm` across bytes `32..34`, and `TailIntegrityMarker = 0xA5` at byte `63`.
    #[inline]
    fn build_0x201_fast_telemetry_fd(
        &mut self,
        timestamp_us: u64,
        t_sec: f64,
        drive_period_sec: f64,
    ) -> RawCanFrame {
        let mut data = [0u8; 64];
        let fd_seq = self.fd_frame_counter;
        self.fd_frame_counter = self.fd_frame_counter.wrapping_add(1);

        let alive = self.fd_alive_counter & 0x0F;
        self.fd_alive_counter = (self.fd_alive_counter + 1) & 0x0F;

        let drive_omega = TAU / drive_period_sec;
        let thermal_omega = TAU / 125.0; // ~0.10 degC/s gradual inverter SiC temperature drift

        let crc16 = ((fd_seq as u16).wrapping_mul(0x9E37)) ^ u16::from(alive);
        pack_intel(&mut data, 0, 16, u64::from(crc16));
        pack_intel(&mut data, 16, 4, u64::from(alive));
        pack_intel(&mut data, 20, 4, 0x05); // E2E_DataId
        pack_intel(&mut data, 32, 32, u64::from(timestamp_us as u32));

        // FluxLinkageWb: IEEE-754 f32 at bit 64 (bytes 8..12), [-10..10 Wb]
        let flux_wb = (0.185 + 0.020 * (t_sec * drive_omega).sin()) as f32;
        pack_intel(&mut data, 64, 32, u64::from(flux_wb.to_bits()));

        // TotalEnergyKwh: IEEE-754 f64 at bit 128 (bytes 16..24), smooth 36 kW average (~0.010 kWh/s)
        let total_energy_kwh = 142.50 + t_sec * 0.010;
        pack_intel(&mut data, 128, 64, total_energy_kwh.to_bits());

        // SubFrameSlotId (Motorola MSB 263, 4 bits)
        pack_motorola_sawtooth(&mut data, 263, 4, fd_seq & 0x07);

        // ShaftTorqueFineNm (Motorola MSB 259, 16 bits signed, factor 0.01, [-320..320 Nm])
        let fine_torque_nm = 45.0 + 195.0 * (t_sec * drive_omega).cos();
        let raw_fine_torque = ((fine_torque_nm / 0.01).round() as i16) as u16;
        pack_motorola_sawtooth(&mut data, 259, 16, u64::from(raw_fine_torque));

        // ResolverQualityPct (Motorola MSB 275, 12 bits unsigned, factor 0.025 -> 99.5% = 3980)
        pack_motorola_sawtooth(&mut data, 275, 12, 3_980);

        // Keep intermediate telemetry pad byte gently animated with alive counter
        data[40] = alive.wrapping_mul(17);

        // SiCBridgeTempMaxDegC (Intel bit 488 = byte 61..62, 16-bit signed, factor 0.01, ~0.10 degC/s)
        let sic_temp = 66.5 + 2.0 * (t_sec * thermal_omega).sin();
        let raw_sic_temp = ((sic_temp / 0.01).round() as i16) as u16;
        pack_intel(&mut data, 488, 16, u64::from(raw_sic_temp));

        // TailIntegrityMarker (Intel bit 504 = byte 63) = 0xA5
        pack_intel(&mut data, 504, 8, 0xA5);

        RawCanFrame {
            timestamp_us,
            arb_id: 0x201,
            bus_id: self.bus_id,
            dlc: 64,
            flags: FLAG_FD | FLAG_BRS | FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x18FF50E5` (Extended 29-bit J1939 `DCFC_ChargerStatus`, 8B):
    /// `802.5 V`, smooth DC charge current & gradual connector temperature (`~0.1 °C/s`).
    #[inline]
    fn build_0x18ff50e5_dcfc_status(&self, timestamp_us: u64, t_sec: f64) -> RawCanFrame {
        let mut data = [0u8; 64];

        // ChargerOutputVoltageV: 802.5 V -> raw 8025 (factor 0.1)
        pack_intel(&mut data, 0, 16, 8_025);

        // ChargerOutputCurrentA: factor 0.1, offset -1000 -> +185.0 A +/- 12.0 A over 40s
        let charge_current_a = 185.0 + 12.0 * (t_sec * (TAU / 40.0)).sin();
        let raw_charge_a = ((charge_current_a + 1_000.0) / 0.1).round() as u64;
        pack_intel(&mut data, 16, 16, raw_charge_a);

        // ChargerOperatingState = 3 (ConstantCurrent), CableLockEngaged = 1 (Locked)
        pack_intel(&mut data, 32, 4, 3);
        pack_intel(&mut data, 36, 2, 1);

        // ConnectorTempDegC: factor 1, offset -40 -> ~39..43 degC (~0.10 degC/s drift)
        let conn_temp_c = (41.0 + 2.0 * (t_sec * (TAU / 125.0)).sin()).round() as i32;
        let raw_conn_temp = (conn_temp_c + 40).clamp(0, 250) as u64;
        pack_intel(&mut data, 40, 8, raw_conn_temp);

        // AvailablePowerKw: 350.0 kW -> raw 3500
        pack_intel(&mut data, 48, 16, 3_500);

        RawCanFrame {
            timestamp_us,
            arb_id: 0x18FF_50E5,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_EXTENDED | FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x301` (`CMC_CellVoltagesMux`, 8B Classical CAN from `sample_bms.kcd`):
    /// Steps `CellBankSelector` `0..=3` calmly on each frame across all 16 Li-NMC cells.
    #[inline]
    fn build_0x301_cmc_cell_voltages_mux(
        &mut self,
        timestamp_us: u64,
        t_sec: f64,
        drive_period_sec: f64,
    ) -> RawCanFrame {
        let mut data = [0u8; 64];
        let bank = self.mux_301_bank & 0x03;
        self.mux_301_bank = (self.mux_301_bank + 1) & 0x03;

        let rolling = self.cmc_rolling_counter & 0x07;
        self.cmc_rolling_counter = (self.cmc_rolling_counter + 1) & 0x07;

        pack_intel(&mut data, 0, 4, u64::from(bank)); // CellBankSelector 0..=3
        pack_intel(&mut data, 4, 1, 1); // CmcBalanceActiveFlag = 1 (BalancingActive)
        pack_intel(&mut data, 5, 3, u64::from(rolling)); // CmcRollingCounter 0..=7

        let accel_wave = (t_sec * (TAU / drive_period_sec)).cos();
        let base_cell_idx = usize::from(bank) * 4;
        let bit_offsets: [u16; 4] = [8, 20, 32, 44];
        for (slot_i, &bit_off) in bit_offsets.iter().enumerate() {
            let cell_num = (base_cell_idx + slot_i) as f64;
            let cell_v = 3.695 + 0.0020 * (cell_num - 7.5) - 0.008 * accel_wave;
            let raw_12b = (((cell_v - 2.5) / 0.0005).round() as u64).min(0x0FFF);
            pack_intel(&mut data, bit_off, 12, raw_12b);
        }

        // Bank NTC temperature: signed 8-bit, slope 0.5, intercept +25.0 -> ~27.0..31.5 degC (~0.10 degC/s)
        let ntc_temp = 28.5 + f64::from(bank) * 0.5 + 1.5 * (t_sec * (TAU / 95.0)).sin();
        let raw_ntc = (((ntc_temp - 25.0) / 0.5).round() as i8) as u8;
        pack_intel(&mut data, 56, 8, u64::from(raw_ntc));

        RawCanFrame {
            timestamp_us,
            arb_id: 0x301,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x302` (`BMS_PackPowerAndLimits`, 8B Classical CAN from `sample_bms.kcd`).
    #[inline]
    fn build_0x302_bms_pack_power_limits(
        &self,
        timestamp_us: u64,
        t_sec: f64,
        drive_period_sec: f64,
    ) -> RawCanFrame {
        let mut data = [0u8; 64];

        // PackCurrentAmp: [-110 .. +230 A] synchronized with drive cycle, big-endian MSB 7, slope 0.1
        let pack_curr_a = 60.0 + 170.0 * (t_sec * (TAU / drive_period_sec)).cos();
        let raw_curr = ((pack_curr_a / 0.1).round() as i16) as u16;
        pack_motorola_sawtooth(&mut data, 7, 16, u64::from(raw_curr));

        // MaxDischargeCurrentLimA: 450 A (slope 0.25 -> raw 1800), big-endian MSB 23, 12-bit
        pack_motorola_sawtooth(&mut data, 23, 12, 1_800);

        // MaxRegenCurrentLimA: 220 A (slope 0.25 -> raw 880), big-endian MSB 27, 12-bit
        pack_motorola_sawtooth(&mut data, 27, 12, 880);

        // BmsThermalState = 2 (ActiveChiller), PackHealthStatus = 0 (Healthy)
        pack_intel(&mut data, 40, 4, 2);
        pack_intel(&mut data, 44, 4, 0);

        // CellVoltageSpreadMv: ~24.0..28.0 mV over 30s (slope 0.1 -> raw 240..280)
        let spread_raw = ((26.0 + 2.0 * (t_sec * (TAU / 30.0)).sin()) / 0.1).round() as u64;
        pack_intel(&mut data, 48, 16, spread_raw);

        RawCanFrame {
            timestamp_us,
            arb_id: 0x302,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x303` (`Thermal_CoolantFloatMetrics`, 8B Classical CAN, IEEE-754 `f32`).
    #[inline]
    fn build_0x303_thermal_coolant_floats(&self, timestamp_us: u64, t_sec: f64) -> RawCanFrame {
        let mut data = [0u8; 64];

        let flow_lpm = (16.4 + 1.4 * (t_sec * (TAU / 30.0)).sin()) as f32;
        let chiller_kw = (3.1 + 0.5 * (t_sec * (TAU / 40.0)).cos()) as f32;

        pack_intel(&mut data, 0, 32, u64::from(flow_lpm.to_bits()));
        pack_intel(&mut data, 32, 32, u64::from(chiller_kw.to_bits()));

        RawCanFrame {
            timestamp_us,
            arb_id: 0x303,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }

    /// `0x18F00900` (`BMS_AccumulatedEnergyExt`, Extended 29-bit 8B, IEEE-754 `f64`).
    #[inline]
    fn build_0x18f00900_accumulated_energy_ext(
        &self,
        timestamp_us: u64,
        t_sec: f64,
    ) -> RawCanFrame {
        let mut data = [0u8; 64];
        let lifetime_kwh = 12_845.65 + t_sec * 0.010;
        pack_intel(&mut data, 0, 64, lifetime_kwh.to_bits());

        RawCanFrame {
            timestamp_us,
            arb_id: 0x18F0_0900,
            bus_id: self.bus_id,
            dlc: 8,
            flags: FLAG_EXTENDED | FLAG_HW_TIMESTAMP,
            _reserved: 0,
            data,
        }
    }
}

impl CanChannel for MockCanChannel {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn capabilities(&self) -> &AdapterCapabilities {
        &self.descriptor.capabilities
    }

    fn close(&mut self) -> Result<(), AdapterError> {
        self.closed = true;
        Ok(())
    }

    fn recv_batch(
        &mut self,
        out_batch: &mut [RawCanFrame],
        timeout_ms: u32,
    ) -> Result<usize, AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if out_batch.is_empty() {
            return Ok(0);
        }

        let mut written = 0usize;

        // 1. Drain any loopback self-transmitted frames first so TX feedback is instantaneous.
        self.drain_loopback(out_batch, &mut written);

        match self.pacing {
            MockPacingMode::CalmTrackableSchedule | MockPacingMode::NominalEcuSchedule => {
                let periods = match self.pacing {
                    MockPacingMode::CalmTrackableSchedule => &CALM_ECU_PERIODS_US,
                    _ => &NOMINAL_ECU_PERIODS_US,
                };

                let mut now_us = self.elapsed_us();
                let earliest_due = self
                    .ecu_next_due_us
                    .iter()
                    .copied()
                    .min()
                    .unwrap_or(u64::MAX);

                if earliest_due > now_us && written == 0 && timeout_ms > 0 && earliest_due < u64::MAX
                {
                    let wait_us = (earliest_due - now_us).min(u64::from(timeout_ms) * 1_000);
                    if wait_us > 0 {
                        thread::sleep(Duration::from_micros(wait_us));
                    }
                    self.drain_loopback(out_batch, &mut written);
                    now_us = self.elapsed_us();
                }

                // Cap stale catch-up lag using max(period * 2, 500_000) so calm periods never underflow
                for (slot, due) in self.ecu_next_due_us.iter_mut().enumerate() {
                    let period = periods[slot];
                    let max_lag = period.saturating_mul(2).max(500_000);
                    if *due < u64::MAX && now_us.saturating_sub(*due) > max_lag {
                        let skip_steps = (now_us - *due - max_lag) / period;
                        if skip_steps > 0 {
                            *due = due.saturating_add(skip_steps.saturating_mul(period));
                        }
                    }
                }

                // Emit due ECU messages in chronological microsecond order (suppressing active TX overrides)
                while written < out_batch.len() {
                    let mut best_slot: Option<(usize, u64)> = None;
                    for (slot, &due_us) in self.ecu_next_due_us.iter().enumerate() {
                        if due_us <= now_us {
                            match best_slot {
                                None => best_slot = Some((slot, due_us)),
                                Some((_, prev_due)) if due_us < prev_due => {
                                    best_slot = Some((slot, due_us))
                                }
                                _ => {}
                            }
                        }
                    }

                    let Some((slot, due_us)) = best_slot else {
                        break;
                    };

                    self.ecu_next_due_us[slot] = due_us.saturating_add(periods[slot]);
                    let timestamp_us = self.base_timestamp_us.saturating_add(due_us);
                    let frame = self.synthesize_ecu_slot(slot, timestamp_us);
                    if !self.is_suppressed_by_tx_override(frame.can_id_key(), now_us)
                        && self.passes_filters(&frame)
                    {
                        out_batch[written] = frame;
                        written += 1;
                    }
                }
            }
            MockPacingMode::BurstFps(fps) => {
                let mut elapsed_us = self.start_instant.elapsed().as_micros();
                let mut target_emitted = ((elapsed_us * u128::from(fps)) / 1_000_000) as u64;

                if target_emitted <= self.emitted_frames && written == 0 && timeout_ms > 0 {
                    let next_due_us =
                        ((u128::from(self.emitted_frames + 1) * 1_000_000) / u128::from(fps))
                            as u64;
                    let now_us = elapsed_us.min(u128::from(u64::MAX)) as u64;
                    let wait_us = next_due_us
                        .saturating_sub(now_us)
                        .min(u64::from(timeout_ms) * 1_000);
                    if wait_us > 0 {
                        thread::sleep(Duration::from_micros(wait_us));
                    }

                    self.drain_loopback(out_batch, &mut written);
                    elapsed_us = self.start_instant.elapsed().as_micros();
                    target_emitted = ((elapsed_us * u128::from(fps)) / 1_000_000) as u64;
                }

                // Cap catch-up backlog to 100ms of traffic so long pauses don't burst stale seconds of data
                let max_backlog = (fps / 10).max(256);
                if target_emitted.saturating_sub(self.emitted_frames) > max_backlog {
                    self.emitted_frames = target_emitted - max_backlog;
                }

                let now_us = elapsed_us.min(u128::from(u64::MAX)) as u64;
                while written < out_batch.len() && self.emitted_frames < target_emitted {
                    let frame = self.synthesize_next_burst_frame(fps);
                    if !self.is_suppressed_by_tx_override(frame.can_id_key(), now_us)
                        && self.passes_filters(&frame)
                    {
                        out_batch[written] = frame;
                        written += 1;
                    }
                }
            }
        }

        Ok(written)
    }

    fn send_frame(&mut self, frame: &RawCanFrame) -> Result<(), AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        if self.listen_only {
            return Err(AdapterError::ListenOnlyMode);
        }
        if frame.is_fd() && !self.enable_fd {
            return Err(AdapterError::UnsupportedCapability(
                "CAN-FD frame rejected because channel was opened with enable_fd = false"
                    .to_string(),
            ));
        }

        let mut echo = *frame;
        echo.bus_id = self.bus_id;
        echo.flags |= FLAG_TX;
        if echo.timestamp_us == 0 {
            echo.timestamp_us = now_monotonic_us().max(1);
        }

        let can_id = CanIdKey::new_masked(echo.arb_id, echo.is_extended());
        let hold_until_us = self.elapsed_us().saturating_add(TX_OVERRIDE_HOLD_US);
        self.tx_override_until_us.insert(can_id, hold_until_us);

        match self.loopback_tx.try_send(echo) {
            Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Disconnected(_)) => Err(AdapterError::ChannelClosed),
        }
    }

    fn set_filters(&mut self, filters: &[CanFilter]) -> Result<(), AdapterError> {
        if self.closed {
            return Err(AdapterError::ChannelClosed);
        }
        self.filters.clear();
        self.filters.extend_from_slice(filters);
        Ok(())
    }

    /// Synthetic generator: there is no physical controller that could ACK frames.
    fn listen_only_enforcement(&self) -> ListenOnlyEnforcement {
        ListenOnlyEnforcement::Virtual
    }

    fn health(&self) -> BusHealthSnapshot {
        BusHealthSnapshot {
            state: if self.closed {
                BusState::Disconnected
            } else {
                BusState::Active
            },
            tx_error_count: 0,
            rx_error_count: 0,
        }
    }
}

#[inline]
fn pack_intel(buf: &mut [u8; 64], start_bit: u16, bit_len: u8, raw: u64) {
    for k in 0..bit_len {
        let pos = usize::from(start_bit) + usize::from(k);
        let byte_idx = pos >> 3;
        let bit_in_byte = pos & 7;
        if byte_idx < 64 && ((raw >> k) & 1) != 0 {
            buf[byte_idx] |= 1u8 << bit_in_byte;
        }
    }
}

#[inline]
fn pack_motorola_sawtooth(buf: &mut [u8; 64], start_bit: u16, bit_len: u8, raw: u64) {
    let mut byte_idx = usize::from(start_bit) >> 3;
    let mut bit_in_byte = (start_bit & 7) as u8;
    for shift in (0..bit_len).rev() {
        if byte_idx < 64 && ((raw >> shift) & 1) != 0 {
            buf[byte_idx] |= 1u8 << bit_in_byte;
        }
        if bit_in_byte == 0 {
            byte_idx += 1;
            bit_in_byte = 7;
        } else {
            bit_in_byte -= 1;
        }
    }
}
