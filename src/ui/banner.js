import {
  accent,
  bold,
  dim,
  gradient,
  gray,
  padEnd,
  red,
  sym,
  truncate,
  visibleLength,
  yellow,
} from './theme.js';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function terminalWidth() {
  return clamp(process.stdout?.columns || 80, 56, 96);
}

/** Maker mark, shown in every header. */
export const AUTHOR = 'by @bitsentry';

const CH = {
  topLeft: '\u256d',
  topRight: '\u256e',
  bottomLeft: '\u2570',
  bottomRight: '\u256f',
  vertical: '\u2502',
  teeLeft: '\u251c',
  teeRight: '\u2524',
  horizontal: '\u2500',
};

/**
 * A border row whose label breaks the line, so the brand sits *in* the frame:
 *   ╭─ ◆ TOPIARY ─────────────────────────── v0.1.0 ─╮
 */
function borderRow(width, { left = '', right = '', top = true } = {}) {
  const [cornerLeft, cornerRight] = top ? [CH.topLeft, CH.topRight] : [CH.bottomLeft, CH.bottomRight];

  const leftText = left ? `${CH.horizontal} ${left} ` : CH.horizontal;
  const rightText = right ? ` ${right} ${CH.horizontal}` : CH.horizontal;
  const fill = Math.max(width - 2 - visibleLength(leftText) - visibleLength(rightText), 1);

  return `${dim(cornerLeft)}${leftText}${dim(CH.horizontal.repeat(fill))}${rightText}${dim(cornerRight)}`;
}

function contentRow(width, content = '') {
  return `${dim(CH.vertical)} ${padEnd(content, width - 4)} ${dim(CH.vertical)}`;
}

function dividerRow(width) {
  return `${dim(CH.teeLeft)}${dim(CH.horizontal.repeat(width - 2))}${dim(CH.teeRight)}`;
}

/**
 * Header panel: the brand breaks the top border, the version closes it, the
 * context grid lives inside the frame and the maker mark closes the bottom.
 * Shared by every command and by the TUI.
 */
export function renderHeader(options = {}) {
  const {
    version = '0.0.0',
    tagline = 'branch hygiene · leak policy · safe deletes',
    author = AUTHOR,
    repo,
    head,
    remote,
    defaultBranch,
    policySource,
    branches,
  } = options;

  const width = terminalWidth();
  const brand = `${accent(sym.diamond)} ${gradient('TOPIARY', '#5eead4', '#818cf8')}`;

  const lines = [
    borderRow(width, { left: brand, right: `${dim('v')}${gray(version)}` }),
    contentRow(width, ` ${dim(tagline)}`),
  ];

  const cells = [];
  if (repo) cells.push(['repo', repo]);
  if (head) cells.push(['head', head]);
  if (remote) cells.push(['remote', remote]);
  if (defaultBranch) cells.push(['default', defaultBranch]);
  if (typeof branches === 'number') cells.push(['branches', String(branches)]);
  if (policySource) cells.push(['policy', policySource]);

  if (cells.length > 0) {
    lines.push(contentRow(width));
    lines.push(dividerRow(width));

    const labelWidth = Math.max(...cells.map(([label]) => label.length)) + 2;
    const colWidth = Math.max(Math.floor((width - 4) / 2), 24);
    const valueWidth = Math.max(colWidth - labelWidth - 2, 8);
    const cell = ([label, value]) => `${dim(padEnd(label, labelWidth))}${truncate(value, valueWidth)}`;

    for (let index = 0; index < cells.length; index += 2) {
      const left = cell(cells[index]);
      const right = cells[index + 1] ? cell(cells[index + 1]) : '';
      lines.push(contentRow(width, ` ${padEnd(left, colWidth)}${right}`.replace(/\s+$/, '')));
    }
  }

  lines.push(borderRow(width, { right: dim(author), top: false }));

  return lines.join('\n');
}

export function renderDivider(width = terminalWidth()) {
  return dim('─'.repeat(width));
}

export function toneForReason(reason = '') {
  if (reason.startsWith('protected')) return red;
  if (reason.startsWith('skip')) return yellow;
  if (reason === 'candidate') return bold;
  return gray;
}

export function reasonLabel(reason, detail) {
  const tone = toneForReason(reason);
  return detail ? `${tone(reason)}${dim(` (${detail})`)}` : tone(reason);
}

export { terminalWidth as width };
