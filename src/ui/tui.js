import { emitKeypressEvents } from 'node:readline';
import { accent, bold, dim, gray, green, inverse, red, sym, visibleLength, yellow } from './theme.js';

/**
 * Minimal full-screen TUI: alternate screen buffer, raw keys, in-place redraw.
 * Works with injected streams so it can be tested without a real terminal.
 */
export function createScreen({ input = process.stdin, output = process.stdout } = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  let active = false;

  const onSignal = () => {
    screen.leave();
    process.exit(130);
  };

  const screen = {
    interactive,
    input,
    output,
    leave() {
      if (!active) return;
      active = false;
      output.write('\u001b[?25h\u001b[?1049l');
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
    enter() {
      if (!interactive) return false;
      output.write('\u001b[?1049h\u001b[?25l');
      active = true;
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      return true;
    },
    columns() {
      return clamp(output.columns || 80, 50, 120);
    },
    rows() {
      return clamp(output.rows || 24, 12, 60);
    },
    render(lines) {
      if (!interactive) {
        output.write(`${lines.join('\n')}\n`);
        return;
      }
      output.write(`\u001b[H${lines.map((line) => `${line}\u001b[K`).join('\n')}\u001b[0J`);
    },
    /** Run `fn` with a spinner; only on a real terminal. */
    async withSpinner(label, fn) {
      if (!interactive) return fn();
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let index = 0;
      output.write(`\u001b[?25l`);
      const timer = setInterval(() => {
        output.write(`\r${accent(frames[index % frames.length])} ${dim(label)}\u001b[K`);
        index += 1;
      }, 80);
      try {
        return await fn();
      } finally {
        clearInterval(timer);
        output.write('\r\u001b[K\u001b[?25h');
      }
    },
  };

  return screen;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function attachKeys(input, handler) {
  emitKeypressEvents(input);
  const listener = (str, key) => handler(str, key || {});
  input.on('keypress', listener);
  input.setRawMode?.(true);
  input.resume?.();
  return () => {
    input.removeListener('keypress', listener);
    input.setRawMode?.(false);
    input.pause?.();
  };
}

export { attachKeys };

/** Single-line editor inside the alt screen. Resolves the text, or null on cancel. */
export async function inputPrompt({
  screen,
  header = [],
  title,
  value = '',
  placeholder = '',
  validate = () => null,
}) {
  if (!screen.interactive) return value;

  let chars = [...String(value)];
  let cursor = chars.length;
  let error = null;

  return new Promise((resolve) => {
    const paint = () => {
      const before = chars.slice(0, cursor).join('');
      const at = chars[cursor] ?? ' ';
      const after = chars.slice(cursor + 1).join('');
      const lines = [
        ...header,
        '',
        `  ${bold(title)}`,
        '',
        `  ${accent('›')} ${before}${inverse(at)}${after}`,
        '',
        `  ${dim(placeholder)}`,
      ];
      if (error) lines.push('', `  ${red(error)}`);
      lines.push('', `  ${dim('⏎ confirm · esc cancel · ←→ move · ⌫ delete')}`);
      screen.render(lines);
    };

    const done = (result) => {
      detach();
      resolve(result);
    };

    const handler = (str, key) => {
      error = null;
      if (key.ctrl && key.name === 'c') return done(null);
      if (key.name === 'escape') return done(null);

      if (key.name === 'return' || key.name === 'enter') {
        const text = chars.join('').trim();
        const message = validate(text);
        if (message) {
          error = message;
          return paint();
        }
        return done(text);
      }

      if (key.name === 'left') cursor = Math.max(cursor - 1, 0);
      else if (key.name === 'right') cursor = Math.min(cursor + 1, chars.length);
      else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
      else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = chars.length;
      else if (key.name === 'backspace') {
        if (cursor > 0) {
          chars.splice(cursor - 1, 1);
          cursor -= 1;
        }
      } else if (key.name === 'delete') {
        chars.splice(cursor, 1);
      } else if (key.ctrl && key.name === 'u') {
        chars = chars.slice(cursor);
        cursor = 0;
      } else if (key.ctrl && key.name === 'w') {
        while (cursor > 0 && chars[cursor - 1] === ' ') {
          chars.splice(cursor - 1, 1);
          cursor -= 1;
        }
        while (cursor > 0 && chars[cursor - 1] !== ' ') {
          chars.splice(cursor - 1, 1);
          cursor -= 1;
        }
      } else if (str && !key.ctrl && !key.meta && str.length >= 1 && str >= ' ') {
        const inserted = [...str];
        chars.splice(cursor, 0, ...inserted);
        cursor += inserted.length;
      }
      paint();
    };

    const detach = attachKeys(screen.input, handler);
    paint();
  });
}

function windowAround(items, index, maxVisible) {
  if (items.length <= maxVisible) return { start: 0, end: items.length };
  const half = Math.floor(maxVisible / 2);
  const start = clamp(index - half, 0, items.length - maxVisible);
  return { start, end: start + maxVisible };
}

function itemLine(item, focused, { multi, checked, width, labelWidth }) {
  const pointer = focused ? accent(sym.arrow) : ' ';
  const box = multi ? (checked ? green(sym.checkOn) : gray(sym.checkOff)) : focused ? accent(sym.radioOn) : gray(sym.radioOff);
  const label = focused ? bold(item.label) : item.label;
  const padding = ' '.repeat(Math.max((labelWidth || 0) - item.label.length, 0));
  const hint = item.hint ? `   ${dim(item.hint)}` : '';
  const line = `${pointer} ${box} ${label}${padding}${hint}`;
  const trimmed = line.replace(/\s+$/, '');
  return visibleLength(trimmed) > width ? trimmed.slice(0, width) : trimmed;
}

function frame({ header = [], title, subtitle, items, index, multi, checked, footer, scroll }) {
  const lines = [...header, ''];
  if (title) lines.push(`  ${bold(title)}`);
  if (subtitle) lines.push(`  ${dim(subtitle)}`);
  if (title || subtitle) lines.push('');

  const labelWidth = Math.min(Math.max(...items.map((item) => item.label.length)), 26);
  const { start, end } = scroll;
  if (start > 0) lines.push(`  ${dim(`↑ ${start} more`)}`);

  items.slice(start, end).forEach((item, offset) => {
    const position = start + offset;
    lines.push(
      `  ${itemLine(item, position === index, { multi, checked: checked.has(position), width: 100, labelWidth })}`,
    );
  });

  if (end < items.length) lines.push(`  ${dim(`↓ ${items.length - end} more`)}`);

  if (multi) {
    lines.push('');
    lines.push(`  ${dim(`${checked.size} of ${items.length} selected`)}`);
  }
  lines.push('');
  lines.push(`  ${dim(footer)}`);
  return lines;
}

/**
 * Single select. Resolves the chosen item's value, or null on cancel.
 */
export async function selectList(options) {
  const {
    screen,
    header = [],
    title,
    subtitle,
    items,
    footer = `${sym.arrow === '->' ? 'arrows' : '↑↓'} move · ⏎ select · q quit`,
    initial = 0,
  } = options;

  if (items.length === 0) return null;

  let index = clamp(initial, 0, items.length - 1);
  const maxVisible = clamp(screen.rows() - header.length - 8, 5, 20);

  return new Promise((resolve) => {
    const paint = () =>
      screen.render(
        frame({
          header,
          title,
          subtitle,
          items,
          index,
          multi: false,
          checked: new Set(),
          footer,
          scroll: windowAround(items, index, maxVisible),
        }),
      );

    const done = (value) => {
      detach();
      resolve(value);
    };

    const handler = (str, key) => {
      if (key.ctrl && key.name === 'c') return done(null);
      switch (key.name) {
        case 'up':
        case 'k':
          index = (index - 1 + items.length) % items.length;
          break;
        case 'down':
        case 'j':
          index = (index + 1) % items.length;
          break;
        case 'home':
          index = 0;
          break;
        case 'end':
          index = items.length - 1;
          break;
        case 'return':
        case 'enter':
          return done(items[index]?.value ?? null);
        case 'q':
        case 'escape':
          return done(null);
        default:
          break;
      }
      paint();
    };

    const detach = attachKeys(screen.input, handler);
    paint();
  });
}

/**
 * Multi select. Resolves the array of selected values, or null on cancel.
 */
export async function multiSelectList(options) {
  const {
    screen,
    header = [],
    title,
    subtitle,
    items,
    footer = '↑↓ move · space toggle · a all · n none · i invert · ⏎ confirm · q cancel',
    preselected = [],
  } = options;

  if (items.length === 0) return [];

  let index = 0;
  const checked = new Set(preselected.filter((value) => value >= 0 && value < items.length));
  const maxVisible = clamp(screen.rows() - header.length - 10, 5, 18);

  return new Promise((resolve) => {
    const paint = () =>
      screen.render(
        frame({
          header,
          title,
          subtitle,
          items,
          index,
          multi: true,
          checked,
          footer,
          scroll: windowAround(items, index, maxVisible),
        }),
      );

    const done = (value) => {
      detach();
      resolve(value);
    };

    const handler = (str, key) => {
      if (key.ctrl && key.name === 'c') return done(null);
      switch (key.name) {
        case 'up':
        case 'k':
          index = (index - 1 + items.length) % items.length;
          break;
        case 'down':
        case 'j':
          index = (index + 1) % items.length;
          break;
        case 'space':
          if (checked.has(index)) checked.delete(index);
          else checked.add(index);
          break;
        case 'a':
          items.forEach((_, position) => checked.add(position));
          break;
        case 'n':
          checked.clear();
          break;
        case 'i':
          items.forEach((_, position) => {
            if (checked.has(position)) checked.delete(position);
            else checked.add(position);
          });
          break;
        case 'return':
        case 'enter':
          return done([...checked].sort((a, b) => a - b).map((position) => items[position].value));
        case 'q':
        case 'escape':
          return done(null);
        default:
          break;
      }
      paint();
    };

    const detach = attachKeys(screen.input, handler);
    paint();
  });
}

/** Yes/no with No as the safe default. */
export async function confirmPrompt({ screen, header = [], title, subtitle, yesLabel = 'Yes', noLabel = 'No', defaultYes = false }) {
  if (!screen.interactive) return defaultYes;
  const value = await selectList({
    screen,
    header,
    title,
    subtitle,
    items: [
      { label: yesLabel, value: 'yes' },
      { label: noLabel, value: 'no' },
    ],
    initial: defaultYes ? 0 : 1,
    footer: '↑↓ move · ⏎ select · q cancel',
  });
  return value === 'yes';
}

export async function pausePrompt({ screen, message = 'press any key to continue' }) {
  if (!screen.interactive) return;
  await new Promise((resolve) => {
    const detach = attachKeys(screen.input, () => {
      detach();
      resolve();
    });
    screen.render([`  ${dim(message)}`]);
  });
}

/** Waits for one key without moving the cursor — safe inside and outside the alt screen. */
export async function waitForKey(screen, message = 'press any key to continue') {
  if (!screen.interactive) return;
  screen.output.write(`\n  ${dim(message)} `);
  await new Promise((resolve) => {
    const detach = attachKeys(screen.input, () => {
      detach();
      resolve();
    });
  });
  screen.output.write('\n');
}

export function renderList(items, { selected = new Set(), multi = false, index = 0 } = {}) {
  return items
    .map((item, position) =>
      itemLine(item, position === index, { multi, checked: selected.has(position), width: 100 }),
    )
    .join('\n');
}

export const symbols = { red, yellow, green };
