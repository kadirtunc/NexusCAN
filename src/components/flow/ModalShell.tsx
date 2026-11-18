import React from 'react';
import { X } from 'lucide-react';

/** Modal chrome shared by the Flow Editor dialogs. */
export const ModalShell: React.FC<{
  title: string;
  onClose: () => void;
  width: number;
  children: React.ReactNode;
}> = ({ title, onClose, width, children }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ backgroundColor: 'var(--bg-scrim)' }}
    role="dialog"
    aria-modal="true"
  >
    <div
      className="flex max-h-[80vh] w-full flex-col overflow-hidden rounded-[2px] border border-strong bg-surface"
      style={{ maxWidth: width }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline bg-elevated px-3.5">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-ink"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  </div>
);
