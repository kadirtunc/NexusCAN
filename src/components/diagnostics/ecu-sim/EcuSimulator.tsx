import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Activity, AlertTriangle, BellOff, Cpu, Database, Lock, LockOpen,
  Network, Plus, Radio, RefreshCw, Send, Shield,
  Timer, Trash2, X, Zap,
} from 'lucide-react';
import { useI18n } from '../../../i18n';
import { ecuSimStore, useEcuSimStore } from './ecuSimStore';
import type { SimSession, SimDid, SimDtc, SimSecurityLevel, SimLogEntry } from './ecuSimStore';
import {
  DIAG_BTN,
  DIAG_BTN_DANGER,
  DIAG_BTN_SM,
  DIAG_DIVIDER,
  DIAG_GRID,
  DIAG_INPUT,
  DIAG_ROW_HOVER,
  DIAG_SECTION_TITLE,
  DIAG_SUBBAR,
  DIAG_TEXT_TONE,
  DIAG_TITLE,
  DIAG_TOOLBAR,
  DiagBadge,
  DiagEmptyState,
  diagToneButtonClass,
  type DiagTone,
} from '../diagUi';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hex2(n: number): string { return n.toString(16).toUpperCase().padStart(2, '0'); }

function formatTs(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}.${d.getMilliseconds().toString().padStart(3,'0')}`;
}

const SESSION_TONE: Record<SimSession, DiagTone> = {
  default:     'neutral',
  extended:    'focus',
  programming: 'warn',
};

const SESSION_LABELS: Record<SimSession, string> = {
  default:     'DEFAULT',
  extended:    'EXTENDED',
  programming: 'PROGRAMMING',
};

const LOG_TONE: Record<SimLogEntry['level'], DiagTone> = {
  tx:   'focus',
  rx:   'nominal',
  nrc:  'critical',
  info: 'neutral',
  warn: 'warn',
};

/** Borderless inline-edit field used inside grid cells. */
const CELL_INPUT =
  'h-[24px] w-full rounded-[2px] border border-transparent bg-transparent px-1 font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-subtle hover:border-hairline focus:border-focus focus:bg-canvas';

/** Compact numeric field for the timing section. */
const SMALL_INPUT = `${DIAG_INPUT} !h-[26px] flex-1`;

// ─── Sub-panels ───────────────────────────────────────────────────────────────

const ToggleRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  stateLabel: string;
  tone: DiagTone;
  onToggle: () => void;
}> = ({ icon, label, stateLabel, tone, onToggle }) => (
  <div className="flex h-[34px] items-center justify-between rounded-[2px] border border-hairline bg-canvas px-3">
    <span className="flex items-center gap-2 text-[12px] text-ink">
      {icon}
      {label}
    </span>
    <button type="button" onClick={onToggle} className={diagToneButtonClass(tone, true, 'sm')}>
      {stateLabel}
    </button>
  </div>
);

const StatePanel: React.FC = () => {
  const { t } = useI18n();
  const st = useEcuSimStore();

  const sessions: SimSession[] = ['default', 'extended', 'programming'];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">

      {/* Session */}
      <section>
        <div className={`${DIAG_SECTION_TITLE} mb-1.5`}>{t('diagHmi.sim.secSession')}</div>
        <div className="flex gap-1.5">
          {sessions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ecuSimStore.setSession(s)}
              className={`${diagToneButtonClass(SESSION_TONE[s], st.session === s)} flex-1`}
            >
              {SESSION_LABELS[s]}
            </button>
          ))}
        </div>
      </section>

      {/* ECU flags */}
      <section>
        <div className={`${DIAG_SECTION_TITLE} mb-1.5`}>{t('diagHmi.sim.secState')}</div>
        <div className="flex flex-col gap-1.5">
          <ToggleRow
            icon={<Radio className={`h-3.5 w-3.5 ${st.commControlEnabled ? 'text-nominal' : 'text-critical'}`} aria-hidden="true" />}
            label={t('diagHmi.sim.commControl')}
            stateLabel={st.commControlEnabled ? t('diagHmi.sim.enabled') : t('diagHmi.sim.disabled')}
            tone={st.commControlEnabled ? 'nominal' : 'critical'}
            onToggle={() => ecuSimStore.setCommControl(!st.commControlEnabled)}
          />
          <ToggleRow
            icon={<BellOff className={`h-3.5 w-3.5 ${st.dtcSettingEnabled ? 'text-nominal' : 'text-critical'}`} aria-hidden="true" />}
            label={t('diagHmi.sim.dtcSetting')}
            stateLabel={st.dtcSettingEnabled ? t('diagHmi.sim.on') : t('diagHmi.sim.off')}
            tone={st.dtcSettingEnabled ? 'nominal' : 'critical'}
            onToggle={() => ecuSimStore.setDtcSetting(!st.dtcSettingEnabled)}
          />
          <ToggleRow
            icon={<Activity className="h-3.5 w-3.5 text-warn" aria-hidden="true" />}
            label={t('diagHmi.sim.busyMode')}
            stateLabel={st.busyMode ? t('diagHmi.sim.active') : t('diagHmi.sim.off')}
            tone={st.busyMode ? 'warn' : 'neutral'}
            onToggle={() => ecuSimStore.setBusyMode(!st.busyMode)}
          />
        </div>
      </section>

      {/* Timing */}
      <section>
        <div className={`${DIAG_SECTION_TITLE} mb-1.5 flex items-center gap-1.5`}>
          <Timer className="h-3 w-3" aria-hidden="true" /> {t('diagHmi.sim.secTiming')}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2">
            <span className="w-20 font-mono text-[11.5px] text-muted">P2 (ms)</span>
            <input
              type="number"
              min={1} max={999}
              value={st.p2Ms}
              onChange={(e) => ecuSimStore.setTiming(Number(e.target.value), st.p2extMs)}
              className={SMALL_INPUT}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-20 font-mono text-[11.5px] text-muted">P2* (ms)</span>
            <input
              type="number"
              min={10} max={9999}
              value={st.p2extMs}
              onChange={(e) => ecuSimStore.setTiming(st.p2Ms, Number(e.target.value))}
              className={SMALL_INPUT}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-20 font-mono text-[11.5px] text-muted">NRC %</span>
            <input
              type="number"
              min={0} max={100}
              value={st.nrcInjectRate}
              onChange={(e) => ecuSimStore.setNrcRate(Number(e.target.value))}
              className={SMALL_INPUT}
            />
          </label>
        </div>
      </section>

      {/* Reset */}
      <button type="button" onClick={() => ecuSimStore.resetState()} className={`${DIAG_BTN_DANGER} mt-auto`}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        {t('diagHmi.sim.resetEcu')}
      </button>

    </div>
  );
};

// ─── DID Store Panel ──────────────────────────────────────────────────────────

const DidStorePanel: React.FC = () => {
  const { t } = useI18n();
  const st = useEcuSimStore();

  return (
    <div className="flex h-full flex-col overflow-hidden">

      <div className={DIAG_SUBBAR}>
        <Database className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
        <span className={DIAG_TITLE}>{t('diagHmi.sim.didStore')}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-subtle">({st.dids.length})</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => ecuSimStore.resetDids()}
          className={DIAG_BTN_SM}
          title={t('diagHmi.sim.resetDefault')}
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => ecuSimStore.addDid()} className={DIAG_BTN_SM}>
          <Plus className="h-3 w-3" aria-hidden="true" /> DID
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className={DIAG_GRID}>
          <colgroup>
            <col style={{ width: 70 }} />
            <col style={{ width: 130 }} />
            <col />
            <col style={{ width: 64 }} />
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr>
              <th>DID</th>
              <th className="font-sans">{t('diagHmi.sim.colName')}</th>
              <th className="font-sans">{t('diagHmi.sim.colValue')}</th>
              <th className="text-center">R/W</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {st.dids.map((did: SimDid) => (
              <tr key={did.id} className={DIAG_ROW_HOVER}>
                <td>
                  <div className="pcan-cell">
                    <input
                      value={did.did}
                      onChange={(e) => ecuSimStore.updateDid(did.id, { did: e.target.value.toUpperCase().slice(0, 4) })}
                      className={`${CELL_INPUT} text-focus`}
                      maxLength={4}
                    />
                  </div>
                </td>
                <td>
                  <div className="pcan-cell">
                    <input
                      value={did.name}
                      onChange={(e) => ecuSimStore.updateDid(did.id, { name: e.target.value })}
                      className={`${CELL_INPUT} font-sans`}
                    />
                  </div>
                </td>
                <td>
                  <div className="pcan-cell">
                    <input
                      value={did.value}
                      onChange={(e) => ecuSimStore.updateDid(did.id, { value: e.target.value })}
                      className={CELL_INPUT}
                    />
                  </div>
                </td>
                <td>
                  <div className="pcan-cell pcan-cell-center">
                    <button
                      type="button"
                      onClick={() => ecuSimStore.updateDid(did.id, { writable: !did.writable })}
                      className={diagToneButtonClass(did.writable ? 'nominal' : 'neutral', true, 'sm')}
                    >
                      {did.writable ? 'R/W' : 'R'}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="pcan-cell pcan-cell-center">
                    <button
                      type="button"
                      onClick={() => ecuSimStore.removeDid(did.id)}
                      className="cursor-pointer text-subtle hover:text-critical"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
};

// ─── DTC Inject Panel ─────────────────────────────────────────────────────────

const DtcPanel: React.FC = () => {
  const { t } = useI18n();
  const st = useEcuSimStore();
  const activeDtcs = st.dtcs.filter((d) => d.present).length;

  return (
    <div className="flex h-full flex-col overflow-hidden">

      <div className={DIAG_SUBBAR}>
        <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden="true" />
        <span className={DIAG_TITLE}>{t('diagHmi.sim.dtcInject')}</span>
        <DiagBadge tone={activeDtcs > 0 ? 'critical' : 'neutral'}>
          {t('diagHmi.sim.dtcActive', { n: activeDtcs })}
        </DiagBadge>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => ecuSimStore.clearAllDtcs()}
          className={DIAG_BTN_SM}
          title={t('diagHmi.sim.clearAll')}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => ecuSimStore.addDtc()} className={DIAG_BTN_SM}>
          <Plus className="h-3 w-3" aria-hidden="true" /> DTC
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className={DIAG_GRID}>
          <colgroup>
            <col style={{ width: 34 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 56 }} />
            <col />
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>DTC</th>
              <th>{t('diagHmi.uds.colBytes')}</th>
              <th>ST</th>
              <th className="font-sans">{t('diag.dtc.colDescription')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {st.dtcs.map((dtc: SimDtc) => (
              <tr key={dtc.id} className={DIAG_ROW_HOVER}>
                <td>
                  <div className="pcan-cell pcan-cell-center">
                    <button
                      type="button"
                      onClick={() => ecuSimStore.updateDtc(dtc.id, { present: !dtc.present })}
                      aria-pressed={dtc.present}
                      className={`flex h-4 w-4 cursor-pointer items-center justify-center rounded-[2px] border ${
                        dtc.present
                          ? 'border-critical bg-[var(--status-critical-bg)]'
                          : 'border-strong bg-canvas'
                      }`}
                    >
                      {dtc.present && <span className="text-[10px] font-bold leading-none text-critical">✓</span>}
                    </button>
                  </div>
                </td>
                <td>
                  <div className="pcan-cell">
                    <input
                      value={dtc.code}
                      onChange={(e) => ecuSimStore.updateDtc(dtc.id, { code: e.target.value.toUpperCase().slice(0, 6) })}
                      className={`${CELL_INPUT} ${dtc.present ? 'text-critical' : 'text-muted'}`}
                    />
                  </div>
                </td>
                <td>
                  <div className="pcan-cell text-[11.5px] text-subtle">{dtc.raw.match(/.{2}/g)?.join(' ')}</div>
                </td>
                <td>
                  <div className="pcan-cell text-[11.5px] text-muted">0x{hex2(dtc.status)}</div>
                </td>
                <td>
                  <div className="pcan-cell">
                    <input
                      value={dtc.description}
                      onChange={(e) => ecuSimStore.updateDtc(dtc.id, { description: e.target.value })}
                      className={`${CELL_INPUT} font-sans text-muted`}
                    />
                  </div>
                </td>
                <td>
                  <div className="pcan-cell pcan-cell-center">
                    <button
                      type="button"
                      onClick={() => ecuSimStore.removeDtc(dtc.id)}
                      className="cursor-pointer text-subtle hover:text-critical"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
};

// ─── Security Panel ───────────────────────────────────────────────────────────

const SecurityPanel: React.FC = () => {
  const { t } = useI18n();
  const st = useEcuSimStore();

  const algOptions = [
    { value: 'xor_ff',       label: 'XOR 0xFF' },
    { value: 'xor_const',    label: t('diagHmi.sim.algXorConst') },
    { value: 'sum_negate',   label: 'Sum Negate' },
    { value: 'add_const',    label: t('diagHmi.sim.algAddConst') },
    { value: 'right_rotate', label: 'Right Rotate' },
    { value: 'crc16',        label: 'CRC-16/IBM' },
    { value: 'crc32',        label: 'CRC-32' },
  ];

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">

      <div className="flex items-center justify-between">
        <span className={`${DIAG_SECTION_TITLE} flex items-center gap-1.5`}>
          <Shield className="h-3 w-3" aria-hidden="true" /> {t('diagHmi.sim.secLevels')}
        </span>
        <button type="button" onClick={() => ecuSimStore.addSecurityLevel()} className={DIAG_BTN_SM}>
          <Plus className="h-3 w-3" aria-hidden="true" /> Level
        </button>
      </div>

      {st.securityLevels.map((lvl: SimSecurityLevel) => (
        <div
          key={lvl.level}
          className={`flex flex-col gap-2 rounded-[2px] border bg-canvas p-3 ${
            lvl.unlocked ? 'border-[color:var(--status-nominal-border)]' : 'border-hairline'
          }`}
        >
          <div className="flex items-center gap-2">
            {lvl.unlocked
              ? <LockOpen className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
              : <Lock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            }
            <span className={`font-mono text-[12px] font-semibold tabular-nums ${lvl.unlocked ? 'text-nominal' : 'text-ink'}`}>
              Level 0x{hex2(lvl.level)} → Key 0x{hex2(lvl.level + 1)}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => lvl.unlocked ? ecuSimStore.lockLevel(lvl.level) : ecuSimStore.unlockLevel(lvl.level)}
              className={diagToneButtonClass(lvl.unlocked ? 'nominal' : 'neutral', true, 'sm')}
            >
              {lvl.unlocked ? t('diagHmi.sim.unlocked') : t('diagHmi.sim.locked')}
            </button>
            <button
              type="button"
              onClick={() => ecuSimStore.removeSecurityLevel(lvl.level)}
              className="cursor-pointer text-subtle hover:text-critical"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>

          <label className="flex items-center gap-2">
            <span className="w-20 text-[11.5px] text-muted">{t('diagHmi.sim.algorithm')}</span>
            <select
              value={lvl.algorithm}
              onChange={(e) => ecuSimStore.updateSecurityLevel(lvl.level, { algorithm: e.target.value as SimSecurityLevel['algorithm'] })}
              className={`${SMALL_INPUT} cursor-pointer`}
            >
              {algOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          {['xor_const','add_const','right_rotate'].includes(lvl.algorithm) && (
            <label className="flex items-center gap-2">
              <span className="w-20 text-[11.5px] text-muted">{t('diagHmi.sim.constant')}</span>
              <input
                value={lvl.constant}
                onChange={(e) => ecuSimStore.updateSecurityLevel(lvl.level, { constant: e.target.value.toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,8) })}
                className={SMALL_INPUT}
                placeholder="5A3C1E8F"
              />
            </label>
          )}

          {lvl.failedAttempts > 0 && (
            <DiagBadge tone="warn">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              {t('diagHmi.sim.failedAttempts', { n: lvl.failedAttempts })}
            </DiagBadge>
          )}
        </div>
      ))}

    </div>
  );
};

// ─── Request Sender ───────────────────────────────────────────────────────────

const QUICK_SIM_PRESETS = [
  { label: 'Sess. Default',  sid: 0x10, subFn: 0x01, data: '' },
  { label: 'Sess. Extended', sid: 0x10, subFn: 0x03, data: '' },
  { label: 'Sess. Prog.',    sid: 0x10, subFn: 0x02, data: '' },
  { label: 'Read VIN',       sid: 0x22, subFn: null,  data: 'F1 90' },
  { label: 'Seed L1',        sid: 0x27, subFn: 0x01, data: '' },
  { label: 'Tester Present', sid: 0x3E, subFn: 0x00, data: '' },
  { label: 'DTC Scan',       sid: 0x19, subFn: 0x02, data: 'FF' },
  { label: 'CommCtrl OFF',   sid: 0x28, subFn: 0x03, data: '01' },
  { label: 'DTC Setting OFF',sid: 0x85, subFn: 0x02, data: '' },
  { label: 'ECU Reset',      sid: 0x11, subFn: 0x01, data: '' },
  { label: 'Erase Mem',      sid: 0x31, subFn: 0x01, data: 'FF 00' },
  { label: 'Req. Download',  sid: 0x34, subFn: null,  data: '00 44 08 00 00 00 24 00 01 00 00' },
];

const RequestSender: React.FC = () => {
  const { t } = useI18n();
  const [sid,    setSid]    = useState('10');
  const [subFn,  setSubFn]  = useState('03');
  const [data,   setData]   = useState('');
  const [hasSubFn, setHasSubFn] = useState(true);

  const handleSend = useCallback(() => {
    const sidVal   = parseInt(sid, 16);
    const subFnVal = hasSubFn ? parseInt(subFn, 16) : null;
    ecuSimStore.simulateRequest(sidVal, subFnVal, data);
  }, [sid, subFn, data, hasSubFn]);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-hairline bg-surface p-3">

      {/* Presets */}
      <div className="flex flex-wrap gap-1">
        {QUICK_SIM_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setSid(p.sid.toString(16).toUpperCase().padStart(2,'0'));
              setHasSubFn(p.subFn !== null);
              setSubFn(p.subFn !== null ? p.subFn.toString(16).toUpperCase().padStart(2,'0') : '');
              setData(p.data);
            }}
            className={DIAG_BTN_SM}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2">
        <span className={`${DIAG_SECTION_TITLE} shrink-0`}>SID</span>
        <input
          value={sid}
          onChange={(e) => setSid(e.target.value.toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,2))}
          className={`${DIAG_INPUT} !w-12 text-center`}
          placeholder="10"
        />

        <button
          type="button"
          onClick={() => setHasSubFn(!hasSubFn)}
          className={diagToneButtonClass('focus', hasSubFn)}
          aria-pressed={hasSubFn}
        >
          SubFn
        </button>

        {hasSubFn && (
          <input
            value={subFn}
            onChange={(e) => setSubFn(e.target.value.toUpperCase().replace(/[^0-9A-F]/g,'').slice(0,2))}
            className={`${DIAG_INPUT} !w-12 text-center`}
            placeholder="00"
          />
        )}

        <input
          value={data}
          onChange={(e) => setData(e.target.value.toUpperCase())}
          className={`${DIAG_INPUT} flex-1`}
          placeholder={t('diagHmi.sim.dataHex')}
        />

        <button type="button" onClick={handleSend} className={DIAG_BTN}>
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.sim.send')}
        </button>
      </div>

    </div>
  );
};

// ─── Log Panel ────────────────────────────────────────────────────────────────

const LOG_DIR_LABEL: Record<SimLogEntry['level'], string> = {
  tx: 'TX↑', rx: 'RX↓', nrc: 'NRC', warn: 'WRN', info: 'INF',
};

const LogPanel: React.FC = () => {
  const { t } = useI18n();
  const st        = useEcuSimStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [st.log, autoScroll]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

      <div className={DIAG_SUBBAR}>
        <Network className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
        <span className={DIAG_TITLE}>{t('diagHmi.sim.logTitle')}</span>
        <span className="font-mono text-[11.5px] tabular-nums text-subtle">({st.log.length})</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setAutoScroll(!autoScroll)}
          className={diagToneButtonClass('focus', autoScroll, 'sm')}
          aria-pressed={autoScroll}
        >
          {t('diagHmi.sim.autoScroll')}
        </button>
        <button type="button" onClick={() => ecuSimStore.clearLog()} className={DIAG_BTN_SM}>
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-surface">
        {st.log.length === 0 ? (
          <DiagEmptyState title={t('diagHmi.sim.logEmpty')} />
        ) : (
          <table className={DIAG_GRID}>
            <colgroup>
              <col style={{ width: 110 }} />
              <col style={{ width: 56 }} />
              <col style={{ width: 200 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>{t('diagHmi.uds.colTime')}</th>
                <th>{t('diagHmi.uds.colDir')}</th>
                <th>{t('diagHmi.uds.colBytes')}</th>
                <th className="font-sans">{t('diagHmi.uds.colDesc')}</th>
              </tr>
            </thead>
            <tbody>
              {st.log.map((entry: SimLogEntry) => (
                <tr key={entry.id} className={DIAG_ROW_HOVER}>
                  <td>
                    <div className="pcan-cell text-[11.5px] text-muted">{formatTs(entry.ts)}</div>
                  </td>
                  <td>
                    <div className="pcan-cell">
                      <DiagBadge tone={LOG_TONE[entry.level]}>{LOG_DIR_LABEL[entry.level]}</DiagBadge>
                    </div>
                  </td>
                  <td>
                    <div className="pcan-cell text-[11.5px] text-muted">{entry.raw || '—'}</div>
                  </td>
                  <td>
                    <div className={`pcan-cell text-[11.5px] ${DIAG_TEXT_TONE[LOG_TONE[entry.level]]}`} title={entry.decoded}>
                      {entry.decoded}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

type SectionId = 'state' | 'dids' | 'dtcs' | 'security';

export const EcuSimulator: React.FC = () => {
  const { t } = useI18n();
  const st = useEcuSimStore();
  const [section, setSection] = useState<SectionId>('state');

  const sectionTabs: ReadonlyArray<{ id: SectionId; label: string; icon: React.ReactNode }> = [
    { id: 'state',    label: t('diagHmi.sim.secState'),   icon: <Cpu className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'dids',     label: t('diagHmi.sim.didStore'),   icon: <Database className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'dtcs',     label: t('diagHmi.sim.dtcInject'),  icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'security', label: t('diagHmi.sim.security'),   icon: <Shield className="h-3.5 w-3.5" aria-hidden="true" /> },
  ];

  const anyUnlocked = st.securityLevels.some((l) => l.unlocked);
  const activeDtcCount = st.dtcs.filter((d) => d.present).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">

      {/* Top toolbar — ECU state overview strip */}
      <div className={`${DIAG_TOOLBAR} gap-3 font-mono text-[12px]`}>
        <span className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          <span className={DIAG_TITLE}>{t('diagHmi.sim.virtualEcu')}</span>
        </span>

        <div className={DIAG_DIVIDER} />

        {/* Session */}
        <DiagBadge tone={SESSION_TONE[st.session]}>{SESSION_LABELS[st.session]}</DiagBadge>

        {/* Security */}
        <span className={`flex items-center gap-1 ${anyUnlocked ? 'text-nominal' : 'text-muted'}`}>
          {anyUnlocked
            ? <LockOpen className="h-3 w-3" aria-hidden="true" />
            : <Lock className="h-3 w-3" aria-hidden="true" />}
          <span>{anyUnlocked ? t('diagHmi.sim.unlocked') : t('diagHmi.sim.locked')}</span>
        </span>

        <div className={DIAG_DIVIDER} />

        {/* Comm */}
        <span className={`flex items-center gap-1 ${st.commControlEnabled ? 'text-nominal' : 'text-critical'}`}>
          <Radio className="h-3 w-3" aria-hidden="true" />
          <span className="text-[11.5px]">{st.commControlEnabled ? 'Comm ON' : 'Comm OFF'}</span>
        </span>

        {/* DTC */}
        <span className={`flex items-center gap-1 ${st.dtcSettingEnabled ? 'text-muted' : 'text-warn'}`}>
          <BellOff className="h-3 w-3" aria-hidden="true" />
          <span className="text-[11.5px]">DTC {st.dtcSettingEnabled ? 'ON' : 'OFF'}</span>
        </span>

        {/* Active DTCs count */}
        {activeDtcCount > 0 && (
          <span className="flex items-center gap-1 text-critical">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            <span className="text-[11.5px] tabular-nums">{activeDtcCount} DTC</span>
          </span>
        )}

        <div className="flex-1" />

        {/* NRC rate indicator */}
        <span className="text-[11.5px] text-subtle">
          NRC inj: <span className="tabular-nums text-muted">{st.nrcInjectRate}%</span>
        </span>
        <span className="text-[11.5px] text-subtle">
          P2: <span className="tabular-nums text-muted">{st.p2Ms}ms</span>
        </span>

        <DiagBadge tone="focus">ISO 14229-1 Sim</DiagBadge>
      </div>

      {/* Main split: left config + right log */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* Left: config sections */}
        <div className="flex w-[420px] shrink-0 flex-col overflow-hidden border-r border-hairline">
          {/* Section tabs */}
          <div className="flex h-8 shrink-0 border-b border-hairline bg-elevated">
            {sectionTabs.map((tab) => {
              const isActive = section === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSection(tab.id)}
                  aria-pressed={isActive}
                  className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 border-b-2 font-mono text-[11.5px] font-semibold uppercase transition-colors ${
                    isActive
                      ? 'border-focus bg-[var(--status-focus-bg)] text-ink'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  {tab.icon}
                  <span className="hidden truncate sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Section content */}
          <div className="min-h-0 flex-1 overflow-hidden bg-surface">
            {section === 'state'    && <StatePanel />}
            {section === 'dids'     && <DidStorePanel />}
            {section === 'dtcs'     && <DtcPanel />}
            {section === 'security' && <SecurityPanel />}
          </div>
        </div>

        {/* Right: request sender + log */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface">
          <RequestSender />
          <LogPanel />
        </div>

      </div>
    </div>
  );
};
