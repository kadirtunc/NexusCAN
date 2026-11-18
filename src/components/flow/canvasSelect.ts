/**
 * Pure selection / navigation logic of the flow canvas: screen <-> canvas mapping under zoom / pan, marquee
 * hit-testing, and the Shift / Ctrl(Cmd) modifier semantics for click and marquee selection.
 */
import { isCompactBlock } from './flowTerminals';
import { BLOCK_HEADER_HEIGHT, BLOCK_WIDTH, PILL_HEIGHT, PILL_WIDTH, PORT_SPACING } from './types';
import type { FlowBlock } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Modifiers {
  shift: boolean;
  /** Ctrl or Cmd. */
  ctrl: boolean;
}

/** View transform: screen = canvas * zoom + pan. */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export function screenToCanvas(sx: number, sy: number, v: View): { x: number; y: number } {
  return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
}

/** Normalized rectangle spanned by two corner points (any drag direction). */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

/** Canvas-space size of a block (header + port rows; compact blocks are pills). */
export function blockSize(block: Pick<FlowBlock, 'type' | 'collapsed'>, portRows: number): { w: number; h: number } {
  if (isCompactBlock(block.type)) return { w: PILL_WIDTH, h: PILL_HEIGHT };
  return { w: BLOCK_WIDTH, h: BLOCK_HEADER_HEIGHT + (block.collapsed ? 0 : portRows * PORT_SPACING + 8) };
}

/** Ids of the blocks whose rectangle intersects the marquee (both in canvas coordinates). */
export function marqueeHits(
  blocks: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>,
  marquee: Rect,
): string[] {
  return blocks.filter((b) => rectsIntersect(marquee, { x: b.x, y: b.y, w: b.w, h: b.h })).map((b) => b.id);
}

/** Marquee result: plain = the hits replace the selection, Shift = added, Ctrl / Cmd = toggled. */
export function applyMarquee(current: readonly string[], hits: readonly string[], mods: Modifiers): string[] {
  if (mods.ctrl) {
    const hit = new Set(hits);
    return [...current.filter((id) => !hit.has(id)), ...hits.filter((id) => !current.includes(id))];
  }
  if (mods.shift) return [...current, ...hits.filter((id) => !current.includes(id))];
  return [...hits];
}

/**
 * Click on a block: Ctrl / Cmd toggles it, Shift adds it, a plain click selects it alone - except on a block that
 * is already part of a multi-selection (the press may start a group drag; `collapseOnRelease` tells the caller to
 * narrow the selection to this block when the press ends without a drag).
 */
export function clickSelect(
  current: readonly string[],
  id: string,
  mods: Modifiers,
): { selection: string[]; collapseOnRelease: boolean } {
  const has = current.includes(id);
  if (mods.ctrl) return { selection: has ? current.filter((x) => x !== id) : [...current, id], collapseOnRelease: false };
  if (mods.shift) return { selection: has ? [...current] : [...current, id], collapseOnRelease: false };
  if (has && current.length > 1) return { selection: [...current], collapseOnRelease: true };
  return { selection: [id], collapseOnRelease: false };
}

/** Drag distance (px) below which a press on empty canvas is a click, not a marquee. */
export const MARQUEE_THRESHOLD = 3;
