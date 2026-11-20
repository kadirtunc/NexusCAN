/** Mirrors the Rust `McpServerStatusDto` (serde camelCase). */
export interface McpServerStatusDto {
  running: boolean;
  port: number | null;
  /** e.g. "http://127.0.0.1:17800/mcp" */
  endpointUrl: string | null;
  /** Bearer token; only present while running. */
  token: string | null;
  connectedClients: number;
  totalCalls: number;
  /** M1: always true. */
  readOnly: boolean;
  lastError: string | null;
  /** True while the frontend UI bridge channel is attached. */
  uiAttached: boolean;
}

/** Request pushed from the MCP server over `cmd_mcp_ui_attach`'s Channel. */
export interface UiRequestDto {
  requestId: number;
  kind: string;
  args: unknown;
}

export type UiView =
  | 'start'
  | 'connections'
  | 'rxtx'
  | 'trace'
  | 'plotter'
  | 'symbols'
  | 'panels'
  | 'diagnostics'
  | 're';

export interface UiSelectedMessage {
  busId: number | null;
  arbId: string;
  name: string | null;
}

export interface UiStateSnapshot {
  activeView: string;
  subTab: string | null;
  selectedMessage: UiSelectedMessage | null;
  plotSignals: string[];
  traceFilterIds: string[] | null;
  activeTraceSession: string | null;
  theme: 'dark' | 'light';
}

export type UiNotifyLevel = 'info' | 'warn' | 'success';

/** One entry of the "recent Claude UI actions" list. */
export interface McpUiActionEntry {
  seq: number;
  atMs: number;
  kind: string;
  summary: string;
  ok: boolean;
}
