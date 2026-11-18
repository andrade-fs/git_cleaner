import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { git, gitLines, gitText, refExists } from './git.js';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function insideRepository(dir = process.cwd()) {
  if (!existsSync(dir)) return false;
  const toplevel = await gitText(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
  return Boolean(toplevel);
}

export async function resolveRepo(cwd = process.cwd()) {
  const absolute = resolve(cwd);
  if (!existsSync(absolute)) {
    throw new UsageError(`path does not exist: ${absolute}`);
  }
  const isBare = (await gitText(['rev-parse', '--is-bare-repository'], { cwd: absolute, allowFail: true })) === 'true';
  const toplevel = await gitText(['rev-parse', '--show-toplevel'], { cwd: absolute, allowFail: true });

  const root = isBare ? absolute : toplevel;
  if (!root) {
    throw new UsageError(`not a git repository: ${absolute}`);
  }

  const gitDir = await gitText(['rev-parse', '--absolute-git-dir'], { cwd: root, allowFail: true });
  const remotes = await gitLines(['remote'], { cwd: root, allowFail: true });
  const head = await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFail: true });

  return {
    root,
    gitDir,
    remotes,
    name: basename(root),
    head: head && head !== 'HEAD' ? head : null,
    bare: isBare,
  };
}

export async function getRemoteUrl(root, remote = 'origin') {
  const url = await gitText(['config', '--get', `remote.${remote}.url`], { cwd: root, allowFail: true });
  return url || null;
}

/** Parse https / ssh / scp-like remotes into a provider descriptor. */
export function parseRemoteUrl(url) {
  if (!url) return null;
  const trimmed = url.trim().replace(/\.git$/, '');

  let host = null;
  let path = null;

  const scp = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  const proto = trimmed.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i);

  if (proto) {
    host = proto[1];
    path = proto[2];
  } else if (scp && !trimmed.includes('://')) {
    host = scp[1];
    path = scp[2];
  } else if (/^[/~]/.test(trimmed)) {
    return { host: null, owner: null, repo: basename(trimmed), kind: 'local', url, slug: null };
  }

  if (!host || !path) return { host: null, owner: null, repo: basename(trimmed), kind: 'unknown', url, slug: null };

  const parts = path.split('/').filter(Boolean);
  const repo = parts.pop() || '';
  const owner = parts.join('/');

  let kind = 'other';
  if (/github\.com$/i.test(host)) kind = 'github';
  else if (/gitlab/i.test(host)) kind = 'gitlab';
  else if (/bitbucket/i.test(host)) kind = 'bitbucket';

  return { host, owner, repo, kind, url, slug: owner ? `${owner}/${repo}` : repo };
}

export async function getDefaultBranch(root, remote = 'origin') {
  const symbolic = await gitText(
    ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`],
    { cwd: root, allowFail: true },
  );
  if (symbolic) return symbolic.replace(`refs/remotes/${remote}/`, '');

  for (const candidate of ['main', 'master', 'develop', 'trunk', 'dev']) {
    if (await refExists(root, `refs/remotes/${remote}/${candidate}`)) return candidate;
  }
  if (await refExists(root, 'refs/heads/main')) return 'main';
  if (await refExists(root, 'refs/heads/master')) return 'master';
  return null;
}

export async function getWorktreeBranches(root) {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], { cwd: root, allowFail: true });
  const branches = new Map();
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch ') && current) {
      const ref = line.slice('branch '.length);
      branches.set(ref.replace('refs/heads/', ''), current);
    }
  }
  return branches;
}

export async function isDirty(root) {
  const { stdout } = await git(['status', '--porcelain=v1', '--untracked-files=no'], {
    cwd: root,
    allowFail: true,
  });
  return stdout.trim().length > 0;
}

export async function fetchRemote(root, remote = 'origin', { prune = true, timeout = 90_000 } = {}) {
  const args = ['fetch', '--quiet'];
  if (prune) args.push('--prune');
  args.push(remote);
  return git(args, { cwd: root, allowFail: true, timeout });
}

export async function remoteHeadSha(root, remote, branch) {
  const out = await gitText(['ls-remote', '--heads', remote, branch], { cwd: root, allowFail: true });
  if (!out) return null;
  const [sha] = out.split(/\s+/);
  return sha || null;
}
