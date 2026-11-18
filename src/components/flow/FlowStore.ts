import { useSyncExternalStore } from 'react';
import type {
  FlowBlock,
  FlowConnection,
  FlowDiagram,
  ConnectingState,
  BlockStatus,
} from './types';
import type { FlowTemplate } from './types';
import { getBlockDef, getBlockDefFor, portsCompatible } from './blockDefs';
import { migrateAll } from './flowMigrate';
import { FLOW_INPUT } from './flowPorts';
import { callType, type CallInfo } from './callIndex';
import { callPorts } from './callPorts';
import type { FlowRefV1 } from '../../types/diagWorkspace';
import { canUseVariableName, defaultInitial, nextVariableName, renameVariableRefs } from './flowVars';
import type { FlowVariableDeclV1 } from '../../types/flowLibrary';
import { blockLabel, resolveDefaultConfig } from './blockText';
import { GOTO_TYPE, listTerminals } from './flowTerminals';
import { t } from '../../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunLogEntry {
  id: string;
  ts: number;
  blockId: string;
  blockLabel: string;
  level: 'info' | 'success' | 'error' | 'warn';
  message: string;
  /** Call-frame path from the root flow (`['Flash ECU', 'Unlock']`); `[]` for entries of the root flow. */
  path: string[];
}

export interface FrameBlockStatus {
  status: BlockStatus;
  message?: string;
}

export interface FlowState {
  diagram: FlowDiagram;
  selectedBlockIds: string[];
  selectedConnectionId: string | null;
  connecting: ConnectingState | null;
  isRunning: boolean;
  isPaused: boolean;
  runLog: RunLogEntry[];
  /** Frame path stamped on new log entries (set by the engine while a frame executes). */
  framePath: string[];
  /** Live block statuses per call frame (`''` = root flow, else `callBlockId/callBlockId...`). */
  frameStatus: Record<string, Record<string, FrameBlockStatus>>;
  /** Frame the canvas currently shows (`''` = the root flow; a callee entered through its call block otherwise). */
  viewPathKey: string;
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  showMinimap: boolean;
  activeTemplateId: string | null;
  templateDialogOpen: boolean;
  /** Historical revision view: every edit is refused. */
  readOnly: boolean;
  undoStack: FlowDiagram[];
  /** Notes of the last legacy-variable migration (shown in the inspector until the next load). */
  migrationNotes: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Legacy single-diagram storage (before the Flow Registry); read only by the one-time library migration. */
export const LEGACY_FLOW_STORAGE_KEY = 'nexuscan:flow_diagrams:v1';

function emptyDiagram(): FlowDiagram {
  return { id: uuid(), name: 'Yeni Diyagram', blocks: [], connections: [] };
}

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState: FlowState = {
  diagram: emptyDiagram(),
  selectedBlockIds: [],
  selectedConnectionId: null,
  connecting: null,
  isRunning: false,
  isPaused: false,
  runLog: [],
  framePath: [],
  frameStatus: {},
  viewPathKey: '',
  zoom: 1,
  panX: 0,
  panY: 0,
  showGrid: true,
  showMinimap: false,
  activeTemplateId: null,
  templateDialogOpen: false,
  readOnly: false,
  undoStack: [],
  migrationNotes: [],
};

// ─── Store ────────────────────────────────────────────────────────────────────

type Listener = () => void;

class FlowStoreImpl {
  private state: FlowState = initialState;
  private listeners: Set<Listener> = new Set();

  getSnapshot = (): FlowState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  private setState(partial: Partial<FlowState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  private pushUndo(): void {
    const stack = [...this.state.undoStack, { ...this.state.diagram }].slice(-20);
    this.setState({ undoStack: stack });
  }

  // ── Block actions ──────────────────────────────────────────────────────────

  addBlock(type: string, x: number, y: number): string {
    if (this.state.readOnly) return '';
    const def = getBlockDef(type);
    if (!def) return '';
    // Exactly one `flow_input` per flow.
    if (type === FLOW_INPUT && this.state.diagram.blocks.some((b) => b.type === FLOW_INPUT)) return '';
    this.pushUndo();
    const block: FlowBlock = {
      id: uuid(),
      type,
      label: blockLabel(def),
      x,
      y,
      config: resolveDefaultConfig(def),
      status: 'idle',
      collapsed: false,
    };
    // A fresh variable block defaults to the first declared variable.
    if (type === 'var_get' || type === 'var_set') {
      const first = this.state.diagram.variables?.[0];
      if (first) block.config = { ...block.config, name: first.name };
    }
    // A fresh goto defaults to the first terminal of the diagram (when there is one).
    if (type === GOTO_TYPE) {
      const first = listTerminals(this.state.diagram)[0];
      if (first) block.config = { ...block.config, target_terminal_id: first.id };
    }
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: [...this.state.diagram.blocks, block],
    };
    this.setState({ diagram });
    return block.id;
  }

  /** Inserts a call block pinned to `ref` (ports derive from the callee interface once it is in the call index). */
  addCallBlock(ref: FlowRefV1, name: string, x: number, y: number): string {
    if (this.state.readOnly) return '';
    this.pushUndo();
    const block: FlowBlock = {
      id: uuid(), type: callType(ref.flowId), label: name, x, y, config: { ref: { ...ref } }, status: 'idle', collapsed: false,
    };
    this.setState({ diagram: { ...this.state.diagram, blocks: [...this.state.diagram.blocks, block] } });
    return block.id;
  }

  /**
   * "Update to latest": re-pins a call block, re-derives its ports from `info` and drops the connections the new
   * interface cannot keep, all as ONE undoable change. Returns the dropped connections (human readable).
   */
  repinCall(blockId: string, info: CallInfo): string[] {
    if (this.state.readOnly) return [];
    const cur = this.state.diagram.blocks.find((b) => b.id === blockId);
    if (!cur) return [];
    this.pushUndo();
    const ports = callPorts(info.iface).ports;
    const dropped: string[] = [];
    const blocks = this.state.diagram.blocks.map((b) => (b.id === blockId ? { ...b, config: { ...b.config, ref: { ...info.ref } } } : b));
    const keep = this.state.diagram.connections.filter((c) => {
      const mine = c.toBlockId === blockId ? c.toPortId : c.fromBlockId === blockId ? c.fromPortId : null;
      if (mine === null) return true;
      const port = ports.find((p) => p.id === mine);
      const otherId = c.toBlockId === blockId ? c.fromBlockId : c.toBlockId;
      const otherPortId = c.toBlockId === blockId ? c.fromPortId : c.toPortId;
      const other = blocks.find((b) => b.id === otherId);
      const otherPort = other ? getBlockDefFor(other)?.ports.find((p) => p.id === otherPortId) : undefined;
      const incompatible = !port || !otherPort || !portsCompatible(c.toBlockId === blockId ? otherPort.type : port.type, c.toBlockId === blockId ? port.type : otherPort.type);
      if (incompatible) dropped.push(c.toBlockId === blockId ? `${other?.label ?? otherId}.${otherPortId} → ${mine}` : `${mine} → ${other?.label ?? otherId}.${otherPortId}`);
      return !incompatible;
    });
    this.setState({ diagram: { ...this.state.diagram, blocks, connections: keep } });
    return dropped;
  }

  /** Replaces the whole diagram as one undoable step (extraction into a custom block). */
  applyDiagram(diagram: FlowDiagram): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    this.setState({ diagram, selectedBlockIds: [], selectedConnectionId: null });
  }

  removeBlock(blockId: string): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.filter((b) => b.id !== blockId),
      connections: this.state.diagram.connections.filter(
        (c) => c.fromBlockId !== blockId && c.toBlockId !== blockId,
      ),
    };
    this.setState({
      diagram,
      selectedBlockIds: this.state.selectedBlockIds.filter((id) => id !== blockId),
    });
  }

  moveBlock(blockId: string, x: number, y: number): void {
    if (this.state.readOnly) return;
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, x, y } : b,
      ),
    };
    this.setState({ diagram });
  }

  updateBlockConfig(blockId: string, config: Record<string, unknown>): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    let diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, config: { ...b.config, ...config } } : b,
      ),
    };
    // Config-derived ports (`text_format.inputs`, `flow_input.inputs`, `flow_output.outputs`): drop connections
    // into / out of ports that no longer exist or whose type is no longer compatible (undoable as one change).
    const updated = diagram.blocks.find((b) => b.id === blockId);
    if (updated && (updated.type === 'text_format' || updated.type === FLOW_INPUT || updated.type === 'flow_output')
      && ('inputs' in config || 'outputs' in config)) {
      const ports = getBlockDefFor(updated)?.ports ?? [];
      const portOf = (b: FlowBlock, id: string) => getBlockDefFor(b)?.ports.find((p) => p.id === id);
      diagram = {
        ...diagram,
        connections: diagram.connections.filter((c) => {
          if (c.toBlockId !== blockId && c.fromBlockId !== blockId) return true;
          const from = diagram.blocks.find((b) => b.id === c.fromBlockId);
          const to = diagram.blocks.find((b) => b.id === c.toBlockId);
          if (!from || !to) return false;
          const fp = c.fromBlockId === blockId ? ports.find((p) => p.id === c.fromPortId) : portOf(from, c.fromPortId);
          const tp = c.toBlockId === blockId ? ports.find((p) => p.id === c.toPortId) : portOf(to, c.toPortId);
          return fp !== undefined && tp !== undefined && portsCompatible(fp.type, tp.type);
        }),
      };
    }
    this.setState({ diagram });
  }

  updateBlockLabel(blockId: string, label: string): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, label } : b,
      ),
    };
    this.setState({ diagram });
  }

  toggleBlockCollapsed(blockId: string): void {
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, collapsed: !b.collapsed } : b,
      ),
    };
    this.setState({ diagram });
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /** Replaces the block selection (marquee / click logic lives in `canvasSelect.ts`). */
  setSelection(ids: readonly string[]): void {
    this.setState({ selectedBlockIds: [...ids], selectedConnectionId: null });
  }

  /** Undo checkpoint taken once at the start of a drag (the moves themselves do not push undo). */
  checkpoint(): void {
    if (this.state.readOnly) return;
    this.pushUndo();
  }

  /** Moves several blocks at once (group drag). */
  moveBlocks(positions: Readonly<Record<string, { x: number; y: number }>>): void {
    if (this.state.readOnly) return;
    this.setState({
      diagram: {
        ...this.state.diagram,
        blocks: this.state.diagram.blocks.map((b) => (positions[b.id] ? { ...b, x: positions[b.id].x, y: positions[b.id].y } : b)),
      },
    });
  }

  /** Deletes several blocks and their connections as ONE undo step. */
  removeBlocks(ids: readonly string[]): void {
    if (this.state.readOnly || ids.length === 0) return;
    const del = new Set(ids);
    this.pushUndo();
    this.setState({
      diagram: {
        ...this.state.diagram,
        blocks: this.state.diagram.blocks.filter((b) => !del.has(b.id)),
        connections: this.state.diagram.connections.filter((c) => !del.has(c.fromBlockId) && !del.has(c.toBlockId)),
      },
      selectedBlockIds: this.state.selectedBlockIds.filter((id) => !del.has(id)),
    });
  }

  selectBlock(blockId: string, multi = false): void {
    const selected = multi
      ? this.state.selectedBlockIds.includes(blockId)
        ? this.state.selectedBlockIds.filter((id) => id !== blockId)
        : [...this.state.selectedBlockIds, blockId]
      : [blockId];
    this.setState({ selectedBlockIds: selected, selectedConnectionId: null });
  }

  deselectAll(): void {
    this.setState({ selectedBlockIds: [], selectedConnectionId: null });
  }

  selectConnection(id: string): void {
    this.setState({ selectedConnectionId: id, selectedBlockIds: [] });
  }

  selectAllBlocks(): void {
    this.setState({
      selectedBlockIds: this.state.diagram.blocks.map((b) => b.id),
      selectedConnectionId: null,
    });
  }

  // ── Connection actions ─────────────────────────────────────────────────────

  addConnection(conn: Omit<FlowConnection, 'id'>): boolean {
    if (this.state.readOnly) return false;
    const { diagram } = this.state;
    const fromBlock = diagram.blocks.find((b) => b.id === conn.fromBlockId);
    const toBlock = diagram.blocks.find((b) => b.id === conn.toBlockId);
    if (!fromBlock || !toBlock) return false;
    const fromDef = getBlockDefFor(fromBlock);
    const toDef = getBlockDefFor(toBlock);
    if (!fromDef || !toDef) return false;

    const fromPort = fromDef.ports.find((p) => p.id === conn.fromPortId);
    const toPort   = toDef.ports.find((p) => p.id === conn.toPortId);
    if (!fromPort || !toPort) return false;

    // Type compatibility (`data` is the untyped value port: it connects to bytes / bool / data)
    if (!portsCompatible(fromPort.type, toPort.type)) return false;
    // Direction
    if (fromPort.direction !== 'output' || toPort.direction !== 'input') return false;
    // No self-loops
    if (conn.fromBlockId === conn.toBlockId) return false;
    // No duplicates
    const exists = diagram.connections.some(
      (c) => c.fromBlockId === conn.fromBlockId &&
             c.fromPortId  === conn.fromPortId  &&
             c.toBlockId   === conn.toBlockId   &&
             c.toPortId    === conn.toPortId,
    );
    if (exists) return false;

    this.pushUndo();
    const newConn: FlowConnection = { ...conn, id: uuid() };
    this.setState({
      diagram: {
        ...diagram,
        connections: [...diagram.connections, newConn],
      },
    });
    return true;
  }

  removeConnection(id: string): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    this.setState({
      diagram: {
        ...this.state.diagram,
        connections: this.state.diagram.connections.filter((c) => c.id !== id),
      },
      selectedConnectionId: null,
    });
  }

  // ── Connecting drag state ──────────────────────────────────────────────────

  startConnecting(state: ConnectingState): void {
    this.setState({ connecting: state });
  }

  updateConnecting(mouseX: number, mouseY: number): void {
    if (!this.state.connecting) return;
    this.setState({ connecting: { ...this.state.connecting, mouseX, mouseY } });
  }

  cancelConnecting(): void {
    this.setState({ connecting: null });
  }

  // ── View ───────────────────────────────────────────────────────────────────

  setZoom(z: number): void {
    this.setState({ zoom: Math.min(2.0, Math.max(0.3, z)) });
  }

  setPan(x: number, y: number): void {
    this.setState({ panX: x, panY: y });
  }

  resetView(): void {
    this.setState({ zoom: 1, panX: 0, panY: 0 });
  }

  setShowGrid(v: boolean): void {
    this.setState({ showGrid: v });
  }

  setShowMinimap(v: boolean): void {
    this.setState({ showMinimap: v });
  }

  // ── Template / diagram management ─────────────────────────────────────────

  loadTemplate(template: FlowTemplate): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    const raw: FlowDiagram = {
      id: uuid(),
      name: t(template.nameKey),
      blocks: template.diagram.blocks.map((b) => ({ ...b, id: b.id })),
      connections: template.diagram.connections.map((c) => ({ ...c, id: c.id })),
      ...(template.diagram.variables ? { variables: template.diagram.variables.map((v) => ({ ...v })) } : {}),
    };
    const { diagram, notes } = migrateAll(raw);
    this.setState({
      migrationNotes: notes,
      diagram,
      selectedBlockIds: [],
      selectedConnectionId: null,
      activeTemplateId: template.id,
      runLog: [],
      undoStack: [],
    });
  }

  clearDiagram(): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    this.setState({
      diagram: {
        ...emptyDiagram(),
        id: this.state.diagram.id,
        name: this.state.diagram.name,
        blocks: this.state.diagram.blocks.filter((b) => b.type === FLOW_INPUT),
      },
      selectedBlockIds: [],
      selectedConnectionId: null,
      runLog: [],
    });
  }

  setDiagramName(name: string): void {
    if (this.state.readOnly) return;
    this.setState({ diagram: { ...this.state.diagram, name } });
  }

  // ── Variables (diag-workspace-v1 §8.1) ─────────────────────────────────────

  addVariable(): string {
    if (this.state.readOnly) return '';
    this.pushUndo();
    const decls = this.state.diagram.variables ?? [];
    const decl: FlowVariableDeclV1 = { name: nextVariableName(decls), type: 'number', initial: '0' };
    this.setState({ diagram: { ...this.state.diagram, variables: [...decls, decl] } });
    return decl.name;
  }

  /** Edits a declaration. A rename (valid + unique name only) updates every reference; returns false when rejected. */
  updateVariable(name: string, patch: Partial<FlowVariableDeclV1>): boolean {
    if (this.state.readOnly) return false;
    const decls = this.state.diagram.variables ?? [];
    const cur = decls.find((d) => d.name === name);
    if (!cur) return false;
    const next: FlowVariableDeclV1 = { ...cur, ...patch };
    if (patch.name !== undefined && patch.name !== name && !canUseVariableName(decls, name, patch.name)) return false;
    if (patch.type !== undefined && patch.type !== cur.type && patch.initial === undefined) next.initial = defaultInitial(patch.type);
    this.pushUndo();
    let diagram: FlowDiagram = {
      ...this.state.diagram,
      variables: decls.map((d) => (d.name === name ? next : d)),
    };
    if (next.name !== name) diagram = renameVariableRefs(diagram, name, next.name);
    this.setState({ diagram });
    return true;
  }

  /** Removes a declaration. References stay and become validation errors (never silently rewritten). */
  removeVariable(name: string): void {
    if (this.state.readOnly) return;
    this.pushUndo();
    this.setState({
      diagram: { ...this.state.diagram, variables: (this.state.diagram.variables ?? []).filter((d) => d.name !== name) },
    });
  }

  // ── Run state ──────────────────────────────────────────────────────────────

  setRunning(v: boolean): void {
    this.setState({ isRunning: v });
  }

  setPaused(v: boolean): void {
    this.setState({ isPaused: v });
  }

  setBlockStatus(blockId: string, status: BlockStatus, message?: string): void {
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId
          ? { ...b, status, statusMessage: message }
          : b,
      ),
    };
    this.setState({ diagram });
  }

  setBlockResult(blockId: string, result: unknown): void {
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, lastResult: result } : b,
      ),
    };
    this.setState({ diagram });
  }

  /** Engine: frame path stamped on the log entries that follow. */
  setFramePath(path: string[]): void {
    this.state = { ...this.state, framePath: path };
  }

  private patchBlock(blockId: string, patch: Partial<FlowBlock>): FlowDiagram {
    return {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
    };
  }

  /** Engine: status of a block of ANY frame; shown on the canvas only while that frame is the viewed one. */
  setFrameStatus(pathKey: string, blockId: string, status: BlockStatus, message?: string): void {
    const frameStatus = { ...this.state.frameStatus, [pathKey]: { ...this.state.frameStatus[pathKey], [blockId]: { status, message } } };
    this.setState(pathKey === this.state.viewPathKey
      ? { frameStatus, diagram: this.patchBlock(blockId, { status, statusMessage: message }) }
      : { frameStatus });
  }

  setFrameResult(pathKey: string, blockId: string, result: unknown): void {
    if (pathKey === this.state.viewPathKey) this.setState({ diagram: this.patchBlock(blockId, { lastResult: result }) });
  }

  /** A call frame starts again (loop): its previous statuses are dropped. */
  clearFrameStatuses(pathKey: string): void {
    if (this.state.frameStatus[pathKey] === undefined) return;
    const frameStatus = { ...this.state.frameStatus };
    delete frameStatus[pathKey];
    if (pathKey === this.state.viewPathKey) {
      this.setState({
        frameStatus,
        diagram: { ...this.state.diagram, blocks: this.state.diagram.blocks.map((b) => ({ ...b, status: 'idle' as BlockStatus, statusMessage: undefined })) },
      });
    } else {
      this.setState({ frameStatus });
    }
  }

  /** Forces a re-render of subscribers (callee interfaces were loaded: call-block ports changed). */
  bump(): void {
    this.setState({});
  }

  resetBlockStatuses(): void {
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) => ({
        ...b,
        status: 'idle' as BlockStatus,
        statusMessage: undefined,
        lastResult: undefined,
      })),
    };
    this.setState({ diagram, frameStatus: {} });
  }

  addRunLog(entry: Omit<RunLogEntry, 'id' | 'ts' | 'path'> & { path?: string[] }): void {
    const full: RunLogEntry = { ...entry, path: entry.path ?? this.state.framePath, id: uuid(), ts: Date.now() };
    this.setState({ runLog: [...this.state.runLog, full] });
  }

  clearRunLog(): void {
    this.setState({ runLog: [] });
  }

  // ── Document (Flow Registry) ───────────────────────────────────────────────

  /**
   * Replaces the canvas content with a document (tab switch / open / reload). The undo stack and the view
   * belong to the document, so switching tabs restores them.
   */
  loadDocument(
    diagram: FlowDiagram,
    opts: { undoStack?: FlowDiagram[]; zoom?: number; panX?: number; panY?: number; readOnly?: boolean; notes?: string[]; viewPath?: string; keepLog?: boolean } = {},
  ): void {
    const viewPathKey = opts.viewPath ?? '';
    // Live statuses are overlaid while a run is active or for a callee view; the root canvas of an idle store keeps its own.
    const overlay = this.state.isRunning || viewPathKey !== '' ? this.state.frameStatus[viewPathKey] : undefined;
    this.setState({
      viewPathKey,
      diagram: overlay ? { ...diagram, blocks: diagram.blocks.map((b) => (overlay[b.id] ? { ...b, status: overlay[b.id].status, statusMessage: overlay[b.id].message } : b)) } : diagram,
      undoStack: opts.undoStack ?? [],
      zoom: opts.zoom ?? 1,
      panX: opts.panX ?? 0,
      panY: opts.panY ?? 0,
      readOnly: opts.readOnly === true,
      migrationNotes: opts.notes ?? [],
      selectedBlockIds: [],
      selectedConnectionId: null,
      connecting: null,
      ...(opts.keepLog === true ? {} : { runLog: [] }),
    });
  }

  /** Content swap that keeps the undo stack and view (reload of the same document). */
  replaceDiagram(diagram: FlowDiagram): void {
    this.setState({ diagram, selectedBlockIds: [], selectedConnectionId: null, connecting: null });
  }

  // ── Template dialog ────────────────────────────────────────────────────────

  setTemplateDialogOpen(v: boolean): void {
    this.setState({ templateDialogOpen: v });
  }

  // ── Undo ───────────────────────────────────────────────────────────────────

  undo(): void {
    if (this.state.undoStack.length === 0) return;
    const stack = [...this.state.undoStack];
    const prev = stack.pop();
    if (!prev) return;
    this.setState({ diagram: prev, undoStack: stack });
  }
}

export const flowStore = new FlowStoreImpl();

// React hook
export function useFlowStore(): FlowState {
  return useSyncExternalStore(flowStore.subscribe, flowStore.getSnapshot);
}
