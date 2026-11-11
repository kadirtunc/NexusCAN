import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { DIAG_BTN_SM, DiagEmptyState } from '../diagUi';
import type { DockRow, TrafficOrder, TrafficViewMode } from './trafficModel';
import { EV_COLS, EV_MIN_W, ROW_H, TX_COLS, TX_MIN_W } from './trafficUi';
import { EventRowView, FrameRowView, NoteRowView, TxFrameRowView, TxRowView } from './TrafficRows';
import { useFixedVirtual } from './useFixedVirtual';

const HEADER_H = 24;
const HEADER_CELL = 'truncate px-2 leading-[24px]';

export const TrafficTable: React.FC<{
  rows: readonly DockRow[];
  mode: TrafficViewMode;
  order: TrafficOrder;
  baseUs: number;
  selectedKey: string | null;
  frozen: boolean;
  filtered: boolean;
  onSelect: (key: string) => void;
  onToggle: (txKey: string) => void;
}> = ({ rows, mode, order, baseUs, selectedKey, frozen, filtered, onSelect, onToggle }) => {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const prevFirstKey = useRef<string | null>(null);
  const prevOrder = useRef<TrafficOrder>(order);
  const newestFirst = order === 'newestFirst';
  const [atLatest, setAtLatest] = useState(true);
  const virt = useFixedVirtual(scrollRef, rows.length, ROW_H, HEADER_H);
  const virtScroll = virt.onScroll;

  // Follow the latest edge (top for newestFirst, bottom for oldestFirst) only while the user is
  // parked there and the view is not frozen. When scrolled away in newestFirst, rows prepended at
  // the top shift the content down: compensate scrollTop so the inspected rows stay put.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const orderChanged = prevOrder.current !== order;
    prevOrder.current = order;
    if (orderChanged) stick.current = true;
    const firstKey = rows.length > 0 ? rows[0].key : null;
    const prevKey = prevFirstKey.current;
    prevFirstKey.current = firstKey;
    if (!el) return;
    if (stick.current) {
      if (!frozen || orderChanged) {
        el.scrollTop = newestFirst ? 0 : el.scrollHeight;
        if (orderChanged) setAtLatest(true);
      }
      return;
    }
    if (newestFirst && prevKey !== null && firstKey !== prevKey) {
      let added = -1;
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].key === prevKey) {
          added = i;
          break;
        }
      }
      if (added > 0) el.scrollTop += added * ROW_H;
    }
  }, [rows, frozen, mode, order, newestFirst]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      const latest = newestFirst
        ? el.scrollTop < ROW_H
        : el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 1.5;
      stick.current = latest;
      setAtLatest((prev) => (prev === latest ? prev : latest));
    }
    virtScroll();
  }, [virtScroll, newestFirst]);

  const jumpLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = newestFirst ? 0 : el.scrollHeight;
  }, [newestFirst]);

  const txMode = mode === 'transactions';
  const cols = txMode ? TX_COLS : EV_COLS;
  const minW = txMode ? TX_MIN_W : EV_MIN_W;
  const heads: string[] = txMode
    ? [
        t('diagTraffic.col.time'), t('diagTraffic.col.seq'), t('diagTraffic.col.origin'), t('diagTraffic.col.addr'),
        t('diagTraffic.col.sid'), t('diagTraffic.col.request'), t('diagTraffic.col.response'),
        t('diagTraffic.col.decoded'), t('diagTraffic.col.ms'), t('diagTraffic.col.status'),
      ]
    : [
        t('diagTraffic.col.type'), t('diagTraffic.col.time'), t('diagTraffic.col.seq'), t('diagTraffic.col.origin'),
        t('diagTraffic.col.dir'), t('diagTraffic.col.id'), t('diagTraffic.col.kind'), t('diagTraffic.col.bytes'),
        t('diagTraffic.col.detail'), t('diagTraffic.col.dt'),
      ];

  const visible: React.ReactNode[] = [];
  for (let i = virt.start; i < virt.end; i += 1) {
    const row = rows[i];
    let node: React.ReactNode;
    switch (row.type) {
      case 'tx':
        node = (
          <TxRowView
            tx={row.tx}
            expanded={row.expanded}
            selected={selectedKey === row.key}
            baseUs={baseUs}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        );
        break;
      case 'txFrame':
        node = (
          <TxFrameRowView
            frame={row.frame}
            tx={row.tx}
            dtUs={row.dtUs}
            selected={selectedKey === `t:${row.tx.key}`}
            onSelect={onSelect}
          />
        );
        break;
      case 'note':
        node = <NoteRowView note={row.note} />;
        break;
      case 'event':
        node = (
          <EventRowView item={row.item} tx={row.tx} selected={selectedKey === row.key} baseUs={baseUs} onSelect={onSelect} />
        );
        break;
      case 'frame':
        node = (
          <FrameRowView
            frame={row.frame}
            tx={row.tx}
            unmatched={row.unmatched}
            selected={selectedKey === row.key}
            baseUs={baseUs}
            onSelect={onSelect}
          />
        );
        break;
    }
    visible.push(
      <div key={row.key} className="absolute left-0 right-0" style={{ top: i * ROW_H, height: ROW_H }}>
        {node}
      </div>,
    );
  }

  return (
    <div className="relative min-h-0 min-w-0 flex-1 bg-surface">
      <div ref={scrollRef} onScroll={handleScroll} className="absolute inset-0 overflow-auto [overflow-anchor:none]">
        <div style={{ minWidth: minW }}>
          <div
            className="sticky top-0 z-10 grid select-none border-b border-[color:var(--border-strong)] bg-[var(--bg-header)] font-mono text-[11px] font-semibold uppercase text-muted"
            style={{ gridTemplateColumns: cols, height: HEADER_H }}
          >
            {heads.map((h, i) => (
              <div key={i} className={HEADER_CELL}>
                {h}
              </div>
            ))}
          </div>
          {rows.length === 0 ? (
            <DiagEmptyState title={filtered ? t('diagTraffic.emptyFiltered') : t('diagTraffic.empty')} />
          ) : (
            <div className="relative" style={{ height: virt.totalHeight }}>
              {visible}
            </div>
          )}
        </div>
      </div>
      {!atLatest && !frozen && rows.length > 0 && (
        <button
          type="button"
          onClick={jumpLatest}
          className={`${DIAG_BTN_SM} absolute right-4 !bg-elevated ${newestFirst ? 'top-8' : 'bottom-2'}`}
          title={t('diagTraffic.jumpLatest')}
        >
          {newestFirst ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />}
          {t('diagTraffic.jumpLatest')}
        </button>
      )}
    </div>
  );
};
