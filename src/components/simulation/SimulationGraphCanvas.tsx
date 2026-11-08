'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type {
  SimulationSignalBindingDto,
  SimulationWidgetDto,
} from '../../types/simulation';
import { useDatabaseStore } from '../../store/databaseStore';
import type { SimulationRuntimeBus } from './simulationRuntimeBus';
import {
  ACCENT_HEX_MAP,
  TRACE_PALETTE,
  makeSignalBusKey,
} from './virtualCanPacking';

interface SimulationGraphCanvasProps {
  widget: SimulationWidgetDto;
  runtimeBus: SimulationRuntimeBus;
  isRunMode: boolean;
}

interface TraceReadout {
  key: string;
  signalName: string;
  unit: string;
  color: string;
  decimals: number;
  latestVal: number;
}

export function SimulationGraphCanvas({
  widget,
  runtimeBus,
  isRunMode,
}: SimulationGraphCanvasProps): React.JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverNormXRef = useRef<number | null>(null);

  const theme = useDatabaseStore().theme;

  const allBindings = useMemo<SimulationSignalBindingDto[]>(() => {
    const list: SimulationSignalBindingDto[] = [];
    if (widget.binding) {
      list.push(widget.binding);
    }
    if (widget.config.extraBindings) {
      for (const extra of widget.config.extraBindings) {
        list.push(extra);
      }
    }
    return list;
  }, [widget.binding, widget.config.extraBindings]);

  const timeWindowSec = Math.max(
    1,
    Math.min(300, widget.config.timeWindowSec ?? 15)
  );
  const autoScaleY = widget.config.autoScaleY ?? true;
  const showLegend = widget.config.showLegend ?? true;

  const [readouts, setReadouts] = useState<TraceReadout[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let widthCss = Math.max(120, container.clientWidth || 320);
    let heightCss = Math.max(80, container.clientHeight || 160);

    const syncSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      widthCss = Math.max(120, container.clientWidth || 320);
      heightCss = Math.max(80, container.clientHeight || 160);
      canvas.width = Math.floor(widthCss * dpr);
      canvas.height = Math.floor(heightCss * dpr);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);

    let rafId = 0;
    let tickCount = 0;

    const renderFrame = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafId = window.requestAnimationFrame(renderFrame);
        return;
      }

      const styles = window.getComputedStyle(document.documentElement);
      const bgCanvas =
        styles.getPropertyValue('--bg-canvas').trim() || '#121417';
      const gridColor =
        styles.getPropertyValue('--canvas-grid').trim() ||
        'rgba(139,148,160,0.12)';
      const axisColor =
        styles.getPropertyValue('--canvas-axis').trim() || '#8b94a0';
      const crossColor =
        styles.getPropertyValue('--canvas-crosshair').trim() ||
        'rgba(220,226,234,0.45)';

      const padLeft = 44;
      const padRight = 10;
      const padTop = 8;
      const padBottom = 18;
      const plotW = Math.max(40, widthCss - padLeft - padRight);
      const plotH = Math.max(32, heightCss - padTop - padBottom);

      ctx.clearRect(0, 0, widthCss, heightCss);
      ctx.fillStyle = bgCanvas;
      ctx.fillRect(0, 0, widthCss, heightCss);

      // 1px precision instrument graticule
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 0; gx <= 5; gx += 1) {
        const x = Math.round(padLeft + (plotW * gx) / 5) + 0.5;
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + plotH);
      }
      for (let gy = 0; gy <= 4; gy += 1) {
        const y = Math.round(padTop + (plotH * gy) / 4) + 0.5;
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
      }
      ctx.stroke();

      const nowSec = runtimeBus.getElapsedSec();
      const startSec = nowSec - timeWindowSec;

      // Determine Y-axis bounds
      let yMin = Infinity;
      let yMax = -Infinity;

      if (!autoScaleY) {
        const cfgMin = widget.config.min ?? allBindings[0]?.min ?? 0;
        const cfgMax = widget.config.max ?? allBindings[0]?.max ?? 100;
        yMin = Math.min(cfgMin, cfgMax);
        yMax = Math.max(cfgMin, cfgMax);
        if (Math.abs(yMax - yMin) < 1e-6) {
          yMax = yMin + 1;
        }
      } else {
        for (const b of allBindings) {
          const key = makeSignalBusKey(b.messageKey, b.signalName);
          const hist = runtimeBus.getHistory(key);
          for (const pt of hist) {
            if (pt.tSec < startSec - 0.25) continue;
            if (pt.val < yMin) yMin = pt.val;
            if (pt.val > yMax) yMax = pt.val;
          }
        }
        if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
          yMin = widget.config.min ?? allBindings[0]?.min ?? 0;
          yMax = widget.config.max ?? allBindings[0]?.max ?? 100;
          if (Math.abs(yMax - yMin) < 1e-6) {
            yMax = yMin + 100;
          }
        } else if (Math.abs(yMax - yMin) < 1e-3) {
          const pad = Math.max(1, Math.abs(yMax) * 0.15);
          yMin -= pad;
          yMax += pad;
        } else {
          const pad = (yMax - yMin) * 0.1;
          yMin -= pad;
          yMax += pad;
        }
      }

      const ySpan = Math.max(1e-6, yMax - yMin);

      // Draw Y & X scale labels
      ctx.fillStyle = axisColor;
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      for (let gy = 0; gy <= 2; gy += 1) {
        const y = padTop + (plotH * gy) / 2;
        const v = yMax - (ySpan * gy) / 2;
        const txt =
          Math.abs(v) >= 1000
            ? `${Math.round(v)}`
            : Math.abs(v) >= 10
              ? v.toFixed(1)
              : v.toFixed(2);
        ctx.fillText(txt, padLeft - 4, y + 3);
      }

      ctx.textAlign = 'center';
      ctx.fillText(`-${timeWindowSec}s`, padLeft + 10, padTop + plotH + 13);
      ctx.fillText(
        `-${(timeWindowSec * 0.5).toFixed(1)}s`,
        padLeft + plotW * 0.5,
        padTop + plotH + 13
      );
      ctx.fillText('0.0s', padLeft + plotW - 8, padTop + plotH + 13);

      const hoverNorm = hoverNormXRef.current;
      const hoverSec =
        hoverNorm !== null ? startSec + hoverNorm * timeWindowSec : null;

      const nextReadouts: TraceReadout[] = [];

      allBindings.forEach((b, idx) => {
        const key = makeSignalBusKey(b.messageKey, b.signalName);
        const color =
          idx === 0
            ? b.color || ACCENT_HEX_MAP[widget.accentColor]
            : b.color || TRACE_PALETTE[idx % TRACE_PALETTE.length] || '#2ea043';

        const hist = runtimeBus.getHistory(key);
        const visible = hist.filter((pt) => pt.tSec >= startSec - 0.3);

        const toX = (t: number) =>
          padLeft + Math.max(0, Math.min(1, (t - startSec) / timeWindowSec)) * plotW;
        const toY = (v: number) => {
          const norm = Math.max(0, Math.min(1, (v - yMin) / ySpan));
          return padTop + plotH - norm * plotH;
        };

        if (visible.length >= 2) {
          // Subtle translucent fill under primary trace
          if (idx === 0 && allBindings.length === 1) {
            ctx.fillStyle = `${color}18`;
            ctx.beginPath();
            const firstPt = visible[0]!;
            const lastPt = visible[visible.length - 1]!;
            ctx.moveTo(toX(firstPt.tSec), padTop + plotH);
            for (const pt of visible) {
              ctx.lineTo(toX(pt.tSec), toY(pt.val));
            }
            ctx.lineTo(toX(lastPt.tSec), padTop + plotH);
            ctx.closePath();
            ctx.fill();
          }

          ctx.strokeStyle = color;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          visible.forEach((pt, pIdx) => {
            const px = toX(pt.tSec);
            const py = toY(pt.val);
            if (pIdx === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          });
          ctx.stroke();
        } else {
          // Design/idle flat preview line at current value
          const curVal = runtimeBus.getValue(key, b.min);
          const py = toY(curVal);
          ctx.strokeStyle = `${color}88`;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(padLeft, py);
          ctx.lineTo(padLeft + plotW, py);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        let displayVal = runtimeBus.getValue(key, b.min);
        if (hoverSec !== null && visible.length > 0) {
          let nearest = visible[visible.length - 1]!;
          let minDiff = Math.abs(nearest.tSec - hoverSec);
          for (const pt of visible) {
            const d = Math.abs(pt.tSec - hoverSec);
            if (d < minDiff) {
              minDiff = d;
              nearest = pt;
            }
          }
          displayVal = nearest.val;
          const dx = toX(nearest.tSec);
          const dy = toY(nearest.val);
          ctx.fillStyle = color;
          ctx.fillRect(dx - 2.5, dy - 2.5, 5, 5);
        }

        nextReadouts.push({
          key,
          signalName: b.signalName,
          unit: b.unit,
          color,
          decimals: b.decimals,
          latestVal: displayVal,
        });
      });

      if (hoverNorm !== null) {
        const cx = Math.round(padLeft + hoverNorm * plotW) + 0.5;
        ctx.strokeStyle = crossColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, padTop);
        ctx.lineTo(cx, padTop + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      tickCount += 1;
      if (tickCount === 1 || tickCount % 6 === 0) {
        setReadouts(nextReadouts);
      }

      if (isRunMode) {
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    renderFrame();
    if (isRunMode) {
      rafId = window.requestAnimationFrame(renderFrame);
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [
    allBindings,
    autoScaleY,
    isRunMode,
    runtimeBus,
    theme,
    timeWindowSec,
    widget.accentColor,
    widget.config.max,
    widget.config.min,
  ]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const padLeft = 44;
    const padRight = 10;
    const plotW = Math.max(40, rect.width - padLeft - padRight);
    const relX = e.clientX - rect.left - padLeft;
    hoverNormXRef.current = Math.max(0, Math.min(1, relX / plotW));
  };

  const handleMouseLeave = () => {
    hoverNormXRef.current = null;
  };

  if (allBindings.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas px-3 text-center font-mono text-[11px] uppercase tracking-wider text-subtle">
        {t('simWdg.graph.noSignal')}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {showLegend && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-hairline bg-canvas/70 px-2.5 py-1">
          <div className="flex flex-wrap items-center gap-2.5">
            {(readouts.length > 0
              ? readouts
              : allBindings.map((b, i) => ({
                  key: makeSignalBusKey(b.messageKey, b.signalName),
                  signalName: b.signalName,
                  unit: b.unit,
                  color:
                    b.color ||
                    TRACE_PALETTE[i % TRACE_PALETTE.length] ||
                    '#0e8ac8',
                  decimals: b.decimals,
                  latestVal: runtimeBus.getValue(
                    makeSignalBusKey(b.messageKey, b.signalName),
                    b.min
                  ),
                }))
            ).map((tr) => (
              <div
                key={tr.key}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] tabular-nums"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-[1px]"
                  style={{ backgroundColor: tr.color }}
                  aria-hidden="true"
                />
                <span className="text-muted">{tr.signalName}:</span>
                <span className="font-semibold text-ink">
                  {tr.latestVal.toFixed(tr.decimals)}
                  {tr.unit ? ` ${tr.unit}` : ''}
                </span>
              </div>
            ))}
          </div>
          <span className="font-mono text-[9px] uppercase tracking-wider tabular-nums text-subtle">
            {timeWindowSec}S · {autoScaleY ? t('simWdg.graph.autoY') : t('simWdg.graph.fixedY')}
          </span>
        </div>
      )}

      <div ref={containerRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="block h-full w-full cursor-crosshair"
          aria-label={t('simWdg.graph.ariaLabel', { title: widget.title })}
        />
      </div>
    </div>
  );
}
