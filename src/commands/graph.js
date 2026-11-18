import { loadGraph, layoutGraph } from '../core/graph.js';
import { renderCommitDetail, renderGraph } from '../ui/graph.js';
import { renderHeader } from '../ui/banner.js';
import { actionBar as frameActionBar, statusStrip, twoPaneBody } from '../ui/frame.js';
import { accent, bold, dim, green, red, sym, yellow } from '../ui/theme.js';
import { attachKeys, waitForKey } from '../ui/tui.js';
import { formatAge } from '../util/format.js';
import { runPlan } from './plan.js';
import { runLeaksView } from './leaksView.js';
import { runRestore } from './restore.js';
import { runSettings } from './settings.js';

const ACTIONS = [
  { id: 'analyze', label: 'Analyze' },
  { id: 'leaks', label: 'Leaks' },
  { id: 'restore', label: 'Restore' },
  { id: 'settings', label: 'Settings' },
];

function readKey(screen) {
  return new Promise((resolve) => {
    const detach = attachKeys(screen.input, (str, key) => {
      detach();
      resolve({ str, key });
    });
  });
}

/** Single-line status strip: brand, repo, branch and the numbers that matter. */
function stripLine(session, width) {
  return statusStrip({
    width,
    left: [
      `${accent(sym.diamond)} ${bold('TOPIARY')}`,
      session.repo.name,
      `${dim('on')} ${green(session.repo.head || 'detached')}`,
    ],
    right: [
      `${bold(String(session.analysis.branches.length))} ${dim('branches')}`,
      `${bold(String(session.plan({}).summary.candidates))} ${dim('candidates')}`,
      dim(`v${session.version}`),
    ],
  });
}

function actionBar(index, focused, width) {
  return frameActionBar({
    width,
    items: ACTIONS.map((action) => action.label),
    index,
    focused,
    hint: focused ? '←→ move · ⏎ run · tab back' : 'tab actions',
  });
}

function branchInfo(session, row, decisions, width) {
  if (!row) return [];
  const branches = (row.commit.refs || []).filter((ref) => !ref.tag);
  if (branches.length === 0) {
    return [`  ${dim('commit')} ${row.commit.short} ${dim('· no branch points here')}`];
  }

  const lines = [];
  for (const ref of branches.slice(0, 2)) {
    const decision = decisions.get(ref.name);
    const analysis = session.analysis.branches.find((branch) => branch.name === ref.name);
    const facts = [];
    if (analysis) {
      if (analysis.ahead !== null) facts.push(`${dim('ahead')} ${analysis.ahead}`);
      if (analysis.merged) facts.push(green('merged'));
      else facts.push(yellow('unmerged'));
      facts.push(dim(`${formatAge(analysis.time)} old`));
      facts.push(dim(`${analysis.authorName || analysis.authorEmail}`));
    }
    const reason = decision
      ? decision.reason === 'candidate'
        ? green('candidate')
        : decision.reason.startsWith('protected')
          ? red(decision.reason)
          : yellow(decision.reason)
      : null;

    lines.push(
      `  ${accent(sym.diamond)} ${bold(ref.name)}  ${facts.join(dim(' · '))}${reason ? `  ${reason}` : ''}`,
    );
  }
  if (branches.length > 2) lines.push(`  ${dim(`+${branches.length - 2} more refs on this commit`)}`);
  return lines;
}

/**
 * The graph screen: a full-terminal view with the action bar on top, the branch
 * being inspected, and the commit graph on the left. The cursor is ours, so the
 * graph is as navigable as any list.
 */
export async function runGraph(session, flags = {}) {
  const screen = session.screen;

  const graph = await screen.withSpinner('reading the commit graph…', () =>
    loadGraph(session.repo.root, { limit: flags.limit ? Number(flags.limit) : 300 }),
  );

  if (graph.commits.length === 0) {
    process.stdout.write(`  ${dim('no commits in this repository')}\n`);
    return 2;
  }

  const { rows, laneCount } = layoutGraph(graph.commits);
  const decisions = new Map(session.plan({}).decisions.map((decision) => [decision.name, decision]));

  if (!screen.interactive) {
    // Scriptable fallback: a plain listing, no cursor.
    const width = screen.columns();
    process.stdout.write(`${renderHeader({ version: session.version, ...headerContext(session) })}\n\n`);
    for (const line of renderGraph(rows, { height: rows.length, width, laneCount })) {
      process.stdout.write(`  ${line}\n`);
    }
    return 0;
  }

  let cursor = 0;
  let actionIndex = 0;
  let focus = 'graph';
  let message = null;

  screen.enter();
  try {
    for (;;) {
      const width = screen.columns();
      const height = screen.rows();
      const split = width >= 96;
      const detailWidth = split ? Math.min(Math.floor(width * 0.38), 52) : 0;
      const graphWidth = split ? width - detailWidth - 3 : width;

      const head = [stripLine(session, width), actionBar(actionIndex, focus === 'bar', width)];
      const info = branchInfo(session, rows[cursor], decisions, width);

      const chromeHeight = head.length + info.length + 3; // + blank + footer + separator
      const bodyHeight = Math.max(height - chromeHeight, 5);

      const graphLines = renderGraph(rows, {
        cursor,
        height: bodyHeight,
        width: graphWidth,
        laneCount,
      });
      const detailLines = split
        ? renderCommitDetail(rows[cursor], { width: detailWidth, decision: policyFor(rows[cursor], decisions) })
        : [];

      const body = split
        ? twoPaneBody({
            left: graphLines,
            right: detailLines,
            leftWidth: width - detailWidth - 5,
            height: bodyHeight,
          })
        : graphLines.slice(0, bodyHeight).map((line) => `  ${line}`);

      const footer = [
        '',
        `  ${
          message ||
          dim('↑↓ move · PgUp/PgDn page · g/G ends · tab actions · q quit')
        }`,
      ];

      screen.render([...head, ...info, '', ...body, ...footer]);

      const { str, key } = await readKey(screen);
      message = null;

      if (key.ctrl && key.name === 'c') break;
      if (key.name === 'q' || key.name === 'escape') {
        if (focus === 'bar') {
          focus = 'graph';
          continue;
        }
        break;
      }

      if (focus === 'bar') {
        if (key.name === 'left' || key.name === 'h') {
          actionIndex = (actionIndex - 1 + ACTIONS.length) % ACTIONS.length;
        } else if (key.name === 'right' || key.name === 'l') {
          actionIndex = (actionIndex + 1) % ACTIONS.length;
        } else if (key.name === 'tab' || key.name === 'down' || key.name === 'j') {
          focus = 'graph';
        } else if (key.name === 'return' || key.name === 'enter') {
          const action = ACTIONS[actionIndex];
          message = await runAction(session, action, screen, { branch: branchAt(rows[cursor]) });
          focus = 'graph';
        }
        continue;
      }

      if (key.name === 'tab' || (key.name === 'up' && cursor === 0)) {
        focus = 'bar';
        continue;
      }

      const page = Math.max(Math.floor(bodyHeight / 2), 5);
      if (key.name === 'up' || key.name === 'k') cursor = Math.max(cursor - 1, 0);
      else if (key.name === 'down' || key.name === 'j') cursor = Math.min(cursor + 1, rows.length - 1);
      else if (key.name === 'pageup' || (key.ctrl && key.name === 'u')) cursor = Math.max(cursor - page, 0);
      else if (key.name === 'pagedown' || (key.ctrl && key.name === 'd')) {
        cursor = Math.min(cursor + page, rows.length - 1);
      } else if (key.name === 'g' || key.name === 'home') cursor = 0;
      else if ((key.shift && key.name === 'g') || key.name === 'end') cursor = rows.length - 1;
      else if (key.name === 'return' || key.name === 'enter') {
        message = dim(`${rows[cursor].commit.short} · ${rows[cursor].commit.subject}`);
      }
    }
  } finally {
    screen.leave();
  }

  return 0;
}

function policyFor(row, decisions) {
  if (!row) return null;
  for (const ref of row.commit.refs || []) {
    const decision = decisions.get(ref.name);
    if (decision) return decision;
  }
  return null;
}

/** The branch a commit carries, preferring a local one — the leak scan scope. */
function branchAt(row) {
  const refs = (row?.commit.refs || []).filter((ref) => !ref.tag);
  const branch = refs.find((ref) => !ref.remote) || refs[0];
  return branch ? branch.name : null;
}

function headerContext(session) {
  return {
    repo: session.repo.name,
    branches: session.analysis.branches.length,
    head: session.repo.head || '(detached)',
    remote: session.remote,
    defaultBranch: session.defaultBranch ? `${session.remote}/${session.defaultBranch}` : 'not found',
  };
}

async function runAction(session, action, screen, context = {}) {
  screen.leave();
  let note = null;
  try {
    if (action.id === 'analyze') await runPlan(session, {});
    else if (action.id === 'leaks') {
      // Scoped to the branch under the cursor: the point of picking a commit.
      await runLeaksView(session, context.branch ? { branch: context.branch } : {});
    } else if (action.id === 'restore') await runRestore(session, { list: true });
    else if (action.id === 'settings') await runSettings(session);
    note = dim(`${action.label.toLowerCase()} done${context.branch ? ` · ${context.branch}` : ''}`);
  } catch (error) {
    note = red(error.message);
  }
  await waitForKey(screen, 'press any key to return to the graph');
  screen.enter();
  return note;
}
