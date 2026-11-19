/**
 * Workbench runner (workbench-v1 §5 / §9.4 / §10). No React; every dependency is injected.
 *
 * Order: preconditions (all of them, before the transport is touched) -> review gate (only when the block
 * writes / erases) -> a DEDICATED `FlowEngine` instance running the pinned library revision with `rootBody`
 * (never the Flow Editor canvas) -> run record -> append.
 *
 * Panic Stop: the run registers itself in the global tx-source registry (`registerTxSource`) the moment it
 * starts, so `stopAllTxSources()` (the single Panic Stop path) reaches it even while it is still loading or
 * waiting in the review dialog (-> `refused: stopped`). Once the engine runs, Panic reaches the engine through
 * this registration too (stopKind `panic`).
 */
import { OPERABLE_PROTOCOLS, type EcuRecordV1, type FlowBindingV1, type FlowRefV1 } from '../../../types/diagWorkspace';
import type { FlowFileValue, FlowInterfaceV1 } from '../../../types/flowLibrary';
import type { RunFileRefV1, RunRecordV1, RunValue } from '../../../types/runRecord';
import { registerTxSource } from '../../../store/txSources';
import { FlowEngine, type FlowRunResult } from '../../flow/FlowEngine';
import type { FlowTransport } from '../../flow/flowTransport';
import { toFlowBody } from '../../flow/registry/flowBody';
import type { FlowDiagram } from '../../flow/types';
import { t } from '../../../i18n';
import {
  buildRunRecord,
  checkFileExpectation,
  ecuSnapshotHash,
  resolveBindingParams,
  reviewItems,
  type WbReviewItem,
} from './workbenchModel';

export interface WbRunDeps {
  loadRevision(ref: FlowRefV1): Promise<{ body: FlowDiagram; iface: FlowInterfaceV1; name: string; contentHash: string } | null>;
  loadCallee(ref: FlowRefV1): FlowDiagram | null;
  /** `null` = no connected session for this ECU -> refuse `no_session`. */
  transportFor(ecu: EcuRecordV1): FlowTransport | null;
  /** Another Workbench run active -> refuse `busy`. */
  isRunActive(): boolean;
  confirmReview(items: WbReviewItem[], ecu: EcuRecordV1, files: RunFileRefV1[]): Promise<boolean>;
  appendRecord(rec: RunRecordV1): Promise<void>;
  now(): number;
  uuid(): string;
  deviceId: string;
  appVersion: string;
  projectId: string;
  vehicleId: string | null;
}

export type WbRefusal = {
  code: 'incomplete' | 'invalid' | 'revision_missing' | 'protocol' | 'crc_mismatch' | 'busy' | 'no_session' | 'review_declined'
    | 'file_missing' | 'stopped';
  message: string;
};

export interface WbRunHandle {
  stop(): void;
  done: Promise<WbRunResult>;
}

export type WbRunResult =
  | { kind: 'refused'; refusal: WbRefusal }
  | { kind: 'ran'; record: RunRecordV1; appendError: string | null };

let runSeq = 0;

const refuse = (code: WbRefusal['code'], message: string): WbRunResult => ({ kind: 'refused', refusal: { code, message } });

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Last `✗` line of the engine log (the reason a run was refused before transmitting). */
function lastErrorLine(log: readonly string[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const k = log[i].indexOf('✗');
    if (k >= 0) return log[i].slice(k + 1).trim();
  }
  return '';
}

export function startWorkbenchRun(
  binding: FlowBindingV1,
  ecu: EcuRecordV1,
  files: Record<string, FlowFileValue>,
  deps: WbRunDeps,
): WbRunHandle {
  let stopKind: 'user' | 'panic' | null = null;
  let engine: FlowEngine | null = null;

  const markStop = (kind: 'user' | 'panic'): void => {
    if (stopKind === null) stopKind = kind;
    engine?.stop();
  };
  const unregister = registerTxSource(`workbench-run:${++runSeq}`, () => markStop('panic'));

  const execute = async (): Promise<WbRunResult> => {
    const stopped = (): WbRunResult => refuse('stopped', t('workbench.refuse.stopped'));

    if (deps.isRunActive()) return refuse('busy', t('workbench.refuse.busy'));

    const rev = await deps.loadRevision(binding.flowRef);
    if (stopKind !== null) return stopped();
    if (rev === null) return refuse('revision_missing', t('workbench.refuse.revisionMissing', { flow: binding.flowRef.flowId, rev: binding.flowRef.revision }));

    // ECU protocol must be operable and satisfy the block's required protocols.
    const protoOk = OPERABLE_PROTOCOLS.includes(ecu.protocol) && rev.iface.requiresProtocols.every((p) => p === ecu.protocol);
    if (!protoOk) return refuse('protocol', t('workbench.refuse.protocol', { ecu: ecu.name, protocol: ecu.protocol }));

    const resolved = resolveBindingParams(binding, rev.iface, ecu);
    if (resolved.status === 'incomplete') {
      return refuse('incomplete', t('workbench.refuse.incomplete', { keys: resolved.missing.join(', ') }));
    }
    if (resolved.status === 'invalid') {
      return refuse('invalid', resolved.issues.filter((i) => i.code !== 'unknown_key').map((i) => i.message).join('; '));
    }

    // Firmware files: chosen at run time, CRC checked against the binding's expectation (mismatch always refuses).
    const refs: RunFileRefV1[] = [];
    const fileInputs: Record<string, FlowFileValue> = {};
    for (const spec of rev.iface.inputs) {
      if (spec.type !== 'file') continue;
      const file = files[spec.key];
      const hasExpect = binding.fileExpect?.[spec.key] !== undefined;
      if (file === undefined) {
        if (spec.required) return refuse('file_missing', t('workbench.refuse.fileMissing', { key: spec.label !== '' ? spec.label : spec.key }));
        continue;
      }
      if (hasExpect) {
        const chk = checkFileExpectation(binding, spec.key, file);
        if (!chk.ok) {
          return refuse('crc_mismatch', t('workbench.refuse.crc', { key: spec.key, expected: chk.expected, actual: chk.actual }));
        }
        refs.push(chk.ref);
      } else {
        const chk = checkFileExpectation({ ...binding, fileExpect: undefined }, spec.key, file);
        refs.push(chk.ok ? chk.ref : { key: spec.key, name: file.name, size: file.bytes.length, crc32: chk.actual });
      }
      fileInputs[spec.key] = file;
    }

    const transport = deps.transportFor(ecu);
    if (transport === null) return refuse('no_session', t('workbench.refuse.noSession', { ecu: ecu.name }));

    // Review gate (flash / erase / write blocks).
    const items = reviewItems(rev.body, rev.name, (ref) => deps.loadCallee(ref));
    if (items.length > 0) {
      const confirmed = await deps.confirmReview(items, ecu, refs);
      if (stopKind !== null) return stopped();
      if (!confirmed) return refuse('review_declined', t('workbench.refuse.reviewDeclined'));
    }
    if (stopKind !== null) return stopped();

    // Dedicated engine instance: root body = the pinned revision, `ecu` = the row ECU. Nothing below awaits
    // between the last stop check and `run()` starting, so a Stop cannot slip in unseen.
    const log: string[] = [];
    const eng = new FlowEngine();
    engine = eng;
    const startedAtMs = deps.now();
    await eng.run({
      rootBody: rev.body,
      ecu,
      inputs: { ...resolved.params, ...fileInputs },
      transport,
      resolveCallee: async (id, revision) => {
        const d = deps.loadCallee({ flowId: id, revision: revision ?? 0 });
        if (d === null) throw new Error(t('workbench.refuse.calleeMissing', { flow: id }));
        return {
          kind: 'nexuscan.flow',
          body: toFlowBody(d, {
            id, revision: revision ?? 1, description: '', createdAt: '', updatedAt: '', author: null, origin: 'user', aiReviewed: false, tags: [],
          }),
        };
      },
      rootId: binding.flowRef.flowId,
      rootName: rev.name,
      onLog: (line) => log.push(line),
    });
    const endedAtMs = deps.now();
    const result: FlowRunResult = eng.result ?? { outcome: 'error', name: null, outputs: {}, stopped: false, refused: false };

    if (result.refused) {
      // The engine's own pre-run validation refused (nothing transmitted): no record.
      const reason = lastErrorLine(log);
      return refuse('invalid', reason !== '' ? reason : t('workbench.refuse.engine'));
    }

    const params: Record<string, RunValue> = { ...resolved.params };
    const record = buildRunRecord({
      runId: deps.uuid(),
      projectId: deps.projectId,
      vehicleId: deps.vehicleId,
      ecu,
      flowId: binding.flowRef.flowId,
      flowRevision: binding.flowRef.revision,
      flowContentHash: rev.contentHash,
      flowName: rev.name,
      params,
      files: refs,
      startedAtMs,
      endedAtMs,
      result,
      stopKind,
      log,
      deviceId: deps.deviceId,
      appVersion: deps.appVersion,
      ecuSnapshotHash: await ecuSnapshotHash(ecu),
    });
    let appendError: string | null = null;
    try {
      await deps.appendRecord(record);
    } catch (e) {
      const m = errText(e);
      appendError = m !== '' ? m : 'append failed';
    }
    return { kind: 'ran', record, appendError };
  };

  const done = execute()
    .catch((e: unknown): WbRunResult => refuse('invalid', errText(e)))
    .finally(() => unregister());

  return { stop: () => markStop('user'), done };
}
