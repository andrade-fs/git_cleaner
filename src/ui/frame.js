import { bold, dim, inverse, visibleLength } from './theme.js';

/**
 * Shared chrome for full-screen views: a one-line status strip, an action bar
 * and a two-pane body. Both the graph and the leaks browser use it, so the tool
 * feels like one application instead of two screens.
 */
export function statusStrip({ width, left = [], right = [] }) {
  const leftText = left.filter(Boolean).join(dim(' · '));
  const rightText = right.filter(Boolean).join(dim(' · '));
  const gap = Math.max(width - visibleLength(leftText) - visibleLength(rightText) - 2, 1);
  return `${leftText}${' '.repeat(gap)}${rightText}`;
}

export function actionBar({ width, items, index = 0, focused = false, hint = '' }) {
  const parts = items.map((item, position) => {
    const selected = position === index;
    if (focused && selected) return inverse(` ${item} `);
    return selected ? `[${bold(item)}]` : ` ${dim(item)} `;
  });
  const line = `  ${parts.join(' ')}`;
  const trailing = hint ? dim(hint) : '';
  const gap = Math.max(width - visibleLength(line) - visibleLength(trailing) - 2, 1);
  return `${line}${' '.repeat(gap)}${trailing}`;
}

/**
 * Body split: `left` keeps its width, `right` gets the rest. Rows that only exist
 * on one side are padded so the separator never moves.
 */
export function twoPaneBody({ left, right, leftWidth, height, separator = '│' }) {
  const lines = [];
  for (let index = 0; index < height; index += 1) {
    const leftLine = pad(left[index] ?? '', leftWidth);
    const rightLine = right[index] ?? '';
    lines.push(`  ${leftLine} ${dim(separator)} ${rightLine}`);
  }
  return lines;
}

function pad(text, width) {
  const missing = width - visibleLength(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}
