import React, { useState, useCallback } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import type { BlockDef, BlockCategory } from './types';
import { BLOCK_CATALOG_BY_CATEGORY } from './blockDefs';
import { flowStore } from './FlowStore';
import { categoryAccentColor } from './BlockNode';
import { blockDescription, blockLabel } from './blockText';

// ─── Category meta ────────────────────────────────────────────────────────────

interface CatMeta {
  id: BlockCategory;
  labelKey: TranslationKey;
}

const CATEGORIES: CatMeta[] = [
  { id: 'flow', labelKey: 'diagHmi.flow.cat.flow' },
  { id: 'uds',  labelKey: 'diagHmi.flow.cat.uds' },
  { id: 'data', labelKey: 'diagHmi.flow.cat.data' },
  { id: 'io',   labelKey: 'diagHmi.flow.cat.io' },
];

// ─── Block chip ───────────────────────────────────────────────────────────────

interface BlockChipProps {
  def: BlockDef;
}

const BlockChip: React.FC<BlockChipProps> = ({ def }) => {
  const { t } = useI18n();

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      e.dataTransfer.setData('application/nexus-block-type', def.type);
      e.dataTransfer.effectAllowed = 'copy';
    },
    [def.type],
  );

  const handleDoubleClick = useCallback(() => {
    // Add block to center area
    flowStore.addBlock(def.type, 300 + Math.random() * 200, 200 + Math.random() * 200);
  }, [def.type]);

  return (
    <button
      draggable
      type="button"
      onDragStart={handleDragStart}
      onDoubleClick={handleDoubleClick}
      title={`${blockDescription(def)}\n${t('diagHmi.flow.chipHint')}`}
      style={{ borderLeftColor: categoryAccentColor(def.category), borderLeftWidth: 2 }}
      className="w-full cursor-grab select-none rounded-[2px] border border-hairline bg-canvas px-2 py-1.5 text-left text-ink transition-colors hover:border-strong hover:bg-hover active:cursor-grabbing"
    >
      <span className="block truncate font-mono text-[11.5px]">{blockLabel(def)}</span>
    </button>
  );
};

// ─── Accordion section ────────────────────────────────────────────────────────

interface AccordionSectionProps {
  meta: CatMeta;
  blocks: BlockDef[];
  open: boolean;
  onToggle: () => void;
  search: string;
}

const AccordionSection: React.FC<AccordionSectionProps> = ({ meta, blocks, open, onToggle, search }) => {
  const { t } = useI18n();
  const filtered = search
    ? blocks.filter(
        (b) =>
          blockLabel(b).toLowerCase().includes(search.toLowerCase()) ||
          blockDescription(b).toLowerCase().includes(search.toLowerCase()),
      )
    : blocks;

  if (search && filtered.length === 0) return null;

  return (
    <div className="border-b border-hairline">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-8 w-full cursor-pointer select-none items-center gap-2 bg-elevated px-3 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted hover:text-ink"
      >
        <ChevronRight
          className="h-3 w-3 shrink-0"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden="true"
        />
        <span className="h-2 w-0.5 shrink-0" style={{ backgroundColor: categoryAccentColor(meta.id) }} />
        {t(meta.labelKey)}
        <span className="ml-auto font-normal tabular-nums text-subtle">{filtered.length}</span>
      </button>

      {open && (
        <div className="grid grid-cols-2 gap-1.5 p-2">
          {filtered.map((def) => (
            <BlockChip key={def.type} def={def} />
          ))}
        </div>
      )}
    </div>
  );
};

// ─── FlowPalette ──────────────────────────────────────────────────────────────

export const FlowPalette: React.FC = () => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [openCats, setOpenCats] = useState<Set<BlockCategory>>(
    new Set<BlockCategory>(['flow', 'uds', 'data', 'io']),
  );

  const toggleCat = useCallback((id: BlockCategory) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full w-[220px] shrink-0 flex-col overflow-y-auto border-r border-hairline bg-surface text-ink">
      {/* Search */}
      <div className="sticky top-0 z-10 border-b border-hairline bg-surface p-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('diagHmi.flow.searchBlocks')}
            className="h-[26px] w-full rounded-[2px] border border-hairline bg-canvas pl-6 pr-2 text-[12px] text-ink outline-none placeholder:text-subtle focus:border-focus"
          />
        </div>
      </div>

      {/* Categories */}
      {CATEGORIES.map((cat) => (
        <AccordionSection
          key={cat.id}
          meta={cat}
          blocks={BLOCK_CATALOG_BY_CATEGORY[cat.id]}
          open={openCats.has(cat.id) || !!search}
          onToggle={() => toggleCat(cat.id)}
          search={search}
        />
      ))}

      {/* Footer hint */}
      <div className="mt-auto px-3 py-2 text-[11px] text-subtle">{t('diagHmi.flow.paletteHint')}</div>
    </div>
  );
};
