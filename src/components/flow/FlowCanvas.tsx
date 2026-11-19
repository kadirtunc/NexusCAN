import React, { useRef, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { applyMarquee, blockSize, clickSelect, MARQUEE_THRESHOLD, marqueeHits, rectFromPoints, screenToCanvas } from './canvasSelect';
import { Workflow } from 'lucide-react';
import type { FlowBlock, FlowConnection, PortDef, PortType } from './types';
import { BLOCK_WIDTH, BLOCK_HEADER_HEIGHT } from './types';
import { useFlowStore, flowStore } from './FlowStore';
import { getBlockDef, getBlockDefFor, portsCompatible } from './blockDefs';
import { isCallType } from './callIndex';
import { flowRegistry } from './registry/flowRegistryStore';
import { BlockNode, PortPill, TerminalPill, PILL_WIDTH, PILL_HEIGHT, categoryAccentColor, getPortPosition, portColor } from './BlockNode';
import { FLOW_IN, FLOW_OUT } from './flowPorts';
import { isCompactBlock, gotoTargetId, resolveGotoTarget, terminalColor, terminalName, terminalReferences, TERMINAL_COLOR_CSS } from './flowTerminals';
import { useI18n } from '../../i18n';

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
  const def = getBlockDefFor(b);
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

/** Group drag of the selected blocks (the moves update the store; one undo checkpoint at the first move). */
type DragState = {
  type: 'block';
  starts: Array<{ id: string; x: number; y: number }>;
  startMX: number;
  startMY: number;
  moved: boolean;
  /** Plain press on a block of a multi-selection: narrow to it when released without a drag. */
  collapseTo: string | null;
} | null;

/** Pan (middle button / Space + left) and marquee (left on empty canvas) use refs + rAF, never React state per move. */
type NavState =
  | { type: 'pan'; pointerId: number; startMX: number; startMY: number; dx: number; dy: number; raf: number | null }
  | { type: 'marquee'; pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean; mods: { shift: boolean; ctrl: boolean }; base: string[]; raf: number | null }
  | null;

function isTyping(el: EventTarget | null): boolean {
  const tag = (el as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export const FlowCanvas: React.FC = () => {
  const { t } = useI18n();
  const state = useFlowStore();
  const { diagram, zoom, panX, panY, showGrid, showMinimap,
          selectedBlockIds, selectedConnectionId, connecting } = state;

  const svgRef      = useRef<SVGSVGElement>(null);
  const rootRef     = useRef<HTMLDivElement>(null);
  const dragRef     = useRef<DragState>(null);
  const navRef      = useRef<NavState>(null);
  const spaceRef    = useRef(false);
  const blocksLayerRef = useRef<HTMLDivElement>(null);
  const svgPanRef   = useRef<SVGGElement>(null);
  const gridRef     = useRef<SVGPatternElement>(null);
  const marqueeRef  = useRef<HTMLDivElement>(null);
  const collapseRef = useRef<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // ── Space key: held = pan with the left button ─────────────────────────────
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTyping(e.target)) return;
      e.preventDefault();
      if (!spaceRef.current) {
        spaceRef.current = true;
        setSpaceHeld(true);
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    const blur = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // ── Global mouse move/up: group block drag + connection ghost line ─────────
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d) {
        const dx = (e.clientX - d.startMX) / zoom;
        const dy = (e.clientY - d.startMY) / zoom;
        if (!d.moved && Math.hypot(e.clientX - d.startMX, e.clientY - d.startMY) < 3) return;
        if (!d.moved) {
          d.moved = true;
          flowStore.checkpoint();
        }
        const pos: Record<string, { x: number; y: number }> = {};
        for (const s of d.starts) pos[s.id] = { x: s.x + dx, y: s.y + dy };
        flowStore.moveBlocks(pos);
      }
      if (connecting) {
        const r = svgRef.current?.getBoundingClientRect();
        if (r) flowStore.updateConnecting(e.clientX - r.left, e.clientY - r.top);
      }
    };
    const mu = () => {
      const d = dragRef.current;
      if (d && !d.moved && d.collapseTo !== null) flowStore.setSelection([d.collapseTo]);
      dragRef.current = null;
    };
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

  // ── Navigation: pan (middle button / Space + left) and marquee (left on empty canvas) ───────────
  const applyPanTransform = useCallback((dx: number, dy: number) => {
    const tf = dx === 0 && dy === 0 ? '' : `translate(${dx}px, ${dy}px)`;
    if (blocksLayerRef.current) blocksLayerRef.current.style.transform = tf;
    if (svgPanRef.current) svgPanRef.current.style.transform = tf;
    const g = 24 * zoom;
    gridRef.current?.setAttribute('x', String((((panX + dx) % g) + g) % g));
    gridRef.current?.setAttribute('y', String((((panY + dy) % g) + g) % g));
  }, [zoom, panX, panY]);

  // The committed pan re-renders every position; drop the temporary transform before paint.
  useLayoutEffect(() => {
    if (blocksLayerRef.current) blocksLayerRef.current.style.transform = '';
    if (svgPanRef.current) svgPanRef.current.style.transform = '';
  }, [panX, panY]);

  const startPan = useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    navRef.current = { type: 'pan', pointerId: e.pointerId, startMX: e.clientX, startMY: e.clientY, dx: 0, dy: 0, raf: null };
    if (rootRef.current) rootRef.current.style.cursor = 'grabbing';
  }, []);

  // Capture phase on the root: the middle button (and Space + left) pans anywhere, even over a block.
  const onRootPointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) startPan(e);
  }, [startPan]);

  // Middle button: stop the browser / WebView autoscroll cursor.
  const onRootMouseDownCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) e.preventDefault();
  }, []);

  const onSvgPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || navRef.current) return;
    const tag = (e.target as Element).tagName;
    if (tag !== 'svg' && tag !== 'rect') return; // ports / connections handle their own presses
    if (connecting) { flowStore.cancelConnecting(); return; }
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    navRef.current = {
      type: 'marquee', pointerId: e.pointerId, startX: x, startY: y, x, y, moved: false,
      mods: { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey },
      base: flowStore.getSnapshot().selectedBlockIds, raf: null,
    };
  }, [connecting]);

  const onNavPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const n = navRef.current;
    if (!n || n.pointerId !== e.pointerId) return;
    if (n.type === 'pan') {
      n.dx = e.clientX - n.startMX;
      n.dy = e.clientY - n.startMY;
    } else {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      n.x = e.clientX - r.left;
      n.y = e.clientY - r.top;
      if (!n.moved && Math.hypot(n.x - n.startX, n.y - n.startY) >= MARQUEE_THRESHOLD) n.moved = true;
    }
    if (n.raf === null) {
      n.raf = requestAnimationFrame(() => {
        const cur = navRef.current;
        if (!cur) return;
        cur.raf = null;
        if (cur.type === 'pan') {
          applyPanTransform(cur.dx, cur.dy);
        } else if (cur.moved && marqueeRef.current) {
          const m = rectFromPoints(cur.startX, cur.startY, cur.x, cur.y);
          const st = marqueeRef.current.style;
          st.display = 'block';
          st.left = `${m.x}px`;
          st.top = `${m.y}px`;
          st.width = `${m.w}px`;
          st.height = `${m.h}px`;
        }
      });
    }
  }, [applyPanTransform]);

  const onNavPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const n = navRef.current;
    if (!n || n.pointerId !== e.pointerId) return;
    navRef.current = null;
    if (n.raf !== null) cancelAnimationFrame(n.raf);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (n.type === 'pan') {
      if (rootRef.current) rootRef.current.style.cursor = '';
      if (n.dx !== 0 || n.dy !== 0) flowStore.setPan(panX + n.dx, panY + n.dy);
      else applyPanTransform(0, 0);
      return;
    }
    if (marqueeRef.current) marqueeRef.current.style.display = 'none';
    if (!n.moved) {
      // plain click on empty canvas clears the selection (Shift / Ctrl keep it)
      if (!n.mods.shift && !n.mods.ctrl) flowStore.deselectAll();
      return;
    }
    const view = { zoom, panX, panY };
    const a = screenToCanvas(n.startX, n.startY, view);
    const b = screenToCanvas(n.x, n.y, view);
    const sizes = flowStore.getSnapshot().diagram.blocks.map((blk) => {
      const def = getBlockDefFor(blk);
      const rows = def ? Math.max(def.ports.filter((p) => p.direction === 'input').length, def.ports.filter((p) => p.direction === 'output').length) : 0;
      return { id: blk.id, x: blk.x, y: blk.y, ...blockSize(blk, rows) };
    });
    const hits = marqueeHits(sizes, rectFromPoints(a.x, a.y, b.x, b.y));
    flowStore.setSelection(applyMarquee(n.base, hits, n.mods));
  }, [applyPanTransform, zoom, panX, panY]);

  // ── Block drag start (from HTML layer): drags the whole selection ──────────
  const onBlockDragStart = useCallback((block: FlowBlock) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button !== 0 || spaceRef.current) return;
    const sel = new Set(flowStore.getSnapshot().selectedBlockIds);
    if (!sel.has(block.id)) sel.add(block.id);
    const starts = flowStore.getSnapshot().diagram.blocks.filter((b) => sel.has(b.id)).map((b) => ({ id: b.id, x: b.x, y: b.y }));
    dragRef.current = { type: 'block', starts, startMX: e.clientX, startMY: e.clientY, moved: false, collapseTo: collapseRef.current };
    collapseRef.current = null;
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

  // ── Block select (Shift = add, Ctrl / Cmd = toggle) ──────────────────────────
  const onBlockSelect = useCallback((blockId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button !== 0 || spaceRef.current) return;
    const r = clickSelect(flowStore.getSnapshot().selectedBlockIds, blockId, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    collapseRef.current = r.collapseOnRelease ? blockId : null;
    flowStore.setSelection(r.selection);
  }, []);

  // ── Double-click on a goto pill: select its terminal and pan the view onto it ──
  const jumpToTerminal = useCallback((gotoBlock: FlowBlock) => {
    const target = resolveGotoTarget(diagram, gotoBlock);
    if (!target) return;
    flowStore.selectBlock(target.id, false);
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    flowStore.setPan(r.width / 2 - (target.x + PILL_WIDTH / 2) * zoom, r.height / 2 - (target.y + PILL_HEIGHT / 2) * zoom);
  }, [diagram, zoom]);

  // Terminal currently selected (single selection) -> its gotos are outlined.
  const selectedTerminalId = selectedBlockIds.length === 1
    && diagram.blocks.some((b) => b.id === selectedBlockIds[0] && b.type === 'flow_terminal')
    ? selectedBlockIds[0] : null;

  // ── Drop from palette ──────────────────────────────────────────────────────
  const onDrop = useCallback((e: React.DragEvent<SVGSVGElement>) => {
    e.preventDefault();
    const t = e.dataTransfer.getData('application/nexus-block-type');
    if (!t) return;
    const p = toCanvas(e.clientX, e.clientY);
    const x = p.x - BLOCK_WIDTH / 2;
    const y = p.y - BLOCK_HEADER_HEIGHT / 2;
    if (isCallType(t)) {
      // Library item dropped from the palette: pinned to its latest revision, cycle-checked.
      void flowRegistry.insertCall(t.slice(5), x, y);
      return;
    }
    flowStore.addBlock(t, x, y);
  }, [toCanvas]);

  // ── Grid values ───────────────────────────────────────────────────────────
  const gs  = 24 * zoom;
  const gox = ((panX % gs) + gs) % gs;
  const goy = ((panY % gs) + gs) % gs;

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--bg-canvas)', cursor: spaceHeld ? 'grab' : undefined, touchAction: 'none' }}
      onPointerDownCapture={onRootPointerDownCapture}
      onMouseDownCapture={onRootMouseDownCapture}
      onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
      onPointerMove={onNavPointerMove}
      onPointerUp={onNavPointerUp}
      onPointerCancel={onNavPointerUp}
    >

      {/* ── Layer 1: SVG — grid, connections, port handles, ghost line ── */}
      <svg
        ref={svgRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        onPointerDown={onSvgPointerDown}
        onWheel={onWheel}
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      >
        {/* Grid dots */}
        {showGrid && (
          <>
            <defs>
              <pattern ref={gridRef} id="nexus-flow-grid" x={gox} y={goy} width={gs} height={gs} patternUnits="userSpaceOnUse">
                <circle cx={0} cy={0} r={1} style={{ fill: 'var(--canvas-grid)' }} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#nexus-flow-grid)" />
          </>
        )}

        <g ref={svgPanRef}>
        {/* Connections */}
        {diagram.connections.map((conn) => {
          const fb = diagram.blocks.find((b) => b.id === conn.fromBlockId);
          const tb = diagram.blocks.find((b) => b.id === conn.toBlockId);
          if (!fb || !tb) return null;
          const fd = getBlockDefFor(fb);
          const td = getBlockDefFor(tb);
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
          const def = getBlockDefFor(block);
          if (!def) return null;
          return (
            <g key={`ph-${block.id}`}>
              {def.ports.map((port) => {
                const ps  = portScreen(block, port.id, def);
                const r   = Math.max(5, 6 * zoom);
                const col = portColor(port.type);
                const compat = connecting
                  && portsCompatible(connecting.fromPortType, port.type)
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
        </g>
      </svg>

      {/* ── Layer 2: HTML block nodes ── */}
      <div ref={blocksLayerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {diagram.blocks.map((block) => {
          const def = getBlockDefFor(block);
          if (!def) return null;
          if (block.type === FLOW_IN || block.type === FLOW_OUT) {
            return (
              <PortPill
                key={block.id}
                block={block}
                selected={selectedBlockIds.includes(block.id)}
                zoom={zoom}
                panX={panX}
                panY={panY}
                onSelect={onBlockSelect(block.id)}
                onDragStart={onBlockDragStart(block)}
              />
            );
          }
          if (isCompactBlock(block.type)) {
            const isTerminal = block.type === 'flow_terminal';
            const target = isTerminal ? block : resolveGotoTarget(diagram, block);
            return (
              <TerminalPill
                key={block.id}
                block={block}
                kind={isTerminal ? 'terminal' : 'goto'}
                name={target ? terminalName(target) : null}
                color={target ? TERMINAL_COLOR_CSS[terminalColor(target)] : 'var(--status-critical)'}
                refCount={isTerminal ? terminalReferences(diagram, block.id).length : 0}
                selected={selectedBlockIds.includes(block.id)}
                highlighted={!isTerminal && selectedTerminalId !== null && gotoTargetId(block) === selectedTerminalId}
                zoom={zoom}
                panX={panX}
                panY={panY}
                onSelect={onBlockSelect(block.id)}
                onDragStart={onBlockDragStart(block)}
                onDoubleClick={() => jumpToTerminal(block)}
              />
            );
          }
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

      {/* ── Marquee (updated through its ref on rAF; no animation, no blur) ── */}
      <div
        ref={marqueeRef}
        style={{ position: 'absolute', display: 'none', pointerEvents: 'none', border: '1px solid var(--status-focus)', background: 'var(--status-focus-bg)', zIndex: 5 }}
      />

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
