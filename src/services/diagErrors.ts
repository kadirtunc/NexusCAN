/**
 * Maps `[diag:<code>]` errors (see `types/udsClient.ts` `parseDiagError`) and HMI transport
 * conditions to localized messages. Usable from React (pass the hook's `t`) and from plain
 * modules (pass the global `t`).
 */
import { parseDiagError } from '../types/udsClient';
import type { DiagUiError } from '../types/diagnostics';
import type { TranslationKey } from '../i18n';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const ERROR_KEY: Record<DiagUiError['code'], TranslationKey> = {
  invalid_input: 'diagReal.err.invalidInput',
  bus_not_connected: 'diagReal.err.busNotConnected',
  listen_only: 'diagReal.err.armFirst',
  disarmed: 'diagReal.err.armFirst',
  panic_latched: 'diagReal.err.panicLatched',
  timeout_p2: 'diagReal.err.timeoutP2',
  timeout_p2_star: 'diagReal.err.timeoutP2Star',
  timeout_isotp: 'diagReal.err.timeoutIsotp',
  isotp_error: 'diagReal.err.isotp',
  busy: 'diagReal.err.busy',
  session_closed: 'diagReal.err.sessionClosed',
  unexpected_response: 'diagReal.err.unexpected',
  negative_response: 'diagReal.err.negative',
  internal: 'diagReal.err.internal',
  not_connected: 'diag.error.notConnected',
  backend_missing: 'diagReal.err.backendMissing',
  duplicate_session: 'diagTabs.err.duplicate',
  unknown: 'diagReal.err.unknown',
};

const BACKEND_MISSING_RE = /unknown nexuscan ipc command|not found|not allowed|not registered/i;

/** Codes after which the backend diag tap/session is no longer usable (HMI drops "connected"). */
export const SESSION_LOST_CODES: ReadonlySet<DiagUiError['code']> = new Set<DiagUiError['code']>([
  'session_closed',
  'panic_latched',
  'disarmed',
  'listen_only',
  'bus_not_connected',
]);

export function toDiagUiError(err: unknown): DiagUiError {
  const parsed = parseDiagError(err);
  if (parsed) return { code: parsed.code, message: parsed.message };
  const msg = err instanceof Error ? err.message : String(err);
  if (BACKEND_MISSING_RE.test(msg)) return { code: 'backend_missing', message: msg };
  return { code: 'unknown', message: msg };
}

export function formatDiagError(translate: Translate, err: DiagUiError): string {
  return translate(ERROR_KEY[err.code], { detail: err.message });
}
