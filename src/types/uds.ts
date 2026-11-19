/**
 * UDS instrument panel contracts.
 *
 * A UDS panel IS a Simulation panel (same widget kinds, accent palette, 24-column grid and
 * widget config). The only extension is the data source: each widget carries an optional UDS
 * read binding (ReadDataByIdentifier 0x22 / ReadMemoryByAddress 0x23 / OBD-II Mode 01 PID) and/or a UDS write binding
 * (WriteDataByIdentifier 0x2E / WriteMemoryByAddress 0x3D / InputOutputControl 0x2F).
 *
 * `SimulationWidgetDto.binding` is DERIVED from the UDS bindings (see udsBinding.ts) so that the
 * shared Simulation widget renderers work unchanged.
 */
import type { SimulationPanelDto, SimulationWidgetDto } from './simulation';

export type UdsReadService = 'read_did' | 'read_mem' | 'obd_pid';
export type UdsWriteService = 'write_did' | 'write_mem' | 'io_control';
export type UdsByteLen = 1 | 2 | 4;
export type UdsIoOption = '00' | '01' | '02' | '03';

export interface UdsReadBinding {
  service: UdsReadService;
  did: string; // hex e.g. 'F190' (read_did)
  address: string; // hex e.g. '20004800' (read_mem)
  /** OBD-II Mode 01 PID, 1-2 hex chars e.g. '0C' (obd_pid). Catalog PIDs decode via PID_CATALOG; others use raw bytes + factor/offset. */
  obdPid?: string;
  byteOffset: number; // byte offset within the response data payload
  byteLen: UdsByteLen;
  signed: boolean;
  factor: number; // physical = raw * factor + offset
  offset: number;
  unit: string;
  min: number;
  max: number;
  decimals: number;
  pollMs: number; // per-widget polling override (0 = panel default)
}

export interface UdsWriteBinding {
  service: UdsWriteService;
  did: string; // write_did / io_control
  address: string; // write_mem
  ioOption: UdsIoOption; // returnControlToECU / resetToDefault / freezeCurrentState / shortTermAdjustment
  byteOffset: number;
  byteLen: UdsByteLen;
  factor: number; // raw = round((physical - offset) / factor)
  offset: number;
  /** Optional explicit write clamp range (physical units). */
  min?: number;
  max?: number;
}

export interface UdsWidgetDto extends SimulationWidgetDto {
  udsRead: UdsReadBinding | null;
  udsWrite: UdsWriteBinding | null;
}

export interface UdsPanelDto extends Omit<SimulationPanelDto, 'widgets'> {
  widgets: UdsWidgetDto[];
}
