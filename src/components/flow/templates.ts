import { getLocale, t } from '../../i18n';
import type { FlowTemplate, FlowBlock, FlowConnection } from './types';
import { getBlockDef } from './blockDefs';
import { PORT_SPACING } from './types';

let _idCounter = 0;
function tid(): string {
  return `tpl_${++_idCounter}`;
}

function makeBlock(
  type: string,
  label: string,
  x: number,
  y: number,
  config: Record<string, unknown> = {},
): FlowBlock {
  return {
    id: tid(),
    type,
    label,
    x,
    y,
    config,
    status: 'idle',
    collapsed: false,
  };
}

function conn(
  fromBlock: FlowBlock,
  fromPort: string,
  toBlock: FlowBlock,
  toPort: string,
): FlowConnection {
  return {
    id: tid(),
    fromBlockId: fromBlock.id,
    fromPortId:  fromPort,
    toBlockId:   toBlock.id,
    toPortId:    toPort,
  };
}

// ─── ECU FLASHER (production) ────────────────────────────────────────────────

/** Grid of the flasher layout: 240 px column pitch (200 px block + 40 px gap). */
const COL = 240;
const X0 = 80;
function cx(i: number): number {
  return X0 + i * COL;
}
/** Main rows (440 px pitch) hold the sequence; each has an aux row 220 px below for data / branches. */
const ROW = { r1: 80, r2: 520, r3: 960, r4: 1400, r5: 1840, safe: 2300, boot: 2560, post: 2820 } as const;
const AUX = 220;

/** Estimated rendered height of a block (header + port rows + status bar + config summary). */
function estBlockHeight(b: FlowBlock): number {
  const def = getBlockDef(b.type);
  const ins = def ? def.ports.filter((p) => p.direction === 'input').length : 1;
  const outs = def ? def.ports.filter((p) => p.direction === 'output').length : 1;
  return 36 + 8 + Math.max(ins, outs) * PORT_SPACING + 38 + (b.type === 'uds_flash_image' ? 40 : 0);
}

/** Functional + suppressPosRspMsgIndicationBit request options (network-wide 0x28 / 0x85). */
const F_SPR = { req_addressing: 'functional', req_spr: true } as const;

/**
 * Production-grade ISO 14229-1 reprogramming sequence (pre-programming → programming session →
 * download → post-programming) with two recovery lanes:
 *
 * - SAFE ABORT (any error BEFORE the first erase): re-enable comm (28 00 01 F+SPR), DTC setting ON
 *   (85 01 F+SPR), default session (10 01), keep-alive stop. The application is untouched.
 * - ECU IN BOOTLOADER (erase / download / verify / FF01 / reset / wait failures): critical message,
 *   re-enable comm + DTC setting so the rest of the vehicle bus recovers, keep-alive stop. NO 11 01:
 *   resetting into an invalid application can brick the ECU / leave it unreachable.
 * - POST-PROGRAMMING (a step after the ECU answered again from its new application fails):
 *   warning, then the same network recovery as the bootloader lane.
 *
 * Every error_out / fail_out / timeout_out is wired (to a goto pill that jumps to the lane's terminal); every recovery block wires its own error_out
 * onward so one failing recovery step never stops the rest.
 */
function buildEcuFlasher(): FlowTemplate {
  const blocks: FlowBlock[] = [];
  const connections: FlowConnection[] = [];
  const B = (type: string, label: string, x: number, y: number, config: Record<string, unknown> = {}): FlowBlock => {
    const b = makeBlock(type, label, x, y, config);
    blocks.push(b);
    return b;
  };
  const W = (from: FlowBlock, fromPort: string, to: FlowBlock, toPort = 'exec_in'): void => {
    connections.push(conn(from, fromPort, to, toPort));
  };
  /** Exec chain helper: `a.exec_out → b.exec_in` for consecutive pairs. */
  const chain = (...list: Array<[FlowBlock, string]>): void => {
    for (let i = 0; i + 1 < list.length; i++) W(list[i][0], list[i][1], list[i + 1][0]);
  };

  // ── Recovery lanes (bottom) ───────────────────────────────────────────────
  // Each lane starts at a wireless TERMINAL; every recovery route elsewhere is a small GOTO pill next to
  // its source block (no long wires across the diagram).
  const termSafe = B('flow_terminal', 'SAFE ABORT', X0 - 160, ROW.safe + 38, { name: 'SAFE ABORT', color: 'amber' });
  const termBoot = B('flow_terminal', 'ECU IN BOOTLOADER', X0 - 160, ROW.boot + 38, { name: 'ECU IN BOOTLOADER', color: 'red' });
  const termPost = B('flow_terminal', 'POST-PROGRAMMING', X0 - 160, ROW.post + 38, { name: 'POST-PROGRAMMING', color: 'orange' });
  /** `source.port -> goto(terminal)`: the goto pill sits just below the source block. */
  const G = (src: FlowBlock, port: string, term: FlowBlock): void => {
    const g = B('flow_goto', t('diagBlk.goto'), src.x + 30, src.y + estBlockHeight(src) + 4, { target_terminal_id: term.id });
    W(src, port, g);
  };
  const sHead  = B('log', t('udsTpl.fl.safeHead'), cx(0), ROW.safe, { message: t('udsTpl.fl.safeHeadMsg') });
  const sComm  = B('uds_comm_control', t('udsTpl.fl.commOnF'), cx(1), ROW.safe, { control_type: '00', comm_type: '01', ...F_SPR });
  const sDtc   = B('uds_dtc_setting', t('udsTpl.fl.dtcOnF'), cx(2), ROW.safe, { setting_type: '01', ...F_SPR });
  const sDef   = B('uds_session', t('udsTpl.fl.defaultSession'), cx(3), ROW.safe, { session_type: 'default' });
  const sKa    = B('uds_tester_present_keepalive', t('udsTpl.fl.kaStop'), cx(4), ROW.safe, { action: 'stop', interval_ms: 2000 });
  const sDone  = B('log', t('udsTpl.fl.safeDone'), cx(5), ROW.safe, { message: t('udsTpl.fl.safeDoneMsg') });
  const sEnd   = B('end', t('udsTpl.fl.endAborted'), cx(6), ROW.safe);
  W(termSafe, 'exec_out', sHead);
  chain([sHead, 'exec_out'], [sComm, 'exec_out'], [sDtc, 'exec_out'], [sDef, 'exec_out'], [sKa, 'exec_out'], [sDone, 'exec_out'], [sEnd, '']);
  W(sComm, 'error_out', sDtc);
  W(sDtc, 'error_out', sDef);
  W(sDef, 'error_out', sKa);
  W(sKa, 'error_out', sDone);

  const bHead  = B('log', t('udsTpl.fl.bootHead'), cx(0), ROW.boot, { message: t('udsTpl.fl.bootHeadMsg') });
  const bComm  = B('uds_comm_control', t('udsTpl.fl.commOnF'), cx(1), ROW.boot, { control_type: '00', comm_type: '01', ...F_SPR });
  const bDtc   = B('uds_dtc_setting', t('udsTpl.fl.dtcOnF'), cx(2), ROW.boot, { setting_type: '01', ...F_SPR });
  const bKa    = B('uds_tester_present_keepalive', t('udsTpl.fl.kaStop'), cx(3), ROW.boot, { action: 'stop', interval_ms: 2000 });
  const bDone  = B('log', t('udsTpl.fl.bootDone'), cx(4), ROW.boot, { message: t('udsTpl.fl.bootDoneMsg') });
  const bEnd   = B('end', t('udsTpl.fl.endFailed'), cx(5), ROW.boot);
  W(termBoot, 'exec_out', bHead);
  chain([bHead, 'exec_out'], [bComm, 'exec_out'], [bDtc, 'exec_out'], [bKa, 'exec_out'], [bDone, 'exec_out'], [bEnd, '']);
  W(bComm, 'error_out', bDtc);
  W(bDtc, 'error_out', bKa);
  W(bKa, 'error_out', bDone);

  // Post-programming failures join the bootloader lane's network recovery (no critical message, no 11 01).
  const pHead  = B('log', t('udsTpl.fl.postHead'), cx(0), ROW.post, { message: t('udsTpl.fl.postHeadMsg') });
  W(termPost, 'exec_out', pHead);
  W(pHead, 'exec_out', bComm);

  // ── A · Pre-programming (row 1: confirmation + identification) ─────────────
  const start   = B('start', t('diagBlk.start'), cx(0), ROW.r1);
  const hdrA    = B('log', t('udsTpl.fl.hdrA'), cx(1), ROW.r1, { message: t('udsTpl.fl.hdrAMsg') });
  const prompt  = B('io_user_prompt', t('udsTpl.fl.prompt'), cx(2), ROW.r1, { message: t('udsTpl.fl.promptMsg') });
  const ext1    = B('uds_session', t('udsTpl.fl.extSession'), cx(3), ROW.r1, { session_type: 'extended' });
  const kaOn    = B('uds_tester_present_keepalive', t('udsTpl.fl.kaStart'), cx(4), ROW.r1, { action: 'start', interval_ms: 2000 });
  const vin     = B('uds_read_did', t('udsTpl.fl.readVin'), cx(5), ROW.r1, { did: 'F190' });
  const vinLog  = B('log', t('udsTpl.fl.logVin'), cx(6), ROW.r1, { message: 'VIN (F190):' });
  const spare   = B('uds_read_did', t('udsTpl.fl.readSpare'), cx(7), ROW.r1, { did: 'F187' });
  const spareLog= B('log', t('udsTpl.fl.logSpare'), cx(8), ROW.r1, { message: 'F187:' });
  const abortLog= B('log', t('udsTpl.fl.cancelled'), cx(2), ROW.r1 + AUX, { message: t('udsTpl.fl.cancelledMsg') });
  const abortEnd= B('end', t('udsTpl.fl.endAborted'), cx(3), ROW.r1 + AUX);

  chain([start, 'exec_out'], [hdrA, 'exec_out'], [prompt, 'exec_out'], [ext1, 'exec_out'], [kaOn, 'exec_out'],
    [vin, 'exec_out'], [vinLog, 'exec_out'], [spare, 'exec_out'], [spareLog, '']);
  W(vin, 'data_out', vinLog, 'value_in');
  W(spare, 'data_out', spareLog, 'value_in');
  W(prompt, 'error_out', abortLog);
  W(abortLog, 'exec_out', abortEnd);

  // ── A · Pre-programming (row 2: versions, HW compatibility, preconditions, network) ──
  const swOld   = B('uds_read_did', t('udsTpl.fl.readSwBefore'), cx(0), ROW.r2, { did: 'F189' });
  const swLog   = B('log', t('udsTpl.fl.logSwBefore'), cx(1), ROW.r2, { message: t('udsTpl.fl.logSwBeforeMsg') });
  const hw      = B('uds_read_did', t('udsTpl.fl.readHw'), cx(2), ROW.r2, { did: 'F191' });
  const hwLog   = B('log', t('udsTpl.fl.logHw'), cx(3), ROW.r2, { message: 'F191:' });
  const hwCond  = B('condition', t('udsTpl.fl.hwOk'), cx(4), ROW.r2);
  const precond = B('uds_routine_ctrl', t('udsTpl.fl.precond'), cx(5), ROW.r2, { control_type: '01', routine_id: '0203', expect_status: '00' });
  const dtcOff  = B('uds_dtc_setting', t('udsTpl.fl.dtcOffF'), cx(6), ROW.r2, { setting_type: '02', ...F_SPR });
  const commOff = B('uds_comm_control', t('udsTpl.fl.commOffF'), cx(7), ROW.r2, { control_type: '03', comm_type: '01', ...F_SPR });
  const hwExp   = B('data_const', t('udsTpl.fl.hwExpected'), cx(3), ROW.r2 + AUX, { value: '', format: 'text' });
  const hwCmp   = B('data_compare', t('udsTpl.fl.hwCompare'), cx(4), ROW.r2 + AUX, { operator: 'ascii_equals', pass_if_right_empty: true });
  const hwBad   = B('log', t('udsTpl.fl.hwMismatch'), cx(5), ROW.r2 + AUX, { message: t('udsTpl.fl.hwMismatchMsg') });

  W(spareLog, 'exec_out', swOld);
  chain([swOld, 'exec_out'], [swLog, 'exec_out'], [hw, 'exec_out'], [hwLog, 'exec_out'], [hwCond, '']);
  W(swOld, 'data_out', swLog, 'value_in');
  W(hw, 'data_out', hwLog, 'value_in');
  W(hw, 'data_out', hwCmp, 'left_in');
  W(hwExp, 'value_out', hwCmp, 'right_in');
  W(hwCmp, 'result_out', hwCond, 'bool_in');
  W(hwCond, 'true_out', precond);
  W(hwCond, 'false_out', hwBad);
  G(hwBad, 'exec_out', termSafe);
  chain([precond, 'exec_out'], [dtcOff, 'exec_out'], [commOff, '']);

  // ── B · Programming session  +  C · Download (row 3) ───────────────────────
  const hdrB    = B('log', t('udsTpl.fl.hdrB'), cx(0), ROW.r3, { message: t('udsTpl.fl.hdrBMsg') });
  const prog    = B('uds_session', t('udsTpl.fl.progSession'), cx(1), ROW.r3, { session_type: 'programming', req_timeout_ms: 5000 });
  const waitBoot= B('uds_wait_ecu_ready', t('udsTpl.fl.waitBoot'), cx(2), ROW.r3, {
    initial_delay_ms: 500, poll_ms: 250, timeout_ms: 10000, probe: '3E00', probe_session: '02', probe_timeout_ms: 300,
  });
  const sec     = B('uds_security_access', t('udsTpl.fl.security'), cx(3), ROW.r3, { access_level: '11', algorithm: 'xor_ff', constant: '5A3C1E8F', script: '' });
  const fp      = B('data_fingerprint', t('udsTpl.fl.fingerprint'), cx(3), ROW.r3 + AUX, {
    format: 'iso_f15a', serial: 'NEXUS1', serial_len: 6, pad: '20', template: '{YY}{MM}{DD} {SERIAL:6}',
  });
  const fpWrite = B('uds_write_did', t('udsTpl.fl.writeFp'), cx(4), ROW.r3, { did: 'F15A' });
  const hdrC    = B('log', t('udsTpl.fl.hdrC'), cx(5), ROW.r3, { message: t('udsTpl.fl.hdrCMsg') });
  const flash   = B('uds_flash_image', t('udsTpl.fl.flash'), cx(6), ROW.r3, {
    file_name: '', format: 'auto', base_address: '00000000', alfid: '44', dfi: '00', max_block_len: 0, retries: 2, transfer_timeout_ms: 0,
    erase_mode: 'per_segment', erase_routine_id: 'FF00', erase_alfid: '44', erase_timeout_ms: 30000,
    erase_busy_retry: 3, erase_busy_delay_ms: 200, erase_expected_status: '',
    verify_mode: 'per_segment_crc32', verify_routine_id: '0202', verify_expected_status: '00', verify_timeout_ms: 5000,
  });
  const deps    = B('uds_routine_ctrl', t('udsTpl.fl.deps'), cx(7), ROW.r3, { control_type: '01', routine_id: 'FF01', expect_status: '00' });

  W(commOff, 'exec_out', hdrB);
  chain([hdrB, 'exec_out'], [prog, 'exec_out'], [waitBoot, 'exec_out'], [sec, '']);
  W(sec, 'success_out', fpWrite);
  W(fp, 'bytes_out', fpWrite, 'data_in');
  chain([fpWrite, 'exec_out'], [hdrC, 'exec_out'], [flash, 'exec_out'], [deps, '']);

  // ── D · Post-programming (row 4: reset, wait, restore network, clear DTCs, re-read version) ──
  const hdrD    = B('log', t('udsTpl.fl.hdrD'), cx(0), ROW.r4, { message: t('udsTpl.fl.hdrDMsg') });
  const reset   = B('uds_ecu_reset', t('udsTpl.fl.reset'), cx(1), ROW.r4, { reset_type: 'hardReset' });
  const waitApp = B('uds_wait_ecu_ready', t('udsTpl.fl.waitApp'), cx(2), ROW.r4, {
    initial_delay_ms: 500, poll_ms: 250, timeout_ms: 15000, probe: '3E00', probe_session: '03', probe_timeout_ms: 300,
  });
  const ext2    = B('uds_session', t('udsTpl.fl.extSession'), cx(3), ROW.r4, { session_type: 'extended' });
  const commOn  = B('uds_comm_control', t('udsTpl.fl.commOnF'), cx(4), ROW.r4, { control_type: '00', comm_type: '01', ...F_SPR });
  const dtcOn   = B('uds_dtc_setting', t('udsTpl.fl.dtcOnF'), cx(5), ROW.r4, { setting_type: '01', ...F_SPR });
  const clr     = B('uds_clear_dtc', t('udsTpl.fl.clearDtc'), cx(6), ROW.r4, { group: 'FFFFFF' });
  const swNew   = B('uds_read_did', t('udsTpl.fl.readSwAfter'), cx(7), ROW.r4, { did: 'F189' });

  W(deps, 'exec_out', hdrD);
  chain([hdrD, 'exec_out'], [reset, 'exec_out'], [waitApp, 'exec_out'], [ext2, 'exec_out'], [commOn, 'exec_out'],
    [dtcOn, 'exec_out'], [clr, 'exec_out'], [swNew, '']);

  // ── D · Version check + finish (row 5) ─────────────────────────────────────
  const chgCond = B('condition', t('udsTpl.fl.swChanged'), cx(0), ROW.r5);
  const chgCmp  = B('data_compare', t('udsTpl.fl.swCompare'), cx(0), ROW.r5 + AUX, { operator: 'bytes_not_equal', pass_if_right_empty: false });
  const chgLog  = B('log', t('udsTpl.fl.swChangedLog'), cx(1), ROW.r5, { message: t('udsTpl.fl.swChangedMsg') });
  const sameLog = B('log', t('udsTpl.fl.swSameLog'), cx(1), ROW.r5 + AUX, { message: t('udsTpl.fl.swSameMsg') });
  const expCond = B('condition', t('udsTpl.fl.swExpectedOk'), cx(2), ROW.r5);
  const expCmp  = B('data_compare', t('udsTpl.fl.swExpCompare'), cx(2), ROW.r5 + AUX, { operator: 'ascii_equals', pass_if_right_empty: true });
  const swExp   = B('data_const', t('udsTpl.fl.swExpected'), cx(3), ROW.r5 + AUX, { value: '', format: 'text' });
  const expBad  = B('log', t('udsTpl.fl.swMismatch'), cx(4), ROW.r5 + AUX, { message: t('udsTpl.fl.swMismatchMsg') });
  const def     = B('uds_session', t('udsTpl.fl.defaultSession'), cx(3), ROW.r5, { session_type: 'default' });
  const kaOff   = B('uds_tester_present_keepalive', t('udsTpl.fl.kaStop'), cx(4), ROW.r5, { action: 'stop', interval_ms: 2000 });
  const okLog   = B('log', t('udsTpl.fl.ok'), cx(5), ROW.r5, { message: t('udsTpl.fl.okMsg') });
  const end     = B('end', t('diagBlk.end'), cx(6), ROW.r5);

  W(swNew, 'exec_out', chgCond);
  W(swOld, 'data_out', chgCmp, 'left_in');
  W(swNew, 'data_out', chgCmp, 'right_in');
  W(chgCmp, 'result_out', chgCond, 'bool_in');
  W(chgCond, 'true_out', chgLog);
  W(chgCond, 'false_out', sameLog);
  W(swNew, 'data_out', chgLog, 'value_in');
  W(swNew, 'data_out', sameLog, 'value_in');
  W(chgLog, 'exec_out', expCond);
  W(sameLog, 'exec_out', expCond);
  W(swNew, 'data_out', expCmp, 'left_in');
  W(swExp, 'value_out', expCmp, 'right_in');
  W(expCmp, 'result_out', expCond, 'bool_in');
  W(expCond, 'true_out', def);
  W(expCond, 'false_out', expBad);
  W(swNew, 'data_out', expBad, 'value_in');
  G(expBad, 'exec_out', termPost);
  chain([def, 'exec_out'], [kaOff, 'exec_out'], [okLog, 'exec_out'], [end, '']);
  W(swNew, 'data_out', okLog, 'value_in');

  // ── Error routing ──────────────────────────────────────────────────────────
  // Before the first erase (application untouched): SAFE ABORT.
  for (const b of [ext1, kaOn, vin, spare, swOld, hw, precond, dtcOff, commOff, prog, fpWrite]) G(b, 'error_out', termSafe);
  G(waitBoot, 'timeout_out', termSafe);
  G(sec, 'error_out', termSafe);
  // Erase / download / verify / dependency check / reset / boot wait: ECU IN BOOTLOADER.
  G(flash, 'fail_out', termBoot);
  G(deps, 'error_out', termBoot);
  G(reset, 'error_out', termBoot);
  G(waitApp, 'timeout_out', termBoot);
  // The new application answered: POST-PROGRAMMING warning lane.
  for (const b of [ext2, commOn, dtcOn, clr, swNew, def, kaOff]) G(b, 'error_out', termPost);

  return {
    id: 'ecu_flasher',
    nameKey: 'diagTpl.ecuFlasher.name',
    descriptionKey: 'diagTpl.ecuFlasher.desc',
    category: 'firmware',
    icon: 'HardDrive',
    diagram: { blocks, connections },
  };
}

// ─── ECU FLASHER (minimal, simulator / quick tests) ──────────────────────────

function buildEcuFlasherMinimal(): FlowTemplate {
  // Short sequence: Ext session (10 03) → DTCSetting off (85 02) → CommControl off (28 03)
  // → Programming session (10 02) → Security → Erase (31 01 FF00) → Flash Image → CheckMemory (31 01 0202, CRC32) → Reset (11 01)

  const start      = makeBlock('start',               t('diagBlk.start'),                   100,  200);
  const extSession = makeBlock('uds_session',         'Extended Session (10 03)',  350,  200, { session_type: 'extended' });
  const dtcOff     = makeBlock('uds_dtc_setting',     'DTC Setting OFF (85 02)',   600,  200, { setting_type: '02' });
  const commOff    = makeBlock('uds_comm_control',    t('diagTpl.commOff'),               850,  200, { control_type: '03', comm_type: '01' });
  const progSession= makeBlock('uds_session',         'Programming Session (10 02)', 1100, 200, { session_type: 'programming' });
  const security   = makeBlock('uds_security_access', 'Security Access L1',       1350,  200, { access_level: '11', algorithm: 'xor_ff' });
  const erase      = makeBlock('uds_routine_ctrl',    t('diagTpl.eraseMemory'),         1600,  200, { control_type: '01', routine_id: 'FF00' });
  const flash      = makeBlock('uds_flash_image',     t('flash.block.short'),            1850,  200, {
    file_name: '', format: 'auto', base_address: '00000000', alfid: '44', dfi: '00', max_block_len: 0, retries: 2, transfer_timeout_ms: 0,
  });
  const checkProg  = makeBlock('uds_routine_ctrl',    'Check Memory (0202)',       2100,  200, { control_type: '01', routine_id: '0202' });
  const reset      = makeBlock('uds_ecu_reset',       'Hard Reset (11 01)',        2350,  200, { reset_type: 'hardReset' });
  const end        = makeBlock('end',                 t('diagBlk.end'),                    2600,  200);
  const logErr     = makeBlock('log',                 t('diagTpl.flashError'),              1850,  520, { message: t('diagTpl.flashErrorMsg') });

  const blocks = [start, extSession, dtcOff, commOff, progSession, security, erase, flash, checkProg, reset, end, logErr];

  const connections: FlowConnection[] = [
    conn(start,       'exec_out',    extSession,  'exec_in'),
    conn(extSession,  'exec_out',    dtcOff,      'exec_in'),
    conn(dtcOff,      'exec_out',    commOff,     'exec_in'),
    conn(commOff,     'exec_out',    progSession, 'exec_in'),
    conn(progSession, 'exec_out',    security,    'exec_in'),
    conn(security,    'success_out', erase,       'exec_in'),
    conn(erase,       'exec_out',    flash,       'exec_in'),
    conn(flash,       'exec_out',    checkProg,   'exec_in'),
    conn(flash,       'crc32',       checkProg,   'option_in'),
    conn(checkProg,   'exec_out',    reset,       'exec_in'),
    conn(reset,       'exec_out',    end,         'exec_in'),
    // error paths
    conn(extSession,  'error_out',   logErr,      'exec_in'),
    conn(dtcOff,      'error_out',   logErr,      'exec_in'),
    conn(commOff,     'error_out',   logErr,      'exec_in'),
    conn(progSession, 'error_out',   logErr,      'exec_in'),
    conn(security,    'error_out',   logErr,      'exec_in'),
    conn(erase,       'error_out',   logErr,      'exec_in'),
    conn(flash,       'fail_out',    logErr,      'exec_in'),
    conn(checkProg,   'error_out',   logErr,      'exec_in'),
    conn(logErr,      'exec_out',    end,         'exec_in'),
  ];

  return {
    id: 'ecu_flasher_minimal',
    nameKey: 'udsTpl.min.name',
    descriptionKey: 'udsTpl.min.desc',
    category: 'firmware',
    icon: 'HardDrive',
    diagram: { blocks, connections },
  };
}

// ─── DTC RAPORU ──────────────────────────────────────────────────────────────

function buildDtcReport(): FlowTemplate {
  const start   = makeBlock('start',        t('diagBlk.start'),          100, 200);
  const session  = makeBlock('uds_session', 'Session Control', 350, 200, { session_type: 'extended' });
  const readDtc = makeBlock('uds_read_dtc', t('diagTpl.readDtc'),         600, 200, { sub_fn: '02', status_mask: 'FF' });
  const display = makeBlock('io_display',   t('diagTpl.showDtc'),      850, 200);
  const end     = makeBlock('end',          t('diagBlk.end'),          1100, 200);

  const blocks = [start, session, readDtc, display, end];
  const connections: FlowConnection[] = [
    conn(start,   'exec_out',    session,  'exec_in'),
    conn(session, 'exec_out',    readDtc,  'exec_in'),
    conn(readDtc, 'exec_out',    display,  'exec_in'),
    conn(readDtc, 'dtc_list_out',display,  'value_in'),
    conn(display, 'exec_out',    end,      'exec_in'),
  ];

  return {
    id: 'dtc_report',
    nameKey: 'diagTpl.dtcReport.name',
    descriptionKey: 'diagTpl.dtcReport.desc',
    category: 'diagnostics',
    icon: 'AlertTriangle',
    diagram: { blocks, connections },
  };
}

// ─── ECU KİMLİK OKUMA ────────────────────────────────────────────────────────

function buildEcuIdentity(): FlowTemplate {
  const start    = makeBlock('start',        t('diagBlk.start'),               100, 200);
  const session  = makeBlock('uds_session',  'Session Control',      350, 200, { session_type: 'extended' });
  const readVin  = makeBlock('uds_read_did', t('diagTpl.readVin'),       600, 200, { did: 'F190' });
  const dispVin  = makeBlock('io_display',   t('diagTpl.showVin'),           850, 200);
  const readSw   = makeBlock('uds_read_did', t('diagTpl.readSw'),  1100, 200, { did: 'F188' });
  const dispSw   = makeBlock('io_display',   t('diagTpl.showSw'),      1350, 200);
  const end      = makeBlock('end',          t('diagBlk.end'),               1600, 200);

  const blocks = [start, session, readVin, dispVin, readSw, dispSw, end];
  const connections: FlowConnection[] = [
    conn(start,   'exec_out', session, 'exec_in'),
    conn(session, 'exec_out', readVin, 'exec_in'),
    conn(readVin, 'exec_out', dispVin, 'exec_in'),
    conn(readVin, 'data_out', dispVin, 'value_in'),
    conn(dispVin, 'exec_out', readSw,  'exec_in'),
    conn(readSw,  'exec_out', dispSw,  'exec_in'),
    conn(readSw,  'data_out', dispSw,  'value_in'),
    conn(dispSw,  'exec_out', end,     'exec_in'),
  ];

  return {
    id: 'ecu_identity',
    nameKey: 'diagTpl.ecuIdentity.name',
    descriptionKey: 'diagTpl.ecuIdentity.desc',
    category: 'diagnostics',
    icon: 'IdCard',
    diagram: { blocks, connections },
  };
}

// ─── TAM TANILAMATIC ─────────────────────────────────────────────────────────

function buildFullDiag(): FlowTemplate {
  const start     = makeBlock('start',        t('diagBlk.start'),              100, 200);
  const session   = makeBlock('uds_session',  'Session Control',     350, 200, { session_type: 'extended' });
  const readDtc   = makeBlock('uds_read_dtc', t('diagTpl.readDtc'),             600, 200, { sub_fn: '02', status_mask: 'FF' });
  const logDtc    = makeBlock('log',          t('diagTpl.dtcResults'),       850, 200, { message: t('diagTpl.dtcListRead') });
  const readDid   = makeBlock('uds_read_did', t('diagTpl.readDid'),       1100, 200, { did: 'F190' });
  const display   = makeBlock('io_display',   t('diagTpl.showDid'),         1350, 200);
  const clearDtc  = makeBlock('uds_clear_dtc',t('diagTpl.clearDtc'),        1600, 200, { group: 'FFFFFF' });
  const end       = makeBlock('end',          t('diagBlk.end'),              1850, 200);

  const blocks = [start, session, readDtc, logDtc, readDid, display, clearDtc, end];
  const connections: FlowConnection[] = [
    conn(start,    'exec_out',    session,  'exec_in'),
    conn(session,  'exec_out',    readDtc,  'exec_in'),
    conn(readDtc,  'exec_out',    logDtc,   'exec_in'),
    conn(readDtc,  'dtc_list_out',logDtc,   'value_in'),
    conn(logDtc,   'exec_out',    readDid,  'exec_in'),
    conn(readDid,  'exec_out',    display,  'exec_in'),
    conn(readDid,  'data_out',    display,  'value_in'),
    conn(display,  'exec_out',    clearDtc, 'exec_in'),
    conn(clearDtc, 'exec_out',    end,      'exec_in'),
  ];

  return {
    id: 'full_diag',
    nameKey: 'diagTpl.fullDiag.name',
    descriptionKey: 'diagTpl.fullDiag.desc',
    category: 'diagnostics',
    icon: 'ClipboardList',
    diagram: { blocks, connections },
  };
}

// ─── EXAMPLES (core block pack, diag-workspace-v1 §8.1 golden flows) ───────────

const EX_X = [80, 340, 600, 860, 1120, 1380] as const;

/** 1. Counter 0 -> 99: var x = 0; while x < 100: log "x = {x}"; x = x + 1. */
function buildExCounter(): FlowTemplate {
  const start = makeBlock('start', t('diagBlk.start'), EX_X[0], 160);
  const get = makeBlock('var_get', 'x', EX_X[0], 420, { name: 'x' });
  const hundred = makeBlock('data_const', '100', EX_X[0], 560, { value: '100', format: 'dec' });
  const lt = makeBlock('data_compare', 'x < 100', EX_X[1], 460, { operator: 'lt', pass_if_right_empty: false });
  const loop = makeBlock('flow_while', t('diagBlk.whileLoop'), EX_X[2], 160, { max_iterations: 1000 });
  const lg = makeBlock('log', t('diagBlk.writeToLog'), EX_X[3], 160, { message: 'x = {x}' });
  const inc = makeBlock('var_set', 'x = x + 1', EX_X[4], 160, { name: 'x', mode: 'add', amount: 1 });
  const end = makeBlock('end', t('diagBlk.end'), EX_X[3], 360);
  return {
    id: 'ex_counter',
    nameKey: 'flowCore.tpl.counter.name',
    descriptionKey: 'flowCore.tpl.counter.desc',
    category: 'examples',
    icon: 'Calculator',
    diagram: {
      variables: [{ name: 'x', type: 'number', initial: '0' }],
      blocks: [start, get, hundred, lt, loop, lg, inc, end],
      connections: [
        conn(start, 'exec_out', loop, 'exec_in'),
        conn(get, 'value', lt, 'left_in'),
        conn(hundred, 'value_out', lt, 'right_in'),
        conn(lt, 'result_out', loop, 'bool_in'),
        conn(loop, 'body_out', lg, 'exec_in'),
        conn(lg, 'exec_out', inc, 'exec_in'),
        conn(loop, 'done_out', end, 'exec_in'),
      ],
    },
  };
}

/** 2. for 1..10, break at index == 5, log "i = {value}" otherwise. */
function buildExForBreak(): FlowTemplate {
  const start = makeBlock('start', t('diagBlk.start'), EX_X[0], 160);
  const loop = makeBlock('flow_for', t('flowCore.blk.flowFor'), EX_X[1], 160, { from: 1, to: 10, step: 1 });
  const five = makeBlock('data_const', '5', EX_X[1], 420, { value: '5', format: 'dec' });
  const eq = makeBlock('data_compare', 'index == 5', EX_X[2], 360, { operator: 'eq', pass_if_right_empty: false });
  const cond = makeBlock('condition', t('diagBlk.condition'), EX_X[3], 160);
  const brk = makeBlock('flow_break', t('flowCore.blk.flowBreak'), EX_X[4], 160);
  const lg = makeBlock('log', t('diagBlk.writeToLog'), EX_X[4], 360, { message: 'i = {value}' });
  const end = makeBlock('end', t('diagBlk.end'), EX_X[2], 160);
  return {
    id: 'ex_for_break',
    nameKey: 'flowCore.tpl.forBreak.name',
    descriptionKey: 'flowCore.tpl.forBreak.desc',
    category: 'examples',
    icon: 'Repeat',
    diagram: {
      blocks: [start, loop, five, eq, cond, brk, lg, end],
      connections: [
        conn(start, 'exec_out', loop, 'exec_in'),
        conn(loop, 'index', eq, 'left_in'),
        conn(five, 'value_out', eq, 'right_in'),
        conn(eq, 'result_out', cond, 'bool_in'),
        conn(loop, 'body_out', cond, 'exec_in'),
        conn(cond, 'true_out', brk, 'exec_in'),
        conn(cond, 'false_out', lg, 'exec_in'),
        conn(loop, 'index', lg, 'value_in'),
        conn(loop, 'done_out', end, 'exec_in'),
      ],
    },
  };
}

/** 3. sum = sum + index for 1..100, then log "sum = {sum}" (5050). */
function buildExSum(): FlowTemplate {
  const start = makeBlock('start', t('diagBlk.start'), EX_X[0], 160);
  const loop = makeBlock('flow_for', t('flowCore.blk.flowFor'), EX_X[1], 160, { from: 1, to: 100, step: 1 });
  const add = makeBlock('var_set', 'sum = sum + index', EX_X[2], 160, { name: 'sum', mode: 'add', amount: 1 });
  const lg = makeBlock('log', t('diagBlk.writeToLog'), EX_X[2], 360, { message: 'sum = {sum}' });
  const end = makeBlock('end', t('diagBlk.end'), EX_X[3], 360);
  return {
    id: 'ex_sum',
    nameKey: 'flowCore.tpl.sum.name',
    descriptionKey: 'flowCore.tpl.sum.desc',
    category: 'examples',
    icon: 'Sigma',
    diagram: {
      variables: [{ name: 'sum', type: 'number', initial: '0' }],
      blocks: [start, loop, add, lg, end],
      connections: [
        conn(start, 'exec_out', loop, 'exec_in'),
        conn(loop, 'body_out', add, 'exec_in'),
        conn(loop, 'index', add, 'value_in'),
        conn(loop, 'done_out', lg, 'exec_in'),
        conn(lg, 'exec_out', end, 'exec_in'),
      ],
    },
  };
}

/** 4. Extended session -> read F190 -> convert to text -> text_format "VIN = {vin}" -> log. */
function buildExDid(): FlowTemplate {
  const start = makeBlock('start', t('diagBlk.start'), EX_X[0], 160);
  const ses = makeBlock('uds_session', 'Extended Session (10 03)', EX_X[1], 160, { session_type: 'extended' });
  const rd = makeBlock('uds_read_did', t('diagTpl.readVin'), EX_X[2], 160, { did: 'F190' });
  const cv = makeBlock('convert', t('flowCore.blk.convert'), EX_X[2], 420, { target: 'text', byteLength: 1, endianness: 'big' });
  const fmt = makeBlock('text_format', t('flowCore.tpl.vinLabel'), EX_X[3], 420, { template: 'VIN = {vin}', inputs: ['vin'] });
  const lg = makeBlock('log', t('diagBlk.writeToLog'), EX_X[4], 160, { message: '{value}' });
  const end = makeBlock('end', t('diagBlk.end'), EX_X[5], 160);
  return {
    id: 'ex_did_format',
    nameKey: 'flowCore.tpl.did.name',
    descriptionKey: 'flowCore.tpl.did.desc',
    category: 'examples',
    icon: 'Type',
    diagram: {
      blocks: [start, ses, rd, cv, fmt, lg, end],
      connections: [
        conn(start, 'exec_out', ses, 'exec_in'),
        conn(ses, 'exec_out', rd, 'exec_in'),
        conn(rd, 'exec_out', lg, 'exec_in'),
        conn(rd, 'data_out', cv, 'value_in'),
        conn(cv, 'value', fmt, 'vin'),
        conn(fmt, 'text_out', lg, 'value_in'),
        conn(lg, 'exec_out', end, 'exec_in'),
      ],
    },
  };
}

/**
 * Block labels / messages inside a template are resolved with the active locale.
 * The diagram is therefore built lazily and cached per locale (a single build per
 * locale keeps block/connection ids consistent between reads).
 */
function lazyTemplate(build: () => FlowTemplate): FlowTemplate {
  const meta = build();
  let cache: { locale: string; diagram: FlowTemplate['diagram'] } | null = null;
  return {
    ...meta,
    get diagram(): FlowTemplate['diagram'] {
      const locale = getLocale();
      if (!cache || cache.locale !== locale) cache = { locale, diagram: build().diagram };
      return cache.diagram;
    },
  };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  lazyTemplate(buildEcuFlasher),
  lazyTemplate(buildEcuFlasherMinimal),
  lazyTemplate(buildDtcReport),
  lazyTemplate(buildEcuIdentity),
  lazyTemplate(buildFullDiag),
  lazyTemplate(buildExCounter),
  lazyTemplate(buildExForBreak),
  lazyTemplate(buildExSum),
  lazyTemplate(buildExDid),
];
