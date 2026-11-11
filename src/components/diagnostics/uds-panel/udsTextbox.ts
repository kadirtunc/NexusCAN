/**
 * UDS side of the shared `textbox` instrument: validation, confirmation preview and the send path.
 * Sending goes through the same `udsTransport` safety gate as every other UDS write
 * (Panic latch / session / Listen-Only / Arm, re-evaluated at send time).
 */
import type { TranslationKey } from '../../../i18n';
import type { TextboxAdapter, TextboxSendOutcome } from '../../simulation/TextboxWidgetView';
import {
  parseDecimalNumber,
  textToBytes,
  type TextboxCodecErrorKey,
} from '../../simulation/textboxCodec';
import type { SimulationRuntimeBus } from '../../simulation/simulationRuntimeBus';
import { makeSignalBusKey } from '../../simulation/virtualCanPacking';
import type { UdsWidgetDto } from '../../../types/uds';
import {
  clampToRange,
  encodeWriteBytesRequest,
  encodeWriteRequest,
  resolveWriteRange,
} from './udsBinding';
import { udsPanelStore } from './udsInstrumentStore';
import {
  executeUdsWrite,
  executeUdsWriteBytes,
  type UdsTxGateReason,
  type UdsWriteResult,
} from './udsTransport';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const GATE_REASON_KEY: Record<UdsTxGateReason, TranslationKey> = {
  panic: 'udsPanel.gate.panic',
  noSession: 'udsPanel.gate.noSession',
  busNotConnected: 'udsPanel.gate.busNotConnected',
  listenOnly: 'udsPanel.gate.listenOnly',
  notArmed: 'udsPanel.gate.notArmed',
};

function hexOf(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

type Parsed =
  | { kind: 'number'; value: number }
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'error'; errorKey: TextboxCodecErrorKey | 'textbox.err.unsupportedFormat' | 'udsPanel.textbox.noWriteBinding'; params?: Record<string, number> };

function parseInput(widget: UdsWidgetDto, text: string): Parsed {
  if (!widget.udsWrite) return { kind: 'error', errorKey: 'udsPanel.textbox.noWriteBinding' };
  const format = widget.config.textFormat ?? 'decimal';
  if (format === 'decimal') {
    const n = parseDecimalNumber(text);
    return n.ok ? { kind: 'number', value: n.value } : { kind: 'error', errorKey: n.errorKey };
  }
  if (format === 'ascii' || format === 'hex') {
    const b = textToBytes(text, format, widget.config);
    return b.ok
      ? { kind: 'bytes', bytes: b.value }
      : { kind: 'error', errorKey: b.errorKey, params: b.params };
  }
  return { kind: 'error', errorKey: 'textbox.err.unsupportedFormat' };
}

function outcomeFromResult(result: UdsWriteResult, t: Translate): TextboxSendOutcome {
  switch (result.status) {
    case 'sent':
      return result.wasClamped
        ? { tone: 'warn', message: t('udsPanel.textbox.sentClamped', { sent: Number(result.clampedValue.toFixed(4)) }) }
        : { tone: 'ok', message: t('udsPanel.textbox.sentOk') };
    case 'blocked':
      return { tone: 'error', message: t('udsPanel.textbox.blocked', { reason: t(GATE_REASON_KEY[result.reason]) }) };
    case 'invalid':
      return {
        tone: 'error',
        message: t(
          result.reason === 'offsetUnsupported'
            ? 'udsPanel.notice.writeOffsetUnsupported'
            : result.reason === 'tooLong'
              ? 'udsPanel.textbox.payloadTooLong'
              : 'udsPanel.notice.writeInvalidId',
          { title: '' }
        ),
      };
    case 'error':
      return {
        tone: 'error',
        message:
          result.kind === 'backendMissing'
            ? t('udsPanel.status.backendMissing')
            : result.kind === 'notConnected'
              ? t('udsPanel.status.notConnected')
              : t('udsPanel.textbox.failed', { message: result.message }),
      };
  }
}

export function buildUdsTextboxAdapter(args: {
  widget: UdsWidgetDto;
  runtimeBus: SimulationRuntimeBus;
  nowSec: () => number;
  t: Translate;
}): TextboxAdapter {
  const { widget, runtimeBus, nowSec, t } = args;
  const busKey = widget.binding
    ? makeSignalBusKey(widget.binding.messageKey, widget.binding.signalName)
    : null;

  return {
    validate: (text) => {
      const parsed = parseInput(widget, text);
      return parsed.kind === 'error'
        ? { ok: false, errorKey: parsed.errorKey, params: parsed.params }
        : { ok: true };
    },

    describe: (text) => {
      const parsed = parseInput(widget, text);
      if (parsed.kind === 'error') return [t(parsed.errorKey, parsed.params)];
      const encoded =
        parsed.kind === 'number'
          ? encodeWriteRequest(widget, parsed.value)
          : encodeWriteBytesRequest(widget, parsed.bytes);
      if (!encoded.ok) return [t('udsPanel.textbox.encodeFailed')];
      const { sid, data, target } = encoded.request;
      return [
        `${t('udsPanel.textbox.confirmTarget')}: ${target}`,
        `${t('udsPanel.textbox.confirmPayload')} (${data.length + 1} B): ${hexOf([sid, ...data])}`,
        `${t('udsPanel.textbox.confirmValue')}: ${text}`,
      ];
    },

    send: async (text) => {
      const parsed = parseInput(widget, text);
      if (parsed.kind === 'error') {
        return { tone: 'error', message: t(parsed.errorKey, parsed.params) };
      }

      if (udsPanelStore.getSnapshot().mockMode) {
        // DEMO only: nothing is transmitted, local reflection so the demo panel reacts.
        if (busKey) {
          if (parsed.kind === 'number') {
            runtimeBus.publishExternalSample(busKey, clampToRange(parsed.value, resolveWriteRange(widget)), nowSec());
          } else {
            runtimeBus.publishExternalBytes(busKey, parsed.bytes);
          }
        }
        return { tone: 'warn', message: t('udsPanel.textbox.mockSent') };
      }

      const result =
        parsed.kind === 'number'
          ? await executeUdsWrite(widget, parsed.value)
          : await executeUdsWriteBytes(widget, parsed.bytes);

      if (result.status === 'sent' && busKey) {
        // Positive response: reflect exactly what went on the wire.
        if (parsed.kind === 'number') {
          runtimeBus.publishExternalSample(busKey, result.clampedValue, nowSec());
        } else {
          runtimeBus.publishExternalBytes(busKey, parsed.bytes);
        }
      }
      return outcomeFromResult(result, t);
    },
  };
}
