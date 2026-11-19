import type { FlowBlock, FlowDiagram } from './types';
import { flowStore } from './FlowStore';
import { t } from '../../i18n';
import { crc16ibm, crc32, computeKey } from './flowAlgos';
import { demoFlowTransport, demoDelay, RealFlowTransport, type FlowTransport } from './flowTransport';
import { RealFlowExecutor } from './flowReal';
import { flowPrompt } from './flowPrompt';
import { resolveGotoTarget, terminalName, validateTerminals } from './flowTerminals';
import { CalleeCache, preflightCalls, terminalIssueMessage, type BodyLoader } from './callGraph';
import { isCallType, readCallRef } from './callIndex';
import { checkEcuBinding, checkEcuSession, resolveFrameDiagram, type SessionProbe } from './ecuBinding';
import { flowRegistry } from './registry/flowRegistryStore';
import type { EcuRecordV1 } from '../../types/diagWorkspace';
import type { BlockStatus } from './types';
import { cancelAllFlashRuns, clearImage, runFlashBlock } from './flashRun';
import { flashRuntime } from './flashRuntime';
import { createScope, FOR_ITERATION_CAP, forValueAt, formatValue, type FlowScope } from './coreBlocks';
import { CORE_EXEC_BLOCKS, WHILE_DEFAULT_MAX, execVarSet, readForRange, renderLogMessage } from './coreRuntime';
import { validateCore, type CoreIssue } from './coreValidate';
import { findEntryBlock, resolveRunInputs, validateInterface } from './flowInterface';
import { FLOW_OUT, FLOW_RETURN, FLOW_START, blockPortSpec, flowInSpecs, returnName, returnOutcome } from './flowPorts';
import { FLASH_IMAGE_KEY, applyBoundParams, preflightBoundValues } from './boundParams';
import type { FlowOutcome } from '../../types/flowLibrary';
import type { TranslationKey } from '../../i18n';
import { diagnosticsStore } from '../../store/diagnosticsStore';
import { registerTxSource } from '../../store/txSources';

// ─── Transports (see flowTransport.ts) ───────────────────────────────────────

function ts(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function hexB(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

function nrcName(nrc: number): string {
  const map: Record<number, string> = {
    0x10: 'generalReject',
    0x11: 'serviceNotSupported',
    0x12: 'subFunctionNotSupported',
    0x13: 'incorrectMessageLengthOrInvalidFormat',
    0x21: 'busyRepeatRequest',
    0x22: 'conditionsNotCorrect',
    0x24: 'requestSequenceError',
    0x31: 'requestOutOfRange',
    0x33: 'securityAccessDenied',
    0x35: 'invalidKey',
    0x36: 'exceededNumberOfAttempts',
    0x37: 'requiredTimeDelayNotExpired',
    0x70: 'uploadDownloadNotAccepted',
    0x71: 'transferDataSuspended',
    0x72: 'generalProgrammingFailure',
    0x73: 'wrongBlockSequenceCounter',
    0x7E: 'subFunctionNotSupportedInActiveSession',
    0x7F: 'serviceNotSupportedInActiveSession',
  };
  return `NRC 0x${hexB(nrc)}${map[nrc] ? ` (${map[nrc]})` : ''}`;
}

/** DEMO-only simulated request (used exclusively by `dispatchDemo`). */
async function udsRequest(sid: number, payload: number[]): Promise<Uint8Array> {
  return new Uint8Array(await demoFlowTransport.request(sid, payload));
}

async function randomDelay(min = 20, max = 80): Promise<void> {
  await demoDelay(min, max);
}

// ─── Run context ──────────────────────────────────────────────────────────────

export interface RunContext {
  sessionType: 'default' | 'extended' | 'programming' | 'safety';
  securityUnlocked: boolean;
  unlockedLevel: number;
  commControlled: boolean;  // disableRxAndTx aktif mi
  dtcSettingOff: boolean;   // DTCSetting off mu
  downloadActive: boolean;
  /** Real mode: the active transfer is an upload (0x35), not a download. */
  uploadActive: boolean;
  /** Real mode: maxNumberOfBlockLength reported by the ECU for the active transfer (0 = unknown). */
  maxBlockLen: number;
  downloadAddress: number;
  downloadSize: number;
  transferBlockSeq: number;
  transferredBytes: number;
  variables: Map<string, unknown>;
  /** A `uds_tester_present_keepalive` START ran: the engine stops the keep-alive on every terminal path. */
  keepaliveActive: boolean;
  /** Variables of the current call frame (core pack, §8.1). Phase B swaps this object per frame. */
  scope: FlowScope;
}

/** Run options. `transport` injects a transport (headless tests); default = live session or DEMO. */
export interface FlowRunOptions {
  transport?: FlowTransport;
  /**
   * Values of the `flow_in` inputs by key (`FlowFileValue` or `Uint8Array` for file, `Uint8Array` for bytes / hex,
   * text / number / bool / select as entered). Missing optional inputs take their spec default; a missing required one refuses the run.
   */
  inputs?: Record<string, unknown>;
  /** The ECU bound to this run (single ECU per run): passed as the value of the `ecu` input and checked. */
  ecu?: EcuRecordV1 | null;
  /** Session probe override (tests); default = the active diagnostics tab, skipped when a transport is injected. */
  ecuSession?: () => SessionProbe | null;
  /** Loader of callee revisions (default: the flow registry). Callees are loaded once per run. */
  resolveCallee?: BodyLoader;
  /**
   * Root diagram to run instead of the canvas diagram (Workbench / dedicated engine). With it the engine NEVER reads or
   * writes `flowStore` (diagram, block statuses, run log, run flags); log lines go to `onLog`.
   */
  rootBody?: FlowDiagram;
  /** Log lines of a `rootBody` run (ignored for canvas runs, which log into `flowStore`). */
  onLog?: (line: string) => void;
  /** Identity of the running flow (default: the canvas diagram). */
  rootId?: string | null;
  rootName?: string;
  /** Runtime limits (diag-workspace-v1 §8): call depth 64, executed blocks 1 000 000. */
  limits?: { maxDepth?: number; maxBlocks?: number };
}

export const MAX_CALL_DEPTH = 64;
export const MAX_RUN_BLOCKS = 1_000_000;

/** One call frame: its own diagram, variables, executors, ECU and control-flow state. */
interface Frame {
  diagram: FlowDiagram;
  name: string;
  /** Names from the root flow to this frame (stamped on every log entry). */
  path: string[];
  /** Call-block ids from the root (`''` = root): key of the frame's live block statuses. */
  pathKey: string;
  ecu: EcuRecordV1 | null;
  inputValues: Record<string, unknown>;
  scope: FlowScope;
  real: RealFlowExecutor | null;
  eval: RealFlowExecutor;
  finished: boolean;
  /** Outcome of the frame (set by a `flow_return`, or implicitly `ok` when the exec path ends) + sampled outputs. */
  reached: { name: string; outcome: FlowOutcome; outputs: Record<string, unknown>; implicit: boolean } | null;
  /** Runtime image keys of bound `file` ports loaded in this frame: released when the frame exits. */
  imageKeys: Set<string>;
  loopSignal: 'break' | 'continue' | null;
  loopDepth: number;
}

/** Result of one run (diag-workspace-v1 §8): the outcome and the values sampled from the `flow_out` blocks. */
export interface FlowRunResult {
  outcome: FlowOutcome;
  /** Name of the reached `flow_return`; `null` for the implicit outcome (exec path ended without one, error, stop). */
  name: string | null;
  outputs: Record<string, unknown>;
  /** Stop / Panic Stop ended the run (outcome `error`). */
  stopped: boolean;
  /** Pre-run validation / input resolution refused the run (nothing was transmitted). */
  refused: boolean;
}

function newRunContext(): RunContext {
  return {
    sessionType: 'default',
    securityUnlocked: false,
    unlockedLevel: 0,
    commControlled: false,
    dtcSettingOff: false,
    downloadActive: false,
    uploadActive: false,
    maxBlockLen: 0,
    downloadAddress: 0,
    downloadSize: 0,
    transferBlockSeq: 1,
    transferredBytes: 0,
    variables: new Map(),
    keepaliveActive: false,
    scope: createScope([]),
  };
}

/** The slice of the canvas store the engine writes during a run. */
export type RunSink = Pick<typeof flowStore,
  'addRunLog' | 'clearRunLog' | 'setBlockStatus' | 'setPaused' | 'setRunning' | 'setFramePath' | 'setFrameStatus'
  | 'setFrameResult' | 'clearFrameStatuses' | 'resetBlockStatuses'>;

/** Detached sink (`rootBody` runs): nothing touches `flowStore`; log lines go to `onLog`. */
function detachedSink(onLog?: (line: string) => void): RunSink {
  const noop = (): void => undefined;
  return {
    addRunLog: (entry) => onLog?.(entry.message),
    clearRunLog: noop,
    setBlockStatus: noop,
    setPaused: noop,
    setRunning: noop,
    setFramePath: noop,
    setFrameStatus: noop,
    setFrameResult: noop,
    clearFrameStatuses: noop,
    resetBlockStatuses: noop,
  };
}

/** Blocks that are pure flow structure (no transport, no fabricated data) and run identically in real mode. */
const REAL_STRUCTURAL: ReadonlySet<string> = new Set([FLOW_START, FLOW_RETURN, 'delay', 'loop', 'flow_while', 'uds_lockout_guard', 'flow_terminal', 'flow_goto']);

/** Pre-run refusal of a failed validation: block statuses + log, nothing executes. */
function refuseRun(sink: RunSink, diagram: FlowDiagram, issues: Array<{ blockId: string; message: string }>, headerKey: TranslationKey): void {
  for (const issue of issues) {
    if (issue.blockId !== '') sink.setBlockStatus(issue.blockId, 'error', issue.message);
    sink.addRunLog({ blockId: issue.blockId, blockLabel: diagram.blocks.find((b) => b.id === issue.blockId)?.label ?? '',
      level: 'error', message: `[${ts()}] ✗ ${issue.message}` });
  }
  sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
    message: `[${ts()}] ✗ ${t(headerKey)}` });
}

// ─── Engine ───────────────────────────────────────────────────────────────────

let flowEngineSeq = 0;

/** The active diagnostics session tab as seen by the ECU binding check. */
function activeSessionProbe(): SessionProbe {
  const st = diagnosticsStore.getState();
  const tab = st.tabs.find((x) => x.id === st.activeTabId) ?? st.tabs[0];
  return { tabId: tab.id, ecuId: tab.ecuId, connected: tab.session.connected };
}

export class FlowEngine {
  private readonly _txSourceId = `uds-flow:${++flowEngineSeq}`;
  /** Where run state / log go: the canvas store, or a detached sink for `rootBody` runs (Workbench). */
  private _sink: RunSink = flowStore;
  private _stopped = false;
  private _paused  = false;
  private _resumeResolve: (() => void) | null = null;
  private _ctx: RunContext = newRunContext();
  /** Snapshot of `diagnosticsStore.mockMode` at run start: true = simulation, false = live bus. */
  private _demo = false;
  private _transport: FlowTransport | null = null;
  private _stack: Frame[] = [];
  private _frame!: Frame;
  private _callees: CalleeCache | null = null;
  private _rootEcu: EcuRecordV1 | null = null;
  private _blocks = 0;
  private _maxDepth = MAX_CALL_DEPTH;
  private _maxBlocks = MAX_RUN_BLOCKS;
  /** Fatal runtime-limit error: halts every frame and ends the run with outcome `error`. */
  private _abortError: Error | null = null;
  private get _real(): RealFlowExecutor | null { return this._frame.real; }
  /**
   * Evaluator of pure data (core pack, constants, compares): the real executor in real mode, a
   * lenient pure-only one in simulated mode, so both modes run the same core semantics.
   */
  private get _eval(): RealFlowExecutor { return this._frame.eval; }
  private get _loopSignal(): 'break' | 'continue' | null { return this._frame.loopSignal; }
  private set _loopSignal(v: 'break' | 'continue' | null) { this._frame.loopSignal = v; }
  private get _loopDepth(): number { return this._frame.loopDepth; }
  private set _loopDepth(v: number) { this._frame.loopDepth = v; }
  /** Result of the last `run()` (`null` while running / before the first run). */
  result: FlowRunResult | null = null;
  /** Block whose port led into the block now executing (for the goto jump log). */
  private _cameFrom: FlowBlock | null = null;

  private log(blockId: string, blockLabel: string, msg: string): void {
    this._sink.addRunLog({ blockId, blockLabel, level: 'info', message: msg });
  }

  /** Flow Stop / Panic Stop: aborts the chain, prompts, flash downloads AND the keep-alive of this run. */
  stop(): void {
    this._stopped = true;
    this._resumeResolve?.();
    flowPrompt.cancel();
    cancelAllFlashRuns();
    void this.releaseKeepalive('stop');
  }

  /**
   * Stops the backend TesterPresent keep-alive started by this run (idempotent). Called on run end,
   * error abort, Flow Stop and Panic Stop: no keep-alive survives the run.
   */
  private async releaseKeepalive(reason: 'end' | 'stop'): Promise<void> {
    const tr = this._transport;
    if (!this._ctx.keepaliveActive || tr === null) return;
    this._ctx.keepaliveActive = false;
    try {
      await tr.setKeepalive(false, 0);
      this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'warn',
        message: `[${ts()}] ${t(reason === 'stop' ? 'udsFlow.log.kaReleasedStop' : 'udsFlow.log.kaReleasedEnd')}` });
    } catch (e) {
      this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
        message: `[${ts()}] ✗ ${t('udsFlow.log.kaReleaseFail', { msg: e instanceof Error ? e.message : String(e) })}` });
    }
  }
  private _halted(): boolean {
    return this._stopped || this._abortError !== null || this._frame.finished;
  }

  private refuse(): void {
    this.result = { outcome: 'error', name: null, outputs: {}, stopped: false, refused: true };
  }

  pause():  void { this._paused = true;  this._sink.setPaused(true); }
  resume(): void {
    this._paused = false; this._sink.setPaused(false);
    this._resumeResolve?.(); this._resumeResolve = null;
  }

  private async waitIfPaused(): Promise<void> {
    if (this._paused) await new Promise<void>((r) => { this._resumeResolve = r; });
  }

  // ── Frames ─────────────────────────────────────────────────────────────────

  private makeFrame(
    diagram: FlowDiagram, name: string, path: string[], pathKey: string, ecu: EcuRecordV1 | null, inputValues: Record<string, unknown>,
  ): Frame {
    const transport = this._transport as FlowTransport;
    const evalLog = (b: FlowBlock, msg: string): void => this.log(b.id, b.label, `[${ts()}]   ${msg}`);
    const frame = {
      diagram, name, path, pathKey, ecu, inputValues,
      scope: createScope(diagram.variables ?? []),
      real: null, finished: false, reached: null, loopSignal: null, loopDepth: 0, imageKeys: new Set<string>(),
    } as unknown as Frame;
    const src = (): FlowDiagram => frame.diagram;
    const inputs = (): Record<string, unknown> => frame.inputValues;
    frame.real = this._demo ? null : new RealFlowExecutor(transport, this._ctx, evalLog, () => this._stopped, false, src, inputs);
    frame.eval = frame.real ?? new RealFlowExecutor(transport, this._ctx, evalLog, () => this._stopped, true, src, inputs);
    return frame;
  }

  private enter(frame: Frame): void {
    this._stack.push(frame);
    this._frame = frame;
    this._ctx.scope = frame.scope;
    this._sink.setFramePath(frame.path);
  }

  private leave(): void {
    this._stack.pop();
    const top = this._stack[this._stack.length - 1];
    if (top) {
      this._frame = top;
      this._ctx.scope = top.scope;
      this._sink.setFramePath(top.path);
    } else {
      this._sink.setFramePath([]);
    }
  }

  /**
   * Runs one frame from its entry block. A child frame that ends with an unhandled error rethrows it (the
   * call block routes it to its `error` port); keep-alives started inside a child are released when it exits.
   */
  private async runFrame(frame: Frame, entry: FlowBlock, child: boolean): Promise<{ unhandled: unknown }> {
    this.enter(frame);
    const kaBefore = this._ctx.keepaliveActive;
    let unhandled: unknown = null;
    try {
      this._cameFrom = null;
      await this.executeChain(entry);
      await this.finishFrame(frame);
    } catch (err) {
      unhandled = err ?? new Error('error');
    } finally {
      if (child && !kaBefore && this._ctx.keepaliveActive) await this.releaseKeepalive(this._stopped ? 'stop' : 'end');
      // Images loaded from bound `file` ports live exactly as long as their frame.
      for (const key of frame.imageKeys) clearImage(key);
      frame.imageKeys.clear();
      this.leave();
    }
    return { unhandled };
  }

  /**
   * Frame end (a `flow_return` was reached, or the exec path finished = implicit `ok`): every `flow_out` is sampled
   * with the `softInput` rule (a source that did not run on this path is absent). A `required` output without a
   * value on outcome `ok` is a run error in the real engine; the simulated one stays lenient.
   */
  private async finishFrame(frame: Frame): Promise<void> {
    if (this._stopped || this._abortError !== null) return;
    const ret = frame.reached ?? { name: 'ok', outcome: 'ok' as FlowOutcome, outputs: {}, implicit: true };
    const outputs: Record<string, unknown> = {};
    for (const b of frame.diagram.blocks) {
      if (b.type !== FLOW_OUT) continue;
      const spec = blockPortSpec(b);
      const v = await frame.eval.softInput(b, 'value');
      if (v !== undefined) {
        outputs[spec.key] = v;
        this.setStatus(b, 'success');
      } else if (spec.required && ret.outcome === 'ok' && frame.real !== null) {
        const msg = t('flowReg.run.outputMissing', { name: spec.key, block: b.label });
        this.setStatus(b, 'error', msg);
        throw new Error(msg);
      }
    }
    frame.reached = { ...ret, outputs };
  }

  async run(opts: FlowRunOptions = {}): Promise<void> {
    this._sink = opts.rootBody ? detachedSink(opts.onLog) : flowStore;
    this._stopped = false;
    this._paused  = false;
    this._abortError = null;
    this._blocks = 0;
    this._maxDepth = opts.limits?.maxDepth ?? MAX_CALL_DEPTH;
    this._maxBlocks = opts.limits?.maxBlocks ?? MAX_RUN_BLOCKS;
    this._stack = [];
    this.result = null;
    this._ctx     = newRunContext();
    this._demo    = opts.transport ? opts.transport.demo : diagnosticsStore.getState().mockMode;
    this._transport = opts.transport ?? (this._demo ? demoFlowTransport : new RealFlowTransport(diagnosticsStore.getState().activeTabId));
    this._cameFrom = null;
    const ecu = opts.ecu ?? null;
    this._rootEcu = ecu;

    // A flow run can transmit UDS requests on its own schedule: Panic Stop must be able to abort it.
    const unregisterTx = this._demo
      ? null
      : registerTxSource(this._txSourceId, () => {
          this.stop();
          this._sink.setRunning(false);
          this._sink.setPaused(false);
        });

    this._sink.setRunning(true);
    this._sink.resetBlockStatuses();
    this._sink.setFramePath([]);
    flashRuntime.resetRuns();
    this._sink.clearRunLog();
    this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'info',
      message: `[${ts()}] ${t('diagEng.flowStarted')} (${this._demo ? t('diagReal.flow.modeDemo') : t('diagReal.flow.modeReal')})` });

    const diagram = opts.rootBody ?? flowStore.getSnapshot().diagram;
    const rootId = opts.rootId !== undefined ? opts.rootId : diagram.id;
    const rootName = opts.rootName ?? diagram.name;
    const refuseAll = (issues: Array<{ blockId: string; message: string }>, header: TranslationKey): void => {
      refuseRun(this._sink, diagram, issues, header);
      this.refuse();
      this._sink.setRunning(false);
      unregisterTx?.();
    };

    const startBlock = findEntryBlock(diagram);
    if (!startBlock) {
      this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
        message: `[${ts()}] ✗ ${t('diagEng.startNotFound')}` });
      this.refuse();
      this._sink.setRunning(false);
      unregisterTx?.();
      return;
    }

    // Terminal / goto integrity is checked BEFORE anything is transmitted.
    const issues = validateTerminals(diagram);
    if (issues.length > 0) {
      refuseAll(issues.map((i) => ({ blockId: i.blockId, message: terminalIssueMessage(diagram, i) })), 'udsFlow.term.invalid');
      return;
    }

    // Core pack: declarations / references / templates / loop control are checked BEFORE anything is transmitted.
    const coreIssues: CoreIssue[] = validateCore(diagram);
    if (coreIssues.length > 0) {
      refuseAll(coreIssues, 'flowCore.val.invalid');
      return;
    }

    // Flow interface (keys, single `flow_start`, `ecu` input, bound params) and the run-time input values: refused BEFORE any TX.
    const ifaceIssues = validateInterface(diagram);
    if (ifaceIssues.length > 0) {
      refuseAll(ifaceIssues, 'flowReg.val.invalid');
      return;
    }
    const resolved = resolveRunInputs(flowInSpecs(diagram), { ...(opts.inputs ?? {}), ...(ecu ? { ecu } : {}) });
    if (resolved.errors.length > 0) {
      refuseAll(resolved.errors.map((message) => ({ blockId: startBlock.id, message })), 'flowReg.run.refused');
      return;
    }
    const inputValues: Record<string, unknown> = resolved.values;

    // Call graph (cycles, unresolved refs, ports), ECU binding (protocols, `{ecu.*}` per frame) and the session.
    const cache = new CalleeCache(opts.resolveCallee ?? ((id, rev) => flowRegistry.loadBody(id, rev)));
    this._callees = cache;
    const pre = await preflightCalls(diagram, rootId, rootName, cache);
    const bindIssues = [...pre.issues, ...checkEcuBinding(pre.frames, ecu)];
    if (ecu && !this._demo) {
      const probe = opts.ecuSession ? opts.ecuSession() : opts.transport ? undefined : activeSessionProbe();
      if (probe !== undefined) {
        const m = checkEcuSession(ecu, probe);
        if (m !== null) bindIssues.push({ blockId: '', code: 'session', message: m });
      }
    }
    if (bindIssues.length > 0) {
      refuseAll(bindIssues, 'flowNest.val.invalid');
      return;
    }

    let root: Frame;
    try {
      root = this.makeFrame(resolveFrameDiagram(diagram, ecu).diagram, rootName, [rootName], '', ecu, inputValues);
    } catch (err) {
      this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
        message: `[${ts()}] ✗ ${err instanceof Error ? err.message : String(err)}` });
      this.refuse();
      this._sink.setRunning(false);
      unregisterTx?.();
      return;
    }

    // Bound values that are already known (flow_in / constant sources) are validated now, before ANY TX.
    const boundIssues = await preflightBoundValues(root.diagram, (b, p) => root.eval.core.optional(b, p, 0));
    if (boundIssues.length > 0) {
      refuseAll(boundIssues, 'flowReg.val.invalid');
      return;
    }

    const { unhandled } = await this.runFrame(root, startBlock, false);
    if (unhandled !== null) {
      this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'error',
        message: `[${ts()}] ✗ ${unhandled instanceof Error ? unhandled.message : String(unhandled)}` });
    }
    // Every terminal path (end, unhandled error, stop, Panic): no keep-alive survives the run.
    await this.releaseKeepalive(this._stopped ? 'stop' : 'end');
    unregisterTx?.();
    const reached = root.reached;
    const failed = unhandled !== null || this._abortError !== null;
    this.result = this._stopped
      ? { outcome: 'error', name: null, outputs: {}, stopped: true, refused: false }
      : reached && !failed
        ? { outcome: reached.outcome, name: reached.implicit ? null : reached.name, outputs: reached.outputs, stopped: false, refused: false }
        : { outcome: failed ? 'error' : 'ok', name: null, outputs: {}, stopped: false, refused: false };

    this._sink.setRunning(false);
    this._sink.setPaused(false);
    if (!this._stopped) {
      this._sink.addRunLog({ blockId: '', blockLabel: 'Engine', level: 'info',
        message: `[${ts()}] ${t('diagEng.flowDone')}` });
    }
  }

  private async executeChain(block: FlowBlock, from: FlowBlock | null = null): Promise<void> {
    if (this._halted()) return;
    await this.waitIfPaused();
    if (this._halted()) return;
    this._cameFrom = from;
    const result = await this.executeBlock(block);
    if (this._halted()) return;
    // flow_break / flow_continue: the chain ends here; the nearest loop driver consumes the signal.
    if (this._loopSignal !== null) return;
    if (block.type === 'flow_goto') {
      // Wireless jump: continue AT the terminal (execute it, then follow its exec_out). The target was
      // validated by dispatchDemo; a tight goto<->terminal cycle is rejected by validateTerminals.
      const target = resolveGotoTarget(this._frame.diagram, block);
      if (target) await this.executeChain(target, block);
      return;
    }
    if (result.nextPortId) {
      const next = this.findNextBlock(block.id, result.nextPortId);
      if (next) await this.executeChain(next, block);
    }
  }

  private async executeBlock(block: FlowBlock): Promise<{ nextPortId: string; result?: unknown }> {
    const diagram = this._frame.diagram;
    if (++this._blocks > this._maxBlocks) {
      throw this.abort(new Error(t('flowNest.err.blockLimit', { n: this._maxBlocks })));
    }
    this.setStatus(block, 'running');

    try {
      // Bound parameters (`p:<key>` ports) override the stored config for THIS execution only; invalid / missing
      // values throw here, before the block transmits anything.
      const effective = await applyBoundParams(
        block,
        (portId) => this._eval.core.optional(block, portId, 0),
        // Distinct from the panel-loaded image of the block (key = block id), which a bound file must never clobber.
        `bound\u0000${this._frame.pathKey}\u0000${block.id}`,
      );
      const imageKey = effective.config[FLASH_IMAGE_KEY];
      if (effective !== block && typeof imageKey === 'string') this._frame.imageKeys.add(imageKey);
      const outcome = await this.dispatchBlock(effective);
      this._eval.record(block, outcome);
      this._sink.setFrameResult(this._frame.pathKey, block.id, outcome.result);
      if (outcome.failed) {
        // Handled failure (e.g. flash download error): leave via `fail_out` when wired, else abort the run.
        const failPort = outcome.nextPort ?? 'fail_out';
        if (!diagram.connections.some((c) => c.fromBlockId === block.id && c.fromPortId === failPort)) {
          throw new Error(outcome.message);
        }
        this.setStatus(block, 'error', outcome.message);
        this._sink.addRunLog({ blockId: block.id, blockLabel: block.label, level: 'error',
          message: `[${ts()}] ✗ ${block.label}  →  ${outcome.message}` });
        return { nextPortId: outcome.nextPort ?? 'fail_out', result: outcome.result };
      }
      this.setStatus(block, 'success', outcome.message);
      this._sink.addRunLog({ blockId: block.id, blockLabel: block.label, level: 'success',
        message: `[${ts()}] ✓ ${block.label}  →  ${outcome.message}` });

      if (block.type === 'loop') {
        const iters = Number(block.config['iterations'] ?? 3);
        for (let i = 0; i < iters; i++) {
          if (this._halted()) break;
          await this.waitIfPaused();
          if (this._halted()) break;
          if ((await this.runLoopBody(block)) === 'break') break;
        }
        return { nextPortId: 'done_out', result: outcome.result };
      }
      if (block.type === 'flow_for') {
        const range = readForRange(block);
        let n = 0;
        for (;;) {
          const v = forValueAt(range, n);
          if (v === null) break;
          if (n >= FOR_ITERATION_CAP) throw new Error(t('flowCore.err.forCap', { block: block.label, cap: FOR_ITERATION_CAP }));
          if (this._halted()) break;
          await this.waitIfPaused();
          if (this._halted()) break;
          this._ctx.scope.locals.set(block.id, v);
          n++;
          if ((await this.runLoopBody(block)) === 'break') break;
        }
        return { nextPortId: 'done_out', result: n };
      }
      if (block.type === 'flow_while') {
        const maxIter = Number(block.config['max_iterations'] ?? WHILE_DEFAULT_MAX);
        let iterCount = 0;
        if (this._real || this._eval?.canEvalPure(block, 'bool_in')) {
          // Re-evaluate the connected bool input before every iteration (pure; reads the current variables).
          const ev = this._eval;
          while (iterCount < maxIter) {
            if (this._halted()) break;
            await this.waitIfPaused();
            if (this._halted() || !(await ev.evalBool(block, 'bool_in'))) break;
            iterCount++;
            if ((await this.runLoopBody(block)) === 'break') return { nextPortId: 'done_out', result: iterCount };
          }
          // Cap reached: only a condition that is still true is an error (never a silent stop).
          if (iterCount >= maxIter && !this._halted() && (await ev.evalBool(block, 'bool_in'))) {
            throw new Error(t('flowCore.err.whileCap', { block: block.label, n: iterCount }));
          }
          return { nextPortId: 'done_out', result: iterCount };
        }
        // DEMO without an evaluable condition: body runs 3 times (simulation)
        while (iterCount < Math.min(3, maxIter)) {
          if (this._halted()) break;
          await this.waitIfPaused();
          iterCount++;
          if ((await this.runLoopBody(block)) === 'break') break;
        }
        return { nextPortId: 'done_out', result: iterCount };
      }
      if (block.type === 'condition') return { nextPortId: outcome.result ? 'true_out' : 'false_out', result: outcome.result };
      if (block.type === 'assert')    return { nextPortId: outcome.result ? 'pass_out' : 'fail_out', result: outcome.result };

      return { nextPortId: outcome.nextPort ?? 'exec_out', result: outcome.result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(block, 'error', msg);
      this._sink.addRunLog({ blockId: block.id, blockLabel: block.label, level: 'error',
        message: `[${ts()}] ✗ ${block.label}  →  ${msg}` });
      // The flash block has no `error_out`: its failures (including refused pre-flight) leave via
      // `fail_out`; wait-ready has only `timeout_out`.
      const errPort = isCallType(block.type) ? 'error' : block.type === 'uds_flash_image' ? 'fail_out' : block.type === 'uds_wait_ecu_ready' ? 'timeout_out' : 'error_out';
      const hasErrOut = diagram.connections.some((c) => c.fromBlockId === block.id && c.fromPortId === errPort);
      if (hasErrOut) return { nextPortId: errPort };
      throw err;
    }
  }

  /** Runs the `body_out` chain once; reports a `flow_break` raised inside it (a `flow_continue` just ends the pass). */
  private async runLoopBody(loop: FlowBlock): Promise<'next' | 'break'> {
    const bodyNext = this.findNextBlock(loop.id, 'body_out');
    if (bodyNext) {
      this._loopDepth++;
      try {
        await this.executeChain(bodyNext);
      } finally {
        this._loopDepth--;
      }
    }
    const sig = this._loopSignal;
    this._loopSignal = null;
    return sig === 'break' ? 'break' : 'next';
  }

  /**
   * Core exec blocks (`log` templates, `var_set`, `flow_for`, `flow_break`, `flow_continue`): identical in
   * simulated and real mode (shared `coreRuntime`), so the two engines cannot diverge.
   */
  private async dispatchCore(block: FlowBlock): Promise<{ message: string; result?: unknown }> {
    const ev = this._eval;
    const scope = this._ctx.scope;
    switch (block.type) {
      case 'log': {
        const msg = await renderLogMessage(block, ev.core, scope);
        this.log(block.id, block.label, `[${ts()}]   LOG: ${msg || t('diagEng.empty')}`);
        return { message: msg || t('diagEng.emptyMsg') };
      }
      case 'var_set':
        return { message: await execVarSet(block, ev.core, scope) };
      case 'flow_for': {
        const r = readForRange(block);
        return { message: t('flowCore.log.for', { from: formatValue(r.from), to: formatValue(r.to), step: formatValue(r.step) }) };
      }
      default: {
        if (this._loopDepth === 0) throw new Error(t('flowCore.err.loopOutside', { block: block.label }));
        this._loopSignal = block.type === 'flow_break' ? 'break' : 'continue';
        return { message: t(block.type === 'flow_break' ? 'flowCore.log.break' : 'flowCore.log.continue') };
      }
    }
  }

  /** Real mode: structural blocks without any bus/data content run as-is; everything else is live. */
  private async dispatchBlock(
    block: FlowBlock,
  ): Promise<{ message: string; result?: unknown; nextPort?: string; outputs?: Record<string, unknown>; failed?: boolean }> {
    if (isCallType(block.type)) return this.dispatchCall(block);
    if (CORE_EXEC_BLOCKS.has(block.type)) return this.dispatchCore(block);
    if (this._real && !REAL_STRUCTURAL.has(block.type)) return this._real.execute(block);
    return this.dispatchDemo(block);
  }

  /**
   * DEMO simulation (random latency / NRCs / fabricated records). Reached in real mode ONLY for the
   * structural blocks in `REAL_STRUCTURAL`, which contain no simulated data.
   */
  private async dispatchDemo(
    block: FlowBlock,
  ): Promise<{ message: string; result?: unknown; nextPort?: string; outputs?: Record<string, unknown>; failed?: boolean }> {
    const ctx = this._ctx;

    switch (block.type) {

      // ── FLOW ─────────────────────────────────────────────────────────────────

      case 'flow_terminal': return { message: t('udsFlow.term.reached', { name: terminalName(block) }) };

      case 'flow_goto': {
        // Real and DEMO share this structural path (no bus traffic). Missing / invalid target = block error.
        const target = resolveGotoTarget(this._frame.diagram, block);
        if (target === null) throw new Error(t('udsFlow.term.missing'));
        const msg = t('udsFlow.term.jump', { name: terminalName(target), from: (this._cameFrom ?? block).label });
        this.log(block.id, block.label, `[${ts()}]   ${msg}`);
        return { message: msg };
      }

      case FLOW_START:
        return { message: t('diagEng.startMsg'), nextPort: 'start' };

      case FLOW_RETURN: {
        // Ends the frame with this outcome; the `flow_out` values are sampled once, at frame end (`finishFrame`).
        const name = returnName(block).trim();
        const outcome = returnOutcome(block);
        this._frame.reached = { name, outcome, outputs: {}, implicit: false };
        this._frame.finished = true;
        return { message: t('flowReg.run.outputReached', { name, outcome }) };
      }

      case 'delay': {
        const ms = Number(block.config['delay_ms'] ?? 1000);
        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.delayWaiting', { ms })}`);
        await new Promise<void>((r) => setTimeout(r, ms));
        return { message: t('diagEng.delayDone', { ms }) };
      }

      case 'condition': {
        // Wired to a pure, real-valued cone (core pack / constants / compares): evaluate it for real.
        if (this._eval?.canEvalPure(block, 'bool_in')) {
          const v = await this._eval.evalBool(block, 'bool_in');
          return { message: String(v), result: v };
        }
        return { message: t('diagEng.condEval'), result: true };
      }
      case 'loop':      return { message: t('diagEng.loopStart', { n: String(block.config['iterations'] ?? 3) }) };
      case 'assert':    return { message: t('diagEng.assertPass'), result: true };

      case 'flow_while': {
        const maxIter = Number(block.config['max_iterations'] ?? WHILE_DEFAULT_MAX);
        // The actual loop execution is handled in executeBlock — just return the message
        return { message: t('diagEng.whileLoop', { max: maxIter }) };
      }

      case 'flow_timeout_guard': {
        const timeoutMs = Number(block.config['timeout_ms'] ?? 5000);
        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.timeoutActive', { ms: timeoutMs })}`);
        return { message: t('diagEng.timeoutGuard', { ms: timeoutMs }) };
      }

      // ── 0x10 DiagnosticSessionControl ────────────────────────────────────────

      case 'uds_session': {
        const st = (block.config['session_type'] as string) ?? 'extended';
        const subFn: Record<string, number> = { default: 0x01, programming: 0x02, extended: 0x03, safety: 0x04 };
        const sf = subFn[st] ?? 0x03;

        this.log(block.id, block.label, `[${ts()}]   TX: 10 ${hexB(sf)}  (DiagnosticSessionControl)`);
        const resp = await udsRequest(0x10, [sf, 0x00, 0x19, 0x01, 0xF4]);
        const p2ms  = ((resp[2] << 8) | resp[3]) * 0.5;
        const p2ext = ((resp[4] << 8) | resp[5]) * 10;
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}  P2=${p2ms}ms P2*=${p2ext}ms`);

        ctx.sessionType = st as RunContext['sessionType'];
        return { message: t('diagEng.sessionOpened', { st: st.toUpperCase(), p2: p2ms }), result: { sessionType: st, p2: p2ms, p2ext } };
      }

      // ── 0x11 ECUReset ─────────────────────────────────────────────────────────

      case 'uds_ecu_reset': {
        const rt = (block.config['reset_type'] as string) ?? 'hardReset';
        const rtBytes: Record<string, number> = { hardReset: 0x01, keyOffOnReset: 0x02, softReset: 0x03, enableRapidPowerShutDown: 0x04 };
        const sf = rtBytes[rt] ?? 0x01;

        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F));

        this.log(block.id, block.label, `[${ts()}]   TX: 11 ${hexB(sf)}  (ECUReset)`);
        const resp = await udsRequest(0x11, [sf]);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        ctx.sessionType      = 'default';
        ctx.securityUnlocked = false;
        ctx.commControlled   = false;

        const labels: Record<string, string> = { hardReset: 'Hard', keyOffOnReset: 'Key Off/On', softReset: 'Soft', enableRapidPowerShutDown: 'Rapid Shutdown' };
        return { message: t('diagEng.ecuReset', { type: labels[rt] ?? rt }) };
      }

      // ── 0x14 ClearDiagnosticInformation ──────────────────────────────────────

      case 'uds_clear_dtc': {
        const group = String(block.config['group'] ?? 'FFFFFF').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(6, '0');
        const gb = [parseInt(group.slice(0, 2), 16), parseInt(group.slice(2, 4), 16), parseInt(group.slice(4, 6), 16)];

        this.log(block.id, block.label, `[${ts()}]   TX: 14 ${gb.map(hexB).join(' ')}  (ClearDiagnosticInformation)`);
        const resp = await udsRequest(0x14, gb);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        return { message: t('diagEng.dtcGroupCleared', { group }) };
      }

      // ── 0x19 ReadDTCInformation ───────────────────────────────────────────────

      case 'uds_read_dtc': {
        const subFnVal  = String(block.config['sub_fn'] ?? '02');
        const sf        = parseInt(subFnVal, 16);
        const statusMask = parseInt(String(block.config['status_mask'] ?? 'FF'), 16);

        this.log(block.id, block.label, `[${ts()}]   TX: 19 ${hexB(sf)} ${hexB(statusMask)}  (ReadDTCInformation subFn=0x${hexB(sf)})`);
        await udsRequest(0x19, [sf, statusMask]);

        // subFn 0x01 / 0x07 / 0x11: return count only
        if ([0x01, 0x07, 0x11].includes(sf)) {
          const count = sf === 0x07 ? 1 : 3;
          this.log(block.id, block.label, `[${ts()}]   RX: 59 ${hexB(sf)} FF 00 ${hexB(count)}  (${t('diagEng.dtcMatched', { n: count })})`);
          return { message: t('diagEng.dtcCount', { count, sf: hexB(sf), mask: hexB(statusMask) }), result: count };
        }

        // subFn 0x0A / 0x0B / 0x0C / 0x0D / 0x0E: single/all DTC lists
        if ([0x0A, 0x0B, 0x0C, 0x0D, 0x0E].includes(sf)) {
          const supported = ['P0100', 'P0200', 'P0300', 'C0010', 'U0100', 'U0073'];
          const single = [0x0B, 0x0C, 0x0D, 0x0E].includes(sf);
          const result = single ? [supported[0]] : supported;
          result.forEach((d) => this.log(block.id, block.label, `[${ts()}]       ${d}`));
          return { message: `${result.length} DTC (subFn=0x${hexB(sf)})`, result };
        }

        // subFn 0x09: severity info for specific DTC
        if (sf === 0x09) {
          this.log(block.id, block.label, `[${ts()}]   RX: 59 09 00 P0100  status=0x08  severity=0x20`);
          return { message: t('diagEng.dtcSeverity'), result: { dtc: 'P0100', severity: 0x20 } };
        }

        // subFn 0x14 / 0x15 / 0x55: fault detection counter / permanent DTCs
        if ([0x14, 0x15, 0x55].includes(sf)) {
          this.log(block.id, block.label, `[${ts()}]   RX: 59 ${hexB(sf)}  P0100 counter=127  P0300 permanent`);
          return { message: t('diagEng.dtcCustom', { sf: hexB(sf) }), result: [] };
        }

        // subFn 0x02 / 0x05 / 0x08 / 0x0F / 0x42: list by mask/severity
        const mockDtcs = [
          { code: 'P0100', raw: [0x01, 0x00, 0x09], status: 0x08, desc: t('diagEng.dtcDescP0100') },
          { code: 'P0300', raw: [0x03, 0x00, 0x00], status: 0x09, desc: t('diagEng.dtcDescP0300') },
          { code: 'U0100', raw: [0x50, 0x01, 0x00], status: 0x08, desc: t('diagEng.dtcDescU0100') },
        ];
        this.log(block.id, block.label, `[${ts()}]   RX: 59 ${hexB(sf)} FF  ${t('diagEng.dtcRecords', { n: mockDtcs.length })}`);
        mockDtcs.forEach((d) => {
          this.log(block.id, block.label, `[${ts()}]       ${d.code}  status=0x${hexB(d.status)}  ${d.desc}`);
        });
        return { message: `${mockDtcs.length} DTC (subFn=0x${hexB(sf)}, mask=0x${hexB(statusMask)})`, result: mockDtcs };
      }

      // ── 0x22 ReadDataByIdentifier ─────────────────────────────────────────────

      case 'uds_read_did': {
        const did = String(block.config['did'] ?? 'F190').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0');
        const didBytes = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];

        this.log(block.id, block.label, `[${ts()}]   TX: 22 ${didBytes.map(hexB).join(' ')}  (ReadDataByIdentifier 0x${did})`);
        await udsRequest(0x22, didBytes);

        const mockData: Record<string, { label: string; raw: number[]; display: string }> = {
          'F190': { label: 'VIN',              raw: [0x57,0x4E,0x58,0x53,0x59,0x4E,0x54,0x48,0x30,0x30,0x30,0x30,0x30,0x30,0x30,0x30,0x31], display: 'WNXSYNTH000000001' },
          'F188': { label: 'ECU Software No',  raw: [0x53,0x57,0x5F,0x76,0x32,0x2E,0x33,0x2E,0x31], display: 'SW_v2.3.1' },
          'F187': { label: 'ECU Part No',      raw: [0x50,0x4E,0x2D,0x37,0x36,0x35,0x34,0x33,0x32,0x31], display: 'PN-7654321' },
          'F18C': { label: 'ECU Serial No',    raw: [0x45,0x43,0x55,0x2D,0x30,0x30,0x31,0x32,0x33], display: 'ECU-00123' },
          'F197': { label: 'System Name',      raw: [0x45,0x4E,0x47,0x49,0x4E,0x45,0x5F,0x43,0x54,0x52,0x4C], display: 'ENGINE_CTRL' },
          'F1A0': { label: 'Calibration ID',   raw: [0x43,0x41,0x4C,0x5F,0x32,0x30,0x32,0x34,0x2D,0x41], display: 'CAL_2024-A' },
          'F1A2': { label: 'Fingerprint',      raw: [0x4E,0x45,0x58,0x55,0x53,0x43,0x41,0x4E,0x5F,0x44,0x45,0x56], display: 'NEXUSCAN_DEV' },
          'F180': { label: 'Boot Software ID', raw: [0x42,0x4F,0x4F,0x54,0x5F,0x31,0x2E,0x30,0x2E,0x32], display: 'BOOT_1.0.2' },
          'F182': { label: 'App Software ID',  raw: [0x41,0x50,0x50,0x5F,0x32,0x2E,0x33,0x2E,0x31], display: 'APP_2.3.1' },
        };

        const entry = mockData[did] ?? { label: `DID 0x${did}`, raw: [0xDE, 0xAD, 0xBE, 0xEF], display: '0xDEADBEEF' };
        const rawBytes = new Uint8Array(entry.raw);
        this.log(block.id, block.label, `[${ts()}]   RX: 62 ${didBytes.map(hexB).join(' ')} ${entry.raw.map(hexB).join(' ')}`);
        this.log(block.id, block.label, `[${ts()}]       ${entry.label}: "${entry.display}"`);

        return { message: `0x${did} (${entry.label}) = "${entry.display}"`, result: { did, label: entry.label, raw: rawBytes, display: entry.display }, outputs: { data_out: rawBytes } };
      }

      // ── 0x23 ReadMemoryByAddress ──────────────────────────────────────────────

      case 'uds_read_memory': {
        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00000010').toUpperCase().replace(/[^0-9A-F]/g, '');
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0,0,0x10];
        const addrLen = addrBytes.length;
        const sizeLen = sizeBytes.length;
        const memFmt  = ((addrLen & 0xF) << 4) | (sizeLen & 0xF);

        this.log(block.id, block.label, `[${ts()}]   TX: 23 ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')}  (ReadMemoryByAddress)`);
        await udsRequest(0x23, [memFmt, ...addrBytes, ...sizeBytes]);

        const dataSize = parseInt(sizeHex, 16);
        const mockData = new Uint8Array(Math.min(dataSize, 32));
        for (let i = 0; i < mockData.length; i++) mockData[i] = (parseInt(addrHex, 16) + i) & 0xFF;
        this.log(block.id, block.label, `[${ts()}]   RX: 63 ${hex(mockData)}${dataSize > 32 ? ` ... (${dataSize} bytes total)` : ''}`);

        return { message: `${t('diagEng.memRead', { addr: addrHex, size: dataSize })}`, result: mockData };
      }

      // ── 0x27 SecurityAccess ───────────────────────────────────────────────────

      case 'uds_security_access': {
        // ISO 14229-1 Table 23: SecurityAccess NOT available in default session
        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needExtProg')}`);

        const accessLevelHex = String(block.config['access_level'] ?? '01').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(2, '0');
        const oddLevel       = parseInt(accessLevelHex, 16);
        const evenLevel      = oddLevel + 1;
        const algorithm      = String(block.config['algorithm'] ?? 'xor_ff');
        const constantHex    = String(block.config['constant']  ?? '5A3C1E8F');
        const script         = String(block.config['script']    ?? '');

        // ── Step 1: Request seed ─────────────────────────────────────────────
        this.log(block.id, block.label, `[${ts()}]   [1/3] TX: 27 ${hexB(oddLevel)}  (SecurityAccess — requestSeed level=0x${accessLevelHex})`);
        await randomDelay(30, 80);
        const seedBytes = new Uint8Array(4);
        crypto.getRandomValues(seedBytes);
        const seedResp = new Uint8Array([0x67, oddLevel, ...seedBytes]);
        this.log(block.id, block.label, `[${ts()}]   [1/3] RX: ${hex(seedResp)}  seed=${hex(seedBytes)}`);

        // Check for zero seed (already unlocked in some ECUs)
        if (seedBytes.every((b) => b === 0x00)) {
          this.log(block.id, block.label, `[${ts()}]   [1/3] ${t('diagEng.seedZero')}`);
          ctx.securityUnlocked = true;
          ctx.unlockedLevel = oddLevel;
          return { message: `${t('diagEng.secAlreadyOpen', { level: accessLevelHex })}`, result: { seed: seedBytes, key: new Uint8Array(0), level: oddLevel }, nextPort: 'success_out' };
        }

        // ── Step 2: Calculate key ────────────────────────────────────────────
        this.log(block.id, block.label, `[${ts()}]   [2/3] ${t('diagEng.keyCalc', { algorithm })}`);
        let keyBytes: Uint8Array;
        try {
          keyBytes = await computeKey(algorithm, seedBytes, oddLevel, constantHex, script);
        } catch (e) {
          throw new Error(t('diagEng.scriptError', { msg: e instanceof Error ? e.message : String(e) }));
        }
        this.log(block.id, block.label, `[${ts()}]   [2/3] key = ${hex(keyBytes)}`);

        // ── Step 3: Send key ─────────────────────────────────────────────────
        const keyPayload = [evenLevel, ...keyBytes];
        this.log(block.id, block.label, `[${ts()}]   [3/3] TX: 27 ${keyPayload.map(hexB).join(' ')}  (SecurityAccess — sendKey level=0x${hexB(evenLevel)})`);
        await randomDelay(30, 80);

        if (Math.random() < 0.04) throw new Error(nrcName(0x35));

        const keyResp = new Uint8Array([0x67, evenLevel]);
        this.log(block.id, block.label, `[${ts()}]   [3/3] RX: ${hex(keyResp)}  → ${t('diagEng.accessGranted')}`);

        ctx.securityUnlocked = true;
        ctx.unlockedLevel    = oddLevel;

        return {
          message: `Security Access 0x${accessLevelHex} [${algorithm}]  seed=${hex(seedBytes)}  key=${hex(keyBytes)}`,
          result:  { seed: seedBytes, key: keyBytes, level: oddLevel },
          nextPort: 'success_out',
        };
      }

      // ── Lockout Guard ─────────────────────────────────────────────────────────

      case 'uds_lockout_guard': {
        const maxAttempts = Number(block.config['max_attempts'] ?? 3);
        const lockoutMs   = Number(block.config['lockout_ms']   ?? 10000);

        // Use ctx.variables to track attempt count per block
        const countKey = `_lockout_${block.id}`;
        const lockedKey = `_lockout_locked_${block.id}`;
        const lockedUntil = ctx.variables.get(lockedKey) as number | undefined;

        if (lockedUntil && Date.now() < lockedUntil) {
          const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
          this.log(block.id, block.label, `[${ts()}]   ⚠ ${t('diagEng.lockActive', { s: remaining })}`);
          return { message: t('diagEng.lockActiveShort', { s: remaining }), nextPort: 'delay_out' };
        }

        const attempts = (ctx.variables.get(countKey) as number ?? 0) + 1;
        ctx.variables.set(countKey, attempts);

        if (attempts > maxAttempts) {
          ctx.variables.set(lockedKey, Date.now() + lockoutMs);
          ctx.variables.set(countKey, 0);
          this.log(block.id, block.label, `[${ts()}]   ✗ ${t('diagEng.maxAttempts', { max: maxAttempts, ms: lockoutMs })}`);
          return { message: t('diagEng.lockoutMsg', { nrc: nrcName(0x36), ms: lockoutMs }), nextPort: 'delay_out' };
        }

        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.attemptAllowed', { a: attempts, max: maxAttempts })}`);
        return { message: t('diagEng.attemptShort', { a: attempts, max: maxAttempts }), result: attempts };
      }

      // ── Seed/Key Validator ────────────────────────────────────────────────────

      case 'uds_seed_validator': {
        const expectedHex = String(block.config['expected_key'] ?? 'C9A8').replace(/[^0-9a-fA-F]/g, '');

        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.expectedKey', { key: expectedHex || t('diagEng.empty') })}`);
        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.mockVerify')}`);

        const passed = Math.random() > 0.1; // 90% pass in simulation
        if (passed) {
          this.log(block.id, block.label, `[${ts()}]   ✓ ${t('diagEng.keyMatched')}`);
          return { message: t('diagEng.keyVerified'), result: { valid: true, expected: expectedHex }, nextPort: 'pass_out' };
        } else {
          this.log(block.id, block.label, `[${ts()}]   ✗ ${t('diagEng.keyMismatchLog', { nrc: nrcName(0x35) })}`);
          return { message: t('diagEng.keyMismatchMsg', { nrc: nrcName(0x35) }), result: { valid: false, expected: expectedHex }, nextPort: 'fail_out' };
        }
      }

      // ── 0x28 CommunicationControl ─────────────────────────────────────────────

      case 'uds_comm_control': {
        // ISO 14229-1 Table 23: CommunicationControl NOT available in default session
        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needExtProg')}`);

        const ctrlType = String(block.config['control_type'] ?? '03');
        const commType = String(block.config['comm_type']    ?? '01');
        const ctrlByte = parseInt(ctrlType, 16);
        const commByte = parseInt(commType, 16);
        const ctrlLabel: Record<string, string> = {
          '00': 'enableRxAndTx', '01': 'enableRxAndDisableTx',
          '02': 'disableRxAndEnableTx', '03': 'disableRxAndTx',
        };

        this.log(block.id, block.label, `[${ts()}]   TX: 28 ${hexB(ctrlByte)} ${hexB(commByte)}  (CommunicationControl — ${ctrlLabel[ctrlType] ?? ctrlType})`);
        const resp = await udsRequest(0x28, [ctrlByte, commByte]);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        ctx.commControlled = ctrlType === '03';
        return { message: `CommunicationControl: ${ctrlLabel[ctrlType] ?? ctrlType}` };
      }

      // ── 0x2E WriteDataByIdentifier ────────────────────────────────────────────

      case 'uds_write_did': {
        const did = String(block.config['did'] ?? 'F190').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0');
        const didBytes = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];
        if (!ctx.securityUnlocked) throw new Error(nrcName(0x33));
        this.log(block.id, block.label, `[${ts()}]   TX: 2E ${didBytes.map(hexB).join(' ')} <data>  (WriteDataByIdentifier 0x${did})`);
        const resp = await udsRequest(0x2E, [...didBytes, 0x00]);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);
        return { message: t('diagEng.didWritten', { did }) };
      }

      // ── 0x2F InputOutputControlByIdentifier ──────────────────────────────────

      case 'uds_io_control': {
        const did = String(block.config['did'] ?? '3001').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0');
        const didBytes  = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];
        const ctrlOpt   = parseInt(String(block.config['io_control'] ?? '03'), 16);
        const ctrlVal   = parseInt(String(block.config['control_value'] ?? '00'), 16);
        const ctrlLabel: Record<number, string> = { 0: 'returnControlToECU', 1: 'resetToDefault', 2: 'freezeCurrentState', 3: 'shortTermAdjustment' };

        this.log(block.id, block.label, `[${ts()}]   TX: 2F ${didBytes.map(hexB).join(' ')} ${hexB(ctrlOpt)} ${hexB(ctrlVal)}  (InputOutputControl ${ctrlLabel[ctrlOpt] ?? ''})`);
        const resp = await udsRequest(0x2F, [...didBytes, ctrlOpt, ctrlVal]);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        return { message: `IO Control 0x${did}: ${ctrlLabel[ctrlOpt] ?? ctrlOpt}`, result: resp };
      }

      // ── 0x31 RoutineControl ───────────────────────────────────────────────────

      case 'uds_routine_ctrl': {
        const ctrlType = String(block.config['control_type'] ?? '01');
        const ridSel   = String(block.config['routine_id'] ?? 'FF00');
        const rid      = ridSel === 'custom'
          ? String(block.config['routine_id_custom'] ?? '0203').toUpperCase().replace(/[^0-9A-F]/g, '').padStart(4, '0')
          : ridSel.toUpperCase();
        const ridBytes  = [parseInt(rid.slice(0, 2), 16), parseInt(rid.slice(2, 4), 16)];
        const ctrlByte  = parseInt(ctrlType, 16);
        const ctrlLabel: Record<string, string> = { '01': 'startRoutine', '02': 'stopRoutine', '03': 'requestRoutineResults' };
        const ridNames: Record<string, string> = {
          'FF00': 'eraseMemory',
          'FF01': 'checkProgrammingDependencies',
          '0202': 'checkMemory',
          '0203': 'checkProgrammingPreconditions',
          'DF01': 'checkMemoryIntegrity',
          'E200': 'requestSoftwareUpdate',
        };

        this.log(block.id, block.label, `[${ts()}]   TX: 31 ${hexB(ctrlByte)} ${ridBytes.map(hexB).join(' ')}  (RoutineControl — 0x${rid} ${ridNames[rid] ?? ''} ${ctrlLabel[ctrlType] ?? ''})`);
        await udsRequest(0x31, [ctrlByte, ...ridBytes]);

        const resultBytes = ctrlType === '03' ? new Uint8Array([0x00, 0x01]) : new Uint8Array([0x00]);
        this.log(block.id, block.label, `[${ts()}]   RX: 71 ${hexB(ctrlByte)} ${ridBytes.map(hexB).join(' ')} ${hex(resultBytes)}`);

        return { message: `Rutin 0x${rid} (${ctrlLabel[ctrlType] ?? ctrlType}) → ${hex(resultBytes)}`, result: resultBytes };
      }

      // ── 0x34 RequestDownload ──────────────────────────────────────────────────

      case 'uds_req_download': {
        if (ctx.sessionType !== 'programming') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needProg')}`);
        if (!ctx.securityUnlocked)             throw new Error(nrcName(0x33) + ` — ${t('diagEng.needSecurity')}`);

        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00010000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const fmtHex  = String(block.config['data_format']    ?? '00').toUpperCase().replace(/[^0-9A-F]/g, '');
        const fmtByte   = parseInt(fmtHex, 16);
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0x01,0,0];
        const memFmt    = ((addrBytes.length & 0xF) << 4) | (sizeBytes.length & 0xF);

        this.log(block.id, block.label, `[${ts()}]   TX: 34 ${hexB(fmtByte)} ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')}  (RequestDownload)`);
        await udsRequest(0x34, [fmtByte, memFmt, ...addrBytes, ...sizeBytes]);

        const maxBlockLen = 0x0802;
        this.log(block.id, block.label, `[${ts()}]   RX: 74 20 ${hexB((maxBlockLen >> 8) & 0xFF)} ${hexB(maxBlockLen & 0xFF)}  maxBlockLen=0x${maxBlockLen.toString(16).toUpperCase()}`);

        ctx.downloadActive   = true;
        ctx.downloadAddress  = parseInt(addrHex, 16);
        ctx.downloadSize     = parseInt(sizeHex, 16);
        ctx.transferBlockSeq = 1;
        ctx.transferredBytes = 0;

        return { message: t('diagEng.downloadAccepted', { addr: addrHex, size: sizeHex, max: maxBlockLen.toString(16).toUpperCase() }), result: { address: ctx.downloadAddress, size: ctx.downloadSize, maxBlockLen } };
      }

      // ── 0x35 RequestUpload ────────────────────────────────────────────────────

      case 'uds_req_upload': {
        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00010000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const fmtHex  = String(block.config['data_format']    ?? '00');
        const fmtByte   = parseInt(fmtHex, 16);
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0x01,0,0];
        const memFmt    = ((addrBytes.length & 0xF) << 4) | (sizeBytes.length & 0xF);

        this.log(block.id, block.label, `[${ts()}]   TX: 35 ${hexB(fmtByte)} ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')}  (RequestUpload)`);
        await udsRequest(0x35, [fmtByte, memFmt, ...addrBytes, ...sizeBytes]);

        const maxBlockLen = 0x0802;
        this.log(block.id, block.label, `[${ts()}]   RX: 75 20 ${hexB((maxBlockLen >> 8) & 0xFF)} ${hexB(maxBlockLen & 0xFF)}`);

        ctx.downloadActive   = true;
        ctx.downloadSize     = parseInt(sizeHex, 16);
        ctx.transferBlockSeq = 1;
        ctx.transferredBytes = 0;

        return { message: t('diagEng.uploadAccepted', { addr: addrHex, size: sizeHex }), result: { address: parseInt(addrHex, 16), size: ctx.downloadSize } };
      }

      // ── 0x36 TransferData ─────────────────────────────────────────────────────

      case 'uds_transfer_data': {
        if (!ctx.downloadActive) throw new Error(nrcName(0x24) + ` — ${t('diagEng.needDownloadFirst')}`);

        const chunkSize  = parseInt(String(block.config['chunk_size'] ?? '0800').replace(/[^0-9a-fA-F]/g, ''), 16) || 0x0800;
        const seq        = ctx.transferBlockSeq;
        const remaining  = ctx.downloadSize - ctx.transferredBytes;
        const thisChunk  = Math.min(chunkSize, remaining);

        this.log(block.id, block.label, `[${ts()}]   TX: 36 ${hexB(seq)} <${thisChunk} bytes data>  (TransferData blockSeq=${seq})`);
        await randomDelay(40, 160);

        if (Math.random() < 0.01) throw new Error(nrcName(0x73) + ` ${t('diagEng.blockSeqExpected', { seq })}`);

        const resp = new Uint8Array([0x76, seq & 0xFF]);
        ctx.transferredBytes += thisChunk;
        ctx.transferBlockSeq  = (seq % 0xFF) + 1;

        const pct = Math.min(100, Math.round((ctx.transferredBytes / ctx.downloadSize) * 100));
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}  [${pct}%]  ${ctx.transferredBytes}/${ctx.downloadSize} bytes`);

        return { message: t('diagEng.blockMsg', { seq, done: ctx.transferredBytes, total: ctx.downloadSize, pct }), result: { seq, transferred: ctx.transferredBytes, total: ctx.downloadSize, percent: pct } };
      }

      // ── 0x37 RequestTransferExit ──────────────────────────────────────────────

      case 'uds_transfer_exit': {
        if (!ctx.downloadActive) throw new Error(nrcName(0x24) + ` — ${t('diagEng.noActiveTransfer')}`);

        this.log(block.id, block.label, `[${ts()}]   TX: 37  (RequestTransferExit)`);
        const resp = await udsRequest(0x37, []);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}  — ${t('diagEng.transferDoneLog')}`);

        const transferred = ctx.transferredBytes;
        ctx.downloadActive   = false;
        ctx.transferredBytes = 0;

        return { message: t('diagEng.transferDoneMsg', { n: transferred }) };
      }

      // ── Flash Image (DEMO: local simulated download, nothing transmitted) ─────

      case 'uds_flash_image':
        return runFlashBlock(block, { demo: true, tabId: null, log: (msg) => this.log(block.id, block.label, `[${ts()}]   ${msg}`), transport: demoFlowTransport, shouldStop: () => this._stopped });

      // ── Keep-alive / wait-ready (DEMO: simulated, nothing transmitted) ───────

      case 'uds_tester_present_keepalive': {
        const interval = Number(block.config['interval_ms'] ?? 2000);
        if (block.config['action'] === 'stop') {
          ctx.keepaliveActive = false;
          return { message: t('udsFlow.log.kaStopped') };
        }
        ctx.keepaliveActive = true;
        return { message: t('udsFlow.log.kaStarted', { ms: interval }) };
      }

      case 'uds_wait_ecu_ready': {
        const ms = Math.min(1500, Math.max(0, Number(block.config['initial_delay_ms'] ?? 500)) + 120);
        this.log(block.id, block.label, `[${ts()}]   ${t('udsFlow.wr.start', { probe: String(block.config['probe'] ?? '3E00'), initial: ms, total: Number(block.config['timeout_ms'] ?? 10000) })}`);
        await randomDelay(ms, ms + 60);
        return { message: t('udsFlow.wr.ready', { ms, n: 1 }), result: ms, outputs: { elapsed_out: ms } };
      }

      // ── 0x3D WriteMemoryByAddress ──────────────────────────────────────────────

      case 'uds_write_memory': {
        if (!ctx.securityUnlocked) throw new Error(nrcName(0x33) + ` — ${t('diagEng.needSecurity')}`);

        const addrHex = String(block.config['memory_address'] ?? '08000000').toUpperCase().replace(/[^0-9A-F]/g, '');
        const sizeHex = String(block.config['memory_size']    ?? '00000010').toUpperCase().replace(/[^0-9A-F]/g, '');
        const addrBytes = addrHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0x08,0,0,0];
        const sizeBytes = sizeHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [0,0,0,0x10];
        const memFmt    = ((addrBytes.length & 0xF) << 4) | (sizeBytes.length & 0xF);

        this.log(block.id, block.label, `[${ts()}]   TX: 3D ${hexB(memFmt)} ${addrBytes.map(hexB).join(' ')} ${sizeBytes.map(hexB).join(' ')} <data>  (WriteMemoryByAddress)`);
        const resp = await udsRequest(0x3D, [memFmt, ...addrBytes, ...sizeBytes]);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);

        return { message: `WriteMemory 0x${addrHex}  size=0x${sizeHex}` };
      }

      // ── 0x3E TesterPresent ────────────────────────────────────────────────────

      case 'uds_tester_present': {
        const suppress = !!block.config['suppress'];
        const sf       = suppress ? 0x80 : 0x00;
        this.log(block.id, block.label, `[${ts()}]   TX: 3E ${hexB(sf)}  (TesterPresent suppress=${suppress})`);
        if (!suppress) {
          await randomDelay(10, 30);
          this.log(block.id, block.label, `[${ts()}]   RX: 7E 00`);
        }
        return { message: `TesterPresent${suppress ? ' (suppress)' : ''}` };
      }

      // ── 0x85 ControlDTCSetting ────────────────────────────────────────────────

      case 'uds_dtc_setting': {
        // ISO 14229-1 Table 23: ControlDTCSetting NOT available in default session
        if (ctx.sessionType === 'default') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needExtProg')}`);

        const st = String(block.config['setting_type'] ?? '02');
        const sf = parseInt(st, 16);
        const label = st === '01' ? 'DTCSettingOn' : 'DTCSettingOff';
        this.log(block.id, block.label, `[${ts()}]   TX: 85 ${hexB(sf)}  (ControlDTCSetting — ${label})`);
        const resp = await udsRequest(0x85, [sf]);
        this.log(block.id, block.label, `[${ts()}]   RX: ${hex(resp)}`);
        ctx.dtcSettingOff = st === '02';
        return { message: `ControlDTCSetting: ${label}` };
      }

      // ── 0x87 LinkControl ─────────────────────────────────────────────────────

      case 'uds_link_control': {
        // ISO 14229-1 §9.11: Only available in Programming session
        if (ctx.sessionType !== 'programming') throw new Error(nrcName(0x7F) + ` — ${t('diagEng.needProg')}`);

        const lcType  = String(block.config['link_control_type'] ?? '01');
        const brId    = String(block.config['link_baudrate_id']  ?? '05');
        const lcByte  = parseInt(lcType, 16);
        const brByte  = parseInt(brId,   16);
        const lcLabel: Record<string, string> = {
          '01': 'verifyModeTransitionWithFixedParameter',
          '02': 'verifyModeTransitionWithSpecificParameter',
          '03': 'transitionMode',
        };
        const brLabel: Record<string, string> = {
          '01': 'PC9600Baud', '02': 'PC19200Baud', '03': 'PC38400Baud',
          '04': 'PC57600Baud', '05': 'PC115200Baud',
          '10': 'CAN125Kbps', '11': 'CAN250Kbps', '12': 'CAN500Kbps', '13': 'CAN1Mbps',
          '20': 'ProgrammingSetup',
        };

        // 2-step sequence: verify → transition
        this.log(block.id, block.label, `[${ts()}]   [1/2] TX: 87 ${hexB(lcByte)} ${hexB(brByte)}  (LinkControl — ${lcLabel[lcType] ?? lcType})`);
        const verifyResp = await udsRequest(0x87, [lcByte, brByte]);
        this.log(block.id, block.label, `[${ts()}]   [1/2] RX: ${hex(verifyResp)}  — Verify OK`);

        // transitionMode with suppressPosRspMsgIndicationBit=1 (0x83)
        const transByte = 0x83; // transitionMode | suppress
        this.log(block.id, block.label, `[${ts()}]   [2/2] TX: 87 ${hexB(transByte)}  (LinkControl — transitionMode, suppress=true)`);
        await randomDelay(20, 60);
        this.log(block.id, block.label, `[${ts()}]   [2/2] ${t('diagEng.noResponse', { baud: brLabel[brId] ?? brId })}`);

        return { message: `LinkControl: ${brLabel[brId] ?? brId}  (${lcLabel[lcType] ?? lcType} → transitionMode)` };
      }

      // ── DATA ─────────────────────────────────────────────────────────────────

      case 'data_const': {
        const val = block.config['value'];
        ctx.variables.set(`_const_${block.id}`, val);
        return { message: t('diagEng.constMsg', { val: String(val) }), result: val };
      }

      case 'data_compare': return { message: t('diagEng.cmpEqual'), result: true };

      case 'data_extract': {
        const offset = Number(block.config['offset'] ?? 0);
        const length = Number(block.config['length'] ?? 1);
        return { message: `Byte [${offset}:${offset + length}]`, result: `0x00` };
      }

      case 'data_byte_builder': {
        const template = String(block.config['template'] ?? '00 00 00 00');
        const bytes = template.replace(/[^0-9a-fA-F]/g, '').match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [];
        const result = new Uint8Array(bytes);
        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.byteSeq', { hex: hex(result), n: result.length })}`);
        return { message: t('diagEng.bytesBuilt', { n: result.length, hex: hex(result) }), result };
      }

      case 'data_bitfield_extract': {
        const byteOffset = Number(block.config['byte_offset'] ?? 0);
        const bitHigh    = Number(block.config['bit_high']    ?? 7);
        const bitLow     = Number(block.config['bit_low']     ?? 0);

        // mock: use a sample byte
        const mockByte = 0xAB;
        const bits = bitHigh - bitLow + 1;
        const mask  = (1 << bits) - 1;
        const value = (mockByte >> bitLow) & mask;

        this.log(block.id, block.label, `[${ts()}]   byte[${byteOffset}]=0x${hexB(mockByte)}  bit[${bitHigh}:${bitLow}] = 0x${hexB(value)} (${value})`);
        return { message: `bit[${bitHigh}:${bitLow}] = 0x${hexB(value)}`, result: value };
      }

      case 'data_checksum': {
        const algorithm = String(block.config['algorithm'] ?? 'crc32');

        // Mock 16-byte input
        const mockData = new Uint8Array([0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,0x10]);

        let checksum: number;
        switch (algorithm) {
          case 'crc16':   checksum = crc16ibm(mockData); break;
          case 'crc32':   checksum = crc32(mockData); break;
          case 'xor_sum': checksum = mockData.reduce((a, b) => a ^ b, 0); break;
          case 'add_sum': checksum = mockData.reduce((a, b) => (a + b) & 0xFF, 0); break;
          default:        checksum = crc32(mockData);
        }

        const hexResult = `0x${checksum.toString(16).toUpperCase().padStart(algorithm === 'crc16' ? 4 : 8, '0')}`;
        this.log(block.id, block.label, `[${ts()}]   ${algorithm.toUpperCase()}: ${hexResult}`);
        return { message: `${algorithm.toUpperCase()} = ${hexResult}`, result: checksum };
      }

      // ── IO ────────────────────────────────────────────────────────────────────

      case 'io_file_input': {
        await randomDelay(50, 100);
        const path = String(block.config['file_path'] ?? '');
        if (!path) throw new Error(t('diagEng.noFilePath'));
        const mockSize = 65536; // 64KB mock firmware
        const data = new Uint8Array(mockSize);
        for (let i = 0; i < mockSize; i++) data[i] = (0x20 + i) & 0xFF;
        this.log(block.id, block.label, `[${ts()}]   ${t('diagEng.fileLine', { path, n: mockSize })}`);
        return { message: t('diagEng.fileRead', { path, n: mockSize }), result: data };
      }

      case 'io_display': return { message: t('diagEng.valueShown') };

      case 'io_user_prompt': {
        const msg = String(block.config['message'] ?? t('diagBlk.enterAValue'));
        this.log(block.id, block.label, `[${ts()}]   Prompt: "${msg}" → "mock_value"`);
        return { message: t('diagEng.userPrompt'), result: 'mock_value' };
      }

      default:
        return { message: t('diagEng.unknownBlock', { type: block.type }) };
    }
  }

  private setStatus(block: FlowBlock, status: BlockStatus, message?: string): void {
    this._sink.setFrameStatus(this._frame.pathKey, block.id, status, message);
  }

  /** Fatal runtime-limit error: every frame halts and the run ends with outcome `error`. */
  private abort(err: Error): Error {
    if (this._abortError === null) this._abortError = err;
    return err;
  }

  /**
   * Call block (`call:<flowId>`): runs the pinned callee as a NESTED FRAME (own variable scope, executors and
   * statuses). Inputs come from the call block's ports, the reached outcome selects the exec output, the
   * outcome's outputs are recorded on the call block's data outputs. An unhandled callee error is thrown and
   * routed by `executeBlock` to the `error` port (unwired = error of the parent frame).
   */
  private async dispatchCall(
    block: FlowBlock,
  ): Promise<{ message: string; result?: unknown; nextPort?: string; outputs?: Record<string, unknown> }> {
    const ref = readCallRef(block);
    const cache = this._callees;
    if (!ref || !cache) throw new Error(t('flowNest.val.badRef', { block: block.label }));
    if (this._stack.length - 1 >= this._maxDepth) {
      throw this.abort(new Error(t('flowNest.err.depth', { n: this._maxDepth })));
    }
    const callee = await cache.ensure(ref);
    const parent = this._frame;
    // Inputs from the parent's ports (typed values pass through unchanged; missing ones take the default).
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const spec of callee.iface.inputs) {
      const v = await parent.eval.core.optional(block, spec.key, 0);
      // Wired value (or the spec default when nothing is wired) goes through the same checks as a root run input.
      const r = resolveRunInputs([spec], v !== undefined ? { [spec.key]: v } : {});
      errors.push(...r.errors);
      Object.assign(values, r.values);
    }
    if (errors.length > 0) throw new Error(`${callee.name}: ${errors.join('; ')}`);
    const childEcu = (values['ecu'] ?? null) as EcuRecordV1 | null;
    if (childEcu && this._rootEcu && childEcu.id !== this._rootEcu.id) {
      throw new Error(t('flowNest.err.otherEcu', { callee: callee.name, ecu: childEcu.name }));
    }
    const pathKey = parent.pathKey === '' ? block.id : `${parent.pathKey}/${block.id}`;
    this._sink.clearFrameStatuses(pathKey);
    const child = this.makeFrame(
      resolveFrameDiagram(callee.diagram, childEcu).diagram, callee.name, [...parent.path, callee.name], pathKey, childEcu, values,
    );
    const entry = findEntryBlock(child.diagram);
    if (!entry) throw new Error(`${callee.name}: ${t('diagEng.startNotFound')}`);
    this.log(block.id, block.label, `[${ts()}]   ${t('flowNest.log.enter', { name: callee.name, rev: ref.revision })}`);
    const { unhandled } = await this.runFrame(child, entry, true);
    if (unhandled !== null) throw (unhandled instanceof Error ? unhandled : new Error(String(unhandled)));
    const reached = child.reached;
    const name = reached ? reached.name : 'ok';
    const outputs = reached ? reached.outputs : {};
    this.log(block.id, block.label, `[${ts()}]   ${t('flowNest.log.leave', { name: callee.name, outcome: name })}`);
    return { message: t('flowNest.log.returned', { name: callee.name, outcome: name }), nextPort: name, outputs, result: outputs };
  }

  private findNextBlock(fromBlockId: string, fromPortId: string): FlowBlock | null {
    const diagram = this._frame.diagram;
    const conn = diagram.connections.find((c) => c.fromBlockId === fromBlockId && c.fromPortId === fromPortId);
    if (!conn) return null;
    return diagram.blocks.find((b) => b.id === conn.toBlockId) ?? null;
  }
}
