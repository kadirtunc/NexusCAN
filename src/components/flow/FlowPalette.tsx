import React, { useState, useCallback } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type { BlockDef, BlockCategory } from './types';
import { BLOCK_CATALOG_BY_CATEGORY, PACK_ORDER } from './blockDefs';
import { flowRegistry, useFlowRegistry } from './registry/flowRegistryStore';
import { flowStore } from './FlowStore';
import { categoryAccentColor } from './BlockNode';
import { blockDescription, blockLabel } from './blockText';
import type { BlockPack } from '../../types/flowLibrary';

// ─── Category meta ────────────────────────────────────────────────────────────

interface CatMeta {
  id: BlockCategory;
  labelKey: TranslationKey;
}

const CATEGORIES: CatMeta[] = [
  { id: 'interface', labelKey: 'flowIface.cat.interface' },
  { id: 'core', labelKey: 'diagHmi.flow.cat.core' },
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
        <div className="grid gap-1.5 p-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
          {filtered.map((def) => (
            <BlockChip key={def.type} def={def} />
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Custom blocks (library) ──────────────────────────────────────────────────

/** Library custom blocks: drag (or double-click) inserts a call block pinned to the latest revision. */
const CustomBlocksSection: React.FC<{ open: boolean; onToggle: () => void; search: string }> = ({ open, onToggle, search }) => {
  const { t } = useI18n();
  const { entries } = useFlowRegistry();
  const q = search.toLowerCase();
  const blocks = entries.filter((e) => e.kind === 'nexuscan.block' && !e.deleted && (q === '' || e.name.toLowerCase().includes(q)));
  if (search && blocks.length === 0) return null;
  return (
    <div className="border-b border-hairline">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-8 w-full cursor-pointer select-none items-center gap-2 bg-elevated px-3 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted hover:text-ink"
      >
        <ChevronRight className="h-3 w-3 shrink-0" style={{ transform: open ? 'rotate(90deg)' : 'none' }} aria-hidden="true" />
        <span className="h-2 w-0.5 shrink-0" style={{ backgroundColor: 'var(--status-warn)' }} />
        {t('flowReg.palette.customBlocks')}
        <span className="ml-auto font-normal tabular-nums text-subtle">{blocks.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 p-2">
          {blocks.length === 0 && <div className="text-[11.5px] leading-snug text-subtle">{t('flowReg.palette.noBlocks')}</div>}
          {blocks.map((e) => (
            <button
              key={e.id}
              type="button"
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData('application/nexus-block-type', `call:${e.id}`);
                ev.dataTransfer.effectAllowed = 'copy';
              }}
              onDoubleClick={() => void flowRegistry.insertCall(e.id, 300 + Math.random() * 200, 200 + Math.random() * 200)}
              title={`${e.name} r${e.latestRevision}\n${t('diagHmi.flow.chipHint')}`}
              className="flex w-full cursor-grab select-none items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-2 py-1.5 text-left text-ink hover:border-strong hover:bg-hover active:cursor-grabbing"
              style={{ borderLeftColor: 'var(--status-warn)', borderLeftWidth: 2 }}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{e.name}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">r{e.latestRevision}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── FlowPalette ──────────────────────────────────────────────────────────────

const PACK_LABEL: Record<BlockPack, TranslationKey> = {
  core: 'flowReg.pack.core',
  can: 'flowReg.pack.can',
  uds: 'flowReg.pack.uds',
  kwp: 'flowReg.pack.kwp',
  obd: 'flowReg.pack.obd',
  j1939: 'flowReg.pack.j1939',
  canopen: 'flowReg.pack.canopen',
  xcp: 'flowReg.pack.xcp',
  custom: 'flowReg.pack.custom',
};

export const FlowPalette: React.FC = () => {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const toggle = useCallback((id: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Packs in palette order, each with its non-empty categories.
  const groups = PACK_ORDER.map((pack) => ({
    pack,
    cats: CATEGORIES.map((cat) => ({
      cat,
      blocks: BLOCK_CATALOG_BY_CATEGORY[cat.id].filter((d) => d.hidden !== true && d.pack === pack),
    })).filter((c) => c.blocks.length > 0),
  })).filter((g) => g.cats.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-ink">
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

      {groups.map((g) => (
        <React.Fragment key={g.pack}>
          <div className="border-b border-hairline bg-canvas px-3 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-widest text-subtle">
            {t(PACK_LABEL[g.pack])}
          </div>
          {g.cats.map(({ cat, blocks }) => {
            const id = `${g.pack}:${cat.id}`;
            return (
              <AccordionSection
                key={id}
                meta={cat}
                blocks={blocks}
                open={!closed.has(id) || !!search}
                onToggle={() => toggle(id)}
                search={search}
              />
            );
          })}
        </React.Fragment>
      ))}

      <CustomBlocksSection open={!closed.has('custom') || !!search} onToggle={() => toggle('custom')} search={search} />

      {/* Footer hint */}
      <div className="mt-auto px-3 py-2 text-[11px] text-subtle">{t('diagHmi.flow.paletteHint')}</div>
    </div>
  );
};
