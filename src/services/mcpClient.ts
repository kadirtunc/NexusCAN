import type { McpServerStatusDto } from '../types/mcp';
import { invokeCmd } from './ipcClient';

export function apiMcpStart(port: number | null): Promise<McpServerStatusDto> {
  return invokeCmd<McpServerStatusDto>('cmd_mcp_start', { port });
}

export function apiMcpStop(): Promise<McpServerStatusDto> {
  return invokeCmd<McpServerStatusDto>('cmd_mcp_stop');
}

export function apiMcpStatus(): Promise<McpServerStatusDto> {
  return invokeCmd<McpServerStatusDto>('cmd_mcp_status');
}
