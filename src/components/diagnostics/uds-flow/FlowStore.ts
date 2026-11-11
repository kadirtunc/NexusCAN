import { useSyncExternalStore } from 'react';
import type {
  FlowBlock,
  FlowConnection,
  FlowDiagram,
  ConnectingState,
  BlockStatus,
} from './types';
import type { FlowTemplate } from './types';
import { getBlockDef } from './blockDefs';
import { blockLabel, resolveDefaultConfig } from './blockText';
import { t } from '../../../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunLogEntry {
  id: string;
  ts: number;
  blockId: string;
  blockLabel: string;
  level: 'info' | 'success' | 'error' | 'warn';
  message: string;
}

export interface FlowState {
  diagram: FlowDiagram;
  selectedBlockIds: string[];
  selectedConnectionId: string | null;
  connecting: ConnectingState | null;
  isRunning: boolean;
  isPaused: boolean;
  runLog: RunLogEntry[];
  zoom: number;
  panX: number;
  panY: number;
  showGrid: boolean;
  showMinimap: boolean;
  activeTemplateId: string | null;
  templateDialogOpen: boolean;
  savedDiagrams: FlowDiagram[];
  undoStack: FlowDiagram[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const LS_KEY = 'nexuscan:flow_diagrams:v1';

function loadSaved(): FlowDiagram[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as FlowDiagram[];
  } catch {
    // ignore
  }
  return [];
}

function persistSaved(diagrams: FlowDiagram[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(diagrams));
  } catch {
    // ignore
  }
}

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
  zoom: 1,
  panX: 0,
  panY: 0,
  showGrid: true,
  showMinimap: false,
  activeTemplateId: null,
  templateDialogOpen: false,
  savedDiagrams: loadSaved(),
  undoStack: [],
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
    const def = getBlockDef(type);
    if (!def) return '';
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
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: [...this.state.diagram.blocks, block],
    };
    this.setState({ diagram });
    return block.id;
  }

  removeBlock(blockId: string): void {
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
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, x, y } : b,
      ),
    };
    this.setState({ diagram });
  }

  updateBlockConfig(blockId: string, config: Record<string, unknown>): void {
    this.pushUndo();
    const diagram: FlowDiagram = {
      ...this.state.diagram,
      blocks: this.state.diagram.blocks.map((b) =>
        b.id === blockId ? { ...b, config: { ...b.config, ...config } } : b,
      ),
    };
    this.setState({ diagram });
  }

  updateBlockLabel(blockId: string, label: string): void {
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
    const { diagram } = this.state;
    const fromDef = getBlockDef(
      diagram.blocks.find((b) => b.id === conn.fromBlockId)?.type ?? '',
    );
    const toDef = getBlockDef(
      diagram.blocks.find((b) => b.id === conn.toBlockId)?.type ?? '',
    );
    if (!fromDef || !toDef) return false;

    const fromPort = fromDef.ports.find((p) => p.id === conn.fromPortId);
    const toPort   = toDef.ports.find((p) => p.id === conn.toPortId);
    if (!fromPort || !toPort) return false;

    // Type compatibility
    if (fromPort.type !== toPort.type) return false;
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
    this.pushUndo();
    const diagram: FlowDiagram = {
      id: uuid(),
      name: t(template.nameKey),
      blocks: template.diagram.blocks.map((b) => ({ ...b, id: b.id })),
      connections: template.diagram.connections.map((c) => ({ ...c, id: c.id })),
    };
    this.setState({
      diagram,
      selectedBlockIds: [],
      selectedConnectionId: null,
      activeTemplateId: template.id,
      runLog: [],
      undoStack: [],
    });
  }

  clearDiagram(): void {
    this.pushUndo();
    this.setState({
      diagram: { ...emptyDiagram(), name: this.state.diagram.name },
      selectedBlockIds: [],
      selectedConnectionId: null,
      runLog: [],
    });
  }

  setDiagramName(name: string): void {
    this.setState({ diagram: { ...this.state.diagram, name } });
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
    this.setState({ diagram });
  }

  addRunLog(entry: Omit<RunLogEntry, 'id' | 'ts'>): void {
    const full: RunLogEntry = { ...entry, id: uuid(), ts: Date.now() };
    this.setState({ runLog: [...this.state.runLog, full] });
  }

  clearRunLog(): void {
    this.setState({ runLog: [] });
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  saveDiagram(name: string): void {
    const diagram: FlowDiagram = { ...this.state.diagram, name };
    const existing = this.state.savedDiagrams.findIndex((d) => d.id === diagram.id);
    const saved =
      existing >= 0
        ? this.state.savedDiagrams.map((d, i) => (i === existing ? diagram : d))
        : [...this.state.savedDiagrams, diagram];
    persistSaved(saved);
    this.setState({ savedDiagrams: saved, diagram });
  }

  loadDiagram(id: string): void {
    const found = this.state.savedDiagrams.find((d) => d.id === id);
    if (!found) return;
    this.pushUndo();
    this.setState({
      diagram: found,
      selectedBlockIds: [],
      selectedConnectionId: null,
      runLog: [],
    });
  }

  deleteSavedDiagram(id: string): void {
    const saved = this.state.savedDiagrams.filter((d) => d.id !== id);
    persistSaved(saved);
    this.setState({ savedDiagrams: saved });
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
