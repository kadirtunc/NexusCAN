import { apiPanicStopTx, formatInFlightBuses } from '../services/ipcClient';
import type { PanicStopResultDto } from '../types/telemetry';
import { telemetryStore } from './telemetryStore';
import { stopAllTxSources } from './txSources';

/**
 * Single "STOP ALL TX" sequence shared by the global shell (TopBar / Ctrl+Shift+Space) and every
 * panel that can transmit: latch the panic flag first (frontend TX gates close immediately), stop
 * EVERY registered TX source (`registerTxSource`: periodic TX, stimulus, PID polling, UDS panel
 * polling, flow runs, TesterPresent, replay with hardware TX, ...), then disarm buses / stop
 * periodic jobs in the backend.
 */
export async function performPanicStop(): Promise<PanicStopResultDto> {
  telemetryStore.markPanicLatched();
  stopAllTxSources();
  return apiPanicStopTx();
}

/** Non-empty 1-based bus list when the Panic result reports a driver write that did not finish; else null. */
export function panicInFlightBuses(res: Pick<PanicStopResultDto, 'inFlightTimeoutBuses'>): string | null {
  const buses = res.inFlightTimeoutBuses;
  return buses !== undefined && buses.length > 0 ? formatInFlightBuses(buses) : null;
}
