import { appendAudit, createSnapshot, pruneSnapshots } from '../core/backup.js';
import { accent, bold, dim, green, yellow } from '../ui/theme.js';

/**
 * A checkpoint on demand. `delete` already backs up what it is about to remove;
 * this is the same mechanism for when you want the safety net *before* a big
 * cleanup, or a restorable copy of the branches as they are today.
 */
export async function runSnapshot(session, flags = {}) {
  const root = session.repo.root;
  const branches = selectBranches(session, flags);

  if (branches.length === 0) {
    process.stdout.write(`  ${yellow('▲')} ${dim('nothing to snapshot — no branch matched')}\n`);
    return 2;
  }

  if (flags.dryRun) {
    const sample = branches
      .slice(0, 10)
      .map((branch) => `    ${dim('·')} ${branch.name} ${dim(String(branch.sha).slice(0, 8))}`)
      .join('\n');
    process.stdout.write(
      `  ${dim('would snapshot')} ${bold(String(branches.length))} ${dim('branches')}\n${sample}${
        branches.length > 10 ? `\n    ${dim(`+${branches.length - 10} more`)}` : ''
      }\n`,
    );
    return 0;
  }

  const snapshot = await session.screen.withSpinner(`snapshotting ${branches.length} branches…`, () =>
    createSnapshot(root, branches),
  );

  const audit = appendAudit(root, session.remoteInfo, {
    action: 'snapshot',
    id: snapshot.id,
    branches: snapshot.refs.length,
    trigger: flags.candidates ? 'candidates' : flags.branch ? 'explicit' : 'all',
  });

  let pruned = null;
  if (flags.prune) pruned = await pruneSnapshots(root, Number(flags.keep ?? 10));

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          id: snapshot.id,
          scope: scopeLabel(flags),
          branches: snapshot.refs.length,
          refs: snapshot.refs,
          audit,
          pruned,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines = [
    `  ${green('✔')} ${bold(`snapshot ${snapshot.id}`)} ${dim('·')} ${bold(String(snapshot.refs.length))} ${dim(
      'branches',
    )}`,
    `  ${dim('scope')}      ${scopeLabel(flags)}`,
    `  ${dim('refs')}       ${dim(`refs/gitcleaner/${snapshot.id}/…`)}`,
  ];
  if (pruned) lines.push(`  ${dim('pruned')}     ${dim(`${pruned.removed} old snapshots, kept ${pruned.kept}`)}`);

  lines.push(
    '',
    `  ${dim('restore all')}    ${accent(`topiary restore --id ${snapshot.id} --all`)}`,
    `  ${dim('one branch')}     ${accent(`topiary restore --id ${snapshot.id} --branch <name>`)}`,
    `  ${dim('list snapshots')} ${accent('topiary restore --list')}`,
    `  ${dim('audit')}          ${dim(audit.replace(`${root}/`, ''))}`,
    '',
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function selectBranches(session, flags) {
  const planned = session.plan({ includeLocal: Boolean(flags.local) });

  if (flags.candidates) return planned.candidates.filter((branch) => branch.sha);

  const names = Array.isArray(flags.branch) ? flags.branch : flags.branch ? [flags.branch] : [];
  if (names.length > 0) {
    const wanted = new Set(names);
    return planned.decisions.filter((branch) => wanted.has(branch.name) && branch.sha);
  }

  return planned.decisions.filter((branch) => branch.sha);
}

function scopeLabel(flags) {
  if (flags.candidates) return 'every branch the plan would delete';
  const names = Array.isArray(flags.branch) ? flags.branch : flags.branch ? [flags.branch] : [];
  return names.length > 0 ? names.join(', ') : 'every branch in scope';
}
