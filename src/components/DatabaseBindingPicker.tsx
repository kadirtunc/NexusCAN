import React from 'react';
import { Database } from 'lucide-react';
import { useDatabaseStore } from '../store/databaseStore';

interface DatabaseBindingPickerProps {
  selectedIds: readonly string[];
  onChange: (nextIds: string[]) => void;
  disabled?: boolean;
  compact?: boolean;
}

/**
 * Multi-select (0..N) picker binding catalog `.dbc` / `.kcd` databases to a connection profile.
 * There is no global "active" database: each bus decodes only with the databases ticked here.
 */
export const DatabaseBindingPicker: React.FC<DatabaseBindingPickerProps> = ({
  selectedIds,
  onChange,
  disabled = false,
  compact = false,
}) => {
  const { databases } = useDatabaseStore();
  const selectedSet = new Set(selectedIds);
  const staleIds = selectedIds.filter((id) => !databases.some((d) => d.id === id));

  const toggle = (id: string): void => {
    if (disabled) return;
    const next = selectedSet.has(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
          <Database className="h-3 w-3" aria-hidden="true" />
          Bağlı Veritabanları (.dbc / .kcd)
        </span>
        {selectedIds.length - staleIds.length === 0 ? (
          <span
            className="rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase"
            style={{ borderColor: 'var(--status-warn)', color: 'var(--status-warn)' }}
          >
            Veritabanı Bağlı Değil (Raw Hex)
          </span>
        ) : (
          <span className="font-mono text-[10px] tabular-nums text-muted">
            {selectedIds.length - staleIds.length} / {databases.length} bağlı
          </span>
        )}
      </div>

      {databases.length === 0 ? (
        <div className="rounded-[2px] border border-dashed border-hairline bg-canvas px-2.5 py-2 text-[11px] text-muted">
          Katalogda veritabanı yok. <span className="font-mono text-ink">Databases</span> sekmesinden
          .dbc / .kcd yükleyin.
        </div>
      ) : (
        <div
          className={`overflow-y-auto rounded-[2px] border border-hairline bg-canvas ${
            compact ? 'max-h-28' : 'max-h-40'
          }`}
        >
          {databases.map((db) => {
            const checked = selectedSet.has(db.id);
            return (
              <label
                key={db.id}
                className={`flex items-center gap-2 border-b border-hairline px-2.5 py-1.5 text-xs last:border-b-0 ${
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-hover'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(db.id)}
                  className="h-3.5 w-3.5 rounded-[2px] accent-[var(--status-focus)]"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{db.fileName}</span>
                <span className="rounded-[2px] border border-hairline px-1 font-mono text-[9px] uppercase text-muted">
                  {db.format}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted">
                  {db.schema ? `${db.schema.messages.length} msg` : '—'}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};
