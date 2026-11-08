import type {
  SimulationButtonMode,
  SimulationComboOptionDto,
  SimulationWidgetDto,
} from './contracts';

const IGNORED_CAPTURE_KEYS = new Set([
  'Shift',
  'ShiftLeft',
  'ShiftRight',
  'Control',
  'ControlLeft',
  'ControlRight',
  'Alt',
  'AltLeft',
  'AltRight',
  'Meta',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
]);

/**
 * Returns true if the focused DOM element is an editable form control or contentEditable surface.
 * Simulation hotkeys MUST NEVER fire when this returns true.
 */
export function isEditableActiveElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  const htmlEl = el as HTMLElement;
  if (htmlEl.isContentEditable) {
    return true;
  }
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) {
    return true;
  }
  return false;
}

/**
 * Normalizes a KeyboardEvent into a portable hotkey identifier (max 24 chars)
 * suitable for storing in `.nexusproj.json` (`widget.config.hotkey`).
 * Returns `null` for bare modifier presses.
 */
export function captureHotkeyFromKeyboardEvent(e: KeyboardEvent): string | null {
  if (IGNORED_CAPTURE_KEYS.has(e.key) || IGNORED_CAPTURE_KEYS.has(e.code)) {
    return null;
  }

  const code = e.code || '';
  if (code === 'Space' || e.key === ' ') {
    return 'Space';
  }
  if (/^F([1-9]|1[0-2])$/i.test(code)) {
    return code.toUpperCase();
  }
  const keyMatch = /^Key([A-Z])$/i.exec(code);
  if (keyMatch && keyMatch[1]) {
    return keyMatch[1].toUpperCase();
  }
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch && digitMatch[1]) {
    return digitMatch[1];
  }
  if (
    code.startsWith('Numpad') ||
    code.startsWith('Arrow') ||
    code === 'Enter' ||
    code === 'Tab' ||
    code === 'Backspace' ||
    code === 'Home' ||
    code === 'End' ||
    code === 'PageUp' ||
    code === 'PageDown'
  ) {
    return code.slice(0, 24);
  }

  const cleanKey = e.key.trim();
  if (cleanKey.length === 1) {
    return cleanKey.toUpperCase();
  }
  if (cleanKey.length > 1) {
    return cleanKey.slice(0, 24);
  }
  return code ? code.slice(0, 24) : null;
}

/**
 * Matches a configured `widget.config.hotkey` against a live browser KeyboardEvent,
 * supporting both `event.code` (`Space`, `KeyA`, `Digit1`, `F1`) and normalized key names (`A`, `1`, `SPACE`).
 */
export function matchesConfiguredHotkey(
  configuredHotkey: string | undefined,
  e: KeyboardEvent
): boolean {
  if (!configuredHotkey) return false;
  const target = configuredHotkey.trim().toUpperCase();
  if (!target) return false;

  const codeUpper = (e.code || '').toUpperCase();
  const keyUpper = e.key === ' ' ? 'SPACE' : (e.key || '').trim().toUpperCase();

  if (codeUpper === target || keyUpper === target) {
    return true;
  }

  if (target === 'SPACE' && (e.code === 'Space' || e.key === ' ')) {
    return true;
  }

  if (target.length === 1 && target >= 'A' && target <= 'Z') {
    if (codeUpper === `KEY${target}`) return true;
  }

  if (target.length === 1 && target >= '0' && target <= '9') {
    if (codeUpper === `DIGIT${target}`) return true;
  }

  if (target.startsWith('KEY') && target.length === 4) {
    if (keyUpper === target.slice(3)) return true;
  }

  if (target.startsWith('DIGIT') && target.length === 6) {
    if (keyUpper === target.slice(5)) return true;
  }

  return false;
}

/**
 * Formats a hotkey token into a crisp uppercase instrument badge (`F1`, `SPACE`, `A`, `↑`).
 */
export function formatHotkeyBadge(hotkey: string | undefined): string {
  if (!hotkey) return '';
  const trimmed = hotkey.trim();
  if (!trimmed) return '';
  const upper = trimmed.toUpperCase();

  if (upper === 'SPACE' || trimmed === ' ') return 'SPACE';
  if (upper.startsWith('KEY') && upper.length === 4) return upper.slice(3);
  if (upper.startsWith('DIGIT') && upper.length === 6) return upper.slice(5);
  if (upper === 'ARROWUP') return '↑ UP';
  if (upper === 'ARROWDOWN') return '↓ DN';
  if (upper === 'ARROWLEFT') return '← LT';
  if (upper === 'ARROWRIGHT') return '→ RT';
  if (upper.startsWith('NUMPAD')) return `NUM ${upper.slice(6)}`;
  return upper;
}

export function resolveEffectiveCycleOptions(
  widget: SimulationWidgetDto
): readonly SimulationComboOptionDto[] {
  const configured = widget.config.cycleOptions;
  if (configured && configured.length > 0) {
    return configured;
  }
  const releaseVal = widget.config.releaseValue ?? 0;
  const pressVal = widget.config.pressValue ?? 1;
  return [
    { label: 'OFF', value: releaseVal },
    { label: 'ON', value: pressVal },
  ];
}

export function formatStepDeltaBadge(delta: number): string {
  const rounded = Number(delta.toFixed(4));
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

export function formatButtonModeShortTag(mode: SimulationButtonMode): string {
  switch (mode) {
    case 'momentary':
      return 'MOMENTARY';
    case 'toggle':
      return 'LATCH';
    case 'pulse':
      return 'PULSE';
    case 'step':
      return 'STEP';
    case 'cycle':
      return 'CYCLE';
  }
}
