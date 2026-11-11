import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ecuGraphStore, type GraphViewport } from '../../../store/ecuGraphStore';
import {
  formatCanId,
  graphBounds,
  NODE_H,
  NODE_W,
  nodeDetailLine,
  nodeTitle,
  TESTER_H,
  TESTER_W,
  rectEdgePoint,
  type GraphNode,
  type GraphPos,
} from './graphModel';

/**
 * Canvas renderer + interaction layer for the ECU graph. No continuous animation loop: a frame is
 * scheduled with requestAnimationFrame only when something changed (props, pan / zoom / drag, resize,
 * theme). Pan / zoom / drag state lives in refs, so pointer moves never re-render React; the store is
 * written only at the end of a gesture.
 */

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const DRAG_THRESHOLD_PX = 3;
const MONO = 'Consolas, "Cascadia Mono", "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace';

export interface GraphCanvasStrings {
  tester: string;
  testerSub: string;
  active: string;
  notSeen: string;
  seen: string;
  pending: string;
  dtc: string;
  ariaLabel: string;
}

interface Props {
  nodes: GraphNode[];
  selectedKey: string | null;
  activeKey: string | null;
  strings: GraphCanvasStrings;
  /** Increment to fit the whole graph into the view. */
  fitNonce: number;
  onSelect: (key: string | null) => void;
  onMove: (key: string, pos: GraphPos) => void;
  onActivate: (key: string) => void;
  renderTooltip: (node: GraphNode) => React.ReactNode;
}

interface Theme {
  canvas: string;
  surface: string;
  elevated: string;
  hairline: string;
  strong: string;
  ink: string;
  muted: string;
  subtle: string;
  nominal: string;
  focus: string;
  warn: string;
  critical: string;
  grid: string;
}

function readTheme(): Theme {
  const cs = window.getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    canvas: v('--bg-canvas', '#121417'),
    surface: v('--bg-surface', '#16191e'),
    elevated: v('--bg-elevated', '#1b1f25'),
    hairline: v('--border-hairline', '#262b33'),
    strong: v('--border-strong', '#313741'),
    ink: v('--text-ink', '#dce2ea'),
    muted: v('--text-secondary', '#9099a6'),
    subtle: v('--text-subtle', '#5d6673'),
    nominal: v('--status-nominal', '#2ea043'),
    focus: v('--status-focus', '#0e8ac8'),
    warn: v('--status-warn', '#d29922'),
    critical: v('--status-critical', '#e5534b'),
    grid: v('--canvas-grid', 'rgba(139,148,160,0.12)'),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function sessionAbbr(s: GraphNode['lastSession']): string | null {
  return s === 'default' ? 'DEF' : s === 'extended' ? 'EXT' : s === 'programming' ? 'PRG' : null;
}

function stateColor(n: GraphNode, theme: Theme): string {
  if (n.pending) return theme.warn;
  if (!n.positive) return theme.critical;
  return theme.nominal;
}

export const EcuGraphCanvas: React.FC<Props> = (props) => {
  const { nodes, selectedKey, activeKey, strings, fitNonce, onSelect, onMove, onActivate, renderTooltip } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ nodes, selectedKey, activeKey, strings });
  const handlersRef = useRef({ onSelect, onMove, onActivate });
  const viewRef = useRef<GraphViewport | null>(ecuGraphStore.getViewport());
  const sizeRef = useRef({ w: 0, h: 0 });
  const overridesRef = useRef(new Map<string, GraphPos>());
  const hoverKeyRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const rafRef = useRef(0);
  const themeRef = useRef<Theme | null>(null);
  const dragRef = useRef<
    | { kind: 'node'; key: string; sx: number; sy: number; offX: number; offY: number; moved: boolean }
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
    | null
  >(null);
  const drawRef = useRef<() => void>(() => undefined);

  const [tooltip, setTooltip] = useState<{ key: string; x: number; y: number } | null>(null);

  const requestDraw = useCallback(() => {
    dirtyRef.current = true;
    if (rafRef.current !== 0) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      drawRef.current();
    });
  }, []);

  const nodePos = useCallback((n: GraphNode): GraphPos => overridesRef.current.get(n.key) ?? n.pos, []);

  const commitView = useCallback(() => {
    if (viewRef.current) ecuGraphStore.saveViewport(viewRef.current);
  }, []);

  const fit = useCallback(() => {
    const { w, h } = sizeRef.current;
    if (w < 10 || h < 10) return;
    const b = graphBounds(propsRef.current.nodes, NODE_W, NODE_H, TESTER_W, TESTER_H);
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const pad = 48;
    const zoom = clamp(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh), MIN_ZOOM, 1.2);
    viewRef.current = {
      zoom,
      x: w / 2 - ((b.minX + b.maxX) / 2) * zoom,
      y: h / 2 - ((b.minY + b.maxY) / 2) * zoom,
    };
    commitView();
    requestDraw();
  }, [commitView, requestDraw]);

  // ── Drawing ────────────────────────────────────────────────────────────────
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = sizeRef.current;
    if (w < 2 || h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (viewRef.current === null) {
      // First paint: fit when there is something to show, otherwise centre the tester.
      if (propsRef.current.nodes.length > 0) {
        fit();
        if (viewRef.current === null) return;
      } else {
        viewRef.current = { x: w / 2, y: h / 2, zoom: 1 };
      }
    }
    const view = viewRef.current;
    const theme = themeRef.current ?? readTheme();
    themeRef.current = theme;
    const { nodes: ns, selectedKey: sel, activeKey: act, strings: st } = propsRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.canvas;
    ctx.fillRect(0, 0, w, h);

    // Graticule (screen-space dots, cheap).
    const step = 40 * view.zoom;
    if (step >= 14) {
      ctx.fillStyle = theme.grid;
      const ox = ((view.x % step) + step) % step;
      const oy = ((view.y % step) + step) % step;
      for (let gx = ox; gx < w; gx += step) {
        for (let gy = oy; gy < h; gy += step) ctx.fillRect(Math.round(gx), Math.round(gy), 1, 1);
      }
    }

    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
    const px = 1 / view.zoom;
    ctx.textBaseline = 'middle';

    // Edges tester -> ECU
    const labels: Array<{ a: GraphPos; b: GraphPos; node: GraphPos; line1: string; line2: string; dim: boolean }> = [];
    for (const n of ns) {
      const p = nodePos(n);
      const isAct = act === n.key;
      const col = isAct ? theme.focus : stateColor(n, theme);
      const a = rectEdgePoint(0, 0, TESTER_W / 2, TESTER_H / 2, p.x, p.y);
      const b = rectEdgePoint(p.x, p.y, NODE_W / 2, NODE_H / 2, 0, 0);
      ctx.save();
      ctx.globalAlpha = n.lastScanSeen ? 1 : 0.4;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = (isAct ? 3 : 1.5) * px;
      ctx.setLineDash(n.lastScanSeen ? [] : [6 * px, 5 * px]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Arrow head at the ECU end (tester -> ECU).
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const ah = 9 * px;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(ang - 0.4) * ah, b.y - Math.sin(ang - 0.4) * ah);
      ctx.lineTo(b.x - Math.cos(ang + 0.4) * ah, b.y - Math.sin(ang + 0.4) * ah);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      const req = n.requestId === null ? '—' : formatCanId(n.requestId, n.isExtendedId);
      labels.push({
        a,
        b,
        node: p,
        line1: `${req}/${formatCanId(n.responseId, n.isExtendedId)}`,
        line2: `${(n.firstResponseUs / 1000).toFixed(2)} ms`,
        dim: !n.lastScanSeen,
      });
    }

    if (view.zoom >= 0.45) {
      ctx.font = `10.5px ${MONO}`;
      ctx.textAlign = 'center';
      for (const l of labels) {
        const tw = Math.max(ctx.measureText(l.line1).width, ctx.measureText(l.line2).width) + 10;
        const th = 28;
        // Centre of the VISIBLE segment (card border to card border); if the plate would still touch
        // a card, slide it perpendicular to the line.
        const mx = (l.a.x + l.b.x) / 2;
        const my = (l.a.y + l.b.y) / 2;
        const len = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) || 1;
        const nx = -(l.b.y - l.a.y) / len;
        const ny = (l.b.x - l.a.x) / len;
        const hits = (cx: number, cy: number): boolean => {
          const inRect = (rx: number, ry: number, hw: number, hh: number): boolean =>
            Math.abs(cx - rx) < hw + tw / 2 + 2 && Math.abs(cy - ry) < hh + th / 2 + 2;
          return inRect(0, 0, TESTER_W / 2, TESTER_H / 2) || inRect(l.node.x, l.node.y, NODE_W / 2, NODE_H / 2);
        };
        let lx = mx;
        let ly = my;
        for (const off of [0, th / 2 + 8, -(th / 2 + 8), th + 16, -(th + 16)]) {
          const cx = mx + nx * off;
          const cy = my + ny * off;
          lx = cx;
          ly = cy;
          if (!hits(cx, cy)) break;
        }
        ctx.save();
        ctx.globalAlpha = l.dim ? 0.6 : 1;
        ctx.fillStyle = theme.canvas;
        ctx.fillRect(lx - tw / 2, ly - th / 2, tw, th);
        ctx.fillStyle = theme.muted;
        ctx.fillText(l.line1, lx, ly - 7);
        ctx.fillText(l.line2, lx, ly + 7);
        ctx.restore();
      }
    }

    // Tester node
    {
      const x = -TESTER_W / 2;
      const y = -TESTER_H / 2;
      roundRect(ctx, x, y, TESTER_W, TESTER_H, 6);
      ctx.fillStyle = theme.elevated;
      ctx.fill();
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = theme.focus;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = theme.focus;
      ctx.font = `700 13px ${MONO}`;
      ctx.fillText(ellipsize(ctx, st.tester, TESTER_W - 16), 0, -9);
      ctx.fillStyle = theme.muted;
      ctx.font = `11px ${MONO}`;
      ctx.fillText(ellipsize(ctx, st.testerSub, TESTER_W - 16), 0, 11);
    }

    // ECU nodes (selected / hovered last so they stay on top)
    const hover = hoverKeyRef.current;
    const ordered = [...ns].sort((a, b) => {
      const ra = a.key === sel ? 2 : a.key === hover ? 1 : 0;
      const rb = b.key === sel ? 2 : b.key === hover ? 1 : 0;
      return ra - rb;
    });
    for (const n of ordered) {
      const p = nodePos(n);
      const x = p.x - NODE_W / 2;
      const y = p.y - NODE_H / 2;
      const isAct = act === n.key;
      const isSel = sel === n.key;
      const accent = isAct ? theme.focus : stateColor(n, theme);
      ctx.save();
      ctx.globalAlpha = n.lastScanSeen ? 1 : 0.55;
      roundRect(ctx, x, y, NODE_W, NODE_H, 4);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      // accent strip
      ctx.save();
      roundRect(ctx, x, y, NODE_W, NODE_H, 4);
      ctx.clip();
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, 4, NODE_H);
      ctx.restore();
      roundRect(ctx, x, y, NODE_W, NODE_H, 4);
      ctx.lineWidth = (isSel || isAct ? 2 : 1) * px;
      ctx.strokeStyle = isSel ? theme.ink : isAct ? theme.focus : hover === n.key ? theme.strong : theme.hairline;
      if (!n.lastScanSeen) ctx.setLineDash([5 * px, 4 * px]);
      ctx.stroke();
      ctx.setLineDash([]);

      const tx = x + 14;
      const maxW = NODE_W - 24;
      ctx.textAlign = 'left';
      ctx.fillStyle = theme.ink;
      ctx.font = `700 13px ${MONO}`;
      ctx.fillText(ellipsize(ctx, nodeTitle(n), maxW), tx, y + 15);
      ctx.fillStyle = theme.focus;
      ctx.font = `12px ${MONO}`;
      const req = n.requestId === null ? '—' : formatCanId(n.requestId, n.isExtendedId);
      ctx.fillText(`${req}/${formatCanId(n.responseId, n.isExtendedId)}`, tx, y + 33);
      ctx.fillStyle = theme.muted;
      ctx.font = `11px ${MONO}`;
      const detail = nodeDetailLine(n);
      if (detail !== null) ctx.fillText(ellipsize(ctx, detail, maxW), tx, y + 50);
      ctx.fillStyle = theme.subtle;
      const seenAt = n.lastSeenMs > 0 ? new Date(n.lastSeenMs).toLocaleTimeString([], { hour12: false }) : '—';
      ctx.fillText(ellipsize(ctx, `${(n.firstResponseUs / 1000).toFixed(2)} ms · ${st.seen} ${seenAt}`, maxW), tx, y + 66);

      // badges
      const badges: Array<{ text: string; color: string }> = [];
      if (isAct) badges.push({ text: st.active, color: theme.focus });
      if (n.dtcCount !== null) badges.push({ text: `${st.dtc} ${n.dtcCount}`, color: n.dtcCount > 0 ? theme.critical : theme.nominal });
      const ses = sessionAbbr(n.lastSession);
      if (ses) badges.push({ text: ses, color: n.lastSession === 'default' ? theme.muted : theme.warn });
      if (n.pending) badges.push({ text: st.pending, color: theme.warn });
      else if (!n.positive) {
        badges.push({ text: n.nrc !== null ? `NRC 0x${n.nrc.toString(16).toUpperCase().padStart(2, '0')}` : 'NRC', color: theme.critical });
      }
      if (n.positive && !n.pending) badges.push({ text: 'OK', color: theme.nominal });
      if (!n.lastScanSeen) badges.push({ text: st.notSeen, color: theme.subtle });
      ctx.font = `700 10px ${MONO}`;
      let bx = tx;
      const by = y + NODE_H - 13;
      for (const bd of badges) {
        const bw = ctx.measureText(bd.text).width + 10;
        if (bx + bw > x + NODE_W - 8) break;
        roundRect(ctx, bx, by - 8, bw, 16, 2);
        ctx.lineWidth = px;
        ctx.strokeStyle = bd.color;
        ctx.stroke();
        ctx.fillStyle = bd.color;
        ctx.fillText(bd.text, bx + 5, by + 0.5);
        bx += bw + 5;
      }
      ctx.restore();
    }
  };

  // ── Sync props -> refs, redraw once ────────────────────────────────────────
  useEffect(() => {
    propsRef.current = { nodes, selectedKey, activeKey, strings };
    handlersRef.current = { onSelect, onMove, onActivate };
    // New authoritative positions arrived: drop the drag overrides.
    const dragging = dragRef.current?.kind === 'node' ? dragRef.current.key : null;
    for (const k of [...overridesRef.current.keys()]) {
      if (k !== dragging) overridesRef.current.delete(k);
    }
    requestDraw();
  }, [nodes, selectedKey, activeKey, strings, onSelect, onMove, onActivate, requestDraw]);

  useEffect(() => {
    if (fitNonce > 0) fit();
  }, [fitNonce, fit]);

  // ── Size / theme observers ─────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const sync = () => {
      sizeRef.current = { w: wrap.clientWidth, h: wrap.clientHeight };
      requestDraw();
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    window.addEventListener('resize', sync);
    const mo = new MutationObserver(() => {
      themeRef.current = null;
      requestDraw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', sync);
      if (rafRef.current !== 0) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [requestDraw]);

  // ── Hit testing / pointer ──────────────────────────────────────────────────
  const toWorld = useCallback((sx: number, sy: number): GraphPos => {
    const v = viewRef.current ?? { x: 0, y: 0, zoom: 1 };
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }, []);

  const hitTest = useCallback(
    (sx: number, sy: number): GraphNode | null => {
      const w = toWorld(sx, sy);
      const ns = propsRef.current.nodes;
      for (let i = ns.length - 1; i >= 0; i--) {
        const p = nodePos(ns[i]);
        if (Math.abs(w.x - p.x) <= NODE_W / 2 && Math.abs(w.y - p.y) <= NODE_H / 2) return ns[i];
      }
      return null;
    },
    [nodePos, toWorld],
  );

  function localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = (wrapRef.current ?? document.body).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function setCursor(c: string): void {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (e.button !== 0) return;
    const pt = localPoint(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setTooltip(null);
    const hit = hitTest(pt.x, pt.y);
    const view = viewRef.current;
    if (!view) return;
    if (hit) {
      const w = toWorld(pt.x, pt.y);
      const p = nodePos(hit);
      dragRef.current = { kind: 'node', key: hit.key, sx: pt.x, sy: pt.y, offX: w.x - p.x, offY: w.y - p.y, moved: false };
      handlersRef.current.onSelect(hit.key);
    } else {
      dragRef.current = { kind: 'pan', sx: pt.x, sy: pt.y, vx: view.x, vy: view.y, moved: false };
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const pt = localPoint(e);
    const d = dragRef.current;
    if (d) {
      if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      if (d.kind === 'node') {
        const w = toWorld(pt.x, pt.y);
        overridesRef.current.set(d.key, { x: w.x - d.offX, y: w.y - d.offY });
        setCursor('grabbing');
      } else if (viewRef.current) {
        viewRef.current = { ...viewRef.current, x: d.vx + (pt.x - d.sx), y: d.vy + (pt.y - d.sy) };
        setCursor('grabbing');
      }
      requestDraw();
      return;
    }
    const hit = hitTest(pt.x, pt.y);
    const key = hit ? hit.key : null;
    setCursor(hit ? 'pointer' : 'grab');
    if (key !== hoverKeyRef.current) {
      hoverKeyRef.current = key;
      setTooltip(key ? { key, x: pt.x, y: pt.y } : null);
      requestDraw();
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>): void {
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    setCursor('grab');
    if (d.kind === 'node') {
      const o = overridesRef.current.get(d.key);
      if (d.moved && o) handlersRef.current.onMove(d.key, o);
      else overridesRef.current.delete(d.key);
    } else if (d.moved) {
      commitView();
    } else {
      handlersRef.current.onSelect(null);
    }
    requestDraw();
  }

  function handlePointerLeave(): void {
    if (dragRef.current) return;
    if (hoverKeyRef.current !== null) {
      hoverKeyRef.current = null;
      setTooltip(null);
      requestDraw();
    }
  }

  function handleDoubleClick(e: React.MouseEvent<HTMLCanvasElement>): void {
    const pt = localPoint(e);
    const hit = hitTest(pt.x, pt.y);
    if (hit) handlersRef.current.onActivate(hit.key);
  }

  // Wheel zoom around the cursor (non-passive so the page does not scroll).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      if (!view) return;
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const zoom = clamp(view.zoom * Math.exp(-e.deltaY * unit * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const wx = (sx - view.x) / view.zoom;
      const wy = (sy - view.y) / view.zoom;
      viewRef.current = { zoom, x: sx - wx * zoom, y: sy - wy * zoom };
      commitView();
      setTooltip(null);
      hoverKeyRef.current = null;
      requestDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [commitView, requestDraw]);

  const tipNode = tooltip ? (nodes.find((n) => n.key === tooltip.key) ?? null) : null;

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-canvas">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={strings.ariaLabel}
        className="absolute inset-0 block h-full w-full touch-none"
        style={{ cursor: 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
      />
      {tooltip && tipNode && (
        <div
          className="pointer-events-none absolute z-10 max-w-[320px] rounded-[2px] border border-strong bg-elevated px-2.5 py-2 font-mono text-[11.5px] tabular-nums text-ink"
          style={{
            left: Math.min(tooltip.x + 14, Math.max(0, sizeRef.current.w - 330)),
            top: Math.min(tooltip.y + 14, Math.max(0, sizeRef.current.h - 150)),
          }}
        >
          {renderTooltip(tipNode)}
        </div>
      )}
    </div>
  );
};
