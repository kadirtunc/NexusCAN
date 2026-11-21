import { MCP_TOOL_CATALOG, mcpToolItems } from '../mcpToolCatalog';
import type { GuideInfoSection, GuidePageDef } from '../types';

// Owned by the 'mcp' guide. Opened from the MCP Server panel header (overlay, not a document tab):
// `tab: null`, no tour (no Start Tour button). Tool list is generated from `mcpToolCatalog.ts`.
const toolSections: readonly GuideInfoSection[] = MCP_TOOL_CATALOG.map((cat) => ({
  id: `tools.${cat.id}`,
  headingKey: cat.headingKey,
  bodyKeys: [cat.introKey],
  items: mcpToolItems(cat),
}));

export const guideMcp: GuidePageDef = {
  id: 'mcp',
  tab: null,
  titleKey: 'onb.mcp.title',
  tour: [],
  info: [
    { id: 'about', headingKey: 'onb.mcp.info.about.h', bodyKeys: ['onb.mcp.info.about.b1', 'onb.mcp.info.about.b2'] },
    {
      id: 'connect',
      headingKey: 'onb.mcp.info.connect.h',
      bodyKeys: [
        'onb.mcp.info.connect.b1',
        'onb.mcp.info.connect.b2',
        'onb.mcp.info.connect.b3',
        'onb.mcp.info.connect.b4',
        'onb.mcp.info.connect.b5',
      ],
    },
    {
      id: 'safety',
      headingKey: 'onb.mcp.info.safety.h',
      bodyKeys: ['onb.mcp.info.safety.b1', 'onb.mcp.info.safety.b2', 'onb.mcp.info.safety.b3', 'onb.mcp.info.safety.b4'],
    },
    ...toolSections,
    {
      id: 'examples',
      headingKey: 'onb.mcp.info.examples.h',
      bodyKeys: [
        'onb.mcp.info.examples.b0',
        'onb.mcp.info.examples.b1',
        'onb.mcp.info.examples.b2',
        'onb.mcp.info.examples.b3',
        'onb.mcp.info.examples.b4',
        'onb.mcp.info.examples.b5',
      ],
    },
    {
      id: 'trouble',
      headingKey: 'onb.mcp.info.trouble.h',
      bodyKeys: [
        'onb.mcp.info.trouble.b1',
        'onb.mcp.info.trouble.b2',
        'onb.mcp.info.trouble.b3',
        'onb.mcp.info.trouble.b4',
      ],
    },
  ],
  tips: ['onb.mcp.tip.1', 'onb.mcp.tip.2', 'onb.mcp.tip.3'],
  keepInteractive: [],
};
