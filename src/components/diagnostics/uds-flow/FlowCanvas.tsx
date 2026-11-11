import React, { useRef, useCallback, useEffect } from 'react';
import { Workflow } from 'lucide-react';
import type { FlowBlock, FlowConnection, PortDef, PortType } from './types';
import { BLOCK_WIDTH, BLOCK_HEADER_HEIGHT } from './types';
import { useFlowStore, flowStore } from './FlowStore';
import { getBlockDef } from './blockDefs';
import { BlockNode, categoryAccentColor, getPortPosition, portColor } from './BlockNode';
import { useI18n } from '../../../i18n';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wire colour = port colour token; opacity is applied via `strokeOpacity`. */
function connectionColor(type: PortType): string {
  return portColor(type);
}

const WIRE_OPACITY = 0.7;

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const cp = Math.abs(x2 - x1) * 0.5 + 30;
  return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
}

function getConnPortType(conn: FlowConnection, blocks: FlowBlock[]): PortType {
  const b = blocks.find((b) => b.id === conn.fromBlockId);
  if (!b) return 'exec';
  const def = getBlockDef(b.type);
  return def?.ports.find((p) => p.id === conn.fromPortId)?.type ?? 'exec';
}

// ─── Minimap ──────────────────────────────────────────────────────────────────

const Minimap: React.FC<{ blocks: FlowBlock[]; zoom: number; panX: number; panY: number }> = ({
  blocks, zoom, panX, panY,
}) => {
  const W = 150; const H = 90;
  if (!blocks.length) return null;
  const xs = blocks.map((b) => b.x);
  const ys = blocks.map((b) => b.y);
  const minX = Math.min(...xs) - 30;
  const minY = Math.min(...ys) - 30;
  const maxX = Math.max(...xs) + BLOCK_WIDTH + 30;
  const maxY = Math.max(...ys) + BLOCK_HEADER_HEIGHT + 30;
  const sc   = Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1));
  return (
    <div style={{ position: 'absolute', bottom: 52, right: 12, background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 2, overflow: 'hidden' }}>
      <svg width={W} height={H}>
        {blocks.map((b) => {
          const def = getBlockDef(b.type);
          const fill = categoryAccentColor(def?.category ?? 'flow');
          return <rect key={b.id} x={(b.x - minX) * sc} y={(b.y - minY) * sc} width={Math.max(4, BLOCK_WIDTH * sc)} height={Math.max(3, BLOCK_HEADER_HEIGHT * sc)} rx={1} style={{ fill }} fillOpacity={0.8} />;
        })}
        <rect x={(-panX / zoom - minX) * sc} y={(-panY / zoom - minY) * sc} width={(800 / zoom) * sc} height={(500 / zoom) * sc} fill="none" style={{ stroke: 'var(--canvas-axis)' }} strokeWidth={1} />
      </svg>
    </div>
  );
};

// ─── FlowCanvas ───────────────────────────────────────────────────────────────

type DragState =
  | { type: 'block'; id: string; startX: number; startY: number; startMX: number; startMY: number }
  | { type: 'pan';   startPanX: number; startPanY: number; startMX: number; startMY: number }
  | null;

export const FlowCanvas: React.FC = () => {
  const { t } = useI18n();
  const state = useFlowStore();
  const { diagram, zoom, panX, panY, showGrid, showMinimap,
          selectedBlockIds, selectedConnectionId, connecting } = state;

  const svgRef      = useRef<SVGSVGElement>(null);
  const dragRef     = useRef<DragState>(null);

  // ── Space key ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space') e.preventDefault(); };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  // ── Global mouse move/up for block drag (works outside SVG) ───────────────
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.type === 'block') {
        flowStore.moveBlock(d.id, d.startX + (e.clientX - d.startMX) / zoom, d.startY + (e.clientY - d.startMY) / zoom);
      } else if (d.type === 'pan') {
        flowStore.setPan(d.startPanX + e.clientX - d.startMX, d.startPanY + e.clientY - d.startMY);
      }
      if (connecting) {
        const r = svgRef.current?.getBoundingClientRect();
        if (r) flowStore.updateConnecting(e.clientX - r.left, e.clientY - r.top);
      }
    };
    const mu = () => { dragRef.current = null; };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup',   mu);
    return () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
  }, [zoom, connecting]);

  // ── Canvas coord helper ────────────────────────────────────────────────────
  const toCanvas = useCallback((cx: number, cy: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (cx - r.left - panX) / zoom, y: (cy - r.top - panY) / zoom };
  }, [panX, panY, zoom]);

  // ── Port screen position ───────────────────────────────────────────────────
  const portScreen = useCallback((block: FlowBlock, portId: string, def: NonNullable<ReturnType<typeof getBlockDef>>) => {
    const cp = getPortPosition(block, portId, def);
    return { x: cp.x * zoom + panX, y: cp.y * zoom + panY };
  }, [zoom, panX, panY]);

  // ── SVG background mousedown → pan ────────────────────────────────────────
  const onSvgMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    if (connecting) { flowStore.cancelConnecting(); return; }
    flowStore.deselectAll();
    dragRef.current = { type: 'pan', startPanX: panX, startPanY: panY, startMX: e.clientX, startMY: e.clientY };
  }, [connecting, panX, panY]);

  // ── Block drag start (from HTML layer) ────────────────────────────────────
  const onBlockDragStart = useCallback((block: FlowBlock) => (e: React.MouseEvent) => {
    e.stopPropagation();
    dragRef.current = { type: 'block', id: block.id, startX: block.x, startY: block.y, startMX: e.clientX, startMY: e.clientY };
  }, []);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const factor  = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(2.0, Math.max(0.25, zoom * factor));
    flowStore.setZoom(newZoom);
    flowStore.setPan(mx - (mx - panX) * (newZoom / zoom), my - (my - panY) * (newZoom / zoom));
  }, [zoom, panX, panY]);

  // ── Port events ────────────────────────────────────────────────────────────
  const onPortMouseDown = useCallback((block: FlowBlock, def: NonNullable<ReturnType<typeof getBlockDef>>, port: PortDef) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (port.direction !== 'output') return;
    const ps = portScreen(block, port.id, def);
    flowStore.startConnecting({ fromBlockId: block.id, fromPortId: port.id, fromPortType: port.type, fromDirection: 'output', x: ps.x, y: ps.y, mouseX: ps.x, mouseY: ps.y });
  }, [portScreen]);

  const onPortMouseUp = useCallback((block: FlowBlock, port: PortDef) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!connecting || port.direction !== 'input') return;
    flowStore.addConnection({ fromBlockId: connecting.fromBlockId, fromPortId: connecting.fromPortId, toBlockId: block.id, toPortId: port.id });
    flowStore.cancelConnecting();
  }, [connecting]);

  // ── Block select ───────────────────────────────────────────────────────────
  const onBlockSelect = useCallback((blockId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    flowStore.selectBlock(blockId, e.ctrlKey || e.metaKey);
  }, []);

  // ── Drop from palette ──────────────────────────────────────────────────────
  const onDrop = useCallback((e: React.DragEvent<SVGSVGElement>) => {
    e.preventDefault();
    const t = e.dataTransfer.getData('application/nexus-block-type');
    if (!t) return;
    const p = toCanvas(e.clientX, e.clientY);
    flowStore.addBlock(t, p.x - BLOCK_WIDTH / 2, p.y - BLOCK_HEADER_HEIGHT / 2);
  }, [toCanvas]);

  // ── Grid values ───────────────────────────────────────────────────────────
  const gs  = 24 * zoom;
  const gox = ((panX % gs) + gs) % gs;
  const goy = ((panY % gs) + gs) % gs;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--bg-canvas)' }}>

      {/* ── Layer 1: SVG — grid, connections, port handles, ghost line ── */}
      <svg
        ref={svgRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        onMouseDown={onSvgMouseDown}
        onWheel={onWheel}
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      >
        {/* Grid dots */}
        {showGrid && (
          <>
            <defs>
              <pattern id="nexus-flow-grid" x={gox} y={goy} width={gs} height={gs} patternUnits="userSpaceOnUse">
                <circle cx={0} cy={0} r={1} style={{ fill: 'var(--canvas-grid)' }} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#nexus-flow-grid)" />
          </>
        )}

        {/* Connections */}
        {diagram.connections.map((conn) => {
          const fb = diagram.blocks.find((b) => b.id === conn.fromBlockId);
          const tb = diagram.blocks.find((b) => b.id === conn.toBlockId);
          if (!fb || !tb) return null;
          const fd = getBlockDef(fb.type);
          const td = getBlockDef(tb.type);
          if (!fd || !td) return null;
          const fp    = portScreen(fb, conn.fromPortId, fd);
          const tp    = portScreen(tb, conn.toPortId,   td);
          const ptype = getConnPortType(conn, diagram.blocks);
          const isSel = selectedConnectionId === conn.id;
          return (
            <path
              key={conn.id}
              d={bezierPath(fp.x, fp.y, tp.x, tp.y)}
              fill="none"
              style={{ cursor: 'pointer', stroke: connectionColor(ptype) }}
              strokeOpacity={isSel ? 1 : WIRE_OPACITY}
              strokeWidth={isSel ? 2.5 : 1.5}
              onClick={(e) => { e.stopPropagation(); flowStore.selectConnection(conn.id); }}
            />
          );
        })}

        {/* Ghost line */}
        {connecting && (
          <path
            d={bezierPath(connecting.x, connecting.y, connecting.mouseX, connecting.mouseY)}
            fill="none"
            strokeOpacity={WIRE_OPACITY}
            strokeWidth={1.5}
            strokeDasharray="6 3"
            style={{ pointerEvents: 'none', stroke: connectionColor(connecting.fromPortType) }}
          />
        )}

        {/* Port handles */}
        {diagram.blocks.map((block) => {
          const def = getBlockDef(block.type);
          if (!def) return null;
          return (
            <g key={`ph-${block.id}`}>
              {def.ports.map((port) => {
                const ps  = portScreen(block, port.id, def);
                const r   = Math.max(5, 6 * zoom);
                const col = portColor(port.type);
                const compat = connecting
                  && connecting.fromPortType === port.type
                  && connecting.fromDirection !== port.direction
                  && connecting.fromBlockId !== block.id;
                return (
                  <circle
                    key={port.id}
                    cx={ps.x}
                    cy={ps.y}
                    r={compat ? r + 2 : r}
                    fillOpacity={0.95}
                    strokeWidth={compat ? 2 : 1}
                    style={{
                      cursor: 'crosshair',
                      fill: col,
                      stroke: compat ? 'var(--text-ink)' : 'var(--bg-canvas)',
                    }}
                    onMouseDown={(e) => onPortMouseDown(block, def, port)(e)}
                    onMouseUp={(e)   => onPortMouseUp(block, port)(e)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* ── Layer 2: HTML block nodes ── */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {diagram.blocks.map((block) => {
          const def = getBlockDef(block.type);
          if (!def) return null;
          return (
            <BlockNode
              key={block.id}
              block={block}
              def={def}
              selected={selectedBlockIds.includes(block.id)}
              zoom={zoom}
              panX={panX}
              panY={panY}
              onSelect={onBlockSelect(block.id)}
              onDragStart={onBlockDragStart(block)}
            />
          );
        })}
      </div>

      {/* ── Zoom controls ── */}
      <div style={{ position: 'absolute', bottom: 12, right: showMinimap ? 170 : 12, display: 'flex', gap: 4, zIndex: 10 }}>
        {(['+'  , `${Math.round(zoom * 100)}%`, '−'] as const).map((label, i) => (
          <button
            key={i}
            onClick={() => {
              if (label === '+') flowStore.setZoom(Math.min(2, zoom * 1.2));
              else if (label === '−') flowStore.setZoom(Math.max(0.25, zoom / 1.2));
              else flowStore.resetView();
            }}
            className="font-mono tabular-nums"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', color: 'var(--text-ink)', borderRadius: 2, height: 24, padding: '0 8px', fontSize: 12, cursor: 'pointer', minWidth: label.includes('%') ? 52 : 28 }}
          >{label}</button>
        ))}
      </div>

      {/* ── Minimap ── */}
      {showMinimap && <Minimap blocks={diagram.blocks} zoom={zoom} panX={panX} panY={panY} />}

      {/* ── Empty state ── */}
      {diagram.blocks.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--text-muted)' }}>
          <Workflow className="mb-3 h-6 w-6" style={{ color: 'var(--text-subtle)' }} aria-hidden="true" />
          <div className="font-mono" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('diagHmi.flow.canvasEmpty')}</div>
          <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-subtle)' }}>{t('diagHmi.flow.canvasEmptyHint')}</div>
        </div>
      )}
    </div>
  );
};
