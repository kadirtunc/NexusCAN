import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';

export interface ContextMenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}

interface MenuRequest {
  x: number;
  y: number;
  anchor: HTMLElement | null;
  items: readonly ContextMenuItem[];
  navigation?: boolean;
}

const OPEN_EVENT = 'nexuscan:context-menu';
const NATIVE_MENU_WINDOW_MS = 8000;
let nativeMenuUntil = 0;

export function nativeContextMenuPending(): boolean {
  return performance.now() < nativeMenuUntil;
}

export function showContextMenu(request: MenuRequest): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: request }));
}

function textField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement
    && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type)) return target;
  return null;
}

export function openContextMenu(
  event: React.MouseEvent<HTMLElement>,
  items: readonly ContextMenuItem[],
): void {
  if (event.defaultPrevented || textField(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  const anchor = event.target instanceof HTMLElement ? event.target : event.currentTarget;
  const rect = anchor.getBoundingClientRect();
  showContextMenu({
    x: event.clientX || rect.left,
    y: event.clientY || rect.bottom,
    anchor,
    items,
  });
}

export function copyMenuText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function ContextMenu(): React.JSX.Element | null {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [nativeHint, setNativeHint] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hintTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const show = (event: Event) => setMenu((event as CustomEvent<MenuRequest>).detail);
    const allowNative = (event: MouseEvent) => {
      if (!nativeContextMenuPending() || !event.isTrusted) return;
      nativeMenuUntil = 0;
      window.clearTimeout(hintTimer.current);
      setNativeHint(false);
      event.stopImmediatePropagation();
    };
    const fallback = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const anchor = event.target instanceof HTMLElement ? event.target : null;
      const field = textField(anchor);
      const selected = field && field.type !== 'password' && field.selectionStart !== null
        ? field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart)
        : window.getSelection()?.toString() ?? '';
      const items: ContextMenuItem[] = [];
      if (selected) items.push({ label: t('debug.console.copy'), run: () => copyMenuText(selected) });
      if (field) items.push({ label: t('context.selectAll'), run: () => { field.focus(); field.select(); } });
      const rect = anchor?.getBoundingClientRect();
      setMenu({
        x: event.clientX || rect?.left || 0,
        y: event.clientY || rect?.bottom || 0,
        anchor,
        items,
      });
    };
    const dismissOutside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const dismiss = () => setMenu(null);
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener('contextmenu', allowNative, true);
    window.addEventListener('contextmenu', fallback);
    window.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      window.removeEventListener('contextmenu', allowNative, true);
      window.removeEventListener('contextmenu', fallback);
      window.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('resize', dismiss);
      window.clearTimeout(hintTimer.current);
    };
  }, [t]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 4))}px`;
    el.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  const close = () => {
    setMenu(null);
    if (menu?.anchor?.isConnected) menu.anchor.focus({ preventScroll: true });
  };

  return createPortal(
    <>
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t(menu.navigation ? 'context.navigate' : 'context.actions')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === 'Tab') {
              setMenu(null);
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
          className="fixed z-[90] min-w-48 max-w-[calc(100vw-8px)] max-h-[calc(100vh-8px)] overflow-auto border border-strong bg-panel p-1 shadow-xl text-[12px]"
        >
          {[...menu.items, {
            label: t('context.native'),
            run: () => {
              nativeMenuUntil = performance.now() + NATIVE_MENU_WINDOW_MS;
              setNativeHint(true);
              window.clearTimeout(hintTimer.current);
              hintTimer.current = window.setTimeout(() => setNativeHint(false), NATIVE_MENU_WINDOW_MS);
            },
          }].map(({ label, run, disabled }, index) => (
            <button
              key={index}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={disabled}
              onClick={() => { close(); run(); }}
              className={`block w-full px-2.5 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--bg-row-hover)] focus:bg-[var(--bg-row-selected)] disabled:opacity-40 ${index === menu.items.length && index > 0 ? 'mt-1 border-t border-strong' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {nativeHint && (
        <div role="status" className="fixed bottom-10 right-3 z-[90] border border-strong bg-panel px-3 py-2 text-[12px] text-[var(--text-primary)] pointer-events-none">
          {t('context.nativeHint')}
        </div>
      )}
    </>,
    document.body,
  );
}
