/**
 * R2a byte x bit grid with drag-select (canvas). MSB left like BitLayoutMatrix. Intel drag = contiguous range,
 * Motorola drag = DBC sawtooth walk (`dragSelection`). Candidate bits are highlighted with `selectionBits`, a
 * highlight-only helper test-matched to netdb `trace_signal_bits`; values come from the backend series, never from here.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReByteOrder } from '../../types/re';
import type { ReCandidateEntry } from '../../store/reSignalStore';
import { bitIsSet } from './reModel';
import { dragSelection, selectionBits } from './reSignalModel';
import { candidateColors, RE_MONO_FONT, useReTheme } from './reTheme';

const LABEL_W = 34;
const CELL = 24;
const ROW_H = 20;
const HEAD_H = 16;
const W = LABEL_W + 8 * CELL + 4;

export interface ReBitSelectGridProps {
  dlcBytes: number;
  /** bit set = never changed (classifier constant mask) */
  constant: Uint8Array;
  candidates: readonly ReCandidateEntry[];
  activeId: number | null;
  /** byte order used for a drag when no candidate is active */
  defaultOrder: ReByteOrder;
  onSelect: (sel: { startBit: number; bitLength: number }) => void;
}

function cellAt(e: React.PointerEvent<HTMLCanvasElement>, dlcBytes: number): number | null {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left - LABEL_W;
  const y = e.clientY - rect.top - HEAD_H;
  if (x < 0 || y < 0) return null;
  const col = Math.floor(x / CELL);
  const byte = Math.floor(y / ROW_H);
  if (col > 7 || byte >= dlcBytes) return null;
  return byte * 8 + (7 - col);
}

export function ReBitSelectGrid(p: ReBitSelectGridProps): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const theme = useReTheme();
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const active = p.candidates.find((c) => c.id === p.activeId) ?? null;
  const order = active?.dto.byteOrder ?? p.defaultOrder;
  const preview = drag === null ? null : dragSelection(drag.a, drag.b, order);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const h = HEAD_H + p.dlcBytes * ROW_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = candidateColors(theme);
    ctx.fillStyle = theme.bgCanvas;
    ctx.fillRect(0, 0, W, h);
    ctx.font = `10px ${RE_MONO_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.textMuted;
    ctx.textAlign = 'center';
    for (let k = 7; k >= 0; k -= 1) ctx.fillText(String(k), LABEL_W + (7 - k) * CELL + CELL / 2, HEAD_H / 2);

    const total = p.dlcBytes * 8;
    const owner = new Int8Array(total).fill(-1);
    const startAt = new Int8Array(total).fill(-1);
    p.candidates.forEach((c, i) => {
      const bits = selectionBits(c.dto, total);
      for (const b of bits) owner[b] = i;
      if (bits.length > 0) startAt[bits[0]] = i;
    });
    const pv = preview === null ? null : new Set(selectionBits({ ...preview, byteOrder: order }, total));

    for (let b = 0; b < p.dlcBytes; b += 1) {
      const y = HEAD_H + b * ROW_H;
      ctx.textAlign = 'left';
      ctx.fillStyle = theme.textMuted;
      ctx.fillText(`B${b}`, 4, y + ROW_H / 2);
      for (let k = 7; k >= 0; k -= 1) {
        const bit = b * 8 + k;
        const x = LABEL_W + (7 - k) * CELL;
        const o = owner[bit];
        const constantBit = bitIsSet(p.constant, bit);
        if (o >= 0) {
          const c = p.candidates[o];
          ctx.globalAlpha = c.id === p.activeId ? 0.85 : 0.5;
          ctx.fillStyle = colors[c.slot] ?? theme.textInk;
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = constantBit ? theme.bgSurface : theme.bgElevated;
        }
        ctx.fillRect(x + 1, y + 1, CELL - 2, ROW_H - 2);
        ctx.globalAlpha = 1;
        if (startAt[bit] >= 0) {
          ctx.fillStyle = theme.bgCanvas;
          ctx.fillRect(x + 3, y + 3, 4, 4);
        }
        if (pv !== null && pv.has(bit)) {
          ctx.strokeStyle = theme.focus;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, CELL - 4, ROW_H - 4);
        }
        if (constantBit && o < 0) {
          ctx.fillStyle = theme.textSubtle;
          ctx.textAlign = 'center';
          ctx.fillText('=', x + CELL / 2, y + ROW_H / 2);
        }
      }
    }
  }, [p.dlcBytes, p.constant, p.candidates, p.activeId, preview, order, theme]);

  return (
    <canvas
      ref={ref}
      className="touch-none cursor-crosshair select-none"
      onPointerDown={(e) => {
        const bit = cellAt(e, p.dlcBytes);
        if (bit === null) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ a: bit, b: bit });
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const bit = cellAt(e, p.dlcBytes);
        if (bit !== null && bit !== drag.b) setDrag({ a: drag.a, b: bit });
      }}
      onPointerUp={() => {
        if (drag !== null && preview !== null) p.onSelect(preview);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}
