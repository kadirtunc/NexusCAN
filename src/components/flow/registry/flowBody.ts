/**
 * Library file serialization of the Flow Editor (`NxFlowFileV1`): converters between the editor's
 * `FlowDiagram` (which carries runtime state) and the persisted `NxFlowBodyV1`, canonical JSON, the
 * content hash and the validating file parser. Pure apart from `crypto.subtle` (sha-256).
 *
 * Runtime-only fields (`status`, `statusMessage`, `lastResult`, file bytes) are NEVER serialized: every block
 * is written field by field. The only UI preference kept is `collapsed`, stored as `config.uiCollapsed` when true.
 */
import type {
  FlowLibKind,
  FlowOrigin,
  FlowVariableDeclV1,
  NxFlowBlockV1,
  NxFlowBodyV1,
  NxFlowConnectionV1,
  NxFlowFileV1,
} from '../../../types/flowLibrary';
import type { FlowBlock, FlowDiagram } from '../types';

export const FLOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Config key that stores the block's collapsed UI flag. */
export const COLLAPSED_KEY = 'uiCollapsed';

/** Non-graph metadata of a library document (everything in the body except name / blocks / connections / variables). */
export interface FlowMeta {
  id: string;
  revision: number;
  description: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  origin: FlowOrigin;
  aiReviewed: boolean;
  tags: string[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function blockToBody(b: FlowBlock): NxFlowBlockV1 {
  const config = clone(b.config);
  if (b.collapsed) config[COLLAPSED_KEY] = true;
  const out: NxFlowBlockV1 = { id: b.id, type: b.type, label: b.label, x: b.x, y: b.y, config };
  if (b.ai) out.ai = { warningLevel: b.ai.warningLevel, reason: b.ai.reason };
  return out;
}

/** Persisted body of a diagram. `name` comes from the diagram, everything else from `meta`. */
export function toFlowBody(diagram: FlowDiagram, meta: FlowMeta): NxFlowBodyV1 {
  const variables: FlowVariableDeclV1[] = (diagram.variables ?? []).map((v) => ({ name: v.name, type: v.type, initial: v.initial }));
  const connections: NxFlowConnectionV1[] = diagram.connections.map((c) => ({
    id: c.id,
    fromBlockId: c.fromBlockId,
    fromPortId: c.fromPortId,
    toBlockId: c.toBlockId,
    toPortId: c.toPortId,
  }));
  return {
    id: meta.id,
    revision: meta.revision,
    name: diagram.name,
    description: meta.description,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    author: meta.author,
    origin: meta.origin,
    aiReviewed: meta.aiReviewed,
    tags: [...meta.tags],
    variables,
    blocks: diagram.blocks.map(blockToBody),
    connections,
  };
}

/** Metadata of a body (the part that is not editor graph state). */
export function bodyMeta(body: NxFlowBodyV1): FlowMeta {
  return {
    id: body.id,
    revision: body.revision,
    description: body.description,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    author: body.author,
    origin: body.origin,
    aiReviewed: body.aiReviewed,
    tags: [...body.tags],
  };
}

const COLS = 6;

/** Editor diagram of a body; blocks without coordinates are laid out on a grid. */
export function fromFlowBody(body: NxFlowBodyV1): FlowDiagram {
  const blocks: FlowBlock[] = body.blocks.map((b, i) => {
    const config = clone(b.config);
    const collapsed = config[COLLAPSED_KEY] === true;
    delete config[COLLAPSED_KEY];
    const block: FlowBlock = {
      id: b.id,
      type: b.type,
      label: b.label,
      x: typeof b.x === 'number' ? b.x : 80 + (i % COLS) * 240,
      y: typeof b.y === 'number' ? b.y : 80 + Math.floor(i / COLS) * 160,
      config,
      status: 'idle',
      collapsed,
    };
    if (b.ai) block.ai = { warningLevel: b.ai.warningLevel, reason: b.ai.reason };
    return block;
  });
  return {
    id: body.id,
    name: body.name,
    blocks,
    connections: body.connections.map((c) => ({ ...c })),
    variables: (body.variables ?? []).map((v) => ({ ...v })),
  };
}

// ─── Canonical JSON / hash ─────────────────────────────────────────────────────────────────────────────

/** JSON with recursively sorted object keys; `undefined` members are dropped (like `JSON.stringify`). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const o = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(o[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonical content of a body: everything except `revision` and `updatedAt` (hash input / dirty detection). */
export function contentCanon(body: NxFlowBodyV1): string {
  const rest: Partial<NxFlowBodyV1> = { ...body };
  delete rest.revision;
  delete rest.updatedAt;
  return canonicalJson(rest);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `contentHash` of a body (independent of key order, `revision` and `updatedAt`). */
export async function computeContentHash(body: NxFlowBodyV1): Promise<string> {
  return sha256Hex(contentCanon(body));
}

export async function buildFlowFile(kind: FlowLibKind, body: NxFlowBodyV1): Promise<NxFlowFileV1> {
  return { schemaVersion: 1, kind, flow: body, contentHash: await computeContentHash(body) };
}

// ─── Parsing ───────────────────────────────────────────────────────────────────────────────────────────

export type ParsedFlowFile = { ok: true; file: NxFlowFileV1 } | { ok: false; message: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ORIGINS: readonly FlowOrigin[] = ['user', 'template', 'ai', 'import'];

/** Parses and structurally validates a `.nxflow.json` / `cmd_flowlib_load` text. Missing optional fields are defaulted. */
export function parseFlowFile(text: string): ParsedFlowFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'not JSON' };
  }
  if (!isObj(raw)) return { ok: false, message: 'not an object' };
  if (raw['schemaVersion'] !== 1) return { ok: false, message: `unsupported schemaVersion ${String(raw['schemaVersion'])}` };
  const kind = raw['kind'];
  if (kind !== 'nexuscan.flow' && kind !== 'nexuscan.block') return { ok: false, message: `unsupported kind ${String(kind)}` };
  const f = raw['flow'];
  if (!isObj(f)) return { ok: false, message: 'flow missing' };
  const id = f['id'];
  if (typeof id !== 'string' || !FLOW_ID_RE.test(id)) return { ok: false, message: 'invalid flow id' };
  if (typeof f['name'] !== 'string') return { ok: false, message: 'name missing' };
  if (!Array.isArray(f['blocks']) || !Array.isArray(f['connections'])) return { ok: false, message: 'blocks / connections missing' };

  const blocks: NxFlowBlockV1[] = [];
  for (const b of f['blocks']) {
    if (!isObj(b) || typeof b['id'] !== 'string' || typeof b['type'] !== 'string') return { ok: false, message: 'invalid block' };
    const block: NxFlowBlockV1 = {
      id: b['id'],
      type: b['type'],
      label: typeof b['label'] === 'string' ? b['label'] : b['type'],
      config: isObj(b['config']) ? clone(b['config']) : {},
    };
    if (typeof b['x'] === 'number') block.x = b['x'];
    if (typeof b['y'] === 'number') block.y = b['y'];
    if (isObj(b['ai']) && typeof b['ai']['reason'] === 'string' && typeof b['ai']['warningLevel'] === 'string') {
      block.ai = clone(b['ai']) as unknown as NxFlowBlockV1['ai'];
    }
    blocks.push(block);
  }
  const connections: NxFlowConnectionV1[] = [];
  for (const c of f['connections']) {
    if (!isObj(c) || typeof c['id'] !== 'string' || typeof c['fromBlockId'] !== 'string' || typeof c['fromPortId'] !== 'string'
      || typeof c['toBlockId'] !== 'string' || typeof c['toPortId'] !== 'string') return { ok: false, message: 'invalid connection' };
    connections.push({ id: c['id'], fromBlockId: c['fromBlockId'], fromPortId: c['fromPortId'], toBlockId: c['toBlockId'], toPortId: c['toPortId'] });
  }
  const variables: FlowVariableDeclV1[] = [];
  if (Array.isArray(f['variables'])) {
    for (const v of f['variables']) {
      if (!isObj(v) || typeof v['name'] !== 'string') return { ok: false, message: 'invalid variable' };
      const type = v['type'];
      variables.push({
        name: v['name'],
        type: type === 'text' || type === 'bool' || type === 'bytes' ? type : 'number',
        initial: typeof v['initial'] === 'string' ? v['initial'] : '',
      });
    }
  }
  const now = new Date().toISOString();
  const origin = ORIGINS.includes(f['origin'] as FlowOrigin) ? (f['origin'] as FlowOrigin) : 'user';
  const body: NxFlowBodyV1 = {
    id,
    revision: typeof f['revision'] === 'number' && f['revision'] >= 1 ? Math.trunc(f['revision']) : 1,
    name: f['name'],
    description: typeof f['description'] === 'string' ? f['description'] : '',
    createdAt: typeof f['createdAt'] === 'string' ? f['createdAt'] : now,
    updatedAt: typeof f['updatedAt'] === 'string' ? f['updatedAt'] : now,
    author: typeof f['author'] === 'string' ? f['author'] : null,
    origin,
    aiReviewed: typeof f['aiReviewed'] === 'boolean' ? f['aiReviewed'] : origin !== 'ai',
    tags: Array.isArray(f['tags']) ? f['tags'].filter((x): x is string => typeof x === 'string') : [],
    variables,
    blocks,
    connections,
  };
  return {
    ok: true,
    file: { schemaVersion: 1, kind, flow: body, contentHash: typeof raw['contentHash'] === 'string' ? raw['contentHash'] : '' },
  };
}
