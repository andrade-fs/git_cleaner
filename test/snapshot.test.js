import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, isolatedEnv } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');

function run(work, args) {
  const out = execFileSync(process.execPath, [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out;
}

function refs(work) {
  const out = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/gitcleaner'], {
    cwd: work,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

test('snapshot backs up every branch in scope without deleting anything', () => {
  const { work } = createFixture();
  const before = execFileSync('git', ['branch', '-r'], { cwd: work, encoding: 'utf8' }).split('\n').filter(Boolean);

  const out = run(work, ['snapshot', '--no-fetch', '--json']);
  const payload = JSON.parse(out);

  assert.match(payload.id, /^\d{8}T\d{6}Z$/, 'the id is a ref-safe timestamp');
  assert.ok(payload.branches >= 7, `expected the fixture branches, got ${payload.branches}`);
  assert.equal(payload.refs.length, payload.branches);
  assert.match(payload.refs[0].ref, new RegExp(`^refs/gitcleaner/${payload.id}/`));

  const created = refs(work);
  assert.equal(created.length, payload.branches, 'one ref per branch');

  const after = execFileSync('git', ['branch', '-r'], { cwd: work, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(after, before, 'the branches are still there');
});

test('the snapshot is restorable: refs point at the branch tips', () => {
  const { work } = createFixture();
  const payload = JSON.parse(run(work, ['snapshot', '--no-fetch', '--json']));

  for (const ref of payload.refs.slice(0, 3)) {
    const sha = execFileSync('git', ['rev-parse', `refs/remotes/origin/${ref.name}`], {
      cwd: work,
      encoding: 'utf8',
    }).trim();
    assert.equal(ref.sha, sha, `${ref.name} is pinned to its tip`);
    assert.equal(ref.ref, `refs/gitcleaner/${payload.id}/${ref.name}`);
  }

  const listed = run(work, ['restore', '--list', '--no-fetch']);
  assert.match(listed, new RegExp(payload.id), 'restore --list sees it');
});

test('--candidates only snapshots what the plan would delete', () => {
  const { work } = createFixture();
  const plan = JSON.parse(run(work, ['plan', '--no-fetch', '--json']));
  const candidates = plan.branches.filter((branch) => branch.decision === 'candidate');
  const payload = JSON.parse(run(work, ['snapshot', '--no-fetch', '--json', '--candidates']));

  assert.equal(payload.branches, candidates.length);
  assert.deepEqual(
    payload.refs.map((ref) => ref.name).sort(),
    candidates.map((entry) => entry.branch).sort(),
  );
});

test('--branch snapshots exactly the named branch', () => {
  const { work } = createFixture();
  const payload = JSON.parse(run(work, ['snapshot', '--no-fetch', '--json', '--branch', 'feature/new']));

  assert.equal(payload.branches, 1);
  assert.equal(payload.refs[0].name, 'feature/new');
  assert.equal(refs(work).length, 1);
});

test('--dry-run writes nothing', () => {
  const { work } = createFixture();
  const out = run(work, ['snapshot', '--no-fetch', '--dry-run']);

  assert.match(out, /would snapshot/);
  assert.deepEqual(refs(work), [], 'no refs are created');
});
