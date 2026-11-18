import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitText } from './git.js';
import { stateDir } from '../config/paths.js';

const PREFIX = 'refs/gitcleaner';

export function repoId(root, remoteInfo) {
  const seed = remoteInfo?.url || root;
  return createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

/** Ref-safe timestamp: ISO 8601 has colons, which refs forbid. */
export function snapshotId(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function formatSnapshotId(id) {
  const match = String(id).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return id;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}Z`;
}

export function snapshotDate(id) {
  const match = String(id).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return new Date(0);
  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

/**
 * Writes refs/gitcleaner/<id>/<branch> for every branch about to be deleted.
 * Cheap (no objects copied) and enough to re-push the branch later.
 */
export async function createSnapshot(root, branches, options = {}) {
  const id = options.id || snapshotId();
  const usable = branches.filter((branch) => branch && branch.sha && branch.name);
  if (usable.length === 0) return { id, refs: [] };

  const rows = usable.map((branch) => ({
    name: branch.name,
    sha: branch.sha,
    ref: `${PREFIX}/${id}/${branch.name}`,
    kind: branch.kind,
  }));

  // One process for the whole batch: 186 branches used to mean 186 git calls.
  if (usable.length > 20) {
    const input = rows.map((row) => `update ${row.ref} ${row.sha}`).join('\n');
    const result = await git(['update-ref', '--stdin'], { cwd: root, allowFail: true, input: `${input}\n` });
    if (result.ok) return { id, refs: rows };
  }

  const refs = [];
  for (const row of rows) {
    const result = await git(['update-ref', row.ref, row.sha], { cwd: root, allowFail: true });
    if (result.ok) refs.push(row);
  }

  return { id, refs };
}

export async function listSnapshots(root) {
  const { ok, stdout } = await git(
    ['for-each-ref', `--format=%(refname)%00%(objectname)`, PREFIX],
    { cwd: root, allowFail: true },
  );
  if (!ok || !stdout.trim()) return [];

  const snapshots = new Map();
  for (const row of stdout.split('\n').filter(Boolean)) {
    const [ref, sha] = row.split('\0');
    const rest = ref.slice(PREFIX.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) continue;
    const id = rest.slice(0, slash);
    const name = rest.slice(slash + 1);
    if (!snapshots.has(id)) snapshots.set(id, { id, refs: [] });
    snapshots.get(id).refs.push({ name, sha, kind: 'remote', ref });
  }

  return [...snapshots.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Re-push backed-up branches to the remote. */
export async function restoreSnapshot(root, remote, snapshot, options = {}) {
  const wanted = options.branches?.length
    ? snapshot.refs.filter((ref) => options.branches.includes(ref.name))
    : snapshot.refs;

  const results = [];
  for (const ref of wanted) {
    const result = await git(['push', '--porcelain', remote, `${ref.sha}:refs/heads/${ref.name}`], {
      cwd: root,
      allowFail: true,
      timeout: 120_000,
    });
    results.push({ name: ref.name, ok: result.ok, error: result.ok ? null : lastLine(result.stderr) });
  }
  return results;
}

export async function pruneSnapshots(root, keep = 10) {
  const snapshots = await listSnapshots(root);
  const doomed = snapshots.slice(keep);
  if (doomed.length === 0) return { removed: 0, kept: snapshots.length };

  const refs = doomed.flatMap((snapshot) => snapshot.refs.map((ref) => `delete ${ref.ref}`));
  for (let i = 0; i < refs.length; i += 50) {
    const chunk = refs.slice(i, i + 50).join('\n');
    await git(['update-ref', '--stdin'], { cwd: root, allowFail: true, input: `${chunk}\n` });
  }
  return { removed: doomed.length, kept: keep };
}

export function auditPath(root, remoteInfo) {
  return join(stateDir(repoId(root, remoteInfo)), 'audit.jsonl');
}

export function appendAudit(root, remoteInfo, entry) {
  const path = auditPath(root, remoteInfo);
  mkdirSync(join(path, '..'), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  return path;
}

export function readAudit(root, remoteInfo, limit = 50) {
  const path = auditPath(root, remoteInfo);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function lastLine(text = '') {
  const lines = String(text).trim().split('\n');
  return lines[lines.length - 1] || '';
}

/** Verify the remote really dropped the refs. */
export async function verifyDeleted(root, remote, branches) {
  if (branches.length === 0) return [];
  const { ok, stdout } = await git(['ls-remote', '--heads', remote, ...branches.map((b) => b.name)], {
    cwd: root,
    allowFail: true,
    timeout: 60_000,
  });
  if (!ok) return branches.map((branch) => ({ name: branch.name, gone: null }));

  const alive = new Set(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1]?.replace('refs/heads/', ''))
      .filter(Boolean),
  );

  return branches.map((branch) => ({ name: branch.name, gone: !alive.has(branch.name) }));
}

export async function hasSnapshotSupport(root) {
  const prefix = await gitText(['rev-parse', '--git-dir'], { cwd: root, allowFail: true });
  return Boolean(prefix);
}
