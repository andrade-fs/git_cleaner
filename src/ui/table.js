import { padEnd, padStart, truncate, visibleLength, dim, bold } from './theme.js';

/**
 * Minimal ANSI-aware table. Columns are truncated to fit `width`; the last
 * column absorbs the remaining space so rows never wrap.
 */
export function renderTable({ columns, rows, width = process.stdout?.columns || 80, zebra = false }) {
  if (rows.length === 0) return '';

  // Drop columns that ended up empty (e.g. HINT when no finding carries one).
  columns = columns.filter((column) =>
    rows.some((row) => {
      const value = row[column.key];
      return value !== undefined && value !== null && String(value).trim() !== '';
    }),
  );
  if (columns.length === 0) return '';

  const widths = columns.map((column) => {
    const headerWidth = visibleLength(column.header);
    const cellWidth = rows.reduce((max, row) => {
      const value = row[column.key];
      return Math.max(max, visibleLength(value === undefined || value === null ? '' : value));
    }, 0);
    const natural = Math.max(headerWidth, cellWidth, column.min || 0);
    return column.max ? Math.min(natural, column.max) : natural;
  });

  // Shrink the widest columns until the row fits.
  const gap = 2;
  const fixed = widths.reduce((sum, w) => sum + w, 0) + gap * (columns.length - 1);
  if (fixed > width) {
    let overflow = fixed - width;
    const order = widths
      .map((w, index) => ({ w, index }))
      .sort((a, b) => b.w - a.w);
    for (const item of order) {
      if (overflow <= 0) break;
      const min = columns[item.index].minWidth || 6;
      const shrinkable = Math.max(widths[item.index] - min, 0);
      const take = Math.min(shrinkable, overflow);
      widths[item.index] -= take;
      overflow -= take;
    }
  }

  const renderRow = (cells) =>
    cells
      .map((cell, index) => {
        const raw = cell === undefined || cell === null ? '' : String(cell);
        const text = truncate(raw, widths[index]);
        return widths[index] && columns[index].align === 'right'
          ? padStart(text, widths[index])
          : padEnd(text, widths[index]);
      })
      .join(' '.repeat(gap))
      .replace(/\s+$/, '');

  const headerRow = renderRow(columns.map((column) => dim(column.header)));
  const lines = [headerRow];

  rows.forEach((row, index) => {
    const cells = columns.map((column) => {
      const value = row[column.key];
      const text = value === undefined || value === null ? '' : value;
      return typeof column.render === 'function' ? column.render(row, text) : text;
    });
    const line = renderRow(cells);
    lines.push(zebra && index % 2 === 1 ? dim(line) : line);
  });

  return lines.join('\n');
}

export function renderKeyValues(pairs, { labelWidth } = {}) {
  const width = labelWidth || Math.max(...pairs.map(([label]) => visibleLength(label))) + 2;
  return pairs.map(([label, value]) => `  ${dim(padEnd(label, width))}${value}`).join('\n');
}

export function renderSection(title, body, { width } = {}) {
  const head = `  ${bold(title)}`;
  const line = `  ${'─'.repeat(Math.max((width || 60) - 4, 10))}`;
  return [head, dim(line), body].join('\n');
}
