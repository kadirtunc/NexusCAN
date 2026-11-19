/**
 * ECU binding of a run (diag-workspace-v1 §5 / §8, single ECU per run in B2): protocol check, `{ecu.*}`
 * resolution per frame, and the session check (the run uses the diagnostics session tab only when it was
 * opened for the bound ECU and is connected). Pure; the stores are injected.
 */
import { t } from '../../i18n';
import type { EcuRecordV1 } from '../../types/diagWorkspace';
import { listEcuRefs, resolveEcuRefs } from '../diagnostics/workspace/ecuRefs';
import { getBlockDef } from './blockDefs';
import { FLOW_IN, blockPortSpec } from './flowPorts';
import type { FlowIssue } from './flowInterface';
import type { FlowDiagram } from './types';

/** One diagram taking part in a run (root or any callee). */
export interface RunFrameInfo {
  name: string;
  /** Names from the root to this frame (`Flash ECU › Unlock`). */
  path: string[];
  diagram: FlowDiagram;
}

/** Whether a diagram declares an `ecu` input (a `flow_in` of type `ecu`). */
export function declaresEcu(diagram: FlowDiagram): boolean {
  return diagram.blocks.some((b) => b.type === FLOW_IN && blockPortSpec(b).type === 'ecu');
}

/** Diagram copy whose block configs have every `{ecu.*}` resolved (blocks without refs are shared). */
export function resolveFrameDiagram(diagram: FlowDiagram, ecu: EcuRecordV1 | null): { diagram: FlowDiagram; errors: Array<{ blockId: string; label: string; message: string }> } {
  if (!ecu) return { diagram, errors: [] };
  const errors: Array<{ blockId: string; label: string; message: string }> = [];
  const blocks = diagram.blocks.map((b) => {
    if (listEcuRefs(b.config).length === 0) return b;
    const r = resolveEcuRefs(b.config, ecu);
    for (const e of r.errors) errors.push({ blockId: b.id, label: b.label, message: `${e.key}: ${e.message}` });
    return { ...b, config: r.config };
  });
  return { diagram: { ...diagram, blocks }, errors };
}

/**
 * Pre-run ECU checks over every frame: `{ecu.*}` needs a declared `ecu` input and a bound ECU, the union of the
 * frames' required protocols must contain the ECU's protocol, every reference must resolve.
 * `rootIssueIds`: blocks of the root frame (issues there carry the block id, nested ones carry '').
 */
export function checkEcuBinding(frames: readonly RunFrameInfo[], ecu: EcuRecordV1 | null): FlowIssue[] {
  const issues: FlowIssue[] = [];
  frames.forEach((f, idx) => {
    const where = f.path.join(' › ');
    const root = idx === 0;
    const uses = f.diagram.blocks.filter((b) => listEcuRefs(b.config).length > 0);
    if (uses.length > 0 && !declaresEcu(f.diagram)) {
      issues.push({ blockId: root ? uses[0].id : '', code: 'ecu_undeclared', message: t('flowNest.val.ecuUndeclared', { frame: where }) });
    }
    if (uses.length > 0 && !ecu) {
      issues.push({ blockId: root ? uses[0].id : '', code: 'ecu_unbound', message: t('flowNest.val.ecuUnbound', { frame: where }) });
    }
    if (ecu) {
      for (const e of resolveFrameDiagram(f.diagram, ecu).errors) {
        issues.push({ blockId: root ? e.blockId : '', code: 'ecu_ref', message: t('flowNest.val.ecuRef', { frame: where, block: e.label, detail: e.message }) });
      }
    }
    if (ecu) {
      for (const b of f.diagram.blocks) {
        const req = getBlockDef(b.type)?.requires;
        if (req && !req.includes(ecu.protocol)) {
          issues.push({ blockId: root ? b.id : '', code: 'protocol', message: t('flowNest.val.protocol', { frame: where, block: b.label, need: req.join('/'), have: ecu.protocol }) });
        }
      }
    }
  });
  return issues;
}

// ─── Session check ──────────────────────────────────────────────────────────────

export interface SessionProbe {
  tabId: string;
  ecuId: string | null;
  connected: boolean;
}

/** Message when the active diagnostics session cannot serve the bound ECU (`null` = ok). */
export function checkEcuSession(ecu: EcuRecordV1, probe: SessionProbe | null): string | null {
  if (probe === null || !probe.connected || probe.ecuId !== ecu.id) return t('flowNest.run.sessionMissing', { name: ecu.name });
  return null;
}
