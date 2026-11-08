import React from 'react';
import { Database } from 'lucide-react';
import { useDatabaseStore } from '../store/databaseStore';
import { useI18n } from '../i18n';

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
  const { t } = useI18n();
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted">
          <Database className="h-3.5 w-3.5" aria-hidden="true" />
          {t('netdb.picker.boundDatabases')}
        </span>
        {selectedIds.length - staleIds.length === 0 ? (
          <span
            className="rounded-[2px] border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase"
            style={{ borderColor: 'var(--status-warn)', color: 'var(--status-warn)' }}
          >
            {t('netdb.picker.notBoundRawHex')}
          </span>
        ) : (
          <span className="font-mono text-[11.5px] tabular-nums text-muted">
            {t('netdb.picker.boundCount', {
              count: selectedIds.length - staleIds.length,
              total: databases.length,
            })}
          </span>
        )}
      </div>

      {databases.length === 0 ? (
        <div className="rounded-[2px] border border-dashed border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
          {t('netdb.picker.noDatabasesInCatalog')}
        </div>
      ) : (
        <div
          className={`overflow-y-auto rounded-[2px] border border-hairline bg-canvas ${
            compact ? 'max-h-32' : 'max-h-48'
          }`}
        >
          {databases.map((db) => {
            const checked = selectedSet.has(db.id);
            return (
              <label
                key={db.id}
                className={`flex items-center gap-2.5 border-b border-hairline px-3 py-2 text-[12px] last:border-b-0 ${
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-hover'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(db.id)}
                  className="h-4 w-4 rounded-[2px] accent-[var(--status-focus)] cursor-pointer"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ink text-[12px]">{db.fileName}</span>
                <span className="rounded-[2px] border border-hairline px-1.5 py-0.5 font-mono text-[11px] uppercase text-muted">
                  {db.format}
                </span>
                <span className="font-mono text-[11.5px] tabular-nums text-muted">
                  {db.schema ? t('netdb.picker.msgCount', { count: db.schema.messages.length }) : '—'}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};
