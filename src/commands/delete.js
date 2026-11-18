import { appendAudit, createSnapshot, formatSnapshotId, verifyDeleted } from '../core/backup.js';
import { git } from '../core/git.js';
import { askYesNo } from '../util/readline.js';
import { accent, bold, dim, green, red, yellow } from '../ui/theme.js';
import { planLines } from './plan.js';

const lastLine = (text = '') => {
  const lines = String(text).trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] || '';
};

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const alreadyGone = (message = '') => /remote ref does not exist|unable to delete/i.test(message);

/** Deletes branches: remote in batches with a lease, local one by one. */
export async function performDeletion(session, branches, { onProgress } = {}) {
  const { repo, remote, config } = session;
  const results = [];

  let snapshot = null;
  if (config.safety.backup) {
    snapshot = await createSnapshot(repo.root, branches);
  }

  const remotes = branches.filter((branch) => branch.kind === 'remote');
  const locals = branches.filter((branch) => branch.kind === 'local');

  for (const group of chunk(remotes, 20)) {
    const args = ['push', '--porcelain', remote];
    for (const branch of group) {
      // Lease: if the branch moved since we analysed it, the delete is refused.
      if (branch.sha) args.push(`--force-with-lease=refs/heads/${branch.name}:${branch.sha}`);
    }
    args.push('--delete', ...group.map((branch) => branch.name));

    const batch = await git(args, { cwd: repo.root, allowFail: true, timeout: 180_000 });
    if (batch.ok) {
      results.push(...group.map((branch) => ({ name: branch.name, kind: 'remote', ok: true })));
    } else {
      // Isolate the failure so the user learns which branch and why.
      for (const branch of group) {
        const single = await git(['push', '--porcelain', remote, '--delete', branch.name], {
          cwd: repo.root,
          allowFail: true,
          timeout: 120_000,
        });
        const error = single.ok ? null : lastLine(single.stderr);
        results.push({
          name: branch.name,
          kind: 'remote',
          ok: single.ok || alreadyGone(error),
          error,
        });
      }
    }
    onProgress?.(results.length, branches.length);
  }

  for (const branch of locals) {
    const single = await git(['branch', branch.merged ? '-d' : '-D', branch.name], {
      cwd: repo.root,
      allowFail: true,
    });
    results.push({
      name: branch.name,
      kind: 'local',
      ok: single.ok,
      error: single.ok ? null : lastLine(single.stderr),
    });
  }

  const deletedRemotes = remotes.filter((branch) => results.some((r) => r.name === branch.name && r.ok));

  // The remote is gone, but `refs/remotes/<remote>/<branch>` is still here and the
  // analysis reads those refs — without this, a deleted branch keeps showing up
  // until the next `fetch --prune`.
  for (const branch of deletedRemotes) {
    await git(['update-ref', '-d', `refs/remotes/${remote}/${branch.name}`], {
      cwd: repo.root,
      allowFail: true,
    });
  }

  const verification = await verifyDeleted(repo.root, remote, deletedRemotes);

  return { snapshot, results, verification };
}

export function deletionReportLines(session, { snapshot, results, verification }) {
  const ok = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const lines = [];

  if (ok.length > 0) {
    lines.push(`  ${green('✔')} ${bold(`deleted ${ok.length}`)} ${dim(`branch${ok.length === 1 ? '' : 'es'}`)}`);
  }
  for (const failure of failed) {
    lines.push(`  ${red('✖')} ${failure.name} ${dim(`— ${failure.error || 'unknown error'}`)}`);
  }

  const raced = verification.filter((item) => item.gone === false);
  if (raced.length > 0) {
    lines.push(`  ${yellow('▲')} ${raced.length} branch${raced.length === 1 ? '' : 'es'} still present on ${session.remote}: ${dim(raced.map((item) => item.name).join(', '))}`);
  }

  if (snapshot && snapshot.refs.length > 0) {
    lines.push('');
    lines.push(`  ${dim('snapshot')}  ${formatSnapshotId(snapshot.id)} ${dim(`(${snapshot.refs.length} refs)`)}`);
    lines.push(`  ${dim('undo')}      ${accent(`topiary restore --id ${snapshot.id}`)}`);
  } else if (!session.config.safety.backup) {
    lines.push('');
    lines.push(`  ${yellow('▲')} ${dim('backup disabled — these branches are gone for good')}`);
  }

  return lines;
}

export async function runDelete(session, flags = {}) {
  const plan = session.plan({
    allowUnmerged: Boolean(flags.allowUnmerged),
    includeLocal: Boolean(flags.includeLocal),
  });

  if (flags.json) {
    if (plan.candidates.length === 0) {
      process.stdout.write(`${JSON.stringify({ deleted: [], failed: [], reason: 'nothing to delete' }, null, 2)}\n`);
      return 2;
    }
  } else {
    process.stdout.write(`${planLines(session, plan, { allowUnmerged: flags.allowUnmerged, explain: flags.explain }).join('\n')}\n`);
  }

  if (plan.candidates.length === 0) return 2;

  if (flags.dryRun) {
    if (!flags.json) process.stdout.write(`\n  ${dim('dry run — nothing was deleted')}\n`);
    return 0;
  }

  const needsConfirm = session.config.safety.requireConfirm && !flags.yes;
  if (needsConfirm) {
    if (!session.screen.interactive) {
      process.stderr.write(
        `\n  ${red('✖')} refusing to delete without a terminal. Re-run with ${accent('--yes')} ${dim('or use --dry-run to inspect')}\n`,
      );
      return 2;
    }
    process.stdout.write('\n');
    const confirmed = await askYesNo(
      `  ${bold(`Delete ${plan.candidates.length} branches from ${session.remote}?`)} ${dim('type y to confirm')}`,
    );
    if (!confirmed) {
      process.stdout.write(`  ${dim('aborted — nothing was deleted')}\n`);
      return 0;
    }
  }

  if (session.dirty) {
    process.stderr.write(`  ${yellow('▲')} ${dim('working tree has uncommitted changes (remote deletion is unaffected)')}\n`);
  }

  const outcome = await session.screen.withSpinner(
    `deleting ${plan.candidates.length} branches from ${session.remote}…`,
    () => performDeletion(session, plan.candidates),
  );

  const auditFile = appendAudit(session.repo.root, session.remoteInfo, {
    action: 'delete',
    remote: session.remote,
    snapshot: outcome.snapshot?.id || null,
    branches: outcome.results.map((result) => ({
      name: result.name,
      kind: result.kind,
      ok: result.ok,
      error: result.error || null,
    })),
  });

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          deleted: outcome.results.filter((result) => result.ok).map((result) => result.name),
          failed: outcome.results.filter((result) => !result.ok),
          snapshot: outcome.snapshot?.id || null,
          verification: outcome.verification,
          audit: auditFile,
        },
        null,
        2,
      )}\n`,
    );
    return outcome.results.some((result) => !result.ok) ? 1 : 0;
  }

  process.stdout.write(`\n${deletionReportLines(session, outcome).join('\n')}\n`);
  process.stdout.write(`  ${dim('audit')}     ${dim(auditFile)}\n`);
  return outcome.results.some((result) => !result.ok) ? 1 : 0;
}
