import type { TranslationKey } from '../../../i18n';

export type PortType = 'exec' | 'data' | 'bool' | 'bytes';
export type PortDirection = 'input' | 'output';
export type BlockCategory = 'flow' | 'uds' | 'data' | 'io';
export type BlockStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped' | 'waiting';

export interface PortDef {
  id: string;
  label: string;
  type: PortType;
  direction: PortDirection;
  optional?: boolean;
}

/** Display text: either a verbatim (language-neutral) string or a translation key. */
export interface LocalizedText {
  label?: string;
  labelKey?: TranslationKey;
}

export interface BlockDef {
  type: string;
  /** Verbatim label for language-neutral names (e.g. "Read DID (0x22)"). */
  label?: string;
  labelKey?: TranslationKey;
  category: BlockCategory;
  descriptionKey?: TranslationKey;
  icon: string;
  ports: PortDef[];
  defaultConfig: Record<string, unknown>;
  /** Config defaults that are localized text; resolved with the active locale when a block is created. */
  defaultConfigKeys?: Record<string, TranslationKey>;
  configSchema: ConfigField[];
}

export interface ConfigField extends LocalizedText {
  key: string;
  type: 'text' | 'number' | 'select' | 'hex' | 'textarea' | 'boolean' | 'code';
  options?: Array<{ value: string } & LocalizedText>;
  /** Verbatim placeholder (language-neutral). */
  placeholder?: string;
  placeholderKey?: TranslationKey;
}

export interface FlowBlock {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
  status: BlockStatus;
  statusMessage?: string;
  lastResult?: unknown;
  collapsed: boolean;
}

export interface FlowConnection {
  id: string;
  fromBlockId: string;
  fromPortId: string;
  toBlockId: string;
  toPortId: string;
}

export interface FlowDiagram {
  id: string;
  name: string;
  blocks: FlowBlock[];
  connections: FlowConnection[];
}

export interface FlowTemplate {
  id: string;
  nameKey: TranslationKey;
  descriptionKey: TranslationKey;
  category: string;
  icon: string;
  diagram: Omit<FlowDiagram, 'id' | 'name'>;
}

export interface ConnectingState {
  fromBlockId: string;
  fromPortId: string;
  fromPortType: PortType;
  fromDirection: PortDirection;
  x: number;
  y: number;
  mouseX: number;
  mouseY: number;
}

// Layout constants
export const BLOCK_WIDTH = 200;
export const BLOCK_HEADER_HEIGHT = 36;
export const PORT_SPACING = 24;
export const PORT_START_Y = 44;
export const PORT_RADIUS = 6;
