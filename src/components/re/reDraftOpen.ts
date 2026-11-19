/** Opens the "Save signal" dialog for a correlation row / candidate of the Signal Inspector (prefill in reDraftModel). */
import { PID_CATALOG } from '../../types/diagnostics';
import type { ReCorrelationRowDto } from '../../types/re';
import { databaseStore } from '../../store/databaseStore';
import { newReDraftId, reDraftStore } from '../../store/reDraftStore';
import type { ReCandidateEntry, ReSignalState } from '../../store/reSignalStore';
import { reRowKey, reStore, type ReRowView } from '../../store/reStore';
import { draftFromCandidate, draftFromCorrelationRow, seriesRange } from './reDraftModel';
import { sameCandidateBits } from './reSignalModel';
import { scanRowToInspect } from './reScanModel';
import type { ReScanResultRowDto } from '../../types/reScan';

/** `{ label: 'OBD 0x0D', unit: 'km/h' }` when the active reference is an OBD-II PID. */
export function obdReference(s: Pick<ReSignalState, 'reference'>): { label: string; unit: string } | null {
  const r = s.reference;
  if (r === null || r.kind !== 'obd_pid') return null;
  const def = PID_CATALOG.find((d) => d.pid === r.pid);
  return { label: `OBD 0x${r.pid.toString(16).toUpperCase().padStart(2, '0')}`, unit: def?.unit ?? '' };
}

function dbMessageName(row: ReRowView): string | null {
  return databaseStore.getMessageForBus(row.bus, '', row.arbId, row.extended)?.name ?? null;
}

/** Save a correlation-table row (observed range = range of the reference series, which is in physical units). */
export function openSaveDialogForRow(row: ReRowView, s: ReSignalState, corr: ReCorrelationRowDto): void {
  reDraftStore.openEditor(
    draftFromCorrelationRow({
      id: newReDraftId(),
      nowMs: Date.now(),
      target: { bus: row.bus, arbId: row.arbId, isExtended: row.extended },
      dlcBytes: row.dlcBytes,
      messageName: dbMessageName(row),
      row: corr,
      observed: seriesRange(s.series, 'reference', 0),
      reference: obdReference(s),
    }),
  );
}

/** Save an inspector candidate (observed range = its own plotted series). */
export function openSaveDialogForCandidate(row: ReRowView, s: ReSignalState, cand: ReCandidateEntry, index: number): void {
  const ref = obdReference(s);
  const matching = s.correlation.result?.rows.find((r) => sameCandidateBits(r.candidate, cand.dto)) ?? null;
  reDraftStore.openEditor(
    draftFromCandidate({
      id: newReDraftId(),
      nowMs: Date.now(),
      target: { bus: row.bus, arbId: row.arbId, isExtended: row.extended },
      dlcBytes: row.dlcBytes,
      messageName: dbMessageName(row),
      candidate: cand.dto,
      matchingRow: matching,
      observed: seriesRange(s.series, 'candidate', index),
      reference: ref === null ? (cand.unit === '' ? null : { label: '', unit: cand.unit }) : { label: ref.label, unit: cand.unit !== '' ? cand.unit : ref.unit },
    }),
  );
}

/** Save a Value Scan result row (bits + preset factor/offset prefilled; no observed range, provenance "Value Scan"). */
export function openSaveDialogForScanRow(row: ReScanResultRowDto): void {
  const { target, candidate } = scanRowToInspect(row);
  const view = reStore.getRows().get(reRowKey(target.bus, target.isExtended, target.arbId));
  const bitsEnd = candidate.startBit + candidate.bitLength;
  const dlcBytes = view?.dlcBytes ?? Math.max(8, Math.ceil(bitsEnd / 8));
  reDraftStore.openEditor(
    draftFromCandidate({
      id: newReDraftId(),
      nowMs: Date.now(),
      target,
      dlcBytes,
      messageName: databaseStore.getMessageForBus(target.bus, '', target.arbId, target.isExtended)?.name ?? null,
      candidate,
      matchingRow: null,
      observed: null,
      reference: { label: 'Value Scan', unit: '' },
    }),
  );
}
