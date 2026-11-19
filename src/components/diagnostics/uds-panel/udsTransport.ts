/**
 * UDS panel transport + TX safety gate.
 *
 * Reads / writes go through the existing Diagnostics path (`diagnosticsStore` strict helpers →
 * `invokeCmd('cmd_diag_read_did' | 'cmd_diag_send_uds')`). Nothing here ever fabricates data.
 */
import { useSyncExternalStore } from 'react';
import {
  diagnosticsStore,
  UdsTransportError,
  type UdsTransportErrorKind,
} from '../../../store/diagnosticsStore';
import { telemetryStore } from '../../../store/telemetryStore';
import type { UdsWidgetDto } from '../../../types/uds';
import {
  encodeWriteBytesRequest,
  encodeWriteRequest,
  type UdsEncodedWrite,
} from './udsBinding';

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Returns the DID data record ONLY (`DidReadResultDto.raw`: without 0x62 and the DID echo), so
 * `UdsReadBinding.byteOffset` is an offset into the data record (offset 0 = first data byte).
 */
export function udsReadDid(did: number): Promise<number[]> {
  return diagnosticsStore.readDidStrict(did, 'panel');
}

function bigEndian(value: number, len: number): number[] {
  const out: number[] = [];
  let rest = value;
  for (let i = 0; i < len; i += 1) {
    out.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return out;
}

/**
 * ReadMemoryByAddress (0x23) with a 4-byte address and a 1/2-byte size.
 * `cmd_diag_send_uds` returns the full response PDU (`63 <data record>`); `sendUdsStrict` strips the
 * SID echo, so `byteOffset` is again an offset into the data record. A negative response throws.
 */
export function udsReadMemory(address: number, size: number): Promise<number[]> {
  const sizeLen = size > 255 ? 2 : 1;
  const fmt = (sizeLen << 4) | 4;
  return diagnosticsStore.sendUdsStrict(
    0x23,
    [fmt, ...bigEndian(address, 4), ...bigEndian(size, sizeLen)],
    { record: false, origin: 'panel' }
  );
}

/**
 * OBD-II Mode 01 read (`01 <pid>`) over the diagnostic session's own request id (physical
 * addressing, same path as the Live PID gauges). Returns the PID DATA bytes (A, B, ...) after the
 * `41 <pid>` echo; a mismatching PID echo is an error (never a silent wrong value).
 */
export async function udsReadObdPid(pid: number): Promise<number[]> {
  const rsp = await diagnosticsStore.sendUdsStrict(0x01, [pid], { record: false, origin: 'panel' });
  if (rsp.length < 1 || rsp[0] !== pid) {
    throw new UdsTransportError('failed', `OBD-II PID echo mismatch (expected 0x${pid.toString(16).toUpperCase().padStart(2, '0')})`);
  }
  return rsp.slice(1);
}

// ─── TX gate (Listen-Only / Arm / Panic Stop) ────────────────────────────────

export type UdsTxGateReason =
  | 'panic'
  | 'noSession'
  | 'busNotConnected'
  | 'listenOnly'
  | 'notArmed';

export type UdsTxGateState = 'open' | UdsTxGateReason;

/**
 * Same rule as the Simulation workbench (`isLiveBusArmed`), but evaluated on the bus that the
 * diagnostic session actually talks to: TX is allowed only if the session is connected, the
 * panic latch is clear and that bus is connected, NOT Listen-Only and explicitly armed.
 */
export function evaluateUdsTxGate(): UdsTxGateState {
  const header = telemetryStore.getHeaderSlice();
  if (header.txPanicLatched) return 'panic';
  const session = diagnosticsStore.getState().session;
  if (!session.connected) return 'noSession';
  const bus = header.buses.find((b) => b.busId === session.config.busId && b.connected);
  if (!bus) return 'busNotConnected';
  if (bus.listenOnly) return 'listenOnly';
  if (!bus.txArmed) return 'notArmed';
  return 'open';
}

export function useUdsTxGate(): UdsTxGateState {
  return useSyncExternalStore(
    (cb) => {
      const offHeader = telemetryStore.subscribeHeader(cb);
      const offDiag = diagnosticsStore.subscribe(cb);
      return () => {
        offHeader();
        offDiag();
      };
    },
    evaluateUdsTxGate,
    evaluateUdsTxGate
  );
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export type UdsWriteResult =
  | { status: 'sent'; clampedValue: number; wasClamped: boolean; label: string }
  | { status: 'blocked'; reason: UdsTxGateReason }
  | { status: 'invalid'; reason: 'invalidId' | 'offsetUnsupported' | 'tooLong' }
  | { status: 'error'; kind: UdsTransportErrorKind; message: string };

/** Gate (re-evaluated at send time) -> raw UDS request via `cmd_diag_send_uds`. */
async function dispatchEncoded(request: UdsEncodedWrite): Promise<UdsWriteResult> {
  const gate = evaluateUdsTxGate();
  if (gate !== 'open') return { status: 'blocked', reason: gate };

  const { sid, data, clampedValue, wasClamped, label } = request;
  try {
    await diagnosticsStore.sendUdsStrict(sid, data, { record: true, origin: 'panel' });
    return { status: 'sent', clampedValue, wasClamped, label };
  } catch (err) {
    if (err instanceof UdsTransportError) {
      return { status: 'error', kind: err.kind, message: err.message };
    }
    return {
      status: 'error',
      kind: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Numeric write: clamp to [min, max] -> gate -> send. */
export async function executeUdsWrite(
  widget: Pick<UdsWidgetDto, 'udsRead' | 'udsWrite' | 'config'>,
  physicalValue: number
): Promise<UdsWriteResult> {
  const encoded = encodeWriteRequest(widget, physicalValue);
  if (!encoded.ok) return { status: 'invalid', reason: encoded.error };
  return dispatchEncoded(encoded.request);
}

/** Byte-array write (textbox ascii / hex): same gate and transport as numeric writes. */
export async function executeUdsWriteBytes(
  widget: Pick<UdsWidgetDto, 'udsWrite'>,
  bytes: Uint8Array
): Promise<UdsWriteResult> {
  const encoded = encodeWriteBytesRequest(widget, bytes);
  if (!encoded.ok) return { status: 'invalid', reason: encoded.error };
  return dispatchEncoded(encoded.request);
}
