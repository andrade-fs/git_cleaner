import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFixture, isolatedEnv, remoteHeads } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: isolatedEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('delete without --yes and without a TTY refuses to touch anything', () => {
  const { work, remote } = createFixture();
  const before = remoteHeads(remote);

  const result = run(['delete', '--no-fetch'], { cwd: work });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(remoteHeads(remote), before);
});

test('--dry-run prints the plan and deletes nothing', () => {
  const { work, remote } = createFixture();
  const before = remoteHeads(remote);

  const result = run(['delete', '--dry-run', '--no-fetch'], { cwd: work });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /dry run/);
  assert.deepEqual(remoteHeads(remote), before);
});

test('delete removes only candidates, keeps protected, and snapshots the rest', () => {
  const { work, remote } = createFixture();

  const result = run(['delete', '--yes', '--no-fetch'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);

  const heads = remoteHeads(remote);
  assert.ok(!heads.includes('feature/old-merged'), 'candidate should be gone');
  assert.ok(heads.includes('dev'), 'protected branch kept');
  assert.ok(heads.includes('release/1.0'), 'protected pattern kept');
  assert.ok(heads.includes('feature/alice'), 'other authors untouched by default');
  assert.ok(heads.includes('feature/new'), 'recent branch untouched');
  assert.match(result.stdout, /snapshot/);
});

test('a deleted branch can be restored from the snapshot', () => {
  const { work, remote } = createFixture();

  const deletion = run(['delete', '--yes', '--no-fetch'], { cwd: work });
  assert.equal(deletion.code, 0, deletion.stderr);
  assert.ok(!remoteHeads(remote).includes('feature/old-merged'));

  const list = run(['restore', '--list', '--no-fetch'], { cwd: work });
  const id = list.stdout.match(/(\d{8}T\d{6}Z)/)?.[1];
  assert.ok(id, `snapshot id should be listed:\n${list.stdout}`);

  const restore = run(['restore', '--id', id, '--no-fetch'], { cwd: work });
  assert.equal(restore.code, 0, restore.stderr);
  assert.ok(remoteHeads(remote).includes('feature/old-merged'), 'branch should be back on the remote');
});

test('backup refs live under refs/gitcleaner and survive', () => {
  const { work } = createFixture();
  run(['delete', '--yes', '--no-fetch'], { cwd: work });

  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/gitcleaner'], {
    cwd: work,
    encoding: 'utf8',
  });
  assert.match(refs, /refs\/gitcleaner\/\d{8}T\d{6}Z\/feature\/old-merged/);
});

test('delete --json reports the outcome machine-readably', () => {
  const { work } = createFixture();
  const result = run(['delete', '--yes', '--no-fetch', '--json'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.ok(payload.deleted.includes('feature/old-merged'));
  assert.equal(payload.failed.length, 0);
  assert.ok(payload.snapshot);
});

test('the audit log records the deletion', () => {
  const { work } = createFixture();
  const result = run(['delete', '--yes', '--no-fetch'], { cwd: work });

  const auditMatch = result.stdout.match(/audit\s+(\S+)/);
  assert.ok(auditMatch, 'audit path should be printed');
  const content = execFileSync('cat', [auditMatch[1]], { encoding: 'utf8' });
  assert.match(content, /"action":"delete"/);
  assert.match(content, /feature\/old-merged/);
});
