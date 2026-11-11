import { useCallback, useEffect, useState, type RefObject } from 'react';

export interface FixedVirtual {
  start: number;
  end: number;
  totalHeight: number;
  onScroll: () => void;
}

/**
 * Fixed-row-height windowing. Only `start`/`end` live in React state, so a scroll event re-renders
 * only when the visible window actually moves to another row.
 */
export function useFixedVirtual(
  containerRef: RefObject<HTMLDivElement | null>,
  count: number,
  rowHeight: number,
  headerHeight: number,
  overscan = 6,
): FixedVirtual {
  const [win, setWin] = useState({ start: 0, end: 0 });

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollTop - headerHeight);
    const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const end = Math.min(count, Math.ceil((top + el.clientHeight) / rowHeight) + overscan);
    setWin((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [containerRef, count, rowHeight, headerHeight, overscan]);

  useEffect(() => {
    measure();
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, containerRef]);

  return { start: win.start, end: Math.min(win.end, count), totalHeight: count * rowHeight, onScroll: measure };
}
