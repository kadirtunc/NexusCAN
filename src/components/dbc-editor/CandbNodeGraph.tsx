'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { DatabaseSchemaDto } from './contracts';
import { formatHexArbId } from './dbcEditorUtils';
import { useDbcStudioI18n } from './i18n/dbcStudio';
import {
  UNASSIGNED_NODE,
  buildNodeGraph,
  circularLayout,
  distanceToEdge,
  edgeControlPoint,
  quadPoint,
  edgeWidth,
  nodeTraffic,
  parseLayout,
  serializeLayout,
  type GraphEdge,
  type GraphEdgeMessage,
  type Pt,
} from './nodeGraphModel';
import { readThemeColor, subscribeThemeChange } from '../../utils/themeTokens';

interface CandbNodeGraphProps {
  schema: DatabaseSchemaDto;
  storageKey?: string;
  onOpenMessageDialog: (messageKey: string, openLayoutTab?: boolean) => void;
  onOpenEcuDialog: (ecuName: string) => void;
}

const WORLD_W = 1000;
const WORLD_H = 640;
const NODE_W = 150;
const NODE_H = 44;
const BEND = 70;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const DRAG_THRESHOLD_PX = 4;
const EDGE_HIT_PX = 6;
const TOOLTIP_MAX_ROWS = 12;
const SIDEBAR_SIGNALS_MAX = 6;
const MONO =
  'Consolas, "Cascadia Mono", "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace';

interface View {
  x: number;
  y: number;
  zoom: number;
}

interface Theme {
  canvas: string;
  grid: string;
  elevated: string;
  border: string;
  text: string;
  muted: string;
  focus: string;
  tx: string;
  rx: string;
  panel: string;
  hairline: string;
  secondary: string;
}

function readTheme(): Theme {
  return {
    canvas: readThemeColor('--bg-canvas'),
    grid: readThemeColor('--canvas-grid'),
    elevated: readThemeColor('--bg-elevated'),
    border: readThemeColor('--border-strong'),
    text: readThemeColor('--text-primary'),
    muted: readThemeColor('--text-muted'),
    focus: readThemeColor('--status-focus'),
    tx: readThemeColor('--series-1'),
    rx: readThemeColor('--series-2'),
    panel: readThemeColor('--bg-panel'),
    hairline: readThemeColor('--border-hairline'),
    secondary: readThemeColor('--text-secondary'),
  };
}

type DragState =
  | { kind: 'node'; name: string; sx: number; sy: number; offX: number; offY: number; moved: boolean }
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Point where the ray from rect centre towards `toward` leaves the rect. */
function rectExit(c: Pt, toward: Pt): Pt {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : NODE_W / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : NODE_H / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
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

function loadSaved(storageKey: string | undefined): Record<string, Pt> {
  if (!storageKey) return {};
  try {
    return parseLayout(window.localStorage.getItem(storageKey));
  } catch {
    return {};
  }
}

interface EdgeGeom {
  a: Pt;
  c: Pt;
  b: Pt;
}

// ── Experimental: edge labels (isolated; remove together with the toggle) ───
interface EdgeLabelRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EdgeLabelStyle {
  color: string;
  alpha: number;
  active: boolean;
}

function edgeLabelText(e: GraphEdge, zoom: number, countLabel: (n: number) => string): string {
  if (e.messages.length === 1) {
    const m = e.messages[0];
    const name = m.name.length > 14 ? `${m.name.slice(0, 14)}…` : m.name;
    return zoom >= 1.4 ? `${name} · ${formatHexArbId(m.arbId, m.isExtended)}` : name;
  }
  return countLabel(e.messages.length);
}

/** Draws pill labels at curve midpoints in screen space; fills `out` with the drawn rects (for hit-testing). */
function drawEdgeLabels(
  ctx: CanvasRenderingContext2D,
  args: {
    edges: readonly GraphEdge[];
    geomOf: (e: GraphEdge) => EdgeGeom;
    view: View;
    theme: Theme;
    styles: ReadonlyMap<string, EdgeLabelStyle>;
    nodeRects: readonly { x: number; y: number; w: number; h: number }[];
    countLabel: (n: number) => string;
  },
  out: EdgeLabelRect[]
): void {
  out.length = 0;
  const { view, theme } = args;
  if (view.zoom < 0.6) return;
  const order = args.edges.slice().sort((p, q) => {
    const ap = args.styles.get(p.id)?.active ? 1 : 0;
    const aq = args.styles.get(q.id)?.active ? 1 : 0;
    return aq - ap || q.messages.length - p.messages.length;
  });
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const e of order) {
    const gm = args.geomOf(e);
    const mid = quadPoint(gm.a, gm.c, gm.b, 0.5);
    const cx = mid.x * view.zoom + view.x;
    const cy = mid.y * view.zoom + view.y;
    const text = edgeLabelText(e, view.zoom, args.countLabel);
    const w = Math.ceil(ctx.measureText(text).width) + 10;
    const h = 15;
    const rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    if (args.nodeRects.some((r) => overlaps(rect, r))) continue;
    if (out.some((r) => overlaps(rect, r))) continue;
    const st = args.styles.get(e.id);
    ctx.save();
    ctx.globalAlpha = st?.alpha ?? 1;
    roundRect(ctx, rect.x, rect.y, w, h, 3);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = st?.active ? st.color : theme.hairline;
    ctx.stroke();
    ctx.fillStyle = st?.active ? st.color : theme.secondary;
    ctx.fillText(text, cx, cy + 0.5);
    ctx.restore();
    out.push({ id: e.id, ...rect });
  }
}

export const CandbNodeGraph: React.FC<CandbNodeGraphProps> = ({
  schema,
  storageKey,
  onOpenMessageDialog,
  onOpenEcuDialog,
}) => {
  const { t } = useDbcStudioI18n();
  const [includeUnassigned, setIncludeUnassigned] = useState(false);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ edgeId: string; x: number; y: number } | null>(null);

  const graph = useMemo(() => buildNodeGraph(schema, { includeUnassigned }), [schema, includeUnassigned]);
  const circ = useMemo(() => circularLayout(graph.nodes.map((n) => n.name)), [graph.nodes]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const viewRef = useRef<View | null>(null);
  const savedRef = useRef<Record<string, Pt>>({});
  const loadedKeyRef = useRef<string | null | undefined>(null);
  const themeRef = useRef<Theme | null>(null);
  const hoverNodeRef = useRef<string | null>(null);
  const hoverEdgeRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const groupHoverRef = useRef<string | null>(null);
  const labelRectsRef = useRef<EdgeLabelRect[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const dirtyRef = useRef(false);
  const rafRef = useRef(0);
  const drawRef = useRef<() => void>(() => undefined);

  // Latest props/derived data for imperative handlers.
  const dataRef = useRef({
    graph,
    circ,
    pinnedId,
    showLabels,
    countLabel: (n: number): string => String(n),
    labels: { tx: '', rx: '', unassigned: '' },
  });
  dataRef.current = {
    graph,
    circ,
    pinnedId,
    showLabels,
    countLabel: (n: number): string => t('nodeGraph.edgeLabel.count', { count: n }),
    labels: {
      tx: t('nodeGraph.legend.tx'),
      rx: t('nodeGraph.legend.rx'),
      unassigned: t('nodeGraph.unassigned'),
    },
  };

  if (loadedKeyRef.current !== (storageKey ?? '')) {
    loadedKeyRef.current = storageKey ?? '';
    savedRef.current = loadSaved(storageKey);
  }

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

  const posOf = useCallback((name: string): Pt => {
    const n = savedRef.current[name] ?? dataRef.current.circ[name] ?? { x: 0.5, y: 0.5 };
    return { x: n.x * WORLD_W, y: n.y * WORLD_H };
  }, []);

  const geomOf = useCallback(
    (e: GraphEdge): EdgeGeom => {
      const pa = posOf(e.from);
      const pb = posOf(e.to);
      const c = edgeControlPoint(pa, pb, e.hasReverse, BEND);
      return { a: rectExit(pa, c), c, b: rectExit(pb, c) };
    },
    [posOf]
  );

  const fit = useCallback(() => {
    const { w, h } = sizeRef.current;
    const names = dataRef.current.graph.nodes.map((n) => n.name);
    if (w < 10 || h < 10 || names.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const name of names) {
      const p = posOf(name);
      minX = Math.min(minX, p.x - NODE_W / 2);
      maxX = Math.max(maxX, p.x + NODE_W / 2);
      minY = Math.min(minY, p.y - NODE_H / 2);
      maxY = Math.max(maxY, p.y + NODE_H / 2);
    }
    const pad = 40;
    const zoom = clamp(Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY)), MIN_ZOOM, 1.5);
    viewRef.current = {
      zoom,
      x: w / 2 - ((minX + maxX) / 2) * zoom,
      y: h / 2 - ((minY + maxY) / 2) * zoom,
    };
    requestDraw();
  }, [posOf, requestDraw]);

  // ── Drawing ──────────────────────────────────────────────────────────────
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
      fit();
      if (viewRef.current === null) return;
    }
    const view = viewRef.current;
    const theme = themeRef.current ?? readTheme();
    themeRef.current = theme;
    const { graph: g, pinnedId: pinned, labels, showLabels: labelsOn, countLabel } = dataRef.current;
    const labelStyles = new Map<string, EdgeLabelStyle>();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.canvas;
    ctx.fillRect(0, 0, w, h);

    const step = 40 * view.zoom;
    if (step >= 14) {
      ctx.fillStyle = theme.grid;
      const ox = ((view.x % step) + step) % step;
      const oy = ((view.y % step) + step) % step;
      for (let gx = ox; gx < w; gx += step) {
        for (let gy = oy; gy < h; gy += step) ctx.fillRect(Math.round(gx), Math.round(gy), 1, 1);
      }
    }

    const focus = hoverNodeRef.current ?? selectedRef.current;
    const hoverEdge = hoverEdgeRef.current;
    const related = new Set<string>();
    if (focus !== null) {
      related.add(focus);
      for (const e of g.edges) {
        if (e.from === focus) related.add(e.to);
        if (e.to === focus) related.add(e.from);
      }
    }

    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
    const px = 1 / view.zoom;

    // Edges
    for (const e of g.edges) {
      const { a, c, b } = geomOf(e);
      let color = theme.border;
      let dashed = false;
      let alpha = 1;
      if (focus !== null) {
        if (e.from === focus) color = theme.tx;
        else if (e.to === focus) {
          color = theme.rx;
          dashed = true;
        } else alpha = 0.2;
      }
      const emphasised = e.id === hoverEdge || e.id === groupHoverRef.current || e.id === pinned;
      if (emphasised) {
        color = e.id === pinned ? theme.focus : theme.text;
        alpha = 1;
      }
      labelStyles.set(e.id, {
        color,
        alpha,
        active: emphasised || (focus !== null && (e.from === focus || e.to === focus)),
      });
      const lw = (edgeWidth(e.messages.length) + (emphasised ? 1.5 : 0)) * px;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw;
      ctx.setLineDash(dashed ? [7 * px, 5 * px] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const tx = c.x === b.x && c.y === b.y ? a.x : c.x;
      const ty = c.x === b.x && c.y === b.y ? a.y : c.y;
      const ang = Math.atan2(b.y - ty, b.x - tx);
      const ah = (8 + lw / px) * px;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(ang - 0.4) * ah, b.y - Math.sin(ang - 0.4) * ah);
      ctx.lineTo(b.x - Math.cos(ang + 0.4) * ah, b.y - Math.sin(ang + 0.4) * ah);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    if (labelsOn) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawEdgeLabels(
        ctx,
        {
          edges: g.edges,
          geomOf,
          view,
          theme,
          styles: labelStyles,
          nodeRects: g.nodes.map((n) => {
            const p = posOf(n.name);
            return {
              x: (p.x - NODE_W / 2) * view.zoom + view.x,
              y: (p.y - NODE_H / 2) * view.zoom + view.y,
              w: NODE_W * view.zoom,
              h: NODE_H * view.zoom,
            };
          }),
          countLabel,
        },
        labelRectsRef.current
      );
      ctx.restore();
    } else {
      labelRectsRef.current.length = 0;
    }

    // Nodes (selected / hovered on top)
    const order = g.nodes.slice().sort((p, q) => {
      const rp = p.name === selectedRef.current ? 2 : p.name === hoverNodeRef.current ? 1 : 0;
      const rq = q.name === selectedRef.current ? 2 : q.name === hoverNodeRef.current ? 1 : 0;
      return rp - rq;
    });
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const n of order) {
      const p = posOf(n.name);
      const isSel = n.name === selectedRef.current;
      const isFocus = n.name === focus;
      ctx.save();
      ctx.globalAlpha = focus !== null && !related.has(n.name) ? 0.2 : 1;
      roundRect(ctx, p.x - NODE_W / 2, p.y - NODE_H / 2, NODE_W, NODE_H, 5);
      ctx.fillStyle = theme.elevated;
      ctx.fill();
      ctx.lineWidth = (isSel || isFocus ? 2 : 1) * px;
      ctx.strokeStyle = isSel || isFocus ? theme.focus : theme.border;
      ctx.setLineDash(n.isUnassigned ? [5 * px, 4 * px] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      const title = n.isUnassigned ? labels.unassigned : n.name;
      ctx.fillStyle = theme.text;
      ctx.font = `700 12px ${MONO}`;
      ctx.fillText(ellipsize(ctx, title, NODE_W - 14), p.x, p.y - 7);
      ctx.fillStyle = theme.muted;
      ctx.font = `11px ${MONO}`;
      ctx.fillText(`TX ${n.txCount} · RX ${n.rxCount}`, p.x, p.y + 9);
      ctx.restore();
    }

    // Legend (screen space, bottom-left)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `11px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const ly = h - 30;
    const rows: Array<{ y: number; color: string; dashed: boolean; label: string }> = [
      { y: ly, color: theme.tx, dashed: false, label: labels.tx },
      { y: ly + 16, color: theme.rx, dashed: true, label: labels.rx },
    ];
    for (const r of rows) {
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(r.dashed ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(12, r.y);
      ctx.lineTo(44, r.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.muted;
      ctx.fillText(r.label, 52, r.y);
    }
  };

  // ── Hit-testing ──────────────────────────────────────────────────────────
  const toWorld = useCallback((sx: number, sy: number): Pt => {
    const v = viewRef.current ?? { x: 0, y: 0, zoom: 1 };
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }, []);

  const hitNode = useCallback(
    (sx: number, sy: number): string | null => {
      const w = toWorld(sx, sy);
      const nodes = dataRef.current.graph.nodes;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const p = posOf(nodes[i].name);
        if (Math.abs(w.x - p.x) <= NODE_W / 2 && Math.abs(w.y - p.y) <= NODE_H / 2) return nodes[i].name;
      }
      return null;
    },
    [posOf, toWorld]
  );

  const hitEdge = useCallback(
    (sx: number, sy: number): GraphEdge | null => {
      const v = viewRef.current;
      if (!v) return null;
      for (const r of labelRectsRef.current) {
        if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
          const hit = dataRef.current.graph.edges.find((e) => e.id === r.id);
          if (hit) return hit;
        }
      }
      const toScr = (p: Pt): Pt => ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y });
      let best: GraphEdge | null = null;
      let bestD = EDGE_HIT_PX;
      for (const e of dataRef.current.graph.edges) {
        const gm = geomOf(e);
        const d = distanceToEdge({ x: sx, y: sy }, toScr(gm.a), toScr(gm.c), toScr(gm.b));
        if (d <= bestD) {
          bestD = d;
          best = e;
        }
      }
      return best;
    },
    [geomOf]
  );

  // ── Lifecycle: resize, theme, wheel ──────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const apply = (): void => {
      const r = wrap.getBoundingClientRect();
      sizeRef.current = { w: Math.floor(r.width), h: Math.floor(r.height) };
      requestDraw();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    const offTheme = subscribeThemeChange(() => {
      themeRef.current = null;
      requestDraw();
    });
    const onWheel = (ev: WheelEvent): void => {
      const v = viewRef.current;
      if (!v) return;
      ev.preventDefault();
      const r = wrap.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      const nz = clamp(v.zoom * Math.exp(-ev.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const k = nz / v.zoom;
      viewRef.current = { zoom: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      setTooltip(null);
      requestDraw();
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      offTheme();
      wrap.removeEventListener('wheel', onWheel);
      if (rafRef.current !== 0) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [graph, circ, pinnedId, showLabels, t, requestDraw]);

  // Drop pin / selection that no longer exists in the model.
  useEffect(() => {
    if (pinnedId !== null && !graph.edges.some((e) => e.id === pinnedId)) setPinnedId(null);
    if (selNode !== null && !graph.nodes.some((n) => n.name === selNode)) {
      selectedRef.current = null;
      setSelNode(null);
    }
  }, [graph, pinnedId, selNode]);

  const clearSelection = useCallback((): void => {
    selectedRef.current = null;
    groupHoverRef.current = null;
    setSelNode(null);
    setPinnedId(null);
    requestDraw();
  }, [requestDraw]);

  const selectNode = useCallback(
    (name: string): void => {
      selectedRef.current = name;
      setSelNode(name);
      setPinnedId(null);
      requestDraw();
    },
    [requestDraw]
  );

  const pinEdge = useCallback(
    (id: string): void => {
      selectedRef.current = null;
      groupHoverRef.current = null;
      setSelNode(null);
      setPinnedId(id);
      requestDraw();
    },
    [requestDraw]
  );

  const setGroupHover = (id: string | null): void => {
    if (groupHoverRef.current === id) return;
    groupHoverRef.current = id;
    requestDraw();
  };

  // ── Pointer handling ─────────────────────────────────────────────────────
  const localPoint = (e: { clientX: number; clientY: number }): Pt => {
    const r = (wrapRef.current ?? document.body).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const setCursor = (c: string): void => {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  };

  const persist = (): void => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, serializeLayout(savedRef.current));
    } catch {
      /* storage full / unavailable: layout stays in memory */
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    rootRef.current?.focus({ preventScroll: true });
    const pt = localPoint(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setTooltip(null);
    const view = viewRef.current;
    if (!view) return;
    const hit = hitNode(pt.x, pt.y);
    if (hit !== null) {
      const w = toWorld(pt.x, pt.y);
      const p = posOf(hit);
      dragRef.current = { kind: 'node', name: hit, sx: pt.x, sy: pt.y, offX: w.x - p.x, offY: w.y - p.y, moved: false };
    } else {
      dragRef.current = { kind: 'pan', sx: pt.x, sy: pt.y, vx: view.x, vy: view.y, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const pt = localPoint(e);
    const d = dragRef.current;
    if (d) {
      if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      if (d.kind === 'node') {
        const w = toWorld(pt.x, pt.y);
        savedRef.current = {
          ...savedRef.current,
          [d.name]: { x: (w.x - d.offX) / WORLD_W, y: (w.y - d.offY) / WORLD_H },
        };
        setCursor('grabbing');
      } else {
        viewRef.current = { zoom: viewRef.current?.zoom ?? 1, x: d.vx + (pt.x - d.sx), y: d.vy + (pt.y - d.sy) };
        setCursor('grabbing');
      }
      requestDraw();
      return;
    }
    const node = hitNode(pt.x, pt.y);
    const edge = node === null ? hitEdge(pt.x, pt.y) : null;
    const edgeId = edge?.id ?? null;
    let dirty = false;
    if (hoverNodeRef.current !== node) {
      hoverNodeRef.current = node;
      dirty = true;
    }
    if (hoverEdgeRef.current !== edgeId) {
      hoverEdgeRef.current = edgeId;
      dirty = true;
    }
    setCursor(node !== null ? 'grab' : edgeId !== null ? 'pointer' : 'default');
    setTooltip((prev) => {
      if (edgeId === null) return prev === null ? prev : null;
      return { edgeId, x: pt.x, y: pt.y };
    });
    if (dirty) requestDraw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    const pt = localPoint(e);
    if (d.kind === 'node') {
      if (d.moved) persist();
      else selectNode(d.name);
    } else if (!d.moved) {
      const edge = hitEdge(pt.x, pt.y);
      if (edge) pinEdge(edge.id);
      else clearSelection();
    }
    setCursor('default');
    requestDraw();
  };

  const onPointerLeave = (): void => {
    if (dragRef.current) return;
    hoverNodeRef.current = null;
    hoverEdgeRef.current = null;
    setTooltip(null);
    requestDraw();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const pt = localPoint(e);
    const hit = hitNode(pt.x, pt.y);
    if (hit !== null && hit !== UNASSIGNED_NODE) onOpenEcuDialog(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && (pinnedId !== null || selNode !== null)) {
      e.stopPropagation();
      clearSelection();
    }
  };

  const resetLayout = (): void => {
    savedRef.current = {};
    if (storageKey) {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }
    fit();
  };

  // ── DOM overlays ─────────────────────────────────────────────────────────
  const nodeLabel = (name: string): string => (name === UNASSIGNED_NODE ? t('nodeGraph.unassigned') : name);
  const edgeById = (id: string | null): GraphEdge | null =>
    id === null ? null : (graph.edges.find((e) => e.id === id) ?? null);
  const tipEdge = edgeById(tooltip?.edgeId ?? null);
  const pinnedEdge = edgeById(pinnedId);

  const rowText = (m: GraphEdge['messages'][number]): string =>
    `${formatHexArbId(m.arbId, m.isExtended)}  ${m.name}  ${t('nodeGraph.row.dlc', { dlc: m.dlc })}  ${
      m.cycleMs === null ? '—' : `${m.cycleMs} ms`
    }  ${t('nodeGraph.row.sig', { count: m.signalNames.length })}`;

  const { w: cw } = sizeRef.current;
  const tipLeft = tooltip ? (tooltip.x + 14 + 380 > cw ? Math.max(4, tooltip.x - 14 - 380) : tooltip.x + 14) : 0;

  const btn =
    'inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink transition-colors hover:border-strong';

  const closeBtn = (
    <button
      type="button"
      aria-label={t('nodeGraph.panel.close')}
      onClick={clearSelection}
      className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[2px] text-muted hover:text-ink"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  const sideNode = selNode === null ? null : (graph.nodes.find((n) => n.name === selNode) ?? null);
  const sideOpen = pinnedEdge !== null || sideNode !== null;
  const reverseEdge = pinnedEdge?.hasReverse
    ? (graph.edges.find((e) => e.from === pinnedEdge.to && e.to === pinnedEdge.from) ?? null)
    : null;

  const renderMessages = (messages: readonly GraphEdgeMessage[]): React.ReactNode => (
    <ul>
      {messages.map((m) => (
        <li key={m.messageKey} className="border-b border-hairline">
          <button
            type="button"
            onClick={() => onOpenMessageDialog(m.messageKey, false)}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-elevated"
          >
            <div className="whitespace-pre font-mono text-[11px] tabular-nums text-ink">
              {`${formatHexArbId(m.arbId, m.isExtended)}  ${m.name}  ${t('nodeGraph.row.dlc', { dlc: m.dlc })}  ${
                m.cycleMs === null ? '—' : `${m.cycleMs} ms`
              }`}
            </div>
            {m.signalNames.length > 0 && (
              <div className="break-words font-mono text-[10px] text-muted">
                {m.signalNames.slice(0, SIDEBAR_SIGNALS_MAX).join(', ')}
                {m.signalNames.length > SIDEBAR_SIGNALS_MAX && (
                  <span className="tabular-nums text-subtle">{` +${m.signalNames.length - SIDEBAR_SIGNALS_MAX}`}</span>
                )}
              </div>
            )}
          </button>
        </li>
      ))}
    </ul>
  );

  const renderSection = (
    title: string,
    groups: ReturnType<typeof nodeTraffic>['incoming'],
    self: string,
    incoming: boolean
  ): React.ReactNode => (
    <section>
      <div className="border-b border-hairline bg-elevated px-3 py-1.5 text-[11px] font-semibold text-muted">{title}</div>
      {groups.map((gr) => (
        <div key={gr.edgeId}>
          <button
            type="button"
            onMouseEnter={() => setGroupHover(gr.edgeId)}
            onMouseLeave={() => setGroupHover(null)}
            onFocus={() => setGroupHover(gr.edgeId)}
            onBlur={() => setGroupHover(null)}
            onClick={() => pinEdge(gr.edgeId)}
            className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-hairline px-3 py-1.5 text-left hover:bg-elevated"
          >
            <span className="truncate font-mono text-xs font-semibold text-focus">
              {incoming
                ? t('nodeGraph.panel.title', { from: nodeLabel(gr.peer), to: nodeLabel(self) })
                : t('nodeGraph.panel.title', { from: nodeLabel(self), to: nodeLabel(gr.peer) })}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
              {t('nodeGraph.side.msgCount', { count: gr.messages.length })}
            </span>
          </button>
          {renderMessages(gr.messages)}
        </div>
      ))}
    </section>
  );

  let sideContent: React.ReactNode = null;
  if (sideNode) {
    const traffic = nodeTraffic(graph, sideNode.name);
    const isReal = !sideNode.isUnassigned;
    sideContent = (
      <>
        <div className="flex items-start justify-between gap-2 border-b border-hairline px-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-xs font-semibold text-ink">{nodeLabel(sideNode.name)}</div>
            <div className="font-mono text-[10px] tabular-nums text-muted">
              {`TX ${sideNode.txCount} · RX ${sideNode.rxCount}`}
            </div>
            {isReal && (
              <button type="button" onClick={() => onOpenEcuDialog(sideNode.name)} className={`${btn} mt-1.5`}>
                {t('nodeGraph.side.openEcu')}
              </button>
            )}
          </div>
          {closeBtn}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {traffic.incoming.length === 0 && traffic.outgoing.length === 0 ? (
            <p className="p-3 text-xs text-muted">{t('nodeGraph.side.none')}</p>
          ) : (
            <>
              {traffic.incoming.length > 0 &&
                renderSection(t('nodeGraph.side.incoming'), traffic.incoming, sideNode.name, true)}
              {traffic.outgoing.length > 0 &&
                renderSection(t('nodeGraph.side.outgoing'), traffic.outgoing, sideNode.name, false)}
            </>
          )}
        </div>
      </>
    );
  } else if (pinnedEdge) {
    sideContent = (
      <>
        <div className="flex items-start justify-between gap-2 border-b border-hairline px-3 py-2">
          <div className="min-w-0">
            <div className="truncate font-mono text-xs font-semibold text-ink">
              {t('nodeGraph.panel.title', { from: nodeLabel(pinnedEdge.from), to: nodeLabel(pinnedEdge.to) })}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] tabular-nums">
              <span className="rounded-[2px] border border-hairline px-1.5 py-0.5 text-muted">
                {`── ${nodeLabel(pinnedEdge.from)} ${t('nodeGraph.legend.tx')}`}
              </span>
              <span className="rounded-[2px] border border-hairline px-1.5 py-0.5 text-muted">
                {`- - ${nodeLabel(pinnedEdge.to)} ${t('nodeGraph.legend.rx')}`}
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] tabular-nums text-muted">
              {t('nodeGraph.side.msgCount', { count: pinnedEdge.messages.length })}
            </div>
            {reverseEdge && (
              <button type="button" onClick={() => pinEdge(reverseEdge.id)} className={`${btn} mt-1.5 tabular-nums`}>
                {t('nodeGraph.side.reverse', { count: reverseEdge.messages.length })}
              </button>
            )}
          </div>
          {closeBtn}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{renderMessages(pinnedEdge.messages)}</div>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-[320px] w-full overflow-hidden bg-canvas select-none focus:outline-none"
    >
    <div ref={wrapRef} className="relative h-full min-w-0 flex-1 overflow-hidden">
      <canvas
        ref={canvasRef}
        aria-label={t('nodeGraph.canvas.aria')}
        role="img"
        className="absolute inset-0 block h-full w-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />

      <div className="absolute left-3 top-3 flex items-center gap-2">
        <button type="button" onClick={resetLayout} className={btn}>
          {t('nodeGraph.resetLayout')}
        </button>
        <button type="button" onClick={fit} className={btn}>
          {t('nodeGraph.fit')}
        </button>
        <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink">
          <input
            type="checkbox"
            checked={includeUnassigned}
            onChange={(e) => setIncludeUnassigned(e.target.checked)}
            className="cursor-pointer"
          />
          <span>{t('nodeGraph.showUnassigned')}</span>
        </label>
        <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={(e) => setShowLabels(e.target.checked)}
            className="cursor-pointer"
          />
          <span>{t('nodeGraph.edgeLabels')}</span>
        </label>
      </div>

      {graph.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted">
          {t('nodeGraph.empty')}
        </div>
      )}

      {tooltip && tipEdge && pinnedId === null && (
        <div
          className="pointer-events-none absolute z-20 max-w-[380px] rounded-[2px] border border-strong bg-elevated px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-ink"
          style={{ left: tipLeft, top: tooltip.y + 14 }}
        >
          <div className="mb-1 font-semibold text-focus">
            {t('nodeGraph.tooltip.header', {
              from: nodeLabel(tipEdge.from),
              to: nodeLabel(tipEdge.to),
              count: tipEdge.messages.length,
            })}
          </div>
          {tipEdge.messages.slice(0, TOOLTIP_MAX_ROWS).map((m) => (
            <div key={m.messageKey} className="whitespace-pre text-muted">
              {rowText(m)}
            </div>
          ))}
          {tipEdge.messages.length > TOOLTIP_MAX_ROWS && (
            <div className="text-subtle">
              {t('nodeGraph.tooltip.more', { count: tipEdge.messages.length - TOOLTIP_MAX_ROWS })}
            </div>
          )}
        </div>
      )}

    </div>
      {sideOpen && (
        <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-hairline bg-panel">
          {sideContent}
        </aside>
      )}
    </div>
  );
};

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}
