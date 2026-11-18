import { git, gitText } from './git.js';

const ATTRS = [
  '%(refname)',
  '%(refname:short)',
  '%(committerdate:unix)',
  '%(authordate:unix)',
  '%(authorname)',
  '%(authoremail)',
  '%(objectname)',
  '%(contents:subject)',
].join('%00');

function toBranch(kind, remote, fields, aheadBehind) {
  const [ref, short, time, authorTime, authorName, authorEmail, sha, subject] = fields;
  let name = short;
  if (kind === 'remote' && remote && name.startsWith(`${remote}/`)) {
    name = name.slice(remote.length + 1);
  }
  return {
    kind,
    name,
    ref,
    sha,
    authorName: (authorName || '').trim(),
    authorEmail: (authorEmail || '').trim().toLowerCase().replace(/^<|>$/g, ''),
    time: Number(time) * 1000,
    date: new Date(Number(time) * 1000),
    authorTime: Number(authorTime) * 1000,
    authorDate: new Date(Number(authorTime) * 1000),
    subject: (subject || '').trim(),
    merged: false,
    ahead: aheadBehind ? aheadBehind[0] : null,
    behind: aheadBehind ? aheadBehind[1] : null,
  };
}

async function listRefs(root, prefix, baseRef) {
  const format = baseRef ? `${ATTRS}%00%(ahead-behind:${baseRef})` : ATTRS;
  let out;
  try {
    out = await gitText(['for-each-ref', `--format=${format}`, prefix], { cwd: root });
  } catch {
    // Older git without the ahead-behind atom: retry without it.
    out = await gitText(['for-each-ref', `--format=${ATTRS}`, prefix], { cwd: root });
  }

  const rows = out ? out.split('\n').filter(Boolean) : [];
  const result = [];
  // `refs/remotes/origin` is the remote HEAD symref, not a branch.
  const skipRef = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;

  for (const row of rows) {
    const fields = row.split('\0');
    if (fields.length < 8) continue;
    if (fields[0] === skipRef) continue;
    // refs/remotes/<remote>/HEAD is the remote HEAD symref, not a branch.
    if (fields[0].endsWith('/HEAD')) continue;

    const extra = fields[8];
    const aheadBehind = extra
      ? extra
          .trim()
          .split(/\s+/)
          .map((value) => Number(value))
      : null;

    result.push(
      toBranch(prefix.startsWith('refs/heads') ? 'local' : 'remote', deriveRemote(prefix), fields, aheadBehind),
    );
  }
  return result;
}

function deriveRemote(prefix) {
  const match = prefix.match(/^refs\/remotes\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

async function mergedSet(root, prefix, baseRef) {
  if (!baseRef) return new Set();
  const { ok, stdout } = await git(['for-each-ref', `--merged=${baseRef}`, '--format=%(refname)', prefix], {
    cwd: root,
    allowFail: true,
  });
  if (!ok) return new Set();
  return new Set(stdout.split('\n').filter(Boolean));
}

/**
 * One pass over all refs: names, dates, authors, subjects, ahead/behind and
 * merged state. No per-branch subprocess.
 */
export async function analyzeRepo({ root, remote = 'origin', defaultBranch, includeLocal = true }) {
  const warnings = [];
  const baseRef = defaultBranch ? `refs/remotes/${remote}/${defaultBranch}` : null;

  const remoteBranches = await listRefs(root, `refs/remotes/${remote}`, baseRef);
  const localBranches = includeLocal ? await listRefs(root, 'refs/heads', baseRef) : [];

  const mergedRemote = await mergedSet(root, `refs/remotes/${remote}`, baseRef);
  const mergedLocal = includeLocal ? await mergedSet(root, 'refs/heads', baseRef) : new Set();

  for (const branch of remoteBranches) branch.merged = mergedRemote.has(branch.ref);
  for (const branch of localBranches) branch.merged = mergedLocal.has(branch.ref);

  if (!baseRef) {
    warnings.push(
      `no default branch found for ${remote}; merged/ahead-behind data is unavailable`,
    );
  }

  // Local branches that already exist upstream are duplicates of remote ones.
  const localNames = new Set(localBranches.map((branch) => branch.name));

  return {
    remoteBranches,
    localBranches,
    branches: [...remoteBranches, ...localBranches],
    localNames,
    warnings,
  };
}
