import { reasonText } from '../core/policy.js';
import { formatAge } from '../util/format.js';
import { renderTable } from '../ui/table.js';
import { accent, bold, dim, gray, green, red, visibleLength, yellow } from '../ui/theme.js';
import { terminalWidth } from '../ui/banner.js';

const mergedCell = (branch) => (branch.merged ? green('yes') : yellow('no'));

const ageCell = (branch) => {
  const days = (Date.now() - branch.time) / 86_400_000;
  const text = formatAge(branch.time);
  if (days > 365) return red(text);
  if (days > 180) return yellow(text);
  return gray(text);
};

const aheadCell = (branch) => {
  if (branch.ahead === null || branch.ahead === undefined) return dim('?');
  if (branch.ahead === 0) return dim('0');
  return yellow(String(branch.ahead));
};

const scopeCell = (branch) => (branch.kind === 'local' ? dim('local') : '');

export function candidatesTable(plan, { width = terminalWidth() } = {}) {
  const rows = plan.candidates.map((branch) => ({
    branch: branch.name,
    author: branch.authorName || branch.authorEmail,
    age: ageCell(branch),
    ahead: aheadCell(branch),
    merged: mergedCell(branch),
    scope: scopeCell(branch),
  }));

  return renderTable({
    width,
    columns: [
      { key: 'branch', header: 'BRANCH', minWidth: 20 },
      { key: 'author', header: 'AUTHOR', max: 20, minWidth: 10 },
      { key: 'age', header: 'AGE', align: 'right', max: 5 },
      { key: 'ahead', header: 'AHEAD', align: 'right', max: 6 },
      { key: 'merged', header: 'MERGED', max: 7 },
      { key: 'scope', header: '', max: 6 },
    ],
    rows,
  });
}

export function decisionsTable(plan, { width = terminalWidth() } = {}) {
  const rows = plan.decisions
    .slice()
    .sort((a, b) => a.time - b.time)
    .map((branch) => ({
      branch: branch.name,
      author: branch.authorName || branch.authorEmail,
      age: ageCell(branch),
      ahead: aheadCell(branch),
      merged: mergedCell(branch),
      reason: branch.decision === 'candidate' ? green('candidate') : branch.decision === 'protected' ? red(reasonText(branch.reason)) : yellow(reasonText(branch.reason)),
      detail: dim(branch.detail || ''),
    }));

  return renderTable({
    width,
    columns: [
      { key: 'branch', header: 'BRANCH', minWidth: 18 },
      { key: 'author', header: 'AUTHOR', max: 18, minWidth: 8 },
      { key: 'age', header: 'AGE', align: 'right', max: 5 },
      { key: 'ahead', header: 'AHEAD', align: 'right', max: 6 },
      { key: 'merged', header: 'MERGED', max: 7 },
      { key: 'reason', header: 'DECISION', max: 24, minWidth: 12 },
      { key: 'detail', header: 'DETAIL', max: 24 },
    ],
    rows,
  });
}

export function summaryLines(plan, config, options = {}) {
  const { summary } = plan;
  const threshold = options.threshold ?? config.rules.minAgeDays;

  const headline = [
    accent('◆'),
    bold(String(summary.candidates)),
    dim(`candidate${summary.candidates === 1 ? '' : 's'}`),
    dim('·'),
    bold(String(summary.total)),
    dim('branches analysed'),
    dim('·'),
    bold(String(summary.total - summary.candidates)),
    dim('left alone'),
    dim('·'),
    dim(`threshold ${threshold}d`),
  ].join(' ');

  const breakdown = [];
  const reasonCounts = Object.entries(summary.byReason)
    .filter(([reason]) => reason !== 'candidate')
    .sort((a, b) => b[1] - a[1]);

  for (const [reason, count] of reasonCounts.slice(0, 6)) {
    const label = reasonText(reason).replace(/^(skip|protected):\s*/, '');
    const tone = reason.startsWith('protected') ? red : yellow;
    breakdown.push(`${tone(String(count))} ${dim(label)}`);
  }

  const lines = [headline];
  if (breakdown.length > 0) lines.push(`  ${dim('left alone')}  ${breakdown.join(dim(' · '))}`);
  if (summary.candidates > 0) {
    lines.push(`  ${dim('oldest')}      ${formatAge(Date.now() - summary.oldestDays * 86_400_000)} ${dim('· average')} ${dim(`${summary.averageDays}d`)}`);
  }
  return lines;
}

export function planLines(session, plan, options = {}) {
  const width = terminalWidth();
  const lines = [];

  lines.push(session.header());
  lines.push('');

  if (plan.candidates.length === 0) {
    // "Nothing to delete" and "nothing CAN match" are opposite outcomes that
    // print the same count. Never let an unsatisfiable policy look like success.
    const blocked = (plan.warnings || []).find((warning) => warning.code === 'empty-allowlist');
    if (blocked) {
      lines.push(`  ${yellow('▲')} ${bold('nothing can match')} ${dim('— the policy excludes every branch')}`);
      lines.push(`  ${dim(blocked.message)}`);
    } else {
      lines.push(`  ${green('✔')} ${bold('nothing to delete')} ${dim('— every branch is either protected, too recent or out of scope')}`);
    }
    if (plan.summary.total === 0) {
      lines.push(`  ${dim('no branches found on')} ${session.remote}${dim('; try --local to include local branches')}`);
    }
  } else {
    lines.push(...summaryLines(plan, session.config, options).map((line) => `  ${line}`));
    lines.push('');
    lines.push(
      `  ${decisionsOrCandidates(plan, options).split('\n').join('\n  ')}`,
    );
  }

  if (options.explain) {
    lines.push('');
    lines.push(`  ${dim('explain: every branch and the rule that decided it')}`);
    lines.push('');
    lines.push(`  ${decisionsTable(plan, { width }).split('\n').join('\n  ')}`);
  }

  lines.push('');
  if (plan.candidates.length > 0) {
    const nextSteps = options.dryRun
      ? `topiary delete --yes${options.allowUnmerged ? ' --allow-unmerged' : ''}`
      : `topiary delete${options.allowUnmerged ? ' --allow-unmerged' : ''}`;
    lines.push(`  ${dim('next')}      ${accent(nextSteps)}`);
  }
  if (plan.protected.length > 0) {
    lines.push(
      `  ${dim('protected')} ${dim(plan.protected.slice(0, 4).map((item) => item.name).join(', '))}${plan.protected.length > 4 ? dim(` +${plan.protected.length - 4}`) : ''}`,
    );
  }

  return lines;
}

function decisionsOrCandidates(plan, options) {
  const width = terminalWidth();
  return candidatesTable(plan, { width });
}

export async function runPlan(session, flags = {}) {
  const plan = session.plan({
    allowUnmerged: Boolean(flags.allowUnmerged),
    includeLocal: Boolean(flags.includeLocal),
  });

  if (flags.json) {
    const { planToJSON } = await import('../core/plan.js');
    process.stdout.write(
      `${JSON.stringify(
        planToJSON(plan, {
          repo: session.repo.root,
          remote: session.remote,
          defaultBranch: session.defaultBranch,
          policy: session.config,
          warnings: session.warnings,
          policyWarnings: (plan.warnings || []).map((warning) => warning.code),
        }),
        null,
        2,
      )}\n`,
    );
    return plan.candidates.length > 0 ? 0 : 2;
  }

  if (session.warnings.length > 0) {
    for (const warning of session.warnings) {
      process.stderr.write(`${yellow('▲')} ${dim(warning)}\n`);
    }
  }

  // Policy warnings change what the numbers mean: print them, never bury them.
  for (const warning of plan.warnings || []) {
    process.stderr.write(`${yellow('▲')} ${yellow(warning.message)}\n`);
  }

  process.stdout.write(`${planLines(session, plan, { allowUnmerged: flags.allowUnmerged, explain: flags.explain }).join('\n')}\n`);
  return plan.candidates.length > 0 ? 0 : 2;
}
