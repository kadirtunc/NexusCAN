import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface TabStripScrollerProps {
  /** Changes whenever the active tab changes; triggers scroll-into-view. */
  activeKey: string;
  leftTitle: string;
  rightTitle: string;
  children: React.ReactNode;
}

/**
 * Single-row tab strip. Never wraps; when tabs overflow, shows left/right
 * arrow buttons and keeps the element marked `data-tab-active="true"` visible.
 * A single ResizeObserver (rAF-throttled) is bound to the strip container.
 */
export const TabStripScroller: React.FC<TabStripScrollerProps> = ({
  activeKey,
  leftTitle,
  rightTitle,
  children,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const schedule = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    el.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure]);

  // Tab set can change (traces opened/closed): re-measure after every render.
  useEffect(() => {
    measure();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[data-tab-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey]);

  const scrollBy = (dir: -1 | 1): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.6) });
  };

  const arrowCls =
    'h-[26px] w-[22px] mb-1 shrink-0 border flex items-center justify-center rounded-[3px] cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-strong)] bg-[var(--bg-panel)]';

  return (
    <div className="flex items-end h-full min-w-0 flex-1 gap-1">
      {(canLeft || canRight) && (
        <button
          type="button"
          disabled={!canLeft}
          onClick={() => scrollBy(-1)}
          className={`${arrowCls} disabled:opacity-35 disabled:cursor-default`}
          title={leftTitle}
          aria-label={leftTitle}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}
      <div
        ref={ref}
        className="flex flex-nowrap items-end h-full pt-1 gap-1 overflow-x-auto no-scrollbar min-w-0 flex-1"
      >
        {children}
      </div>
      {(canLeft || canRight) && (
        <button
          type="button"
          disabled={!canRight}
          onClick={() => scrollBy(1)}
          className={`${arrowCls} disabled:opacity-35 disabled:cursor-default`}
          title={rightTitle}
          aria-label={rightTitle}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
