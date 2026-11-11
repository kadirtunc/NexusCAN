import React, { useState, useRef, useCallback } from 'react';
import type { FlowBlock, BlockDef, PortType } from './types';
import { BLOCK_WIDTH, BLOCK_HEADER_HEIGHT, PORT_SPACING } from './types';
import { flowStore } from './FlowStore';
import { localizedText } from './blockText';
import { useI18n } from '../../../i18n';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * All colours resolve through the app design tokens (index.css) so the flow
 * editor follows the active `data-theme` without any JS re-read: these values
 * are consumed by DOM/SVG `style` props, where `var(--…)` is live.
 */
export function categoryHeaderBg(_cat: string): string {
  // Category identity is carried by the accent bar + dot; the header surface is uniform.
  return 'var(--bg-elevated)';
}

export function categoryAccentColor(cat: string): string {
  switch (cat) {
    case 'flow': return 'var(--text-secondary)';
    case 'uds':  return 'var(--status-focus)';
    case 'data': return 'var(--status-nominal)';
    case 'io':   return 'var(--status-warn)';
    default:     return 'var(--border-strong)';
  }
}

export function portColor(type: PortType): string {
  switch (type) {
    case 'exec':  return 'var(--text-primary)';
    case 'data':  return 'var(--status-focus)';
    case 'bool':  return 'var(--status-warn)';
    case 'bytes': return 'var(--status-nominal)';
  }
}

/*
 * Single source of truth for the block geometry (unscaled block coords). The HTML node below and
 * the SVG port handles / wires in FlowCanvas both derive from these numbers, so labels and handles
 * cannot drift apart:
 *   [ACCENT_H accent bar][HEADER_INNER_H header][PORT_BODY_PAD][rows × PORT_SPACING][PORT_BODY_PAD]
 *   [status bar (optional)][config summary (optional)]
 * Anything that is shown conditionally (status, summary) lives BELOW the port rows, so it never
 * moves a port. The selection frame is an outline (not a border) so it never shifts the content.
 */
const ACCENT_H       = 2;
const HEADER_INNER_H = BLOCK_HEADER_HEIGHT - ACCENT_H;
const PORT_BODY_PAD  = 4;

/** Y of a port handle relative to block top-left, in block (unscaled) coords. */
export function portRelativeY(portIdx: number): number {
  return BLOCK_HEADER_HEIGHT + PORT_BODY_PAD + portIdx * PORT_SPACING + PORT_SPACING / 2;
}

/** Vertical centre of the header text (collapsed blocks anchor every port here). */
const HEADER_CENTER_Y = ACCENT_H + HEADER_INNER_H / 2;

/** Absolute canvas coordinates of a port handle. */
export function getPortPosition(
  block: FlowBlock,
  portId: string,
  def: BlockDef,
): { x: number; y: number } {
  const inputs  = def.ports.filter((p) => p.direction === 'input');
  const outputs = def.ports.filter((p) => p.direction === 'output');
  const inIdx   = inputs.findIndex((p)  => p.id === portId);
  const outIdx  = outputs.findIndex((p) => p.id === portId);
  if (block.collapsed) {
    // Collapsed: the port rows are hidden, so every handle sits on the header line.
    const x = outIdx >= 0 ? block.x + BLOCK_WIDTH : block.x;
    return { x, y: block.y + HEADER_CENTER_Y };
  }
  if (inIdx >= 0)  return { x: block.x,              y: block.y + portRelativeY(inIdx) };
  if (outIdx >= 0) return { x: block.x + BLOCK_WIDTH, y: block.y + portRelativeY(outIdx) };
  return { x: block.x, y: block.y + HEADER_CENTER_Y };
}

function configSummary(block: FlowBlock, def: BlockDef): string {
  return def.configSchema
    .slice(0, 2)
    .map((f) => {
      const v = block.config[f.key];
      return v !== undefined && v !== '' ? `${localizedText(f)}: ${String(v)}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}

// ─── BlockNode (pure HTML — rendered in a positioned div layer over SVG) ───────

interface BlockNodeProps {
  block:       FlowBlock;
  def:         BlockDef;
  selected:    boolean;
  zoom:        number;
  panX:        number;
  panY:        number;
  onSelect:    (e: React.MouseEvent) => void;
  onDragStart: (e: React.MouseEvent) => void;
}

export const BlockNode: React.FC<BlockNodeProps> = React.memo(
  ({ block, def, selected, zoom, panX, panY, onSelect, onDragStart }) => {
    const { t } = useI18n();
    const [editing,   setEditing]   = useState(false);
    const [editValue, setEditValue] = useState(block.label);
    const inputRef = useRef<HTMLInputElement>(null);

    const inputPorts  = def.ports.filter((p) => p.direction === 'input');
    const outputPorts = def.ports.filter((p) => p.direction === 'output');
    const portRows    = Math.max(inputPorts.length, outputPorts.length);
    const bodyHeight  = block.collapsed ? 0 : portRows * PORT_SPACING + 2 * PORT_BODY_PAD;
    const hasConfig   = !block.collapsed && def.configSchema.length > 0;
    const summary     = hasConfig ? configSummary(block, def) : '';

    const startEdit = useCallback(() => {
      setEditValue(block.label);
      setEditing(true);
      setTimeout(() => inputRef.current?.select(), 10);
    }, [block.label]);

    const commitEdit = useCallback(() => {
      setEditing(false);
      if (editValue.trim()) flowStore.updateBlockLabel(block.id, editValue.trim());
    }, [editValue, block.id]);

    // Status
    let statusDot   = '';
    let statusText  = '';
    let statusAnim  = false;
    if (block.status === 'running') { statusDot = 'var(--status-focus)';    statusText = t('diagHmi.flow.status.running'); statusAnim = true; }
    if (block.status === 'success') { statusDot = 'var(--status-nominal)';  statusText = t('diagHmi.flow.status.ok'); }
    if (block.status === 'error')   { statusDot = 'var(--status-critical)'; statusText = block.statusMessage ?? t('diagHmi.flow.status.error'); }
    if (block.status === 'skipped') { statusDot = 'var(--text-subtle)';     statusText = t('diagHmi.flow.status.skipped'); }
    if (block.status === 'waiting') { statusDot = 'var(--status-warn)';     statusText = t('diagHmi.flow.status.waiting'); statusAnim = true; }
    const showStatus = block.status !== 'idle';

    const accent      = categoryAccentColor(def.category);
    const headerBg    = categoryHeaderBg(def.category);
    const screenX     = block.x * zoom + panX;
    const screenY     = block.y * zoom + panY;
    const borderColor = selected ? 'var(--status-focus)' : 'var(--border-strong)';
    const borderWidth = Math.max(1, selected ? 1.5 * zoom : zoom * 0.8);

    return (
      <div
        style={{
          position:      'absolute',
          left:          screenX,
          top:           screenY,
          width:         BLOCK_WIDTH * zoom,
          transformOrigin: '0 0',
          boxSizing:     'border-box',
          borderRadius:  `${2 * zoom}px`,
          // Outline (painted over the content, takes no layout space): selecting a block or
          // changing zoom must not push the header / port rows away from the SVG handles.
          outline:       `${borderWidth}px solid ${borderColor}`,
          outlineOffset: `${-borderWidth}px`,
          background:    'var(--bg-surface)',
          userSelect:    'none',
          cursor:        'default',
          pointerEvents: 'all',
          overflow:      'hidden',
        }}
        onMouseDown={(e) => { e.stopPropagation(); onSelect(e); onDragStart(e); }}
      >
        {/* ── Accent bar (category color) ── */}
        <div style={{ height: ACCENT_H * zoom, background: accent, opacity: 0.85 }} />

        {/* ── Header ── */}
        <div
          style={{
            boxSizing:   'border-box',
            height:      HEADER_INNER_H * zoom,
            background:  headerBg,
            display:     'flex',
            alignItems:  'center',
            gap:         5 * zoom,
            paddingLeft: 8 * zoom,
            paddingRight: 6 * zoom,
            cursor:      'grab',
            borderBottom: '1px solid var(--border-hairline)',
          }}
          onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}
          onMouseDown={(e) => { e.stopPropagation(); onSelect(e); onDragStart(e); }}
        >
          {/* Category dot */}
          <span style={{ width: 5 * zoom, height: 5 * zoom, borderRadius: '50%', background: accent, flexShrink: 0, opacity: 0.7 }} />

          <span style={{ fontSize: 10.5 * zoom, fontWeight: 600, color: 'var(--text-ink)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>
            {editing ? (
              <input
                ref={inputRef}
                style={{ background: 'transparent', border: 'none', borderBottom: `1px solid ${accent}`, outline: 'none', color: 'var(--text-ink)', fontSize: 10.5 * zoom, width: '100%' }}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false); }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : block.label}
          </span>
          <button
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10 * zoom, lineHeight: 1, padding: `${2 * zoom}px`, flexShrink: 0 }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); flowStore.toggleBlockCollapsed(block.id); }}
          >
            {block.collapsed ? '›' : '⌄'}
          </button>
        </div>

        {/* ── Port label rows (directly under the header: geometry = portRelativeY) ── */}
        {!block.collapsed && (
          <div style={{ boxSizing: 'border-box', display: 'flex', height: bodyHeight * zoom, padding: `${PORT_BODY_PAD * zoom}px 0`, background: 'var(--bg-surface)' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingLeft: 13 * zoom }}>
              {inputPorts.map((p) => (
                <div key={p.id} style={{ height: PORT_SPACING * zoom, display: 'flex', alignItems: 'center' }}>
                  <span className="font-mono" style={{ fontSize: 8.5 * zoom, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', paddingRight: 13 * zoom }}>
              {outputPorts.map((p) => (
                <div key={p.id} style={{ height: PORT_SPACING * zoom, display: 'flex', alignItems: 'center' }}>
                  <span className="font-mono" style={{ fontSize: 8.5 * zoom, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Status bar (below the port rows so it never moves a port) ── */}
        {showStatus && (
          <div style={{ boxSizing: 'border-box', height: 18 * zoom, display: 'flex', alignItems: 'center', gap: 5 * zoom, padding: `0 ${8 * zoom}px`, background: 'var(--bg-canvas)', borderTop: '1px solid var(--border-hairline)' }}>
            <span
              className={statusAnim ? 'nexus-pulse-slow' : undefined}
              style={{ width: 5 * zoom, height: 5 * zoom, borderRadius: '50%', background: statusDot, flexShrink: 0 }}
            />
            <span className="font-mono tabular-nums" style={{ fontSize: 9 * zoom, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.03em' }}>{statusText}</span>
          </div>
        )}

        {/* ── Config summary ── */}
        {summary && (
          <div style={{ height: 20 * zoom, display: 'flex', alignItems: 'center', padding: `0 ${8 * zoom}px`, borderTop: '1px solid var(--border-hairline)', background: 'var(--bg-elevated)' }}>
            <span className="font-mono" style={{ fontSize: 8.5 * zoom, color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
          </div>
        )}
      </div>
    );
  },
);
BlockNode.displayName = 'BlockNode';
