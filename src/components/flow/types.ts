import type { TranslationKey } from '../../i18n';
import type { BlockPack, FlowVariableDeclV1, WarningLevel } from '../../types/flowLibrary';
import type { DiagProtocol } from '../../types/diagWorkspace';

/** `ecu` carries an ECU record reference (flow interface input `ecu`, `ecu_source` in Phase C). */
export type PortType = 'exec' | 'data' | 'bool' | 'bytes' | 'ecu';
export type PortDirection = 'input' | 'output';
export type BlockCategory = 'core' | 'flow' | 'uds' | 'data' | 'io' | 'interface';
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
  /** Palette pack (diag-workspace-v1 §8): core / can / uds ... */
  pack: BlockPack;
  /** Protocols the block needs; checked against the bound ECU in Phase B2 (not enforced in B1). */
  requires?: DiagProtocol[];
  descriptionKey?: TranslationKey;
  icon: string;
  ports: PortDef[];
  /** Kept only so saved flows can load; not offered in the palette. */
  hidden?: boolean;
  defaultConfig: Record<string, unknown>;
  /** Config defaults that are localized text; resolved with the active locale when a block is created. */
  defaultConfigKeys?: Record<string, TranslationKey>;
  configSchema: ConfigField[];
}

/** Catalog literal before the pack is assigned (`blockDefs.ts` adds `pack` / `requires` per category). */
export type BlockDefSeed = Omit<BlockDef, 'pack' | 'requires'>;

export interface ConfigField extends LocalizedText {
  key: string;
  type: 'text' | 'number' | 'select' | 'hex' | 'textarea' | 'boolean' | 'code'
    /** Select of the flow's declared variables (config value = variable name). */
    | 'variable'
    /** Comma-separated identifier list stored as `string[]` (text_format inputs). */
    | 'namelist';
  options?: Array<{ value: string } & LocalizedText>;
  /** Verbatim placeholder (language-neutral). */
  placeholder?: string;
  placeholderKey?: TranslationKey;
  /**
   * Scalar fields (`text` / `textarea` / `number` / `select` / `hex` / `boolean`) can be bound to an input port
   * (`p:<key>`, flow-interface-v2 §3); `false` opts a field out.
   */
  bindable?: boolean;
  /** Field is shown only while this returns true for the block's current config. */
  visibleWhen?: (config: Record<string, unknown>) => boolean;
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
  /** AI authoring metadata (kept verbatim through load/save; never produced by the editor). */
  ai?: { warningLevel: WarningLevel; reason: string };
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
  /** Frame-scoped variables (diag-workspace-v1 §8.1), reset to `initial` at every run start. */
  variables?: FlowVariableDeclV1[];
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
/** Compact pill geometry (`flow_terminal` / `flow_goto`). */
export const PILL_WIDTH = 140;
export const PILL_HEIGHT = 28;
