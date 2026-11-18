import { accent, bold, dim, gray, green, red, truncate, visibleLength, yellow } from './theme.js';

const TONE = { critical: red, high: red, medium: yellow, low: gray };
const SEV = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };

export const severityTone = (severity) => TONE[severity] || gray;

/**
 * The findings list: one row per finding, cursor on the selected one. Widths are
 * computed once so the columns line up whatever the findings are.
 */
export function renderFindingsList(findings, { cursor = 0, height = 20, width = 70 } = {}) {
  if (findings.length === 0) return [dim('  no findings')];

  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), findings.length - height));
  const visible = findings.slice(start, start + height);

  const location = (finding) => `${finding.path}${finding.line ? `:${finding.line}` : ''}`;
  const pathWidth = Math.min(
    Math.max(...visible.map((finding) => location(finding).length), 12),
    Math.max(width - 26, 14),
  );
  const ruleWidth = Math.min(
    Math.max(...visible.map((finding) => String(finding.rule).length), 8),
    Math.max(width - pathWidth - 12, 10),
  );

  const lines = visible.map((finding, offset) => {
    const index = start + offset;
    const focused = index === cursor;
    const tone = severityTone(finding.severity);
    const gutter = focused ? accent('▸') : ' ';
    const sev = tone((SEV[finding.severity] || finding.severity).padEnd(4));
    const path = truncate(location(finding), pathWidth).padEnd(pathWidth);
    const rule = dim(truncate(String(finding.rule), ruleWidth));
    const base = `${gutter} ${sev} ${focused ? bold(path) : path} ${rule}`;
    const messageWidth = Math.max(width - visibleLength(base) - 4, 0);
    const message = messageWidth > 6 ? `  ${dim(truncate(finding.message || '', messageWidth))}` : '';
    return `${base}${message}`.replace(/\s+$/, '');
  });

  if (start > 0) lines[0] = dim(`↑ ${start} more`);
  if (start + height < findings.length) {
    lines[lines.length - 1] = dim(`↓ ${findings.length - (start + height)} more`);
  }
  return lines;
}

/** The right pane: a real window of code, then where it is and what it is. */
export function renderFindingDetail(finding, { width = 46, frame = null, masked = true, hint = null } = {}) {
  if (!finding) return [dim('  no finding selected')];

  const tone = severityTone(finding.severity);
  const lines = [];
  lines.push(`  ${tone(bold(finding.severity.toUpperCase()))}  ${dim(finding.source || 'policy')}`);
  lines.push(`  ${bold(`${finding.path}${finding.line ? `:${finding.line}` : ''}`)}`);
  lines.push(...wrap(finding.message || '', width - 4).map((line) => `  ${dim(line)}`));
  lines.push('');

  if (frame) {
    lines.push(...renderCodeFrame(frame, { width: width - 2, masked, secret: finding.secret, tone }));
  } else if (finding.snippet) {
    const number = String(finding.line ?? '').padStart(4);
    const prefix = `  ${dim(`${number} │`)} `;
    const available = Math.max(width - visibleLength(prefix) - 2, 10);
    lines.push(`${prefix}${yellow(truncate(finding.snippet, available))}`);
  } else if (finding.line) {
    lines.push(`  ${dim('the file is not in the worktree (history finding)')}`);
  } else {
    lines.push(`  ${dim('contents not displayed — the file itself is the finding')}`);
  }

  lines.push('');
  lines.push(`  ${dim('rule')}         ${finding.rule}`);

  // The key itself: shown in full by default, because this only exists on the
  // operator's terminal. `h` masks it when the screen is shared.
  if (finding.secret) {
    lines.push(`  ${dim('key')}          ${masked ? gray(finding.hint) : red(bold(finding.secret))}`);
  } else if (finding.hint) {
    lines.push(`  ${dim('match')}        ${gray(finding.hint)}`);
  }

  if (finding.commit) lines.push(`  ${dim('commit')}       ${finding.commit}${finding.author ? ` ${dim(`· ${finding.author}`)}` : ''}`);
  if (finding.fingerprint) lines.push(`  ${dim('fingerprint')}  ${gray(finding.fingerprint)}`);

  const fixLabel = !finding.fixable
    ? dim('manual')
    : finding.fix === 'ignore'
      ? green('yes · add to .gitignore')
      : green('yes · git rm --cached');
  lines.push(`  ${dim('fixable')}      ${fixLabel}`);

  if (hint) {
    lines.push('');
    lines.push(`  ${hint}`);
  }

  return lines;
}

/**
 * A frame of real source around the finding, with the line itself marked. Long
 * lines wrap instead of clipping — a key sitting at column 120 must still show.
 */
export function renderCodeFrame(frame, { width = 60, masked = false, secret = null, tone = yellow } = {}) {
  if (!frame || !frame.lines) return [];

  const numberWidth = String(frame.total).length;
  const textWidth = Math.max(width - numberWidth - 6, 20);
  const lines = [];

  if (frame.hiddenAbove > 0) lines.push(dim(`  ${'·'.repeat(3)} ${frame.hiddenAbove} above`));

  for (const line of frame.lines) {
    const isTarget = line.number === frame.line;
    const text =
      isTarget && masked && secret ? line.text.split(secret).join('●'.repeat(Math.min(secret.length, 12))) : line.text;

    const chunks = hardWrap(text, textWidth);
    chunks.forEach((chunk, index) => {
      const bar = isTarget && index === 0 ? accent('▸') : index === 0 ? dim('│') : ' ';
      const number = index === 0 ? dim(`${String(line.number).padStart(numberWidth)} `) : ' '.repeat(numberWidth + 1);
      const body = isTarget ? tone(bold(chunk)) : dim(chunk);
      lines.push(`${bar} ${number}${dim('│')} ${body}`);
    });
  }

  if (frame.hiddenBelow > 0) {
    lines.push(dim(`  ${'·'.repeat(3)} ${frame.hiddenBelow} below`));
  }

  return lines;
}

/**
 * Wraps at word boundaries. A long token is pushed to the next row instead of
 * being cut in half — a key split across rows is a key you can't copy.
 */
function hardWrap(text, width) {
  const clean = String(text).replace(/\t/g, '  ').replace(/\r/g, '');
  if (clean.length <= width) return [clean];

  const out = [];
  let rest = clean;
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width);
    const cut = space > 0 ? space + 1 : width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export function renderFindingsFooter({ findings, cursor, scan, width, masked = false }) {
  const counts = ['critical', 'high', 'medium', 'low']
    .map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length])
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${severityTone(severity)(String(count))} ${dim(severity)}`);

  const left = [
    `${accent('◆')} ${bold(String(findings.length))} ${dim('findings')}`,
    counts.length > 0 ? counts.join(dim(' · ')) : dim('clean'),
    `${dim('engine')} ${scan.engine ? green(scan.engine) : yellow('policy only')}`,
  ].join(' ');

  const right = dim(`↑↓ move · tab actions · h ${masked ? 'show key' : 'hide key'} · q quit`);
  const gap = Math.max(width - visibleLength(left) - visibleLength(right) - 2, 1);
  return `${left}${' '.repeat(gap)}${right}`;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if ((line + word).length > width && line) {
      out.push(line.trim());
      line = '';
    }
    line += `${word} `;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
