/**
 * Ports of a call block (flow-interface-v2 §2) derived from the callee's interface: exec `in` + one input per
 * `flow_in` (port id = key, ordered by `order`); one exec output per outcome name, an always present exec
 * `error` (unhandled callee error) and one data output per `flow_out` (port id = key; flow-level, not per
 * outcome). A callee outcome named `error` shares the `error` port.
 */
import { t } from '../../i18n';
import type { FlowInterfaceV1 } from '../../types/flowLibrary';
import { portTypeOf } from './flowPorts';
import type { PortDef } from './types';

export const CALL_IN = 'in';
export const CALL_ERROR = 'error';

export interface CallPorts {
  ports: PortDef[];
  /** Localized interface problems that make the callee uncallable (shown as a validation error). */
  conflicts: string[];
}

export function callPorts(iface: FlowInterfaceV1): CallPorts {
  const conflicts: string[] = [];
  const ports: PortDef[] = [{ id: CALL_IN, label: CALL_IN, type: 'exec', direction: 'input' }];
  const used = new Set<string>([CALL_IN]);
  for (const s of iface.inputs) {
    if (used.has(s.key)) {
      conflicts.push(t('flowNest.val.portClash', { id: s.key }));
      continue;
    }
    used.add(s.key);
    ports.push({ id: s.key, label: s.key, type: portTypeOf(s.type), direction: 'input', optional: !s.required });
  }
  const outs = new Set<string>();
  for (const o of iface.outcomes) {
    const id = o.name.trim();
    if (id === CALL_IN) conflicts.push(t('flowNest.val.portClash', { id }));
    else if (!outs.has(id)) {
      outs.add(id);
      ports.push({ id, label: id, type: 'exec', direction: 'output' });
    }
  }
  if (!outs.has(CALL_ERROR)) ports.push({ id: CALL_ERROR, label: CALL_ERROR, type: 'exec', direction: 'output' });
  const execOut = new Set<string>([...outs, CALL_ERROR]);
  const outKeys = new Set<string>();
  for (const s of iface.outputs) {
    if (execOut.has(s.key) || outKeys.has(s.key)) {
      conflicts.push(t('flowNest.val.portClash', { id: s.key }));
      continue;
    }
    outKeys.add(s.key);
    ports.push({ id: s.key, label: s.key, type: portTypeOf(s.type), direction: 'output' });
  }
  return { ports, conflicts };
}
