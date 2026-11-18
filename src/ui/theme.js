/**
 * Zero-dependency ANSI theming.
 * Colour is on only for a real TTY, unless FORCE_COLOR is set; NO_COLOR always wins.
 */
const env = process.env;

const forceColor = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== '';
const isTty = Boolean(process.stdout?.isTTY);

/** Runtime switch so --no-color / output.color=never win over detection. */
export const state = {
  enabled: 'NO_COLOR' in env ? false : forceColor || isTty,
};

export function setColorEnabled(value) {
  state.enabled = Boolean(value);
}

export const isColorEnabled = () => state.enabled;

export const trueColor = /truecolor|24bit/i.test(env.COLORTERM || '');
export const unicode = env.TERM !== 'dumb' && env.LANG !== 'C';

const wrap = (open, close) => (text) => (state.enabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text));

export const bold = wrap('1', '22');
export const dim = wrap('2', '22');
export const italic = wrap('3', '23');
export const underline = wrap('4', '24');
export const inverse = wrap('7', '27');
export const strike = wrap('9', '29');

export const black = wrap('30', '39');
export const red = wrap('31', '39');
export const green = wrap('32', '39');
export const yellow = wrap('33', '39');
export const blue = wrap('34', '39');
export const magenta = wrap('35', '39');
export const cyan = wrap('36', '39');
export const white = wrap('37', '39');
export const gray = wrap('90', '39');

/** Theme accent — change here, changes everywhere. */
export const accent = cyan;
export const accentSoft = blue;

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

export function visibleLength(text) {
  return stripAnsi(String(text)).length;
}

export function truncate(text, width) {
  const plain = stripAnsi(String(text));
  if (width <= 0) return '';
  if (plain.length <= width) return String(text);
  if (width === 1) return '…';
  return `${plain.slice(0, width - 1)}…`;
}

export function padEnd(text, width) {
  const diff = width - visibleLength(text);
  return diff > 0 ? String(text) + ' '.repeat(diff) : String(text);
}

export function padStart(text, width) {
  const diff = width - visibleLength(text);
  return diff > 0 ? ' '.repeat(diff) + String(text) : String(text);
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

export function fg(text, hex) {
  if (!state.enabled) return String(text);
  const [r, g, b] = hexToRgb(hex);
  if (!trueColor) return String(text);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

/** Horizontal truecolor gradient across the string (falls back to accent). */
export function gradient(text, from = '#5eead4', to = '#818cf8') {
  if (!state.enabled) return String(text);
  const chars = [...String(text)];
  if (!trueColor) return accent(String(text));
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const span = Math.max(chars.length - 1, 1);
  return chars
    .map((char, i) => {
      if (char === ' ') return char;
      const t = i / span;
      const r = Math.round(a[0] + (b[0] - a[0]) * t);
      const g = Math.round(a[1] + (b[1] - a[1]) * t);
      const c = Math.round(a[2] + (b[2] - a[2]) * t);
      return `\u001b[38;2;${r};${g};${c}m${char}`;
    })
    .join('') + '\u001b[39m';
}

export const sym = unicode
  ? {
      diamond: '◆',
      check: '✔',
      cross: '✖',
      warn: '▲',
      info: '●',
      arrow: '→',
      dot: '·',
      bar: '│',
      radioOff: '○',
      radioOn: '◉',
      checkOff: '◻',
      checkOn: '◼',
      spark: '✦',
    }
  : {
      diamond: '*',
      check: '+',
      cross: 'x',
      warn: '!',
      info: '-',
      arrow: '->',
      dot: '.',
      bar: '|',
      radioOff: '( )',
      radioOn: '(*)',
      checkOff: '[ ]',
      checkOn: '[x]',
      spark: '*',
    };

export function badge(text, tone = 'accent') {
  const map = { accent, ok: green, warn: yellow, err: red, muted: gray };
  return (map[tone] || accent)(` ${text} `);
}

export function success(text) {
  return `${green(sym.check)} ${text}`;
}

export function failure(text) {
  return `${red(sym.cross)} ${text}`;
}

export function warning(text) {
  return `${yellow(sym.warn)} ${text}`;
}

export function info(text) {
  return `${accent(sym.info)} ${text}`;
}
