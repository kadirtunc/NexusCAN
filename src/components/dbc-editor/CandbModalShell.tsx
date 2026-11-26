'use client';

import React, { useEffect } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useDbcStudioI18n } from './i18n/dbcStudio';

export interface CandbModalTabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  alertCount?: number;
}

interface CandbModalShellProps<T extends string = string> {
  title: string;
  badge?: string;
  subtitle?: string;
  maxWidthClass?: string;
  heightClass?: string;
  tabs?: ReadonlyArray<CandbModalTabItem<T>>;
  activeTab?: T;
  onTabChange?: (tab: T) => void;
  backLabel?: string;
  onBack?: () => void;
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

export function CandbModalShell<T extends string = string>({
  title,
  badge,
  subtitle,
  maxWidthClass = 'max-w-5xl',
  heightClass = 'h-[78vh] max-h-[760px]',
  tabs,
  activeTab,
  onTabChange,
  backLabel,
  onBack,
  headerRight,
  footer,
  onClose,
  children,
}: CandbModalShellProps<T>): React.JSX.Element {
  const { t } = useDbcStudioI18n();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-scrim)' }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`flex w-full ${maxWidthClass} ${heightClass} flex-col overflow-hidden rounded-[2px] border border-strong bg-surface`}
      >
        {/* Dialog Title Bar */}
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-elevated px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {onBack && backLabel && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 font-mono text-[10px] font-semibold text-muted transition-colors hover:border-strong hover:text-ink"
              >
                <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                <span>{backLabel}</span>
              </button>
            )}

            {badge && (
              <span className="shrink-0 rounded-[2px] border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-focus">
                {badge}
              </span>
            )}

            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="truncate text-sm font-semibold text-ink">
                {title}
              </h2>
              {subtitle && (
                <span className="hidden truncate font-mono text-[11px] tabular-nums text-muted sm:inline">
                  {subtitle}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {headerRight}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('modal.closeWindowAria')}
              className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[2px] text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* DBC Studio Modal Tab Bar */}
        {tabs && tabs.length > 0 && activeTab && onTabChange && (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-hairline bg-canvas px-4 pt-2">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  className={`relative -mb-px inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-t-[2px] border px-3.5 text-xs font-medium transition-colors ${
                    isActive
                      ? 'border-hairline border-b-surface bg-surface text-focus font-semibold'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  <span>{tab.label}</span>
                  {tab.count !== undefined && (
                    <span className="font-mono text-[10px] tabular-nums text-subtle">
                      ({tab.count})
                    </span>
                  )}
                  {tab.alertCount !== undefined && tab.alertCount > 0 && (
                    <span
                      className="rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-on-accent"
                      style={{ backgroundColor: 'var(--status-critical)' }}
                    >
                      {tab.alertCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Scrollable Content */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline bg-elevated px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
