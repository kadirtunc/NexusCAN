import { apiPanicStopTx } from '../services/ipcClient';
import type { PanicStopResultDto } from '../types/telemetry';
import { simulationPanelStore } from './simulationPanelStore';
import { telemetryStore } from './telemetryStore';
import { transmitStore } from './transmitStore';

/**
 * Single "STOP ALL TX" sequence shared by the global shell (TopBar / Ctrl+Shift+Space) and every
 * panel that can transmit: latch the panic flag first (frontend TX gates close immediately),
 * pause local TX schedulers, then disarm buses / stop periodic jobs in the backend.
 */
export async function performPanicStop(): Promise<PanicStopResultDto> {
  telemetryStore.markPanicLatched();
  transmitStore.markAllPaused();
  simulationPanelStore.stopAllPeriodicStimulusJobs();
  return apiPanicStopTx();
}
