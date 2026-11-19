/**
 * R2a time plot (Canvas 2D, no SVG/DOM points). Candidate min/max bands on the left axis, reference on the right
 * axis, markers as dashed vertical lines with labels, hover read-out, wheel zoom, drag pan, double-click = follow live.
 * Time axis: seconds since the capture origin, ascending (oscilloscope: the trace grows from 0 until the span is full,
 * then scrolls). Y axes are stable (`stableAxis`: nice bounds, zero-based by default, shrink hysteresis, manual min/max).
 * Colours come from the app tokens via `reTheme`; redraw happens only on data/size/hover/theme change.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ReMarkerDto, RePoints, ReSeries } from '../../types/re';
import {
  formatSignalValue, nearestIndex, niceTicks, plotRange, stableAxis, timeTicks, formatAxisTime, type AxisState,
} from './reSignalModel';
import { candidateColors, RE_MONO_FONT, useReTheme, withAlpha } from './reTheme';
import { reSignalStore, type ReCandidateEntry } from '../../store/reSignalStore';
import { DIAG_CHECKBOX, DIAG_INPUT } from '../diagnostics/diagUi';

const PAD_L = 62;
const PAD_R = 62;
const PAD_T = 16;
const PAD_B = 22;
const FONT = `10px ${RE_MONO_FONT}`;

export interface ReSeriesCanvasProps {
  series: ReSeries | null;
  candidates: readonly ReCandidateEntry[];
  referenceLabel: string;
  followLive: boolean;
  spanUs: number;
  originUs: number | null;
  view: { t0Us: number; t1Us: number } | null;
  markers: readonly ReMarkerDto[];
}

interface Extent {
  lo: number;
  hi: number;
}

/** Raw data extent inside the visible window (no padding; `stableAxis` snaps it). */
function extentOf(list: readonly RePoints[], tRelLo: number, tRelHi: number): Extent | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of list) {
    for (let i = 0; i < p.tUsRel.length; i += 1) {
      if (p.tUsRel[i] < tRelLo || p.tUsRel[i] > tRelHi) continue;
      if (p.min[i] < lo) lo = p.min[i];
      if (p.max[i] > hi) hi = p.max[i];
    }
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : null;
}

function parseManual(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function AxisField(p: { label: string; value: string; onCommit: (v: string) => void; placeholder: string }): React.ReactElement {
  const [text, setText] = useState(p.value);
  useEffect(() => setText(p.value), [p.value]);
  return (
    <input
      value={text}
      aria-label={p.label}
      title={p.label}
      placeholder={p.placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== p.value && p.onCommit(text)}
      onKeyDown={(e) => e.key === 'Enter' && p.onCommit(text)}
      className={`${DIAG_INPUT} !h-[22px] !w-[58px] !px-1.5 !text-[11px]`}
    />
  );
}

export function ReSeriesCanvas(p: ReSeriesCanvasProps): React.ReactElement {
  const { t } = useI18n();
  const theme = useReTheme();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [normalize, setNormalize] = useState(false);
  const [zeroBased, setZeroBased] = useState(true);
  const [manual, setManual] = useState({ lMin: '', lMax: '', rMin: '', rMax: '' });
  const dragRef = useRef<{ x: number; t0: number; t1: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const axes = useRef<{ key: string; map: Map<string, AxisState> }>({ key: '', map: new Map() });

  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r !== undefined) setSize({ w: Math.max(240, Math.floor(r.width)), h: Math.max(140, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const range = plotRange(p.series, p.followLive, p.spanUs, p.view, p.originUs);
  const colors = useMemo(() => candidateColors(theme), [theme]);
  const refColor = theme.textSecondary;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const { w, h } = size;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bgCanvas;
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;

    const pw = w - PAD_L - PAD_R;
    const ph = h - PAD_T - PAD_B;
    if (range === null || p.series === null) {
      ctx.fillStyle = theme.textMuted;
      ctx.textAlign = 'center';
      ctx.fillText(t('re.plot.empty'), w / 2, h / 2);
      return;
    }
    const [t0, t1] = range;
    const base = p.series.fromUs;
    const span = Math.max(1, t1 - t0);
    const origin = p.originUs ?? p.series.fromUs;
    const xOf = (abs: number): number => PAD_L + ((abs - t0) / span) * pw;
    const rel0 = t0 - base;
    const rel1 = t1 - base;

    const candSeries = p.series.series.filter((e) => e.kind === 'candidate');
    const refSeries = p.series.series.find((e) => e.kind === 'reference') ?? null;

    // stable axes (state kept across redraws; reset when the candidate set changes)
    const axisKey = p.candidates.map((c) => `${c.id}:${c.dto.startBit}:${c.dto.bitLength}:${c.dto.factor}:${c.dto.offset}:${c.dto.valueType}`).join('|');
    if (axes.current.key !== axisKey) axes.current = { key: axisKey, map: new Map() };
    const nowMs = performance.now();
    const axisFor = (id: string, ext: Extent | null, min: string, max: string): Extent | null => {
      if (ext === null) return null;
      const next = stableAxis(axes.current.map.get(id) ?? null, ext.lo, ext.hi, nowMs, {
        zeroBased,
        manualMin: parseManual(min),
        manualMax: parseManual(max),
        ticks: Math.max(2, Math.floor(ph / 40)),
      });
      axes.current.map.set(id, next);
      return next;
    };
    const leftExt = axisFor('L', extentOf(candSeries.map((e) => e.points), rel0, rel1), manual.lMin, manual.lMax);
    const rightExt = refSeries === null ? null : axisFor('R', extentOf([refSeries.points], rel0, rel1), manual.rMin, manual.rMax);

    // time grid + axis (seconds since origin, ascending)
    ctx.lineWidth = 1;
    ctx.fillStyle = theme.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tk of timeTicks(t0, t1, origin, Math.max(2, Math.floor(pw / 90)))) {
      if (tk.frac < 0 || tk.frac > 1) continue;
      const x = Math.round(PAD_L + tk.frac * pw) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(x, PAD_T);
      ctx.lineTo(x, PAD_T + ph);
      ctx.stroke();
      ctx.fillStyle = theme.axis;
      ctx.fillText(tk.label, x, PAD_T + ph + 5);
    }
    const drawYAxis = (ext: Extent | null, side: 'l' | 'r', color: string): void => {
      if (ext === null) return;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.textAlign = side === 'l' ? 'right' : 'left';
      for (const v of niceTicks(ext.lo, ext.hi, Math.max(2, Math.floor(ph / 40)))) {
        const y = Math.round(PAD_T + ph - ((v - ext.lo) / (ext.hi - ext.lo)) * ph) + 0.5;
        if (side === 'l') {
          ctx.strokeStyle = theme.grid;
          ctx.beginPath();
          ctx.moveTo(PAD_L, y);
          ctx.lineTo(PAD_L + pw, y);
          ctx.stroke();
        }
        ctx.fillText(formatSignalValue(v), side === 'l' ? PAD_L - 5 : PAD_L + pw + 5, y);
      }
    };
    if (!normalize) drawYAxis(leftExt, 'l', theme.axis);
    drawYAxis(rightExt, 'r', refColor);
    ctx.strokeStyle = theme.borderStrong;
    ctx.strokeRect(PAD_L + 0.5, PAD_T + 0.5, pw, ph);

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_L, PAD_T, pw, ph);
    ctx.clip();

    const drawSeries = (pts: RePoints, color: string, ext: Extent | null, dash: boolean): void => {
      if (ext === null) return;
      const yOf = (v: number): number => PAD_T + ph - ((v - ext.lo) / (ext.hi - ext.lo)) * ph;
      const n = pts.tUsRel.length;
      ctx.fillStyle = withAlpha(color, 0.2);
      let open = false;
      let startI = 0;
      const closeBand = (endI: number): void => {
        for (let i = endI; i >= startI; i -= 1) ctx.lineTo(xOf(base + pts.tUsRel[i]), yOf(pts.min[i]));
        ctx.closePath();
        ctx.fill();
        open = false;
      };
      for (let i = 0; i < n; i += 1) {
        const ok = !Number.isNaN(pts.min[i]) && !Number.isNaN(pts.max[i]);
        if (!ok) {
          if (open) closeBand(i - 1);
          continue;
        }
        const x = xOf(base + pts.tUsRel[i]);
        if (!open) {
          ctx.beginPath();
          ctx.moveTo(x, yOf(pts.max[i]));
          open = true;
          startI = i;
        } else ctx.lineTo(x, yOf(pts.max[i]));
      }
      if (open) closeBand(n - 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash ? [5, 3] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i += 1) {
        const mid = (pts.min[i] + pts.max[i]) / 2;
        if (Number.isNaN(mid)) {
          pen = false;
          continue;
        }
        const x = xOf(base + pts.tUsRel[i]);
        const y = yOf(mid);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    p.candidates.forEach((c, i) => {
      const e = candSeries.find((s) => s.index === i);
      if (e === undefined) return;
      const ext = normalize ? axisFor(`N${c.id}`, extentOf([e.points], rel0, rel1), '', '') : leftExt;
      drawSeries(e.points, colors[c.slot] ?? theme.textInk, ext, false);
    });
    if (refSeries !== null) drawSeries(refSeries.points, refColor, rightExt, true);

    // markers
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    for (const m of p.markers) {
      if (m.tsUs < t0 || m.tsUs > t1) continue;
      const x = Math.round(xOf(m.tsUs)) + 0.5;
      ctx.strokeStyle = theme.axis;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD_T);
      ctx.lineTo(x, PAD_T + ph);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.textSecondary;
      ctx.fillText(m.label === '' ? `#${m.id}` : `#${m.id} ${m.label}`, x + 3, PAD_T + 2);
    }

    if (hoverX !== null && hoverX >= PAD_L && hoverX <= PAD_L + pw) {
      ctx.strokeStyle = theme.crosshair;
      ctx.beginPath();
      ctx.moveTo(Math.round(hoverX) + 0.5, PAD_T);
      ctx.lineTo(Math.round(hoverX) + 0.5, PAD_T + ph);
      ctx.stroke();
    }
    ctx.restore();

    if (hoverX !== null && hoverX >= PAD_L && hoverX <= PAD_L + pw) {
      const tAbs = t0 + ((hoverX - PAD_L) / pw) * span;
      const tRel = tAbs - base;
      const lines: { color: string; text: string }[] = [{ color: theme.axis, text: `t ${formatAxisTime((tAbs - origin) / 1e6)}` }];
      p.candidates.forEach((c, i) => {
        const e = candSeries.find((s) => s.index === i);
        if (e === undefined) return;
        const k = nearestIndex(e.points.tUsRel, tRel);
        if (k >= 0) lines.push({ color: colors[c.slot] ?? theme.textInk, text: `${formatSignalValue((e.points.min[k] + e.points.max[k]) / 2)} ${c.unit}` });
      });
      if (refSeries !== null) {
        const k = nearestIndex(refSeries.points.tUsRel, tRel);
        if (k >= 0) lines.push({ color: refColor, text: `ref ${formatSignalValue((refSeries.points.min[k] + refSeries.points.max[k]) / 2)}` });
      }
      const bw = 132;
      const bh = lines.length * 13 + 6;
      const bx = hoverX + 10 + bw > PAD_L + pw ? hoverX - 10 - bw : hoverX + 10;
      ctx.fillStyle = theme.bgElevated;
      ctx.fillRect(bx, PAD_T + 4, bw, bh);
      ctx.strokeStyle = theme.borderStrong;
      ctx.strokeRect(bx + 0.5, PAD_T + 4.5, bw, bh);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, bx + 5, PAD_T + 7 + i * 13);
      });
    }
  }, [size, range, p.series, p.candidates, p.markers, p.originUs, hoverX, normalize, zeroBased, manual, theme, colors, refColor, t]);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>): void => {
      const rg = plotRange(p.series, p.followLive, p.spanUs, p.view, p.originUs);
      if (rg === null) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - PAD_L) / Math.max(1, rect.width - PAD_L - PAD_R)));
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const span = rg[1] - rg[0];
      const next = span * factor;
      if (p.followLive) {
        reSignalStore.setSpan(next);
      } else {
        const anchor = rg[0] + span * frac;
        reSignalStore.setView(anchor - next * frac, anchor + next * (1 - frac));
      }
    },
    [p.series, p.followLive, p.spanUs, p.view, p.originUs],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rg = plotRange(p.series, p.followLive, p.spanUs, p.view, p.originUs);
    if (rg === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, t0: rg[0], t1: rg[1] };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const d = dragRef.current;
    if (d === null) {
      setHoverX(e.clientX - rect.left);
      return;
    }
    const dx = e.clientX - d.x;
    if (Math.abs(dx) < 3 && p.followLive) return;
    const dt = -(dx / Math.max(1, rect.width - PAD_L - PAD_R)) * (d.t1 - d.t0);
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      if (reSignalStore.getState().followLive) reSignalStore.setFollow(false);
      reSignalStore.setView(d.t0 + dt, d.t1 + dt);
    });
  };
  const endDrag = (): void => {
    dragRef.current = null;
  };

  useEffect(
    () => () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const field = (label: string, key: keyof typeof manual): React.ReactElement => (
    <AxisField label={label} value={manual[key]} placeholder="auto" onCommit={(v) => setManual({ ...manual, [key]: v })} />
  );

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex items-center gap-3 px-2 py-1 text-[11px] flex-wrap border-b border-hairline bg-elevated">
        {p.candidates.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5 font-mono tabular-nums">
            <span className="inline-block w-3 h-[3px]" style={{ backgroundColor: colors[c.slot] }} />@{c.dto.startBit}+{c.dto.bitLength}
          </span>
        ))}
        {p.series?.series.some((e) => e.kind === 'reference') === true && (
          <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
            <span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: refColor }} />
            {t('re.plot.reference')} {p.referenceLabel}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 text-muted">
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" className={DIAG_CHECKBOX} checked={zeroBased} onChange={(e) => setZeroBased(e.target.checked)} />
            {t('re.plot.zeroBased')}
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" className={DIAG_CHECKBOX} checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
            {t('re.plot.normalize')}
          </label>
          <span className="inline-flex items-center gap-1">
            {t('re.plot.axisL')}
            {field(t('re.plot.min'), 'lMin')}
            {field(t('re.plot.max'), 'lMax')}
          </span>
          <span className="inline-flex items-center gap-1">
            {t('re.plot.axisR')}
            {field(t('re.plot.min'), 'rMin')}
            {field(t('re.plot.max'), 'rMax')}
          </span>
        </span>
        <span className="basis-full text-subtle">{t('re.plot.hint')}</span>
      </div>
      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <canvas
          ref={canvasRef}
          className="absolute left-0 top-0 cursor-crosshair touch-none"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHoverX(null)}
          onDoubleClick={() => reSignalStore.setFollow(true)}
        />
      </div>
    </div>
  );
}
