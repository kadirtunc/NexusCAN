import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { cansubProbeHost } from '../../services/ipcClient';
import type { DeviceDescriptorDto } from '../../types/hal';

export interface CansubNetworkConfig {
  host: string | null;
  deviceId: string | null;
  acceptAny: boolean;
}

interface KnownHost {
  host: string;
  deviceId: string | null;
  acceptAny: boolean;
}

interface CansubFieldsProps {
  /** Channels discovered through the regular device flow (`driverId === "cansub"`). */
  discovered: readonly DeviceDescriptorDto[];
  selectedDeviceId: string;
  initialNetwork?: CansubNetworkConfig;
  onSelect: (device: DeviceDescriptorDto, net: CansubNetworkConfig) => void;
}

export const CANSUB_KNOWN_HOSTS_KEY = 'nexuscan.cansub.knownHosts';
const DEVICE_ID_RE = /^[0-9a-fA-F]{8}$/;
const IPV4_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;

function loadKnownHosts(): KnownHost[] {
  try {
    const raw = window.localStorage.getItem(CANSUB_KNOWN_HOSTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: KnownHost[] = [];
    for (const e of parsed as unknown[]) {
      if (typeof e !== 'object' || e === null) continue;
      const r = e as Record<string, unknown>;
      if (typeof r.host !== 'string' || r.host.length === 0) continue;
      out.push({
        host: r.host,
        deviceId: typeof r.deviceId === 'string' && r.deviceId ? r.deviceId : null,
        acceptAny: r.acceptAny === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function saveKnownHosts(list: readonly KnownHost[]): void {
  try {
    window.localStorage.setItem(CANSUB_KNOWN_HOSTS_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: non-fatal
  }
}

function errText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-input)',
  borderColor: 'var(--border-strong)',
  color: 'var(--text-primary)',
};

export const CansubFields: React.FC<CansubFieldsProps> = ({
  discovered,
  selectedDeviceId,
  initialNetwork,
  onSelect,
}) => {
  const { t } = useI18n();
  const [host, setHost] = useState(initialNetwork?.host ?? '');
  const [deviceId, setDeviceId] = useState(initialNetwork?.deviceId ?? '');
  const [acceptAny, setAcceptAny] = useState(initialNetwork?.acceptAny ?? false);
  const [probing, setProbing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [okCount, setOkCount] = useState<number | null>(null);
  const [probed, setProbed] = useState<DeviceDescriptorDto[]>([]);
  const [netById, setNetById] = useState<Record<string, CansubNetworkConfig>>({});
  const [known, setKnown] = useState<KnownHost[]>(() => loadKnownHosts());

  useEffect(() => {
    saveKnownHosts(known);
  }, [known]);

  const channels = useMemo(() => {
    const seen = new Set<string>();
    const out: DeviceDescriptorDto[] = [];
    for (const d of [...discovered, ...probed]) {
      if (d.driverId !== 'cansub' || seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      out.push(d);
    }
    return out;
  }, [discovered, probed]);

  const idTrim = deviceId.trim();
  const idInvalid = idTrim.length > 0 && !DEVICE_ID_RE.test(idTrim);
  const hostTrim = host.trim();
  const hostIsIp = IPV4_HOST_RE.test(hostTrim);
  const needsIdHint =
    error !== null && hostIsIp && idTrim.length === 0 && !acceptAny;

  const runProbe = async (h: string, id: string | null, any: boolean): Promise<void> => {
    setProbing(true);
    setError(null);
    setOkCount(null);
    try {
      const found = await cansubProbeHost({ host: h, deviceId: id, acceptAny: any });
      const net: CansubNetworkConfig = { host: h, deviceId: id, acceptAny: any };
      setNetById((prev) => {
        const next = { ...prev };
        for (const d of found) next[d.deviceId] = net;
        return next;
      });
      setProbed((prev) => {
        const ids = new Set(found.map((d) => d.deviceId));
        return [...prev.filter((d) => !ids.has(d.deviceId)), ...found];
      });
      setOkCount(found.length);
      setKnown((prev) => [
        ...prev.filter((k) => k.host !== h),
        { host: h, deviceId: id, acceptAny: any },
      ]);
      if (found.length > 0) onSelect(found[0], net);
    } catch (err) {
      setError(errText(err));
    } finally {
      setProbing(false);
    }
  };

  const handleProbe = (): void => {
    if (hostTrim.length === 0) {
      setError(t('conn.cansub.hostRequired'));
      return;
    }
    if (idInvalid) return;
    void runProbe(hostTrim, idTrim ? idTrim.toLowerCase() : null, acceptAny);
  };

  const probeDisabled = probing || hostTrim.length === 0 || idInvalid;

  return (
    <div
      style={{ borderColor: 'var(--border-strong)', backgroundColor: 'var(--bg-surface)' }}
      className="border p-2 flex flex-col gap-2"
    >
      <div>
        <div className="text-[11px] text-[var(--text-secondary)] mb-1">
          {t('conn.cansub.discovered')}
        </div>
        {channels.length === 0 ? (
          <div className="text-[11px] text-[var(--text-muted)]">{t('conn.cansub.noneDiscovered')}</div>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-[96px] overflow-y-auto">
            {channels.map((d) => {
              const sel = d.deviceId === selectedDeviceId;
              return (
                <button
                  key={d.deviceId}
                  type="button"
                  onClick={() =>
                    onSelect(d, netById[d.deviceId]
                      ?? (sel ? initialNetwork : undefined)
                      ?? { host: null, deviceId: null, acceptAny: false })
                  }
                  style={{
                    backgroundColor: sel ? 'var(--bg-row-selected)' : 'var(--bg-input)',
                    borderColor: sel ? 'var(--status-focus-border)' : 'var(--border-hairline)',
                    color: 'var(--text-primary)',
                  }}
                  className="flex items-center justify-between gap-2 h-[22px] px-2 border text-[11px] font-mono tabular-nums text-left cursor-pointer"
                >
                  <span className="truncate">{d.displayName}</span>
                  <span className="text-[var(--text-muted)] truncate">{d.channelName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border-hairline)' }} className="pt-2">
        <div className="text-[11px] text-[var(--text-secondary)] mb-1">{t('conn.cansub.manualTitle')}</div>
        <div className="grid grid-cols-[1fr_120px_auto] gap-1.5 items-start">
          <div>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.50"
              aria-label={t('conn.cansub.host')}
              spellCheck={false}
              style={inputStyle}
              className="w-full h-[26px] px-2 border text-[11px] font-mono tabular-nums focus:outline-none"
            />
          </div>
          <div>
            <input
              type="text"
              value={deviceId}
              maxLength={8}
              onChange={(e) => setDeviceId(e.target.value.toLowerCase())}
              placeholder="aabbccdd"
              aria-label={t('conn.cansub.deviceId')}
              spellCheck={false}
              style={{
                ...inputStyle,
                borderColor: idInvalid ? 'var(--status-critical)' : 'var(--border-strong)',
              }}
              className="w-full h-[26px] px-2 border text-[11px] font-mono tabular-nums focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={handleProbe}
            disabled={probeDisabled}
            style={{
              backgroundColor: 'var(--bg-header)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
            className="h-[26px] px-3 border text-[11px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {probing ? t('conn.cansub.probing') : t('conn.cansub.probe')}
          </button>
        </div>
        {idInvalid && (
          <div className="mt-1 text-[10.5px] text-[var(--status-critical)]">
            {t('conn.cansub.deviceIdInvalid')}
          </div>
        )}

        <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] cursor-pointer">
          <input
            type="checkbox"
            checked={acceptAny}
            onChange={(e) => setAcceptAny(e.target.checked)}
            className="accent-nominal cursor-pointer"
          />
          <span>{t('conn.cansub.acceptAny')}</span>
        </label>
        {acceptAny && (
          <div
            role="alert"
            style={{
              backgroundColor: 'var(--status-warn-bg)',
              borderColor: 'var(--status-warn-border)',
              color: 'var(--status-warn)',
            }}
            className="mt-1 border px-2 py-1 text-[10.5px] leading-snug"
          >
            {t('conn.cansub.acceptAnyWarn')}
          </div>
        )}

        {okCount !== null && error === null && (
          <div className="mt-1 text-[10.5px] text-[var(--status-nominal)] font-mono tabular-nums">
            {t('conn.cansub.probeOk', { count: okCount })}
          </div>
        )}
        {error !== null && (
          <div
            role="alert"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical-border)',
              color: 'var(--status-critical)',
            }}
            className="mt-1 border px-2 py-1 text-[10.5px] leading-snug break-words"
          >
            <div className="font-mono">{t('conn.cansub.probeFailed', { err: error })}</div>
            {needsIdHint && <div className="mt-0.5">{t('conn.cansub.hintDeviceId')}</div>}
          </div>
        )}
      </div>

      {known.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-hairline)' }} className="pt-2">
          <div className="text-[11px] text-[var(--text-secondary)] mb-1">{t('conn.cansub.knownHosts')}</div>
          <div className="flex flex-col gap-0.5 max-h-[80px] overflow-y-auto">
            {known.map((k) => (
              <div key={k.host} className="flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
                <span className="flex-1 truncate">
                  {k.host}
                  {k.deviceId ? ` · ${k.deviceId}` : ''}
                  {k.acceptAny ? ' · *' : ''}
                </span>
                <button
                  type="button"
                  disabled={probing}
                  onClick={() => {
                    setHost(k.host);
                    setDeviceId(k.deviceId ?? '');
                    setAcceptAny(k.acceptAny);
                    void runProbe(k.host, k.deviceId, k.acceptAny);
                  }}
                  className="px-1.5 h-[20px] border border-strong text-[10.5px] cursor-pointer text-focus disabled:opacity-50"
                >
                  {t('conn.cansub.reprobe')}
                </button>
                <button
                  type="button"
                  onClick={() => setKnown((prev) => prev.filter((x) => x.host !== k.host))}
                  className="px-1.5 h-[20px] border border-strong text-[10.5px] cursor-pointer text-muted"
                >
                  {t('conn.cansub.remove')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[10.5px] text-[var(--text-muted)]">{t('conn.cansub.hwListenOnly')}</div>
    </div>
  );
};
