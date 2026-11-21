import type { TranslationKey } from '../i18n';
import type { GuideInfoItem } from './types';

/**
 * Catalog of the in-app MCP server tools (crates/nexus-mcp). Must match the Rust `#[tool(name = ...)]`
 * registrations one-to-one (compare with `grep -ohE 'name = "[a-z_0-9]+",'` over server.rs + server/*.rs);
 * onboarding.test.ts checks duplicates and translations. `ui_confirm` is the only tool that asks the user a question.
 */
export type McpToolCategoryId = 'workspace' | 'live' | 'trace' | 'db' | 'diag' | 're' | 'runs' | 'ui';

export interface McpToolEntry {
  name: string;
  descKey: TranslationKey;
  badge?: 'readOnly' | 'confirm';
}

export interface McpToolCategory {
  id: McpToolCategoryId;
  headingKey: TranslationKey;
  introKey: TranslationKey;
  tools: readonly McpToolEntry[];
}

const ro = 'readOnly' as const;

function tool(name: string, badge?: McpToolEntry['badge']): McpToolEntry {
  return { name, descKey: `onb.mcp.tool.${name}` as TranslationKey, badge };
}

export const MCP_TOOL_CATALOG: readonly McpToolCategory[] = [
  {
    id: 'workspace',
    headingKey: 'onb.mcp.cat.workspace.h',
    introKey: 'onb.mcp.cat.workspace.intro',
    tools: [tool('project_list', ro), tool('project_get', ro), tool('trace_compare', ro), tool('debug_events_query', ro)],
  },
  {
    id: 'live',
    headingKey: 'onb.mcp.cat.live.h',
    introKey: 'onb.mcp.cat.live.intro',
    tools: [
      tool('app_status', ro),
      tool('device_list', ro),
      tool('driver_probe', ro),
      tool('bus_status', ro),
      tool('live_message_table', ro),
      tool('live_signal_values', ro),
      tool('periodic_tx_list', ro),
      tool('signal_stats', ro),
      tool('live_trace_window', ro),
    ],
  },
  {
    id: 'trace',
    headingKey: 'onb.mcp.cat.trace.h',
    introKey: 'onb.mcp.cat.trace.intro',
    tools: [tool('trace_list', ro), tool('trace_summary', ro), tool('trace_query', ro), tool('trace_signal_series', ro)],
  },
  {
    id: 'db',
    headingKey: 'onb.mcp.cat.db.h',
    introKey: 'onb.mcp.cat.db.intro',
    tools: [
      tool('db_info', ro),
      tool('db_list', ro),
      tool('db_search_signals', ro),
      tool('db_get_message', ro),
      tool('db_get_ecu', ro),
      tool('db_decode_frame', ro),
      tool('db_encode_frame', ro),
      tool('db_diagnostics', ro),
    ],
  },
  {
    id: 'diag',
    headingKey: 'onb.mcp.cat.diag.h',
    introKey: 'onb.mcp.cat.diag.intro',
    tools: [
      tool('diag_session_info', ro),
      tool('diag_conversation', ro),
      tool('diag_isotp_frames', ro),
      tool('diag_passive_discovery', ro),
    ],
  },
  {
    id: 're',
    headingKey: 'onb.mcp.cat.re.h',
    introKey: 'onb.mcp.cat.re.intro',
    tools: [
      tool('re_status', ro),
      tool('re_series', ro),
      tool('re_correlate', ro),
      tool('re_scan_results', ro),
      tool('re_row_detail', ro),
      tool('re_dbc_generate', ro),
    ],
  },
  {
    id: 'runs',
    headingKey: 'onb.mcp.cat.runs.h',
    introKey: 'onb.mcp.cat.runs.intro',
    tools: [tool('run_query', ro), tool('run_latest', ro), tool('flowlib_list', ro), tool('flowlib_get', ro)],
  },
  {
    id: 'ui',
    headingKey: 'onb.mcp.cat.ui.h',
    introKey: 'onb.mcp.cat.ui.intro',
    tools: [
      tool('ui_get_state', ro),
      tool('ui_navigate'),
      tool('ui_select_message'),
      tool('ui_trace_filter'),
      tool('ui_plot_signals'),
      tool('ui_notify'),
      tool('ui_confirm', 'confirm'),
    ],
  },
];

export function mcpToolItems(cat: McpToolCategory): readonly GuideInfoItem[] {
  return cat.tools.map((t) => ({ code: t.name, descKey: t.descKey, badge: t.badge }));
}

export function allMcpToolNames(): string[] {
  return MCP_TOOL_CATALOG.flatMap((c) => c.tools.map((t) => t.name));
}
