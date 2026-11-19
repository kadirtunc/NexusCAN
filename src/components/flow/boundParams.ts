/**
 * Bound block parameters at run time (flow-interface-v2 §3). A block with `config.boundParams = ['base_address']`
 * has a required `p:base_address` input; before the block executes the value on that port is read, converted
 * and validated against the field, and it OVERRIDES `config[key]` for this execution only (the stored config
 * is never touched). An invalid / missing value is a block error BEFORE anything is transmitted.
 *
 * The `file` pseudo-field of `uds_flash_image` carries a `FlowFileValue`; it is handed to the flash runner as
 * the transient config key `file` together with the runtime image key (frame path + block id).
 */
import { t } from '../../i18n';
import type { FlowFileValue } from '../../types/flowLibrary';
import { bindableFields, boundPortId, readBoundParams, type BindableField } from './blockDefs';
import { localizedText } from './blockText';
import { hexList, isFlowFileValue, asBytes, numeric, valueText } from './flowValues';
import type { FlowBlock } from './types';

/** Transient config keys of the effective block handed to the flash runner (never stored). */
export const FLASH_FILE_KEY = 'file';
export const FLASH_IMAGE_KEY = '$imageKey';

/** Display label of a bindable field. */
export function bindableLabel(f: BindableField): string {
  if (f.field) return localizedText(f.field);
  return f.label ?? (f.labelKey ? t(f.labelKey) : f.key);
}

/** Converts + validates a port value for a field; throws a localized Error naming the block and parameter. */
export function coerceBound(block: FlowBlock, f: BindableField, v: unknown): unknown {
  const name = `${block.label} · ${boundPortId(f.key)}`;
  const bad = (reason: string): Error => new Error(t('flowIface.bound.invalid', { name, reason }));
  switch (f.kind) {
    case 'number': {
      const n = numeric(typeof v === 'string' ? v.trim() : v);
      if (!Number.isFinite(n)) throw bad(t('flowIface.bound.notNumber', { value: valueText(v) }));
      return n;
    }
    case 'hex': {
      const b = asBytes(v);
      if (b) {
        if (b.length === 0) throw bad(t('flowIface.bound.emptyHex'));
        return hexList(b).replace(/ /g, '');
      }
      if (typeof v !== 'string') throw bad(t('flowIface.bound.notHex', { value: valueText(v) }));
      const s = v.replace(/^\s*0x/i, '').replace(/[\s,]/g, '');
      if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) throw bad(t('flowIface.bound.notHex', { value: v }));
      return s.toUpperCase();
    }
    case 'select': {
      const s = typeof v === 'string' ? v : valueText(v);
      if (!(f.options ?? []).includes(s)) throw bad(t('flowIface.bound.notOption', { value: s }));
      return s;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = typeof v === 'string' ? v.trim().toLowerCase() : typeof v === 'number' ? String(v) : '';
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      throw bad(t('flowIface.bound.notBool', { value: valueText(v) }));
    }
    case 'file': {
      if (isFlowFileValue(v)) return v;
      const b = asBytes(v);
      if (b === null || b.length === 0) throw bad(t('flowIface.bound.notFile'));
      return { name: '', bytes: b } satisfies FlowFileValue;
    }
    default:
      return typeof v === 'string' ? v : valueText(v);
  }
}

/**
 * Effective block of one execution: bound values override the stored config. `read` returns the value on a
 * connected port (`undefined` = not connected / no value). Blocks without bound params are returned as-is.
 */
export async function applyBoundParams(
  block: FlowBlock,
  read: (portId: string) => Promise<unknown>,
  imageKey: string,
): Promise<FlowBlock> {
  const keys = readBoundParams(block.config);
  if (keys.length === 0) return block;
  const fields = bindableFields(block.type);
  const config: Record<string, unknown> = { ...block.config };
  for (const key of keys) {
    const f = fields.find((x) => x.key === key);
    if (!f) throw new Error(t('flowIface.val.boundUnknown', { block: block.label, key }));
    const v = await read(boundPortId(key));
    if (v === undefined) throw new Error(t('flowIface.bound.missing', { name: `${block.label} · ${boundPortId(key)}` }));
    const value = coerceBound(block, f, v);
    if (f.kind === 'file') {
      config[FLASH_FILE_KEY] = value;
      config[FLASH_IMAGE_KEY] = imageKey;
      const fv = value as FlowFileValue;
      // The file name drives the format auto-detect (`file_name` is also what the node summary shows).
      if (fv.name !== '') config['file_name'] = fv.name;
    } else {
      config[key] = value;
    }
  }
  return { ...block, config };
}

/**
 * Pre-run check of bound values whose source is known before anything runs: a `flow_in` (value = the resolved
 * run input) or a `data_const`. The same conversion / validation as at execution is applied; any problem refuses
 * the whole run before the first TX. Values from exec-produced or variable-dependent sources are checked when
 * the block executes (they cannot be known earlier).
 */
export async function preflightBoundValues(
  diagram: { blocks: readonly FlowBlock[]; connections: ReadonlyArray<{ toBlockId: string; toPortId: string; fromBlockId: string }> },
  read: (block: FlowBlock, portId: string) => Promise<unknown>,
): Promise<Array<{ blockId: string; message: string }>> {
  const issues: Array<{ blockId: string; message: string }> = [];
  for (const block of diagram.blocks) {
    const keys = readBoundParams(block.config);
    if (keys.length === 0) continue;
    const fields = bindableFields(block.type);
    for (const key of keys) {
      const f = fields.find((x) => x.key === key);
      const conn = diagram.connections.find((c) => c.toBlockId === block.id && c.toPortId === boundPortId(key));
      const src = conn ? diagram.blocks.find((b) => b.id === conn.fromBlockId) : undefined;
      if (!f || !src || (src.type !== 'flow_in' && src.type !== 'data_const')) continue;
      let v: unknown;
      try {
        v = await read(block, boundPortId(key));
      } catch {
        continue; // an unusable constant is reported when the block runs
      }
      if (v === undefined) continue;
      try {
        coerceBound(block, f, v);
      } catch (e) {
        issues.push({ blockId: block.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return issues;
}
