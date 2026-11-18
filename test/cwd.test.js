import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, isolatedEnv } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');

function run(work, args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: isolatedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out: stdout, code: 0 };
  } catch (error) {
    return { out: `${error.stdout || ''}${error.stderr || ''}`, code: error.status };
  }
}

test('a stale GIT_PATH in .env cannot hijack the repository you are standing in', () => {
  const { work } = createFixture();
  writeFileSync(join(work, '.env'), 'GIT_PATH=/Volumes/980PRO/Workspace/gone/old-repo\n');

  const { out, code } = run(work, ['plan', '--no-fetch']);

  assert.equal(code, 0, `the plan should work on the current repo:\n${out}`);
  assert.doesNotMatch(out, /not a git repository/, 'the dead path is not used');
  assert.doesNotMatch(out, /980PRO/, 'the stale path is not even mentioned');
  assert.match(out, /repo\s+repo\b/, 'it analysed the repository in the cwd');
});

test('GIT_PATH is still a fallback outside a repository, when it exists', () => {
  const { work } = createFixture();
  const outside = join(work, 'nested-plain-dir');
  execFileSync('mkdir', ['-p', outside]);
  writeFileSync(join(outside, '.env'), `GIT_PATH=${work}\n`);

  const { out, code } = run(outside, ['plan', '--no-fetch']);

  assert.equal(code, 0, `the legacy contract still works:\n${out}`);
  assert.match(out, /repo\s+repo\b/, 'it used the pointed repository');
});

test('--cwd with a missing path says so instead of blaming git', () => {
  const { work } = createFixture();
  const { out, code } = run(work, ['plan', '--cwd', '/Volumes/definitely-not-here/repo', '--no-fetch']);

  assert.equal(code, 1);
  assert.match(out, /path does not exist/);
  assert.doesNotMatch(out, /not a git repository/);
});

test('--cwd outside a repository is still a git error', () => {
  const { work } = createFixture();
  const { out, code } = run(work, ['plan', '--cwd', '/tmp', '--no-fetch']);

  assert.equal(code, 1);
  assert.match(out, /not a git repository/);
});
