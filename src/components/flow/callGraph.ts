/**
 * Call graph of a run (flow-platform-v1 §6, diag-workspace-v1 §8): loads every callee once (immutable pinned
 * revisions, cached), validates the reference graph (cycles with the full path, unresolved refs, connections to
 * ports the pinned callee does not have, callee interface conflicts) and validates the callee frames' content.
 */
import { t } from '../../i18n';
import type { FlowRefV1 } from '../../types/diagWorkspace';
import type { FlowLibKind, NxFlowBodyV1 } from '../../types/flowLibrary';
import { callIndex, isCallType, readCallRef, refKey, type CallInfo } from './callIndex';
import { callPorts } from './callPorts';
import { validateCore } from './coreValidate';
import type { RunFrameInfo } from './ecuBinding';
import { deriveFlowInterface, validateInterface, type FlowIssue } from './flowInterface';
import { migrateAll } from './flowMigrate';
import { validateTerminals, type TerminalIssue } from './flowTerminals';
import type { FlowDiagram } from './types';
import { fromFlowBody } from './registry/flowBody';

export type BodyLoader = (id: string, revision: number | null) => Promise<{ kind: FlowLibKind; body: NxFlowBodyV1 }>;

export interface ResolvedCallee extends CallInfo {
  /** Editor diagram of the pinned revision (legacy `start` / variables migrated in memory). */
  diagram: FlowDiagram;
}

/** Per-run callee cache: a pinned revision is loaded once. */
export class CalleeCache {
  private readonly map = new Map<string, ResolvedCallee>();
  loads = 0;

  constructor(private readonly loader: BodyLoader) {}

  peek(ref: FlowRefV1): ResolvedCallee | undefined {
    return this.map.get(refKey(ref));
  }

  async ensure(ref: FlowRefV1): Promise<ResolvedCallee> {
    const hit = this.map.get(refKey(ref));
    if (hit) return hit;
    this.loads += 1;
    const { kind, body } = await this.loader(ref.flowId, ref.revision);
    const diagram = migrateAll(fromFlowBody(body)).diagram;
    const resolved: ResolvedCallee = { ref, name: body.name, kind, iface: deriveFlowInterface(diagram), diagram };
    this.map.set(refKey(ref), resolved);
    callIndex.set({ ref, name: resolved.name, kind, iface: resolved.iface });
    return resolved;
  }
}

/** Localized message of a terminal / goto issue. */
export function terminalIssueMessage(diagram: FlowDiagram, issue: TerminalIssue): string {
  const block = diagram.blocks.find((b) => b.id === issue.blockId)?.label ?? issue.blockId;
  switch (issue.kind) {
    case 'goto_no_target':  return t('udsFlow.term.errNoTarget', { block });
    case 'goto_bad_target': return t('udsFlow.term.errBadTarget', { block });
    case 'name_empty':      return t('udsFlow.term.errNameEmpty', { block });
    case 'name_duplicate':  return t('udsFlow.term.errNameDup', { block, name: issue.name });
    case 'goto_loop':       return t('udsFlow.term.errLoop', { block, name: issue.name });
  }
}

export interface PreflightResult {
  issues: FlowIssue[];
  /** Root frame first, then every distinct callee frame reached (by pinned ref). */
  frames: RunFrameInfo[];
}

/**
 * Walks the reference graph from `root`. Recursion is rejected by flow id (a flow can never contain itself,
 * whatever revision it pins). Issues of the root frame carry the block id; nested ones carry '' and name the path.
 */
export async function preflightCalls(root: FlowDiagram, rootId: string | null, rootName: string, cache: CalleeCache): Promise<PreflightResult> {
  const issues: FlowIssue[] = [];
  const frames: RunFrameInfo[] = [{ name: rootName, path: [rootName], diagram: root }];
  const validated = new Set<string>();

  const walk = async (diagram: FlowDiagram, path: string[], ids: string[], isRoot: boolean): Promise<void> => {
    for (const b of diagram.blocks) {
      if (!isCallType(b.type)) continue;
      const add = (code: string, message: string): void => {
        issues.push({ blockId: isRoot ? b.id : '', code, message: isRoot ? message : `${path.join(' › ')}: ${message}` });
      };
      const ref = readCallRef(b);
      if (!ref || ref.flowId !== b.type.slice(5)) {
        add('call_ref', t('flowNest.val.badRef', { block: b.label }));
        continue;
      }
      let callee: ResolvedCallee;
      try {
        callee = await cache.ensure(ref);
      } catch (e) {
        add('call_unresolved', t('flowNest.val.unresolved', { block: b.label, id: ref.flowId, rev: ref.revision, reason: e instanceof Error ? e.message : String(e) }));
        continue;
      }
      if (ids.includes(ref.flowId)) {
        add('call_cycle', t('flowNest.val.cycle', { path: [...path, callee.name].join(' › ') }));
        continue;
      }
      const { ports, conflicts } = callPorts(callee.iface);
      for (const c of conflicts) add('call_iface', t('flowNest.val.iface', { block: b.label, callee: callee.name, detail: c }));
      const portIds = new Set(ports.map((p) => p.id));
      for (const c of diagram.connections) {
        if (c.toBlockId === b.id && !portIds.has(c.toPortId)) add('call_port', t('flowNest.val.port', { block: b.label, callee: callee.name, rev: ref.revision, port: c.toPortId }));
        if (c.fromBlockId === b.id && !portIds.has(c.fromPortId)) add('call_port', t('flowNest.val.port', { block: b.label, callee: callee.name, rev: ref.revision, port: c.fromPortId }));
      }
      const key = refKey(ref);
      const calleePath = [...path, callee.name];
      if (!validated.has(key)) {
        validated.add(key);
        frames.push({ name: callee.name, path: calleePath, diagram: callee.diagram });
        const where = calleePath.join(' › ');
        for (const i of validateCore(callee.diagram)) issues.push({ blockId: '', code: i.code, message: `${where}: ${i.message}` });
        for (const i of validateInterface(callee.diagram)) issues.push({ blockId: '', code: i.code, message: `${where}: ${i.message}` });
        for (const i of validateTerminals(callee.diagram)) {
          issues.push({ blockId: '', code: `terminal_${i.kind}`, message: `${where}: ${terminalIssueMessage(callee.diagram, i)}` });
        }
        if (!callee.diagram.blocks.some((x) => x.type === 'flow_input' || x.type === 'start')) {
          issues.push({ blockId: '', code: 'no_entry', message: `${where}: ${t('diagEng.startNotFound')}` });
        }
      }
      await walk(callee.diagram, calleePath, [...ids, ref.flowId], false);
    }
  };

  await walk(root, [rootName], rootId === null ? [] : [rootId], true);
  return { issues, frames };
}

/** Would pinning `calleeFlowId` into the flow `callerId` create a cycle (the callee already contains the caller)? */
export async function wouldCreateCycle(callerId: string, callee: FlowRefV1, cache: CalleeCache): Promise<boolean> {
  if (callee.flowId === callerId) return true;
  const seen = new Set<string>();
  const visit = async (ref: FlowRefV1): Promise<boolean> => {
    const k = refKey(ref);
    if (seen.has(k)) return false;
    seen.add(k);
    let c: ResolvedCallee;
    try {
      c = await cache.ensure(ref);
    } catch {
      return false;
    }
    for (const b of c.diagram.blocks) {
      const r = isCallType(b.type) ? readCallRef(b) : null;
      if (!r) continue;
      if (r.flowId === callerId) return true;
      if (await visit(r)) return true;
    }
    return false;
  };
  return visit(callee);
}
