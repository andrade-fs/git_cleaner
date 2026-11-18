import { accent, bold, dim, gray, green, magenta, red, truncate, visibleLength, yellow } from './theme.js';

/** One colour per lane, cycling. Kept short so it reads as a palette, not a rainbow. */
const LANE_COLORS = [accent, magenta, green, yellow, red, gray];

const CHAR = {
  node: '●',
  merge: '◆',
  vertical: '│',
  horizontal: '─',
  forkRight: '╮',
  forkLeft: '╭',
  joinLeft: '╯',
  joinRight: '╰',
  cursor: '▸',
};

export const laneColor = (lane) => LANE_COLORS[lane % LANE_COLORS.length];

/**
 * Paints the lane area of one row: verticals for active lanes, the commit node,
 * and the horizontal run towards every parent that lives in another lane.
 * Returns plain text plus the column of the node, so callers can colour by lane.
 */
export function paintLanes(row, { laneCount = 1 } = {}) {
  const cells = Array.from({ length: laneCount }, () => ({ main: ' ', sep: ' ' }));

  row.verticals.forEach((active, index) => {
    if (active && index < laneCount) cells[index].main = CHAR.vertical;
  });

  const isMerge = row.commit.parents.length > 1;
  cells[row.lane].main = isMerge ? CHAR.merge : CHAR.node;

  // Lanes arriving into this commit (two children reached the same ancestor):
  // draw the corner pointing at the node. Edges below may override the cell,
  // which is correct — the lane continues downwards in that case.
  for (const index of row.collapsed) {
    if (index >= laneCount) continue;
    cells[index].main = index > row.lane ? CHAR.joinLeft : CHAR.joinRight;
    const [from, to] = [Math.min(index, row.lane), Math.max(index, row.lane)];
    for (let position = from; position < to; position += 1) cells[position].sep = CHAR.horizontal;
  }

  // Lanes leaving towards a parent in another lane.
  for (const edge of row.edges) {
    const [from, to] = [edge.from, edge.to].sort((a, b) => a - b);
    for (let index = from; index < to && index < laneCount; index += 1) cells[index].sep = CHAR.horizontal;
    if (to < laneCount) cells[to].main = edge.to > edge.from ? CHAR.forkRight : CHAR.forkLeft;
  }

  return cells;
}

export function lanesToText(cells) {
  return cells.map((cell) => `${cell.main}${cell.sep}`).join('').replace(/\s+$/, '');
}

/**
 * Renders the graph pane: one line per commit, the cursor row highlighted, refs
 * in colour and the commit metadata to the right of the lanes.
 */
export function renderGraph(rows, options = {}) {
  const {
    cursor = 0,
    height = 20,
    width = 80,
    laneCount = 1,
    showMeta = true,
  } = options;

  if (rows.length === 0) {
    return [dim('  no commits')];
  }

  const laneWidth = laneCount * 2;
  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), rows.length - height));
  const visible = rows.slice(start, start + height);
  const lines = [];

  visible.forEach((row, offset) => {
    const index = start + offset;
    const focused = index === cursor;
    const cells = paintLanes(row, { laneCount });

    // Colour each cell by its own lane so merges read at a glance.
    const painted = cells
      .map((cell, lane) => {
        const paint = laneColor(lane);
        return `${paint(cell.main)}${cell.sep === ' ' ? ' ' : dim(cell.sep)}`;
      })
      .join('')
      .replace(/\s+$/, '');

    const gutter = focused ? accent(`${CHAR.cursor} `) : '  ';
    const pad = ' '.repeat(Math.max(laneWidth - cells.length * 2, 0));

    if (!showMeta) {
      lines.push(`${gutter}${painted}`);
      return;
    }

    const refs = (row.commit.refs || [])
      .map((ref) => (ref.tag ? yellow(`⟨${ref.name.replace(/^tag:/, '')}⟩`) : green(ref.name)))
      .join(' ');

    const available = Math.max(width - laneWidth - 4, 12);
    const subject = focused ? bold(row.commit.subject) : row.commit.subject;
    const extra = `${row.commit.short} · ${row.commit.authorName}`;

    // The subject wins over the metadata when the pane is narrow.
    let meta = refs ? `${refs}  ${subject}` : subject;
    if (visibleLength(meta) + extra.length + 2 <= available) {
      meta = `${meta}  ${dim(extra)}`;
    }

    const clipped = visibleLength(meta) > available ? truncate(meta, available) : meta;

    lines.push(`${gutter}${painted}${pad}  ${clipped}`);
  });

  if (start > 0) lines[0] = `${dim(`↑ ${start} more`)}`;
  if (start + height < rows.length) {
    lines[lines.length - 1] = `${dim(`↓ ${rows.length - (start + height)} more`)}`;
  }

  return lines;
}

/** The commit detail block used by the right pane. */
export function renderCommitDetail(row, { width = 44, decision = null } = {}) {
  if (!row) return [dim('  no commit selected')];
  const { commit } = row;
  const lines = [];
  const wrap = (text) => {
    const words = String(text).split(' ');
    const out = [];
    let line = '';
    for (const word of words) {
      if ((line + word).length > width - 4) {
        out.push(line.trim());
        line = '';
      }
      line += `${word} `;
    }
    if (line.trim()) out.push(line.trim());
    return out;
  };

  lines.push(`  ${bold(commit.subject)}`);
  lines.push('');
  lines.push(`  ${dim('commit')}   ${commit.short}`);
  lines.push(`  ${dim('author')}   ${commit.authorName} ${dim(`<${commit.authorEmail}>`)}`);
  lines.push(`  ${dim('date')}     ${new Date(commit.time).toISOString().slice(0, 16).replace('T', ' ')}`);

  if (commit.refs.length > 0) {
    const names = commit.refs
      .map((ref) => (ref.tag ? yellow(ref.name.replace('tag:', '')) : green(ref.name)))
      .join(', ');
    lines.push(`  ${dim('refs')}     ${names}`);
  }

  if (commit.parents.length > 1) {
    lines.push(`  ${dim('merge')}    ${commit.parents.length} parents`);
  }

  if (decision) {
    lines.push('');
    const tone =
      decision.reason === 'candidate' ? green : decision.reason.startsWith('protected') ? red : yellow;
    lines.push(`  ${dim('policy')}   ${tone(decision.reason)}`);
    if (decision.detail) lines.push(`  ${dim('         ')}${dim(decision.detail)}`);
  }

  return lines;
}
