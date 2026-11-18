import { formatSnapshotId, listSnapshots, pruneSnapshots, restoreSnapshot, snapshotDate } from '../core/backup.js';
import { formatAge } from '../util/format.js';
import { renderTable } from '../ui/table.js';
import { terminalWidth } from '../ui/banner.js';
import { accent, bold, dim, green, red } from '../ui/theme.js';

export function snapshotsTable(snapshots, { remote } = {}) {
  const rows = snapshots.map((snapshot) => ({
    id: snapshot.id,
    branches: String(snapshot.refs.length),
    sample: snapshot.refs.slice(0, 2).map((ref) => ref.name).join(', ') + (snapshot.refs.length > 2 ? ' …' : ''),
  }));

  return renderTable({
    width: terminalWidth(),
    columns: [
      { key: 'id', header: 'SNAPSHOT', minWidth: 18 },
      { key: 'branches', header: 'BRANCHES', align: 'right', max: 10 },
      { key: 'sample', header: 'BRANCHES (sample)', minWidth: 20 },
    ],
    rows,
  });
}

export async function runRestore(session, flags = {}) {
  const snapshots = await listSnapshots(session.repo.root);

  if (flags.prune) {
    const keep = Number(flags.keep ?? 10);
    const result = await pruneSnapshots(session.repo.root, keep);
    process.stdout.write(`  ${green('✔')} pruned ${result.removed} snapshots, kept ${result.kept}\n`);
    if (!flags.list && !flags.id && !flags.all) return 0;
  }

  if (flags.list || (!flags.id && !flags.all && !flags.prune)) {
    if (snapshots.length === 0) {
      process.stdout.write(`  ${dim('no snapshots for this repository')}\n`);
      return 2;
    }
    process.stdout.write(`${snapshotsTable(snapshots).split('\n').join('\n')}\n`);
    process.stdout.write(
      `\n  ${dim('restore one')}  ${accent(`topiary restore --id ${snapshots[0].id}`)}\n`,
    );
    process.stdout.write(`  ${dim('prune old')}   ${accent('topiary restore --prune --keep 10')}\n`);
    return 0;
  }

  const targets = flags.all ? snapshots : snapshots.filter((snapshot) => snapshot.id === flags.id);
  if (targets.length === 0) {
    process.stderr.write(`  ${red('✖')} snapshot not found: ${flags.id}\n`);
    return 1;
  }

  if (flags.json) {
    const payload = [];
    for (const snapshot of targets) {
      const results = await restoreSnapshot(session.repo.root, session.remote, snapshot, {
        branches: flags.branch,
      });
      payload.push({ snapshot: snapshot.id, results });
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  for (const snapshot of targets) {
    process.stdout.write(
      `\n  ${dim('snapshot')} ${formatSnapshotId(snapshot.id)} ${dim(`· ${snapshot.refs.length} refs · ${formatAge(snapshotDate(snapshot.id))} old`)}\n`,
    );
    const results = await restoreSnapshot(session.repo.root, session.remote, snapshot, {
      branches: flags.branch,
    });
    for (const result of results) {
      if (result.ok) process.stdout.write(`  ${green('✔')} restored ${result.name}\n`);
      else process.stdout.write(`  ${red('✖')} ${result.name} ${dim(`— ${result.error}`)}\n`);
    }
    const failed = results.filter((result) => !result.ok).length;
    if (failed > 0) return 1;
  }

  process.stdout.write(`\n  ${dim('restored to')} ${bold(session.remote)}\n`);
  return 0;
}
