import type { BlockDef, BlockDefSeed, BlockCategory, ConfigField, FlowBlock, PortDef, PortType } from './types';
import type { BlockPack } from '../../types/flowLibrary';
import type { DiagProtocol } from '../../types/diagWorkspace';
import { formatInputs } from './coreRuntime';
import { callIndex, isCallType, readCallRef, refKey } from './callIndex';
import { callPorts, CALL_ERROR, CALL_IN } from './callPorts';
import {
  FLOW_IN, FLOW_OUT, FLOW_RETURN, FLOW_START, LEGACY_END, LEGACY_FLOW_INPUT, LEGACY_FLOW_OUTPUT, LEGACY_START,
  VALUE_PORT, interfacePorts, interfacePortsKey,
} from './flowPorts';

// ─── CORE CATEGORY (diag-workspace-v1 §8.1) ───────────────────────────────────

const MATH_SYMBOLS: Array<[string, string]> = [
  ['add', '+'], ['sub', '−'], ['mul', '×'], ['div', '÷'], ['mod', 'mod'],
  ['min', 'min'], ['max', 'max'], ['abs', 'abs'], ['round', 'round'], ['floor', 'floor'],
];

const coreBlocks: BlockDefSeed[] = [
  {
    type: 'var_get',
    labelKey: 'flowCore.blk.varGet',
    category: 'core',
    descriptionKey: 'flowCore.desc.varGet',
    icon: 'Variable',
    ports: [{ id: 'value', label: 'value', type: 'data', direction: 'output' }],
    defaultConfig: { name: '' },
    configSchema: [{ key: 'name', labelKey: 'flowCore.cfg.varName', type: 'variable' }],
  },
  {
    type: 'var_set',
    labelKey: 'flowCore.blk.varSet',
    category: 'core',
    descriptionKey: 'flowCore.desc.varSet',
    icon: 'Variable',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input', optional: true },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { name: '', mode: 'set', amount: 1 },
    configSchema: [
      { key: 'name', labelKey: 'flowCore.cfg.varName', type: 'variable' },
      {
        key: 'mode',
        labelKey: 'flowCore.cfg.mode',
        type: 'select',
        options: [
          { value: 'set', labelKey: 'flowCore.cfg.modeSet' },
          { value: 'add', labelKey: 'flowCore.cfg.modeAdd' },
          { value: 'sub', labelKey: 'flowCore.cfg.modeSub' },
        ],
      },
      {
        key: 'amount',
        labelKey: 'flowCore.cfg.amount',
        type: 'number',
        placeholder: '1',
        visibleWhen: (c) => c['mode'] === 'add' || c['mode'] === 'sub',
      },
    ],
  },
  {
    type: 'math',
    labelKey: 'flowCore.blk.math',
    category: 'core',
    descriptionKey: 'flowCore.desc.math',
    icon: 'Calculator',
    ports: [
      { id: 'a_in',   label: 'a_in',   type: 'data', direction: 'input' },
      { id: 'b_in',   label: 'b_in',   type: 'data', direction: 'input', optional: true },
      { id: 'result', label: 'result', type: 'data', direction: 'output' },
    ],
    defaultConfig: { op: 'add', b: 1 },
    configSchema: [
      {
        key: 'op',
        labelKey: 'diagBlk.operator',
        type: 'select',
        options: MATH_SYMBOLS.map(([value, label]) => ({ value, label })),
      },
      {
        key: 'b',
        labelKey: 'flowCore.cfg.mathB',
        type: 'number',
        placeholder: '1',
        visibleWhen: (c) => c['op'] !== 'abs' && c['op'] !== 'round' && c['op'] !== 'floor',
      },
    ],
  },
  {
    type: 'logic',
    labelKey: 'flowCore.blk.logic',
    category: 'core',
    descriptionKey: 'flowCore.desc.logic',
    icon: 'GitMerge',
    ports: [
      { id: 'a_in',   label: 'a_in',   type: 'bool', direction: 'input' },
      { id: 'b_in',   label: 'b_in',   type: 'bool', direction: 'input', optional: true },
      { id: 'result', label: 'result', type: 'bool', direction: 'output' },
    ],
    defaultConfig: { op: 'and' },
    configSchema: [
      {
        key: 'op',
        labelKey: 'diagBlk.operator',
        type: 'select',
        options: [
          { value: 'and', label: 'AND' },
          { value: 'or',  label: 'OR' },
          { value: 'xor', label: 'XOR' },
          { value: 'not', label: 'NOT' },
        ],
      },
    ],
  },
  {
    type: 'convert',
    labelKey: 'flowCore.blk.convert',
    category: 'core',
    descriptionKey: 'flowCore.desc.convert',
    icon: 'Shuffle',
    ports: [
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input' },
      { id: 'value',    label: 'value',    type: 'data', direction: 'output' },
    ],
    defaultConfig: { target: 'number', byteLength: 1, endianness: 'big' },
    configSchema: [
      {
        key: 'target',
        labelKey: 'flowCore.cfg.target',
        type: 'select',
        options: [
          { value: 'number', labelKey: 'flowCore.cfg.tNumber' },
          { value: 'text',   labelKey: 'diagBlk.text' },
          { value: 'hex',    label: 'Hex' },
          { value: 'bytes',  label: 'Bytes' },
        ],
      },
      {
        key: 'byteLength',
        labelKey: 'flowCore.cfg.byteLength',
        type: 'number',
        placeholder: '1',
        visibleWhen: (c) => c['target'] === 'bytes',
      },
      {
        key: 'endianness',
        labelKey: 'flowCore.cfg.endianness',
        type: 'select',
        options: [
          { value: 'big',    labelKey: 'flowCore.cfg.big' },
          { value: 'little', labelKey: 'flowCore.cfg.little' },
        ],
        visibleWhen: (c) => c['target'] === 'bytes' || c['target'] === 'number',
      },
    ],
  },
  {
    type: 'text_format',
    labelKey: 'flowCore.blk.textFormat',
    category: 'core',
    descriptionKey: 'flowCore.desc.textFormat',
    icon: 'Type',
    ports: [{ id: 'text_out', label: 'text_out', type: 'data', direction: 'output' }],
    defaultConfig: { template: '', inputs: [] },
    configSchema: [
      { key: 'template', labelKey: 'flowCore.cfg.template', type: 'text', placeholder: 'x = {x}, nrc = {nrc}' },
      { key: 'inputs', labelKey: 'flowCore.cfg.inputs', type: 'namelist', placeholder: 'nrc, did' },
    ],
  },
  {
    type: 'flow_for',
    labelKey: 'flowCore.blk.flowFor',
    category: 'core',
    descriptionKey: 'flowCore.desc.flowFor',
    icon: 'Repeat',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'body_out', label: 'body_out', type: 'exec', direction: 'output' },
      { id: 'done_out', label: 'done_out', type: 'exec', direction: 'output' },
      { id: 'index',    label: 'index',    type: 'data', direction: 'output' },
    ],
    defaultConfig: { from: 1, to: 10, step: 1 },
    configSchema: [
      { key: 'from', labelKey: 'flowCore.cfg.from', type: 'number', placeholder: '1' },
      { key: 'to',   labelKey: 'flowCore.cfg.to',   type: 'number', placeholder: '10' },
      { key: 'step', labelKey: 'flowCore.cfg.step', type: 'number', placeholder: '1' },
    ],
  },
  {
    type: 'flow_break',
    labelKey: 'flowCore.blk.flowBreak',
    category: 'core',
    descriptionKey: 'flowCore.desc.flowBreak',
    icon: 'LogOut',
    ports: [{ id: 'exec_in', label: 'exec_in', type: 'exec', direction: 'input' }],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'flow_continue',
    labelKey: 'flowCore.blk.flowContinue',
    category: 'core',
    descriptionKey: 'flowCore.desc.flowContinue',
    icon: 'SkipForward',
    ports: [{ id: 'exec_in', label: 'exec_in', type: 'exec', direction: 'input' }],
    defaultConfig: {},
    configSchema: [],
  },
];

// ─── INTERFACE CATEGORY (flow-interface-v2 §2) ───────────────────────────────

const interfaceBlocks: BlockDefSeed[] = [
  {
    type: FLOW_START,
    labelKey: 'flowIface.blk.start',
    category: 'interface',
    descriptionKey: 'flowIface.desc.start',
    icon: 'Play',
    ports: [{ id: 'start', label: 'start', type: 'exec', direction: 'output' }],
    defaultConfig: {},
    configSchema: [],
  },
  {
    // Pure: its `value` is the frame input `key`. Port type / label derive from the config (`getBlockDefFor`);
    // the spec itself is edited by the dedicated port-spec inspector.
    type: FLOW_IN,
    labelKey: 'flowIface.blk.in',
    category: 'interface',
    descriptionKey: 'flowIface.desc.in',
    icon: 'LogIn',
    ports: [{ id: VALUE_PORT, label: VALUE_PORT, type: 'data', direction: 'output' }],
    defaultConfig: { key: '', label: '', type: 'text', required: false },
    configSchema: [],
  },
  {
    // NOT on the exec path: sampled when the frame ends.
    type: FLOW_OUT,
    labelKey: 'flowIface.blk.out',
    category: 'interface',
    descriptionKey: 'flowIface.desc.out',
    icon: 'LogOut',
    ports: [{ id: VALUE_PORT, label: VALUE_PORT, type: 'data', direction: 'input', optional: true }],
    defaultConfig: { key: '', label: '', type: 'text', required: false },
    configSchema: [],
  },
  {
    type: FLOW_RETURN,
    labelKey: 'flowIface.blk.return',
    category: 'interface',
    descriptionKey: 'flowIface.desc.return',
    icon: 'CornerDownLeft',
    ports: [{ id: 'in', label: 'in', type: 'exec', direction: 'input' }],
    defaultConfig: { name: 'ok', outcome: 'ok' },
    configSchema: [
      { key: 'name', labelKey: 'flowReg.cfg.outputName', type: 'text', placeholder: 'ok', bindable: false },
      {
        key: 'outcome',
        labelKey: 'flowReg.cfg.outcome',
        type: 'select',
        bindable: false,
        options: [
          { value: 'ok', label: 'ok' },
          { value: 'fail', label: 'fail' },
          { value: 'error', label: 'error' },
        ],
      },
    ],
  },
];

// ─── FLOW CATEGORY ────────────────────────────────────────────────────────────

const flowBlocks: BlockDefSeed[] = [
  // v1 interface blocks: not offered in the palette; `migrateAll` rewrites them on load, the defs only keep
  // unmigratable data renderable (flow-interface-v2 §4).
  {
    type: LEGACY_FLOW_INPUT,
    labelKey: 'flowReg.blk.flowInput',
    category: 'flow',
    descriptionKey: 'flowReg.desc.flowInput',
    icon: 'LogIn',
    hidden: true,
    ports: [{ id: 'start', label: 'start', type: 'exec', direction: 'output' }],
    defaultConfig: { inputs: [] },
    configSchema: [],
  },
  {
    type: LEGACY_FLOW_OUTPUT,
    labelKey: 'flowReg.blk.flowOutput',
    category: 'flow',
    descriptionKey: 'flowReg.desc.flowOutput',
    icon: 'LogOut',
    hidden: true,
    ports: [{ id: 'in', label: 'in', type: 'exec', direction: 'input' }],
    defaultConfig: { name: 'ok', outcome: 'ok', outputs: [] },
    configSchema: [],
  },
  {
    type: LEGACY_START,
    labelKey: 'diagBlk.start',
    category: 'flow',
    descriptionKey: 'diagBlk.startsTheFlow',
    icon: 'Play',
    hidden: true,
    ports: [
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: LEGACY_END,
    labelKey: 'diagBlk.end',
    category: 'flow',
    descriptionKey: 'diagBlk.endsTheFlow',
    icon: 'Square',
    hidden: true,
    ports: [
      { id: 'exec_in', label: 'exec_in', type: 'exec', direction: 'input' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'delay',
    labelKey: 'diagBlk.waitMs',
    category: 'flow',
    descriptionKey: 'diagBlk.waitsForTheGivenDuration',
    icon: 'Timer',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { delay_ms: 1000 },
    configSchema: [
      { key: 'delay_ms', labelKey: 'diagBlk.delayMs', type: 'number', placeholder: '1000' },
    ],
  },
  {
    type: 'condition',
    labelKey: 'diagBlk.condition',
    category: 'flow',
    descriptionKey: 'diagBlk.branchesOnABooleanValue',
    icon: 'GitBranch',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'bool_in',   label: 'bool_in',   type: 'bool', direction: 'input' },
      { id: 'true_out',  label: 'true_out',  type: 'exec', direction: 'output' },
      { id: 'false_out', label: 'false_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'loop',
    labelKey: 'diagBlk.loop',
    category: 'flow',
    descriptionKey: 'diagBlk.repeatsTheGivenNumberOfTimes',
    icon: 'RefreshCw',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'body_out', label: 'body_out', type: 'exec', direction: 'output' },
      { id: 'done_out', label: 'done_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { iterations: 3 },
    configSchema: [
      { key: 'iterations', labelKey: 'diagBlk.iterations', type: 'number', placeholder: '3' },
    ],
  },
  {
    type: 'assert',
    labelKey: 'diagBlk.assert',
    category: 'flow',
    descriptionKey: 'diagBlk.validatesAValueTakesTheFail',
    icon: 'CheckCircle',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input' },
      { id: 'pass_out', label: 'pass_out', type: 'exec', direction: 'output' },
      { id: 'fail_out', label: 'fail_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { expected: '', operator: 'eq' },
    configSchema: [
      { key: 'expected', labelKey: 'diagBlk.expectedValue', type: 'text', placeholder: '' },
      {
        key: 'operator',
        labelKey: 'diagBlk.operator',
        type: 'select',
        options: [
          { value: 'eq',       labelKey: 'diagBlk.equal' },
          { value: 'neq',      labelKey: 'diagBlk.notEqual' },
          { value: 'gt',       labelKey: 'diagBlk.greater' },
          { value: 'ge',       label: '≥' },
          { value: 'lt',       labelKey: 'diagBlk.less' },
          { value: 'le',       label: '≤' },
          { value: 'contains', labelKey: 'diagBlk.contains' },
        ],
      },
    ],
  },
  {
    type: 'log',
    labelKey: 'diagBlk.writeToLog',
    category: 'flow',
    descriptionKey: 'diagBlk.writesTheMessageToTheRun',
    icon: 'FileText',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input', optional: true },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { message: '' },
    configSchema: [
      { key: 'message', labelKey: 'diagBlk.message', type: 'text', placeholderKey: 'diagBlk.messageText' },
    ],
  },

  // ── While Loop ───────────────────────────────────────────────────────────────
  {
    type: 'flow_while',
    labelKey: 'diagBlk.whileLoop',
    category: 'flow',
    descriptionKey: 'diagBlk.loopsWhileTheBooleanConditionIs',
    icon: 'IterationCw',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'bool_in',  label: 'bool_in',  type: 'bool', direction: 'input' },
      { id: 'body_out', label: 'body_out', type: 'exec', direction: 'output' },
      { id: 'done_out', label: 'done_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { max_iterations: 10000 },
    configSchema: [
      { key: 'max_iterations', labelKey: 'diagBlk.maxIterationsSafety', type: 'number', placeholder: '10000' },
    ],
  },

  // ── Timeout Guard ────────────────────────────────────────────────────────────
  {
    type: 'flow_timeout_guard',
    labelKey: 'diagBlk.timeoutGuard',
    category: 'flow',
    descriptionKey: 'diagBlk.ifTheEnclosedBlocksDoNot',
    icon: 'Timer',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec', direction: 'input' },
      { id: 'exec_out',    label: 'exec_out',    type: 'exec', direction: 'output' },
      { id: 'timeout_out', label: 'timeout_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { timeout_ms: 5000 },
    configSchema: [
      { key: 'timeout_ms', labelKey: 'diagBlk.timeoutMs', type: 'number', placeholder: '5000' },
    ],
  },

  // ── Terminal / Goto (wireless jump points) ───────────────────────────────────
  {
    type: 'flow_terminal',
    labelKey: 'diagBlk.terminal',
    category: 'flow',
    descriptionKey: 'diagBlk.terminalDesc',
    icon: 'Flag',
    ports: [
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { name: 'TERMINAL', color: 'amber' },
    configSchema: [
      { key: 'name', labelKey: 'diagBlk.terminalName', type: 'text', placeholder: 'SAFE ABORT' },
      {
        key: 'color',
        labelKey: 'diagBlk.terminalColor',
        type: 'select',
        options: [
          { value: 'amber',   labelKey: 'diagBlk.tcol.amber' },
          { value: 'red',     labelKey: 'diagBlk.tcol.red' },
          { value: 'orange',  labelKey: 'diagBlk.tcol.orange' },
          { value: 'cyan',    labelKey: 'diagBlk.tcol.cyan' },
          { value: 'violet',  labelKey: 'diagBlk.tcol.violet' },
          { value: 'emerald', labelKey: 'diagBlk.tcol.emerald' },
        ],
      },
    ],
  },
  {
    type: 'flow_goto',
    labelKey: 'diagBlk.goto',
    category: 'flow',
    descriptionKey: 'diagBlk.gotoDesc',
    icon: 'CornerDownRight',
    ports: [
      { id: 'exec_in', label: 'exec_in', type: 'exec', direction: 'input' },
    ],
    defaultConfig: { target_terminal_id: '' },
    // The target is a dropdown of the diagram's terminals (rendered by FlowInspector, value = block id).
    configSchema: [
      { key: 'target_terminal_id', labelKey: 'diagBlk.gotoTarget', type: 'select' },
    ],
  },
];

// ─── UDS CATEGORY ─────────────────────────────────────────────────────────────

const udsBlocks: BlockDefSeed[] = [
  // ── 0x10 DiagnosticSessionControl ──────────────────────────────────────────
  {
    type: 'uds_session',
    label: 'Session Control (0x10)',
    category: 'uds',
    descriptionKey: 'diagBlk.opensAUDSDiagnosticSessionThe',
    icon: 'Wifi',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec', direction: 'input' },
      { id: 'exec_out',    label: 'exec_out',    type: 'exec', direction: 'output' },
      { id: 'error_out',   label: 'error_out',   type: 'exec', direction: 'output' },
      { id: 'session_out', label: 'session_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { session_type: 'extended' },
    configSchema: [
      {
        key: 'session_type',
        labelKey: 'diagBlk.sessionType',
        type: 'select',
        options: [
          { value: 'default',      label: 'Default (0x01)' },
          { value: 'programming',  label: 'Programming (0x02)' },
          { value: 'extended',     label: 'Extended Diagnostic (0x03)' },
          { value: 'safety',       label: 'Safety System (0x04)' },
        ],
      },
    ],
  },

  // ── 0x11 ECUReset ──────────────────────────────────────────────────────────
  {
    type: 'uds_ecu_reset',
    label: 'ECU Reset (0x11)',
    category: 'uds',
    descriptionKey: 'diagBlk.resetsTheECURequiresAProgramming',
    icon: 'RotateCcw',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { reset_type: 'hardReset' },
    configSchema: [
      {
        key: 'reset_type',
        labelKey: 'diagBlk.resetType',
        type: 'select',
        options: [
          { value: 'hardReset',               label: 'Hard Reset (0x01)' },
          { value: 'keyOffOnReset',           label: 'Key Off/On Reset (0x02)' },
          { value: 'softReset',               label: 'Soft Reset (0x03)' },
          { value: 'enableRapidPowerShutDown',label: 'Rapid Power Shutdown (0x04)' },
        ],
      },
    ],
  },

  // ── 0x14 ClearDiagnosticInformation ────────────────────────────────────────
  {
    type: 'uds_clear_dtc',
    label: 'Clear DTC (0x14)',
    category: 'uds',
    descriptionKey: 'diagBlk.clearsTheGivenDTCGroup0xFFFFFF',
    icon: 'Trash2',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { group: 'FFFFFF' },
    configSchema: [
      { key: 'group', labelKey: 'diagBlk.dtcGroupHex3Bytes', type: 'hex', placeholder: 'FFFFFF' },
    ],
  },

  // ── 0x19 ReadDTCInformation ─────────────────────────────────────────────────
  {
    type: 'uds_read_dtc',
    label: 'Read DTC (0x19)',
    category: 'uds',
    descriptionKey: 'diagBlk.readsFaultCodesTheReadType',
    icon: 'AlertTriangle',
    ports: [
      { id: 'exec_in',      label: 'exec_in',      type: 'exec', direction: 'input' },
      { id: 'exec_out',     label: 'exec_out',     type: 'exec', direction: 'output' },
      { id: 'error_out',    label: 'error_out',    type: 'exec', direction: 'output' },
      { id: 'dtc_list_out', label: 'dtc_list_out', type: 'data', direction: 'output' },
      { id: 'count_out',    label: 'count_out',    type: 'data', direction: 'output' },
    ],
    defaultConfig: { sub_fn: '02', status_mask: 'FF' },
    configSchema: [
      {
        key: 'sub_fn',
        labelKey: 'diagBlk.subFunction',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — reportNumberOfDTCByStatusMask' },
          { value: '02', label: '0x02 — reportDTCByStatusMask' },
          { value: '03', label: '0x03 — reportDTCSnapshotIdentification' },
          { value: '04', label: '0x04 — reportDTCSnapshotRecordByDTCNumber' },
          { value: '05', label: '0x05 — reportDTCStoredDataByRecordNumber' },
          { value: '06', label: '0x06 — reportDTCExtDataRecordByDTCNumber' },
          { value: '07', label: '0x07 — reportNumberOfDTCBySeverityMask' },
          { value: '08', label: '0x08 — reportDTCBySeverityMaskRecord' },
          { value: '09', label: '0x09 — reportSeverityInformationOfDTC' },
          { value: '0A', label: '0x0A — reportSupportedDTC' },
          { value: '0B', label: '0x0B — reportFirstTestFailedDTC' },
          { value: '0C', label: '0x0C — reportFirstConfirmedDTC' },
          { value: '0D', label: '0x0D — reportMostRecentTestFailedDTC' },
          { value: '0E', label: '0x0E — reportMostRecentConfirmedDTC' },
          { value: '0F', label: '0x0F — reportMirrorMemoryDTCByStatusMask' },
          { value: '11', label: '0x11 — reportNumberOfMirrorMemoryDTCByStatusMask' },
          { value: '14', label: '0x14 — reportDTCFaultDetectionCounter' },
          { value: '15', label: '0x15 — reportDTCWithPermanentStatus' },
          { value: '42', label: '0x42 — reportWWHOBDDTCByMaskRecord' },
          { value: '55', label: '0x55 — reportWWHOBDDTCWithPermanentStatus' },
        ],
      },
      { key: 'status_mask', labelKey: 'diagBlk.statusMaskHex', type: 'hex', placeholder: 'FF' },
    ],
  },

  // ── 0x22 ReadDataByIdentifier ───────────────────────────────────────────────
  {
    type: 'uds_read_did',
    label: 'Read DID (0x22)',
    category: 'uds',
    descriptionKey: 'diagBlk.readsADataIdentifierDIDMultiple',
    icon: 'Download',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
      { id: 'data_out',  label: 'data_out',  type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { did: 'F190' },
    configSchema: [
      { key: 'did', label: 'DID (hex, 2 byte)', type: 'hex', placeholder: 'F190' },
    ],
  },

  // ── 0x23 ReadMemoryByAddress ────────────────────────────────────────────────
  {
    type: 'uds_read_memory',
    label: 'Read Memory (0x23)',
    category: 'uds',
    descriptionKey: 'diagBlk.readsDataDirectlyFromAMemory',
    icon: 'Database',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
      { id: 'data_out',  label: 'data_out',  type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00000010' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHexBytes',   type: 'hex', placeholder: '00000010' },
    ],
  },

  // ── 0x27 SecurityAccess ─────────────────────────────────────────────────────
  {
    type: 'uds_security_access',
    label: 'Security Access (0x27)',
    category: 'uds',
    descriptionKey: 'diagBlk.twoStepSecurityAccess1Request',
    icon: 'Lock',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec',  direction: 'input' },
      { id: 'seed_out',    label: 'seed_out',    type: 'bytes', direction: 'output' },
      { id: 'key_in',      label: 'key_in',      type: 'bytes', direction: 'input', optional: true },
      { id: 'success_out', label: 'success_out', type: 'exec',  direction: 'output' },
      { id: 'error_out',   label: 'error_out',   type: 'exec',  direction: 'output' },
    ],
    defaultConfig: {
      access_level: '01',
      algorithm: 'xor_ff',
      constant: '5A3C1E8F',
      script: `// Rhai (sandboxed, runs in the backend). seed: blob, level: int
// Return a blob or an array of ints 0..255
fn calculate_key(seed, level) {
  let key = blob();
  for b in seed { key.push(b ^ 0xFF); }
  key
}`,
    },
    configSchema: [
      {
        key: 'access_level',
        labelKey: 'diagBlk.accessLevelOddSubFnHex',
        type: 'hex',
        placeholder: '01',
      },
      {
        key: 'algorithm',
        labelKey: 'diagBlk.keyAlgorithm',
        type: 'select',
        options: [
          { value: 'xor_ff',       label: 'XOR 0xFF  —  key[i] = seed[i] ^ 0xFF' },
          { value: 'xor_const',    labelKey: 'diagBlk.xorConstantKeySeedXORConstant' },
          { value: 'sum_negate',   label: 'Byte Sum Negate  —  key = ~sum(seed)' },
          { value: 'add_const',    labelKey: 'diagBlk.seedConstantKeySeedConstant' },
          { value: 'right_rotate', label: 'Right Rotate 2  —  key = ROR(seed,2) ^ const' },
          { value: 'crc16',        label: 'CRC-16/IBM  —  key = CRC16(seed)' },
          { value: 'crc32',        label: 'CRC-32  —  key = CRC32(seed)' },
          { value: 'custom',       label: 'Custom Script (Rhai)' },
        ],
      },
      {
        key: 'constant',
        labelKey: 'diagBlk.constantValueForXorConstAdd',
        type: 'hex',
        placeholder: '5A3C1E8F',
      },
      {
        key: 'script',
        labelKey: 'diagBlk.customScriptActiveWhenAlgorithmCustom',
        type: 'code',
        placeholder: 'fn calculate_key(seed, level) { ... }',
      },
    ],
  },

  // ── 0x28 CommunicationControl ───────────────────────────────────────────────
  {
    type: 'uds_comm_control',
    label: 'Comm. Control (0x28)',
    category: 'uds',
    descriptionKey: 'diagBlk.controlsNetworkCommunicationTxRxShould',
    icon: 'Radio',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { control_type: '03', comm_type: '01' },
    configSchema: [
      {
        key: 'control_type',
        labelKey: 'diagBlk.controlType',
        type: 'select',
        options: [
          { value: '00', label: '0x00 — enableRxAndTx' },
          { value: '01', label: '0x01 — enableRxAndDisableTx' },
          { value: '02', label: '0x02 — disableRxAndEnableTx' },
          { value: '03', labelKey: 'diagBlk.0x03DisableRxAndTxBeforeFlashing' },
        ],
      },
      {
        key: 'comm_type',
        labelKey: 'diagBlk.communicationType',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — normalCommunicationMessages' },
          { value: '02', label: '0x02 — nmCommunicationMessages' },
          { value: '03', label: '0x03 — networkManagementCommunicationMessages' },
        ],
      },
    ],
  },

  // ── 0x2E WriteDataByIdentifier ──────────────────────────────────────────────
  {
    type: 'uds_write_did',
    label: 'Write DID (0x2E)',
    category: 'uds',
    descriptionKey: 'diagBlk.writesToADataIdentifierRequires',
    icon: 'Upload',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'data_in',   label: 'data_in',   type: 'bytes', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
    ],
    defaultConfig: { did: 'F190' },
    configSchema: [
      { key: 'did', label: 'DID (hex, 2 byte)', type: 'hex', placeholder: 'F190' },
    ],
  },

  // ── 0x2F InputOutputControlByIdentifier ────────────────────────────────────
  {
    type: 'uds_io_control',
    label: 'IO Control (0x2F)',
    category: 'uds',
    descriptionKey: 'diagBlk.actuatorSensorControlUsedForDiagnostic',
    icon: 'Zap',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
      { id: 'data_out',  label: 'data_out',  type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { did: '3001', io_control: '03', control_value: '00' },
    configSchema: [
      { key: 'did', label: 'Data Identifier (hex)', type: 'hex', placeholder: '3001' },
      {
        key: 'io_control',
        label: 'Control Option',
        type: 'select',
        options: [
          { value: '00', label: '0x00 — returnControlToECU' },
          { value: '01', label: '0x01 — resetToDefault' },
          { value: '02', label: '0x02 — freezeCurrentState' },
          { value: '03', label: '0x03 — shortTermAdjustment' },
        ],
      },
      { key: 'control_value', label: 'Control Value (hex)', type: 'hex', placeholder: '00' },
    ],
  },

  // ── 0x31 RoutineControl ─────────────────────────────────────────────────────
  {
    type: 'uds_routine_ctrl',
    label: 'Routine Control (0x31)',
    category: 'uds',
    descriptionKey: 'diagBlk.routineControlForOperationsSuchAs',
    icon: 'Cpu',
    ports: [
      { id: 'exec_in',    label: 'exec_in',    type: 'exec', direction: 'input' },
      { id: 'option_in',  label: 'option_in',  type: 'data', direction: 'input', optional: true },
      { id: 'exec_out',   label: 'exec_out',   type: 'exec', direction: 'output' },
      { id: 'result_out', label: 'result_out', type: 'data', direction: 'output' },
      { id: 'error_out',  label: 'error_out',  type: 'exec', direction: 'output' },
    ],
    defaultConfig: { control_type: '01', routine_id: 'FF00' },
    configSchema: [
      {
        key: 'control_type',
        labelKey: 'diagBlk.controlType',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — startRoutine' },
          { value: '02', label: '0x02 — stopRoutine' },
          { value: '03', label: '0x03 — requestRoutineResults' },
        ],
      },
      {
        key: 'routine_id',
        labelKey: 'diagBlk.routineIDHex2Bytes',
        type: 'select',
        options: [
          { value: 'FF00', label: '0xFF00 — eraseMemory' },
          { value: 'FF01', label: '0xFF01 — checkProgrammingDependencies' },
          { value: '0202', label: '0x0202 — checkMemory (CRC32, OEM)' },
          { value: '0203', label: '0x0203 — checkProgrammingPreconditions (OEM)' },
          { value: 'DF01', label: '0xDF01 — checkMemoryIntegrity (CRC/Checksum)' },
          { value: 'E200', label: '0xE200 — requestSoftwareUpdate' },
          { value: 'custom', labelKey: 'diagBlk.customEnterInTheFieldBelow' },
        ],
      },
      { key: 'routine_id_custom', labelKey: 'diagBlk.customRoutineIDHex', type: 'hex', placeholder: '0203' },
      { key: 'expect_status', labelKey: 'udsFlow.cfg.expectStatus', type: 'hex', placeholderKey: 'udsFlow.cfg.expectStatusPh' },
    ],
  },

  // ── 0x34 RequestDownload ────────────────────────────────────────────────────
  {
    type: 'uds_req_download',
    label: 'Request Download (0x34)',
    category: 'uds',
    descriptionKey: 'diagBlk.memoryWriteRequestRequiresProgrammingSession',
    icon: 'HardDrive',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
      { id: 'max_block_out', label: 'max_block_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00010000', data_format: '00' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHex',         type: 'hex', placeholder: '00010000' },
      {
        key: 'data_format',
        labelKey: 'diagBlk.dataFormat',
        type: 'select',
        options: [
          { value: '00', labelKey: 'diagBlk.0x00NoCompressionNoEncryption' },
          { value: '11', labelKey: 'diagBlk.0x11CompressedNotEncrypted' },
          { value: '01', labelKey: 'diagBlk.0x01EncryptedOEMDefined' },
        ],
      },
    ],
  },

  // ── 0x35 RequestUpload ──────────────────────────────────────────────────────
  {
    type: 'uds_req_upload',
    label: 'Request Upload (0x35)',
    category: 'uds',
    descriptionKey: 'diagBlk.uploadsReadsDataFromTheECU',
    icon: 'Upload',
    ports: [
      { id: 'exec_in',       label: 'exec_in',       type: 'exec', direction: 'input' },
      { id: 'exec_out',      label: 'exec_out',      type: 'exec', direction: 'output' },
      { id: 'error_out',     label: 'error_out',     type: 'exec', direction: 'output' },
      { id: 'max_block_out', label: 'max_block_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00010000', data_format: '00' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHex',         type: 'hex', placeholder: '00010000' },
      { key: 'data_format',    labelKey: 'diagBlk.dataFormatHex', type: 'hex', placeholder: '00' },
    ],
  },

  // ── 0x36 TransferData ───────────────────────────────────────────────────────
  {
    type: 'uds_transfer_data',
    label: 'Transfer Data (0x36)',
    category: 'uds',
    descriptionKey: 'diagBlk.transfersDataBlocksTheBlockSequence',
    icon: 'ArrowRightLeft',
    ports: [
      { id: 'exec_in',      label: 'exec_in',      type: 'exec',  direction: 'input' },
      { id: 'chunk_in',     label: 'chunk_in',     type: 'bytes', direction: 'input', optional: true },
      { id: 'exec_out',     label: 'exec_out',     type: 'exec',  direction: 'output' },
      { id: 'error_out',    label: 'error_out',    type: 'exec',  direction: 'output' },
      { id: 'progress_out', label: 'progress_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { chunk_size: '0800' },
    configSchema: [
      { key: 'chunk_size', labelKey: 'diagBlk.chunkSizeHexBytes', type: 'hex', placeholder: '0800' },
    ],
  },

  // ── Flash Image (high-level 0x34 → 0x36* → 0x37) ────────────────────────────
  {
    type: 'uds_flash_image',
    labelKey: 'flash.block.label',
    category: 'uds',
    descriptionKey: 'flash.block.desc',
    icon: 'HardDriveUpload',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
      { id: 'fail_out', label: 'fail_out', type: 'exec', direction: 'output' },
      { id: 'crc32',    label: 'crc32',    type: 'data', direction: 'output' },
      { id: 'report',   label: 'report',   type: 'data', direction: 'output' },
    ],
    defaultConfig: {
      file_name: '',
      format: 'auto',
      base_address: '00000000',
      alfid: '44',
      dfi: '00',
      max_block_len: 0,
      retries: 2,
      transfer_timeout_ms: 0,
      erase_mode: 'none',
      erase_routine_id: 'FF00',
      erase_alfid: '44',
      erase_timeout_ms: 30000,
      erase_busy_retry: 3,
      erase_busy_delay_ms: 200,
      erase_expected_status: '',
      verify_mode: 'total_crc32',
      verify_routine_id: '0202',
      verify_expected_status: '00',
      verify_timeout_ms: 5000,
    },
    configSchema: [
      {
        key: 'format',
        labelKey: 'flash.cfg.format',
        type: 'select',
        options: [
          { value: 'auto',     labelKey: 'flash.fmt.auto' },
          { value: 'intelHex', labelKey: 'flash.fmt.intelHex' },
          { value: 'srec',     labelKey: 'flash.fmt.srec' },
          { value: 'binary',   labelKey: 'flash.fmt.binary' },
        ],
      },
      {
        key: 'base_address',
        labelKey: 'flash.cfg.baseAddress',
        type: 'hex',
        placeholder: '08000000',
        visibleWhen: (c) =>
          c['format'] === 'binary' ||
          (c['format'] === 'auto' && String(c['file_name'] ?? '').toLowerCase().endsWith('.bin')),
      },
      { key: 'alfid', labelKey: 'flash.cfg.alfid', type: 'hex', placeholder: '44' },
      { key: 'dfi',   labelKey: 'flash.cfg.dfi',   type: 'hex', placeholder: '00' },
      { key: 'max_block_len',       labelKey: 'flash.cfg.maxBlockLen',       type: 'number', placeholderKey: 'flash.cfg.autoPlaceholder' },
      { key: 'retries',             labelKey: 'flash.cfg.retries',           type: 'number', placeholder: '2' },
      { key: 'transfer_timeout_ms', labelKey: 'flash.cfg.transferTimeout',   type: 'number', placeholderKey: 'flash.cfg.autoPlaceholder' },
      {
        key: 'erase_mode',
        labelKey: 'flash.cfg.eraseMode',
        type: 'select',
        options: [
          { value: 'none',        labelKey: 'flash.cfg.eraseNone' },
          { value: 'per_segment', labelKey: 'flash.cfg.erasePerSegment' },
        ],
      },
      { key: 'erase_routine_id',      labelKey: 'flash.cfg.eraseRoutine',   type: 'hex',    placeholder: 'FF00',  visibleWhen: (c) => c['erase_mode'] === 'per_segment' },
      { key: 'erase_alfid',           labelKey: 'flash.cfg.eraseAlfid',     type: 'hex',    placeholder: '44',    visibleWhen: (c) => c['erase_mode'] === 'per_segment' },
      { key: 'erase_timeout_ms',      labelKey: 'flash.cfg.eraseTimeout',   type: 'number', placeholder: '30000', visibleWhen: (c) => c['erase_mode'] === 'per_segment' },
      { key: 'erase_busy_retry',      labelKey: 'flash.cfg.eraseBusyRetry', type: 'number', placeholder: '3',     visibleWhen: (c) => c['erase_mode'] === 'per_segment' },
      { key: 'erase_busy_delay_ms',   labelKey: 'flash.cfg.eraseBusyDelay', type: 'number', placeholder: '200',   visibleWhen: (c) => c['erase_mode'] === 'per_segment' },
      { key: 'erase_expected_status', labelKey: 'flash.cfg.eraseStatus',    type: 'hex',    placeholderKey: 'udsFlow.cfg.expectStatusPh', visibleWhen: (c) => c['erase_mode'] === 'per_segment' },
      {
        key: 'verify_mode',
        labelKey: 'flash.cfg.verifyMode',
        type: 'select',
        options: [
          { value: 'total_crc32',       labelKey: 'flash.cfg.verifyTotal' },
          { value: 'per_segment_crc32', labelKey: 'flash.cfg.verifyPerSegment' },
          { value: 'none',              labelKey: 'flash.cfg.verifyNone' },
        ],
      },
      { key: 'verify_routine_id',      labelKey: 'flash.cfg.verifyRoutine', type: 'hex',    placeholder: '0202', visibleWhen: (c) => c['verify_mode'] === 'per_segment_crc32' },
      { key: 'verify_expected_status', labelKey: 'flash.cfg.verifyStatus',  type: 'hex',    placeholder: '00',   visibleWhen: (c) => c['verify_mode'] === 'per_segment_crc32' },
      { key: 'verify_timeout_ms',      labelKey: 'flash.cfg.verifyTimeout', type: 'number', placeholder: '5000', visibleWhen: (c) => c['verify_mode'] === 'per_segment_crc32' },
    ],
  },

  // ── 0x37 RequestTransferExit ────────────────────────────────────────────────
  {
    type: 'uds_transfer_exit',
    label: 'Transfer Exit (0x37)',
    category: 'uds',
    descriptionKey: 'diagBlk.endsTheTransferSessionCalledAfter',
    icon: 'LogOut',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    configSchema: [],
  },

  // ── 0x3D WriteMemoryByAddress ───────────────────────────────────────────────
  {
    type: 'uds_write_memory',
    label: 'Write Memory (0x3D)',
    category: 'uds',
    descriptionKey: 'diagBlk.writesDirectlyToAMemoryAddress',
    icon: 'PenLine',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'data_in',   label: 'data_in',   type: 'bytes', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00000010' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHex',         type: 'hex', placeholder: '00000010' },
    ],
  },

  // ── 0x3E TesterPresent ──────────────────────────────────────────────────────
  {
    type: 'uds_tester_present',
    label: 'Tester Present (0x3E)',
    category: 'uds',
    descriptionKey: 'diagBlk.keepsTheSessionAliveMustBe',
    icon: 'Activity',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { suppress: true },
    configSchema: [
      {
        key: 'suppress',
        labelKey: 'diagBlk.suppressResponseSuppressPosRspMsgIndicationBit',
        type: 'boolean',
      },
    ],
  },

  // ── TesterPresent keep-alive (backend, per session) ───────────────────────
  {
    type: 'uds_tester_present_keepalive',
    label: 'TesterPresent Keep-Alive (0x3E)',
    category: 'uds',
    descriptionKey: 'udsFlow.blk.keepaliveDesc',
    icon: 'HeartPulse',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { action: 'start', interval_ms: 2000 },
    configSchema: [
      {
        key: 'action',
        labelKey: 'udsFlow.cfg.kaAction',
        type: 'select',
        options: [
          { value: 'start', labelKey: 'udsFlow.cfg.kaStart' },
          { value: 'stop',  labelKey: 'udsFlow.cfg.kaStop' },
        ],
      },
      { key: 'interval_ms', labelKey: 'udsFlow.cfg.kaInterval', type: 'number', placeholder: '2000', visibleWhen: (c) => c['action'] !== 'stop' },
    ],
  },

  // ── Wait for ECU ready (after 10 02 / 11 01) ───────────────────────────────
  {
    type: 'uds_wait_ecu_ready',
    label: 'Wait ECU Ready',
    category: 'uds',
    descriptionKey: 'udsFlow.blk.waitReadyDesc',
    icon: 'Hourglass',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec', direction: 'input' },
      { id: 'exec_out',    label: 'exec_out',    type: 'exec', direction: 'output' },
      { id: 'timeout_out', label: 'timeout_out', type: 'exec', direction: 'output' },
      { id: 'elapsed_out', label: 'elapsed_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { initial_delay_ms: 500, poll_ms: 250, timeout_ms: 10000, probe: '3E00', probe_session: '02', probe_timeout_ms: 300 },
    configSchema: [
      {
        key: 'probe',
        labelKey: 'udsFlow.cfg.wrProbe',
        type: 'select',
        options: [
          { value: '3E00',    label: '3E 00 — TesterPresent' },
          { value: 'session', labelKey: 'udsFlow.cfg.wrProbeSession' },
          { value: 'F186',    label: '22 F1 86 — activeDiagnosticSession' },
        ],
      },
      { key: 'timeout_ms',       labelKey: 'udsFlow.cfg.wrTimeout',      type: 'number', placeholder: '10000' },
      { key: 'initial_delay_ms', labelKey: 'udsFlow.cfg.wrInitial',      type: 'number', placeholder: '500' },
      { key: 'poll_ms',          labelKey: 'udsFlow.cfg.wrPoll',         type: 'number', placeholder: '250' },
      { key: 'probe_timeout_ms', labelKey: 'udsFlow.cfg.wrProbeTimeout', type: 'number', placeholder: '300' },
      { key: 'probe_session',    labelKey: 'udsFlow.cfg.wrSession',      type: 'hex',    placeholder: '02', visibleWhen: (c) => c['probe'] === 'session' },
    ],
  },

  // ── 0x85 ControlDTCSetting ──────────────────────────────────────────────────
  {
    type: 'uds_dtc_setting',
    label: 'DTC Setting (0x85)',
    category: 'uds',
    descriptionKey: 'diagBlk.enablesDisablesDTCStorageMustBe',
    icon: 'BellOff',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { setting_type: '02' },
    configSchema: [
      {
        key: 'setting_type',
        label: 'DTC Setting Tipi',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — on  (DTCSettingOn)' },
          { value: '02', label: '0x02 — off (DTCSettingOff)' },
        ],
      },
    ],
  },

  // ── Lockout Guard (NRC 0x36 protection) ────────────────────────────────────
  {
    type: 'uds_lockout_guard',
    label: 'Lockout Guard (0x36/0x37)',
    category: 'uds',
    descriptionKey: 'diagBlk.nrc0x36ExceededNumberOfAttemptsGuardFailedAttempts',
    icon: 'ShieldAlert',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'delay_out', label: 'delay_out', type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { max_attempts: 3, lockout_ms: 10000 },
    configSchema: [
      { key: 'max_attempts', labelKey: 'diagBlk.maxAttempts', type: 'number', placeholder: '3' },
      { key: 'lockout_ms',   labelKey: 'diagBlk.lockoutTimeMs',       type: 'number', placeholder: '10000' },
    ],
  },

  // ── Seed/Key Validator ──────────────────────────────────────────────────────
  {
    type: 'uds_seed_validator',
    labelKey: 'diagBlk.seedKeyValidator',
    category: 'uds',
    descriptionKey: 'diagBlk.comparesTheComputedKeyWithThe',
    icon: 'KeyRound',
    ports: [
      { id: 'exec_in',    label: 'exec_in',    type: 'exec',  direction: 'input' },
      { id: 'seed_in',    label: 'seed_in',    type: 'bytes', direction: 'input' },
      { id: 'key_in',     label: 'key_in',     type: 'bytes', direction: 'input' },
      { id: 'pass_out',   label: 'pass_out',   type: 'exec',  direction: 'output' },
      { id: 'fail_out',   label: 'fail_out',   type: 'exec',  direction: 'output' },
      { id: 'result_out', label: 'result_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { expected_key: 'C9A8', algorithm: 'xor_ff' },
    configSchema: [
      { key: 'expected_key', labelKey: 'diagBlk.expectedKeyHex', type: 'hex', placeholder: 'C9A8' },
      {
        key: 'algorithm',
        labelKey: 'diagBlk.keyAlgorithm',
        type: 'select',
        options: [
          { value: 'xor_ff',       label: 'XOR 0xFF  —  key[i] = seed[i] ^ 0xFF' },
          { value: 'xor_const',    labelKey: 'diagBlk.xorConstantKeySeedXORConstant' },
          { value: 'sum_negate',   label: 'Byte Sum Negate  —  key = ~sum(seed)' },
          { value: 'add_const',    labelKey: 'diagBlk.seedConstantKeySeedConstant' },
          { value: 'right_rotate', label: 'Right Rotate 2  —  key = ROR(seed,2) ^ const' },
          { value: 'crc16',        label: 'CRC-16/IBM  —  key = CRC16(seed)' },
          { value: 'crc32',        label: 'CRC-32  —  key = CRC32(seed)' },
          { value: 'custom',       label: 'Custom Script (Rhai)' },
        ],
      },
    ],
  },

  // ── 0x87 LinkControl ────────────────────────────────────────────────────────
  {
    type: 'uds_link_control',
    label: 'Link Control (0x87)',
    category: 'uds',
    descriptionKey: 'diagBlk.twoStepBaudrateChange1Verify',
    icon: 'Network',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { link_control_type: '01', link_baudrate_id: '05' },
    configSchema: [
      {
        key: 'link_control_type',
        labelKey: 'diagBlk.controlType',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — verifyModeTransitionWithFixedParameter' },
          { value: '02', label: '0x02 — verifyModeTransitionWithSpecificParameter' },
          { value: '03', labelKey: 'diagBlk.0x03TransitionModeAfterVerification' },
        ],
      },
      {
        key: 'link_baudrate_id',
        labelKey: 'diagBlk.baudrateIDForFixedParameter',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — PC9600Baud' },
          { value: '02', label: '0x02 — PC19200Baud' },
          { value: '03', label: '0x03 — PC38400Baud' },
          { value: '04', label: '0x04 — PC57600Baud' },
          { value: '05', label: '0x05 — PC115200Baud' },
          { value: '10', label: '0x10 — CAN125Kbps' },
          { value: '11', label: '0x11 — CAN250Kbps' },
          { value: '12', label: '0x12 — CAN500Kbps' },
          { value: '13', label: '0x13 — CAN1Mbps' },
          { value: '20', label: '0x20 — ProgrammingSetup' },
        ],
      },
    ],
  },
];

// ─── DATA CATEGORY ────────────────────────────────────────────────────────────

const dataBlocks: BlockDefSeed[] = [
  {
    type: 'data_const',
    labelKey: 'diagBlk.constant',
    category: 'data',
    descriptionKey: 'diagBlk.outputsAConstantValue',
    icon: 'Hash',
    ports: [
      { id: 'value_out', label: 'value_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { value: '', format: 'text' },
    configSchema: [
      { key: 'value', labelKey: 'diagBlk.value', type: 'text', placeholder: '' },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'text', labelKey: 'diagBlk.text' },
          { value: 'hex',  label: 'Hex' },
          { value: 'dec',  label: 'Decimal' },
        ],
      },
    ],
  },
  {
    type: 'data_var',
    labelKey: 'diagBlk.variable',
    category: 'data',
    hidden: true,
    descriptionKey: 'diagBlk.storesAndReadsAValue',
    icon: 'Variable',
    ports: [
      { id: 'set_in',  label: 'set_in',  type: 'data', direction: 'input', optional: true },
      { id: 'get_out', label: 'get_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { name: 'myVar', initial: '' },
    configSchema: [
      { key: 'name',    labelKey: 'diagBlk.variableName', type: 'text', placeholder: 'myVar' },
      { key: 'initial', labelKey: 'diagBlk.initialValue', type: 'text', placeholder: '' },
    ],
  },
  {
    type: 'data_compare',
    labelKey: 'diagBlk.compare',
    category: 'data',
    descriptionKey: 'diagBlk.comparesTwoValues',
    icon: 'Equal',
    ports: [
      { id: 'left_in',    label: 'left_in',    type: 'data', direction: 'input' },
      { id: 'right_in',   label: 'right_in',   type: 'data', direction: 'input' },
      { id: 'result_out', label: 'result_out', type: 'bool', direction: 'output' },
    ],
    defaultConfig: { operator: 'eq', pass_if_right_empty: false },
    configSchema: [
      {
        key: 'operator',
        labelKey: 'diagBlk.operator',
        type: 'select',
        options: [
          { value: 'eq',              labelKey: 'diagBlk.equal' },
          { value: 'neq',             labelKey: 'diagBlk.notEqual' },
          { value: 'gt',              labelKey: 'diagBlk.greater' },
          { value: 'ge',              label: '≥' },
          { value: 'lt',              labelKey: 'diagBlk.less' },
          { value: 'le',              label: '≤' },
          { value: 'ascii_equals',    labelKey: 'udsFlow.cmp.asciiEquals' },
          { value: 'bytes_not_equal', labelKey: 'udsFlow.cmp.bytesNotEqual' },
        ],
      },
      { key: 'pass_if_right_empty', labelKey: 'udsFlow.cmp.passIfEmpty', type: 'boolean' },
    ],
  },
  {
    type: 'data_extract',
    labelKey: 'diagBlk.extractBytes',
    category: 'data',
    descriptionKey: 'diagBlk.extractsAValueFromAByte',
    icon: 'Scissors',
    ports: [
      { id: 'bytes_in',  label: 'bytes_in',  type: 'bytes', direction: 'input' },
      { id: 'value_out', label: 'value_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { offset: 0, length: 1 },
    configSchema: [
      { key: 'offset', labelKey: 'diagBlk.startByte', type: 'number', placeholder: '0' },
      { key: 'length', labelKey: 'diagBlk.lengthBytes',   type: 'number', placeholder: '1' },
    ],
  },

  // ── Byte Builder ─────────────────────────────────────────────────────────────
  {
    type: 'data_byte_builder',
    labelKey: 'diagBlk.byteBuilder',
    category: 'data',
    descriptionKey: 'diagBlk.buildsAByteArrayFromA',
    icon: 'Braces',
    ports: [
      { id: 'value_in',  label: 'value_in',  type: 'data',  direction: 'input', optional: true },
      { id: 'bytes_out', label: 'bytes_out', type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { template: '00 00 00 00', format: 'hex' },
    configSchema: [
      { key: 'template', labelKey: 'diagBlk.templateHexBytes', type: 'hex', placeholder: '00 11 22 33' },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'hex',     label: 'Hex' },
          { value: 'ascii',   label: 'ASCII' },
          { value: 'decimal', labelKey: 'diagBlk.decimalCommaSeparated' },
        ],
      },
    ],
  },

  // ── Bitfield Extract ──────────────────────────────────────────────────────────
  {
    type: 'data_bitfield_extract',
    labelKey: 'diagBlk.extractBitField',
    category: 'data',
    descriptionKey: 'diagBlk.extractsABitRangeFromA',
    icon: 'SplitSquareHorizontal',
    ports: [
      { id: 'bytes_in',  label: 'bytes_in',  type: 'bytes', direction: 'input' },
      { id: 'value_out', label: 'value_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { byte_offset: 0, bit_high: 7, bit_low: 0 },
    configSchema: [
      { key: 'byte_offset', labelKey: 'diagBlk.byteOffset',      type: 'number', placeholder: '0' },
      { key: 'bit_high',    labelKey: 'diagBlk.highBit70', type: 'number', placeholder: '7' },
      { key: 'bit_low',     labelKey: 'diagBlk.lowBit70',  type: 'number', placeholder: '0' },
    ],
  },

  // ── ASCII text → bytes ────────────────────────────────────────────────────────
  {
    type: 'data_ascii',
    labelKey: 'udsFlow.blk.asciiLabel',
    category: 'data',
    descriptionKey: 'udsFlow.blk.asciiDesc',
    icon: 'Type',
    ports: [
      { id: 'value_in',  label: 'value_in',  type: 'data',  direction: 'input', optional: true },
      { id: 'bytes_out', label: 'bytes_out', type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { text: '', length: 0, pad: '20' },
    configSchema: [
      { key: 'text',   labelKey: 'udsFlow.cfg.asciiText', type: 'text',   placeholder: 'NEXUSCAN' },
      { key: 'length', labelKey: 'udsFlow.cfg.asciiLen',  type: 'number', placeholderKey: 'udsFlow.cfg.asciiLenPh' },
      { key: 'pad',    labelKey: 'udsFlow.cfg.padByte',   type: 'hex',    placeholder: '20' },
    ],
  },

  // ── Repair-shop fingerprint (e.g. DID F15A) ───────────────────────────────────
  {
    type: 'data_fingerprint',
    labelKey: 'udsFlow.blk.fpLabel',
    category: 'data',
    descriptionKey: 'udsFlow.blk.fpDesc',
    icon: 'Fingerprint',
    ports: [
      { id: 'bytes_out', label: 'bytes_out', type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { format: 'iso_f15a', serial: 'NEXUS1', serial_len: 6, pad: '20', template: '{YY}{MM}{DD} {SERIAL:6}' },
    configSchema: [
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'iso_f15a', labelKey: 'udsFlow.cfg.fpIso' },
          { value: 'custom',   labelKey: 'udsFlow.cfg.fpCustom' },
        ],
      },
      { key: 'serial',     labelKey: 'udsFlow.cfg.fpSerial',    type: 'text',   placeholder: 'NEXUS1' },
      { key: 'serial_len', labelKey: 'udsFlow.cfg.fpSerialLen', type: 'number', placeholder: '6', visibleWhen: (c) => c['format'] !== 'custom' },
      { key: 'pad',        labelKey: 'udsFlow.cfg.padByte',     type: 'hex',    placeholder: '20' },
      { key: 'template',   labelKey: 'udsFlow.cfg.fpTemplate',  type: 'text',   placeholder: '{YY}{MM}{DD} {SERIAL:6}', visibleWhen: (c) => c['format'] === 'custom' },
    ],
  },

  // ── Checksum ──────────────────────────────────────────────────────────────────
  {
    type: 'data_checksum',
    labelKey: 'diagBlk.computeChecksum',
    category: 'data',
    descriptionKey: 'diagBlk.standaloneCRCChecksumCalculatorUsedFor',
    icon: 'Hash',
    ports: [
      { id: 'exec_in',      label: 'exec_in',      type: 'exec',  direction: 'input' },
      { id: 'data_in',      label: 'data_in',      type: 'bytes', direction: 'input' },
      { id: 'exec_out',     label: 'exec_out',     type: 'exec',  direction: 'output' },
      { id: 'checksum_out', label: 'checksum_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { algorithm: 'crc32', output_format: 'hex' },
    configSchema: [
      {
        key: 'algorithm',
        labelKey: 'diagBlk.algorithm',
        type: 'select',
        options: [
          { value: 'crc16',    label: 'CRC-16/IBM' },
          { value: 'crc32',    label: 'CRC-32' },
          { value: 'xor_sum',  label: 'XOR Sum' },
          { value: 'add_sum',  label: 'Add Sum (8-bit)' },
        ],
      },
      {
        key: 'output_format',
        labelKey: 'diagBlk.outputFormat',
        type: 'select',
        options: [
          { value: 'hex',    label: 'Hex String' },
          { value: 'bytes',  label: 'Byte Array' },
          { value: 'number', label: 'Number' },
        ],
      },
    ],
  },
];

// ─── IO CATEGORY ──────────────────────────────────────────────────────────────

const ioBlocks: BlockDefSeed[] = [
  {
    type: 'io_file_input',
    labelKey: 'diagBlk.fileInputBin',
    category: 'io',
    descriptionKey: 'diagBlk.readsDataFromAFile',
    icon: 'File',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec',  direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec',  direction: 'output' },
      { id: 'data_out', label: 'data_out', type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { file_path: '', chunk_size: 128 },
    configSchema: [
      { key: 'file_path',  labelKey: 'diagBlk.filePath', type: 'text',   placeholder: '/path/to/firmware.bin' },
      { key: 'chunk_size', labelKey: 'diagBlk.chunkSizeBytes', type: 'number', placeholder: '2048' },
    ],
  },
  {
    type: 'io_display',
    labelKey: 'diagBlk.showValue',
    category: 'io',
    descriptionKey: 'diagBlk.writesTheValueToTheRun',
    icon: 'Monitor',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'io_user_prompt',
    labelKey: 'diagBlk.userInput',
    category: 'io',
    descriptionKey: 'diagBlk.promptsTheUserForAValue',
    icon: 'MessageSquare',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'value_out', label: 'value_out', type: 'data', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    defaultConfigKeys: { message: 'diagBlk.enterAValue' },
    configSchema: [
      { key: 'message', labelKey: 'diagBlk.message', type: 'text', placeholderKey: 'diagBlk.enterAValue' },
    ],
  },
];

// ─── PER-REQUEST OPTIONS ──────────────────────────────────────────────────────

/**
 * Blocks with the common "Request options" inspector section (config keys `req_addressing`,
 * `req_spr`, `req_timeout_ms`, `req_busy_retry`, `req_busy_delay_ms`). Absent keys = the previous
 * behaviour: physical, no SPR, backend timing, no busy retry.
 */
export const REQUEST_OPTION_BLOCKS: ReadonlySet<string> = new Set([
  'uds_session', 'uds_ecu_reset', 'uds_clear_dtc', 'uds_read_dtc', 'uds_read_did', 'uds_read_memory',
  'uds_security_access', 'uds_comm_control', 'uds_write_did', 'uds_io_control', 'uds_routine_ctrl',
  'uds_req_download', 'uds_req_upload', 'uds_transfer_data', 'uds_transfer_exit', 'uds_write_memory',
  'uds_tester_present', 'uds_dtc_setting', 'uds_link_control',
]);

/**
 * Functional addressing is offered only for single-frame, broadcast-meaningful services
 * (ISO 15765-2: functional requests are single frame only; seed/key, transfers and writes are
 * always physical).
 */
export const FUNCTIONAL_OK_BLOCKS: ReadonlySet<string> = new Set([
  'uds_session', 'uds_ecu_reset', 'uds_clear_dtc', 'uds_read_dtc', 'uds_read_did',
  'uds_comm_control', 'uds_routine_ctrl', 'uds_tester_present', 'uds_dtc_setting',
]);

/**
 * suppressPosRspMsgIndicationBit (ISO 14229-1 §7.5, sub-function bit 7) offered by the common
 * section: 0x10, 0x11, 0x28, 0x85. Not offered for 0x31 (the routine status record is needed),
 * 0x27 (the seed is needed); 0x3E keeps its own `suppress` field and 0x87 sets it internally.
 */
export const SPR_BLOCKS: ReadonlySet<string> = new Set(['uds_session', 'uds_ecu_reset', 'uds_comm_control', 'uds_dtc_setting']);

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

/** Pack of a catalog category: UDS blocks are the `uds` pack (needs a `uds_can` ECU), everything else is `core`. */
function packed(defs: BlockDefSeed[], pack: BlockPack, requires?: DiagProtocol[]): BlockDef[] {
  return defs.map((d) => (requires ? { ...d, pack, requires } : { ...d, pack }));
}

const coreDefs = packed(coreBlocks, 'core');
const flowDefs = packed(flowBlocks, 'core');
const interfaceDefs = packed(interfaceBlocks, 'core');
const udsDefs = packed(udsBlocks, 'uds', ['uds_can']);
const dataDefs = packed(dataBlocks, 'core');
const ioDefs = packed(ioBlocks, 'core');

export const BLOCK_CATALOG: BlockDef[] = [
  ...coreDefs,
  ...interfaceDefs,
  ...flowDefs,
  ...udsDefs,
  ...dataDefs,
  ...ioDefs,
];

export const BLOCK_CATALOG_BY_CATEGORY: Record<BlockCategory, BlockDef[]> = {
  core: coreDefs,
  interface: interfaceDefs,
  flow: flowDefs,
  uds:  udsDefs,
  data: dataDefs,
  io:   ioDefs,
};

/** Palette order of the packs (packs without blocks are not shown). */
export const PACK_ORDER: readonly BlockPack[] = ['core', 'can', 'uds', 'kwp', 'obd', 'j1939', 'canopen', 'xcp', 'custom'];

/**
 * Union of `requires` over the diagram's blocks (empty = protocol-agnostic). Phase B2 checks it against the
 * bound ECU's protocol (and adds the callee interfaces of call blocks); B1 only exposes it.
 */
export function requiredProtocols(diagram: { blocks: ReadonlyArray<{ type: string }> }): DiagProtocol[] {
  const out = new Set<DiagProtocol>();
  for (const b of diagram.blocks) for (const p of getBlockDef(b.type)?.requires ?? []) out.add(p);
  return [...out];
}

const callBaseDefs = new Map<string, BlockDef>();

/** Call block (`call:<flowId>`): ports `in` / `error` until the callee interface is known (`getBlockDefFor`). */
function callBaseDef(type: string): BlockDef {
  let d = callBaseDefs.get(type);
  if (!d) {
    d = {
      type, label: 'Custom Block', category: 'flow', pack: 'custom', icon: 'Box', defaultConfig: {}, configSchema: [],
      ports: [
        { id: CALL_IN, label: CALL_IN, type: 'exec', direction: 'input' },
        { id: CALL_ERROR, label: CALL_ERROR, type: 'exec', direction: 'output' },
      ],
    };
    callBaseDefs.set(type, d);
  }
  return d;
}

export function getBlockDef(type: string): BlockDef | undefined {
  if (isCallType(type)) return callBaseDef(type);
  return BLOCK_CATALOG.find((d) => d.type === type);
}

/**
 * Port compatibility of a connection: exec only with exec; otherwise equal types, or `data`
 * (untyped value) on either side. A typed `bytes` / `bool` port therefore accepts a `data` source
 * (`var_get`, `math`, `convert`) and a `data` port accepts any typed source.
 */
export function portsCompatible(a: PortType, b: PortType): boolean {
  if (a === 'exec' || b === 'exec' || a === 'ecu' || b === 'ecu') return a === b;
  return a === b || a === 'data' || b === 'data';
}

const dynamicDefs = new Map<string, BlockDef>();

/**
 * Definition of one block instance with its config-derived ports: `text_format` gets one optional `data`
 * input per name in `config.inputs`; `flow_input` / `flow_output` get one port per interface spec.
 */
export function getBlockDefFor(block: FlowBlock): BlockDef | undefined {
  const base = getBlockDefForInner(block);
  if (!base) return base;
  return withBoundPorts(base, block);
}

function getBlockDefForInner(block: FlowBlock): BlockDef | undefined {
  const def = getBlockDef(block.type);
  if (!def) return def;
  if (isCallType(block.type)) {
    const ref = readCallRef(block);
    const info = ref ? callIndex.get(ref) : undefined;
    if (!info) return def;
    const { ports } = callPorts(info.iface);
    const key = `call\u0000${ref ? refKey(ref) : ''}\u0000${ports.map((p) => `${p.direction}:${p.id}:${p.type}`).join('|')}`;
    const cached = dynamicDefs.get(key);
    if (cached) return cached;
    const next: BlockDef = { ...def, label: info.name, ports };
    dynamicDefs.set(key, next);
    return next;
  }
  if (block.type === FLOW_IN || block.type === FLOW_OUT) {
    const ports = interfacePorts(block) ?? [];
    if (ports.length === 0) return def;
    const key = interfacePortsKey(block);
    const cached = dynamicDefs.get(key);
    if (cached) return cached;
    const next: BlockDef = { ...def, ports };
    dynamicDefs.set(key, next);
    return next;
  }
  if (block.type !== 'text_format') return def;
  const names = formatInputs(block);
  if (names.length === 0) return def;
  const key = `text_format\u0000${names.join('\u0000')}`;
  const cached = dynamicDefs.get(key);
  if (cached) return cached;
  const inputs: PortDef[] = names.map((n) => ({ id: n, label: n, type: 'data', direction: 'input', optional: true }));
  const next: BlockDef = { ...def, ports: [...inputs, ...def.ports] };
  dynamicDefs.set(key, next);
  return next;
}

// ─── Bindable parameters (flow-interface-v2 §3) ───────────────────────────────

/** Input port id of a bound parameter. */
export const BOUND_PREFIX = 'p:';
export const boundPortId = (key: string): string => `${BOUND_PREFIX}${key}`;

/** Pseudo-field of `uds_flash_image`: the firmware file (not a config key; the value is a `FlowFileValue`). */
export const FLASH_FILE_FIELD = 'file';
export const FLASH_FILE_ACCEPT: readonly string[] = ['.hex', '.s19', '.srec', '.bin'];

const BINDABLE_TYPES: ReadonlySet<ConfigField['type']> = new Set(['text', 'textarea', 'number', 'select', 'hex', 'boolean']);

export type BindableKind = 'text' | 'textarea' | 'number' | 'select' | 'hex' | 'boolean' | 'file';

export interface BindableField {
  key: string;
  kind: BindableKind;
  /** Config field (`null` for the `file` pseudo-field). */
  field: ConfigField | null;
  /** Verbatim label for the pseudo-field. */
  labelKey?: ConfigField['labelKey'];
  label?: string;
  portType: PortType;
  options?: string[];
  accept?: string[];
}

function boundPortType(kind: BindableKind): PortType {
  return kind === 'boolean' ? 'bool' : kind === 'file' ? 'bytes' : 'data';
}

/** Structural blocks whose parameters are never bound (they ARE the interface / the jump markers). */
const NON_BINDABLE_BLOCKS: ReadonlySet<string> = new Set([FLOW_START, FLOW_IN, FLOW_OUT, FLOW_RETURN, 'flow_terminal', 'flow_goto']);

/** Fields of a block type that can be bound to an input port (catalog order; the `file` pseudo-field last). */
export function bindableFields(type: string): BindableField[] {
  const def = isCallType(type) || NON_BINDABLE_BLOCKS.has(type) ? undefined : getBlockDef(type);
  if (!def) return [];
  const out: BindableField[] = [];
  for (const f of def.configSchema) {
    if (f.bindable === false || !BINDABLE_TYPES.has(f.type)) continue;
    const kind = f.type as BindableKind;
    out.push({
      key: f.key, kind, field: f, labelKey: f.labelKey, label: f.label, portType: boundPortType(kind),
      ...(kind === 'select' ? { options: (f.options ?? []).map((o) => o.value) } : {}),
    });
  }
  if (type === 'uds_flash_image') {
    out.push({
      key: FLASH_FILE_FIELD, kind: 'file', field: null, labelKey: 'flowIface.bind.firmwareFile',
      portType: 'bytes', accept: [...FLASH_FILE_ACCEPT],
    });
  }
  return out;
}

/** `config.boundParams` (field keys); a malformed value reads as none. */
export function readBoundParams(config: Record<string, unknown>): string[] {
  const raw = config['boundParams'];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** One required `p:<key>` input per bound parameter (known keys only: unknown ones are a validation error). */
export function boundPorts(block: FlowBlock): PortDef[] {
  const keys = readBoundParams(block.config);
  if (keys.length === 0) return [];
  const fields = bindableFields(block.type);
  const ports: PortDef[] = [];
  for (const k of keys) {
    const f = fields.find((x) => x.key === k);
    if (!f) continue;
    ports.push({ id: boundPortId(k), label: boundPortId(k), type: f.portType, direction: 'input' });
  }
  return ports;
}

function withBoundPorts(def: BlockDef, block: FlowBlock): BlockDef {
  const extra = boundPorts(block);
  if (extra.length === 0) return def;
  const key = `bound\u0000${block.type}\u0000${def.ports.map((p) => p.id).join('|')}\u0000${extra.map((p) => `${p.id}:${p.type}`).join('|')}`;
  const cached = dynamicDefs.get(key);
  if (cached) return cached;
  // Bound inputs sit with the other inputs (before the first output) so the port rows stay grouped.
  const firstOut = def.ports.findIndex((p) => p.direction === 'output');
  const at = firstOut < 0 ? def.ports.length : firstOut;
  const next: BlockDef = { ...def, ports: [...def.ports.slice(0, at), ...extra, ...def.ports.slice(at)] };
  dynamicDefs.set(key, next);
  return next;
}
