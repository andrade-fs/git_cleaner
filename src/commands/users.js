import { formatAge } from '../util/format.js';
import { renderTable } from '../ui/table.js';
import { terminalWidth } from '../ui/banner.js';
import { dim, gray, green, yellow } from '../ui/theme.js';

/** Group branches by author identity so config can be written from data. */
export function groupAuthors(branches) {
  const map = new Map();

  for (const branch of branches) {
    const key = branch.authorEmail || `name:${branch.authorName}`;
    if (!map.has(key)) {
      map.set(key, {
        email: branch.authorEmail || null,
        names: new Set(),
        branches: 0,
        merged: 0,
        last: branch.time,
      });
    }
    const entry = map.get(key);
    if (branch.authorName) entry.names.add(branch.authorName);
    entry.branches += 1;
    if (branch.merged) entry.merged += 1;
    entry.last = Math.max(entry.last, branch.time);
  }

  return [...map.values()]
    .map((entry) => ({ ...entry, names: [...entry.names] }))
    .sort((a, b) => b.branches - a.branches);
}

export function authorsTable(authors) {
  const rows = authors.map((author) => ({
    email: author.email || dim('(no email)'),
    names: author.names.join(', '),
    branches: String(author.branches),
    merged: author.merged === author.branches ? green(String(author.merged)) : yellow(`${author.merged}/${author.branches}`),
    last: gray(formatAge(author.last)),
  }));

  return renderTable({
    width: terminalWidth(),
    columns: [
      { key: 'email', header: 'EMAIL', minWidth: 22 },
      { key: 'names', header: 'NAMES SEEN', minWidth: 16, max: 34 },
      { key: 'branches', header: 'BRANCHES', align: 'right', max: 9 },
      { key: 'merged', header: 'MERGED', align: 'right', max: 8 },
      { key: 'last', header: 'LAST', align: 'right', max: 6 },
    ],
    rows,
  });
}

export async function runUsers(session, flags = {}) {
  const branches = flags.local ? session.analysis.branches : session.analysis.remoteBranches;
  const authors = groupAuthors(branches);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ authors, me: session.me }, null, 2)}\n`);
    return 0;
  }

  if (authors.length === 0) {
    process.stdout.write(`  ${dim('no branches on')} ${session.remote}\n`);
    return 2;
  }

  process.stdout.write(`${authorsTable(authors).split('\n').join('\n')}\n`);
  process.stdout.write(
    `\n  ${dim(`${authors.length} identities · ${branches.length} branches · your git user.email: ${session.me || 'unset'}`)}\n`,
  );
  if (authors.length > 1) {
    process.stdout.write(
      `  ${dim('copy an email into targets.users (allowlist) or targets.exclude (denylist) in')} .git-cleaner.json\n`,
    );
  }
  return 0;
}
