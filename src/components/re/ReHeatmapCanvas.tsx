/**
 * RE bit-level toggle heatmap. One row per ID, 8 cells per byte, Canvas 2D only (no per-bit DOM nodes).
 * Rows and columns are virtualized by drawing only the scrolled viewport; redraw is coalesced into one rAF and
 * is triggered only by a new snapshot (`rowsVersion`), selection, filter, scroll or resize.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { isNoisyBit, type ReRowView } from '../../store/reStore';
import { formatByteValue, reLayout, type ReDisplay } from '../../store/reDisplay';
import { bitIsSet, formatArbId, formatByteTriple } from './reModel';
import { heatGlyphLut, heatLut, mix, pickContrast, RE_MONO_FONT, useReTheme } from './reTheme';

const GUTTER_W = 196;

const FONT = `11px ${RE_MONO_FONT}`;
const GLYPH_FONT = `10px ${RE_MONO_FONT}`;
const HEX_FONT = `11px ${RE_MONO_FONT}`;
const IDX_FONT = `9px ${RE_MONO_FONT}`;
const BIT_IDX: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7'];

interface Hover {
  x: number;
  y: number;
  row: ReRowView;
  bit: number;
}

export interface ReHeatmapCanvasProps {
  rows: readonly ReRowView[];
  rowsVersion: number;
  selectedKey: string | null;
  muteNoisy: boolean;
  display: ReDisplay;
  onSelect: (row: ReRowView) => void;
}

export function ReHeatmapCanvas({ rows, rowsVersion, selectedKey, muteNoisy, display, onSelect }: ReHeatmapCanvasProps): React.ReactElement {
  const { t } = useI18n();
  const theme = useReTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const geom = reLayout(display);
  const propsRef = useRef({ rows, selectedKey, muteNoisy, geom, display });
  propsRef.current = { rows, selectedKey, muteNoisy, geom, display };
  const hoverKeyRef = useRef('');
  const [hover, setHover] = useState<Hover | null>(null);

  let maxDlc = 8;
  for (const r of rows) if (r.dlcBytes > maxDlc) maxDlc = r.dlcBytes;
  const contentW = GUTTER_W + maxDlc * geom.byteW + 16;
  const contentH = geom.headerH + rows.length * geom.rowH;

  const draw = useCallback((): void => {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const sc = scrollRef.current;
    if (canvas === null || sc === null) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = themeRef.current;
    const lut = heatLut(th);
    const glyphLut = heatGlyphLut(th);
    const cBg = th.bgCanvas;
    const cConst = mix(th.bgCanvas, th.textSubtle, 0.14);
    const cNeutral = mix(th.bgCanvas, th.textMuted, 0.28);
    const cNoise = mix(th.bgCanvas, th.warn, 0.3);
    const gNoise = pickContrast(cNoise, th.textInk, th.bgCanvas);
    ctx.fillStyle = cBg;
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const { rows: rs, selectedKey: sel, muteNoisy: mute, geom: g, display: dsp } = propsRef.current;
    const { rowH, headerH, pitch, cellW, cellH, byteW, bits, hexLine, cellTop } = g;
    const heatOn = dsp.showHeat;
    const sx = sc.scrollLeft;
    const sy = sc.scrollTop;
    const first = Math.max(0, Math.floor(sy / rowH));
    const last = Math.min(rs.length - 1, Math.ceil((sy + h - headerH) / rowH));

    for (let i = first; i <= last; i += 1) {
      const r = rs[i];
      const y = headerH + i * rowH - sy;
      if (r.key === sel) {
        ctx.fillStyle = th.bgRowSelected;
        ctx.fillRect(0, y, w, rowH);
        ctx.fillStyle = th.focus;
        ctx.fillRect(0, y, 2, rowH);
      } else if ((i & 1) === 1) {
        ctx.fillStyle = th.bgRowAlt;
        ctx.fillRect(0, y, w, rowH);
      }
      const cy = y + cellTop;
      const nBytes = r.dlcBytes;
      const b0 = Math.max(0, Math.floor((sx - 0) / byteW) - 1);
      const b1 = Math.min(nBytes - 1, Math.ceil((sx + w - GUTTER_W) / byteW));
      for (let b = b0; b <= b1; b += 1) {
        const bx = GUTTER_W + b * byteW - sx;
        if (bx + byteW < GUTTER_W || bx > w) continue;
        const constByte = r.constant[b];
        const diffByte = r.diff[b];
        const dataByte = r.data[b];
        for (let k = 7; k >= 0; k -= 1) {
          const bit = b * 8 + k;
          const x = bx + (7 - k) * pitch;
          const heat = r.heat[bit];
          const isConst = ((constByte >> k) & 1) === 1;
          const isDiff = ((diffByte >> k) & 1) === 1;
          const isNoise = !isConst && mute && isNoisyBit(r, bit);
          if (isConst) ctx.fillStyle = cConst;
          else if (isNoise) ctx.fillStyle = cNoise;
          else ctx.fillStyle = heatOn ? lut[heat] : cNeutral;
          ctx.fillRect(x, cy, cellW, cellH);
          if (isDiff) {
            ctx.strokeStyle = th.warn;
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, cy + 1, cellW - 2, cellH - 2);
          }
        }
        if (bits) {
          // Bit glyphs: one font set per byte group; '0' dimmed, '1' full strength.
          ctx.font = GLYPH_FONT;
          ctx.textAlign = 'center';
          for (let k = 7; k >= 0; k -= 1) {
            const bit = b * 8 + k;
            const one = ((dataByte >> k) & 1) === 1;
            if (((constByte >> k) & 1) === 1) ctx.fillStyle = one ? th.textMuted : th.textSubtle;
            else if (mute && isNoisyBit(r, bit)) ctx.fillStyle = gNoise;
            else ctx.fillStyle = heatOn ? glyphLut[r.heat[bit]] : th.textPrimary;
            ctx.globalAlpha = one ? 1 : 0.55;
            ctx.fillText(one ? '1' : '0', bx + (7 - k) * pitch + cellW / 2, cy + cellH / 2 + 0.5);
          }
          ctx.globalAlpha = 1;
          ctx.textAlign = 'left';
          ctx.font = FONT;
        }
        if (hexLine) {
          // Byte value line (hex or dec) under the group.
          ctx.font = HEX_FONT;
          ctx.textAlign = 'center';
          const changed = dataByte !== r.prevData[b];
          ctx.fillStyle = diffByte !== 0 ? th.warn : changed ? th.nominal : th.textPrimary;
          const hx = bx + (8 * pitch - (pitch - cellW)) / 2;
          const hy = y + rowH - 8;
          ctx.fillText(formatByteValue(dataByte, dsp.byteFormat), hx, hy);
          if (changed && diffByte !== 0) {
            ctx.fillStyle = th.nominal;
            ctx.fillRect(hx - 7, hy + 7, 14, 1);
          }
          ctx.textAlign = 'left';
          ctx.font = FONT;
        }
      }
      // sticky gutter
      ctx.fillStyle = r.key === sel ? th.bgRowSelected : i % 2 === 1 ? th.bgRowAlt : cBg;
      ctx.fillRect(0, y, GUTTER_W - 6, rowH);
      ctx.fillStyle = th.textMuted;
      ctx.fillText(`${r.bus}${r.fd ? 'F' : ' '}${r.extended ? 'X' : ' '}`, 6, y + rowH / 2);
      ctx.fillStyle = r.hasDiff ? th.warn : th.textPrimary;
      ctx.fillText(formatArbId(r.arbId, r.extended).padStart(8, ' '), 40, y + rowH / 2);
      ctx.fillStyle = th.textMuted;
      ctx.textAlign = 'right';
      ctx.fillText(String(r.rxCount), GUTTER_W - 12, y + rowH / 2);
      ctx.textAlign = 'left';
    }

    // sticky header
    ctx.fillStyle = th.bgElevated;
    ctx.fillRect(0, 0, w, headerH);
    ctx.fillStyle = th.borderStrong;
    ctx.fillRect(0, headerH - 1, w, 1);
    ctx.fillStyle = th.textMuted;
    const labelY = bits ? 11 : headerH / 2;
    for (let b = 0; b < maxDlc; b += 1) {
      const bx = GUTTER_W + b * byteW - sx;
      if (bx + byteW < GUTTER_W || bx > w) continue;
      ctx.fillText(`B${b}`, bx + 2, labelY);
      if (bits) {
        ctx.font = IDX_FONT;
        ctx.textAlign = 'center';
        for (let k = 7; k >= 0; k -= 1) ctx.fillText(BIT_IDX[k], bx + (7 - k) * pitch + cellW / 2, headerH - 10);
        ctx.textAlign = 'left';
        ctx.font = FONT;
      }
    }
    ctx.fillStyle = th.bgElevated;
    ctx.fillRect(0, 0, GUTTER_W - 6, headerH - 1);
    ctx.fillStyle = th.textMuted;
    ctx.fillText('BUS', 6, headerH / 2);
    ctx.fillText('ID', 40, headerH / 2);
    ctx.textAlign = 'right';
    ctx.fillText('RX', GUTTER_W - 12, headerH / 2);
    ctx.textAlign = 'left';
    ctx.fillStyle = th.borderStrong;
    ctx.fillRect(GUTTER_W - 6, 0, 1, h);
  }, [maxDlc]);


  const schedule = useCallback((): void => {
    if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(draw);
  }, [draw]);

  // Redraw only on new snapshot / selection / filter changes.
  useEffect(() => {
    schedule();
  }, [rowsVersion, rows, selectedKey, muteNoisy, display, schedule, theme]);

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (sc === null) return undefined;
    const measure = (): void => {
      sizeRef.current = { w: sc.clientWidth, h: sc.clientHeight };
      schedule();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => {
      ro.disconnect();
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [schedule]);

  const hit = (clientX: number, clientY: number): Hover | null => {
    const sc = scrollRef.current;
    if (sc === null) return null;
    const { geom: g } = propsRef.current;
    const rect = sc.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (py < g.headerH || px < GUTTER_W) return null;
    const idx = Math.floor((py - g.headerH + sc.scrollTop) / g.rowH);
    const row = propsRef.current.rows[idx];
    if (row === undefined) return null;
    const cx = px - GUTTER_W + sc.scrollLeft;
    const b = Math.floor(cx / g.byteW);
    const within = cx - b * g.byteW;
    if (b < 0 || b >= row.dlcBytes || within >= 8 * g.pitch) return null;
    const k = 7 - Math.floor(within / g.pitch);
    return { x: px, y: py, row, bit: b * 8 + k };
  };

  const onMove = (e: React.MouseEvent): void => {
    const h = hit(e.clientX, e.clientY);
    const key = h === null ? '' : `${h.row.key}#${h.bit}#${h.row.heat[h.bit]}#${h.row.data[h.bit >> 3]}`;
    if (key !== hoverKeyRef.current) {
      hoverKeyRef.current = key;
      setHover(h);
    } else if (h !== null) {
      setHover(h);
    }
  };

  const onClick = (e: React.MouseEvent): void => {
    const sc = scrollRef.current;
    if (sc === null) return;
    const rect = sc.getBoundingClientRect();
    const py = e.clientY - rect.top;
    const { geom: g } = propsRef.current;
    if (py < g.headerH) return;
    const row = propsRef.current.rows[Math.floor((py - g.headerH + sc.scrollTop) / g.rowH)];
    if (row !== undefined) onSelect(row);
  };

  return (
    <div className="relative w-full h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={schedule}
        onMouseMove={onMove}
        onMouseLeave={() => {
          hoverKeyRef.current = '';
          setHover(null);
        }}
        onClick={onClick}
        className="absolute inset-0 overflow-auto bg-canvas"
        role="grid"
        aria-label={t('re.heatmap.aria')}
      >
        <div style={{ width: contentW, height: contentH }} />
        <canvas
          ref={canvasRef}
          className="pointer-events-none"
          style={{ position: 'sticky', top: 0, left: 0, display: 'block', marginTop: -contentH }}
        />
      </div>
      {hover !== null && (
        <div
          className="absolute z-20 pointer-events-none px-2 py-1 border border-strong bg-elevated text-ink text-[11px] font-mono tabular-nums rounded-[2px] whitespace-pre"
          style={{
            left: Math.min(hover.x + 12, Math.max(0, sizeRef.current.w - 220)),
            top: hover.y + 14,
          }}
        >
          {`${formatArbId(hover.row.arbId, hover.row.extended)}  bus ${hover.row.bus}\n`}
          {`${t('re.tip.bit')} ${hover.bit}  (B${hover.bit >> 3}.${hover.bit & 7}) = ${(hover.row.data[hover.bit >> 3] >> (hover.bit & 7)) & 1}\n`}
          {`${t('re.tip.byte')} B${hover.bit >> 3}  ${formatByteTriple(hover.row.data[hover.bit >> 3])}\n`}
          {`${t('re.tip.heat')} ${hover.row.heat[hover.bit]}/255\n`}
          {bitIsSet(hover.row.constant, hover.bit) ? `${t('re.tip.constant')}\n` : ''}
          {bitIsSet(hover.row.diff, hover.bit) ? `${t('re.tip.diff')}\n` : ''}
          {isNoisyBit(hover.row, hover.bit) ? t('re.tip.noisy') : ''}
        </div>
      )}
    </div>
  );
}
