import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createFixture, isolatedEnv } from './helpers/fixture.js';

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

test('config --explain shows the merged values and their layer', () => {
  const { work } = createFixture();
  writeFileSync(join(work, '.git-cleaner.json'), JSON.stringify({ rules: { minAgeDays: 90 } }));

  const result = run(['config', '--explain', '--no-fetch'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /rules\.minAgeDays\s+90\s+repo/);
  assert.match(result.stdout, /leaks\.engine\s+auto\s+defaults/);
});

test('global config is a layer below the repo config', () => {
  const { work } = createFixture();
  const configHome = join(isolatedEnv().XDG_CONFIG_HOME, 'topiary');
  mkdirSync(configHome, { recursive: true });
  writeFileSync(join(configHome, 'config.json'), JSON.stringify({ rules: { minAgeDays: 111 } }));

  const env = { XDG_CONFIG_HOME: join(configHome, '..') };
  const globalOnly = run(['config', '--json', '--no-fetch'], { cwd: work, env });
  assert.equal(JSON.parse(globalOnly.stdout).rules.minAgeDays, 111);

  writeFileSync(join(work, '.git-cleaner.json'), JSON.stringify({ rules: { minAgeDays: 222 } }));
  const repoWins = run(['config', '--json', '--no-fetch'], { cwd: work, env });
  assert.equal(JSON.parse(repoWins.stdout).rules.minAgeDays, 222);
});

test('flags are the highest layer', () => {
  const { work } = createFixture();
  writeFileSync(join(work, '.git-cleaner.json'), JSON.stringify({ rules: { minAgeDays: 222 } }));

  const result = run(['config', '--json', '--no-fetch', '--min-age', '7'], { cwd: work });
  assert.equal(JSON.parse(result.stdout).rules.minAgeDays, 7);
});

test('--init writes a starter config and refuses to overwrite it', () => {
  const { work } = createFixture();

  const first = run(['config', '--init', '--no-fetch'], { cwd: work });
  assert.equal(first.code, 0, first.stderr);
  assert.ok(existsSync(join(work, '.git-cleaner.json')));

  const second = run(['config', '--init', '--no-fetch'], { cwd: work });
  assert.equal(second.code, 1);
  assert.match(second.stderr, /already exists/);
});

test('--path lists the layers that were loaded', () => {
  const { work } = createFixture();
  writeFileSync(join(work, '.git-cleaner.json'), '{}');

  const result = run(['config', '--path', '--no-fetch'], { cwd: work });
  assert.match(result.stdout, /repo/);
  assert.match(result.stdout, /defaults/);
});

test('an unknown option is a warning, a wrong type is an error', () => {
  const { work } = createFixture();

  writeFileSync(join(work, '.git-cleaner.json'), JSON.stringify({ rules: { minAgeDayz: 3 } }));
  const warn = run(['config', '--explain', '--no-fetch'], { cwd: work });
  assert.equal(warn.code, 0);

  writeFileSync(join(work, '.git-cleaner.json'), JSON.stringify({ rules: { merged: 'yes' } }));
  const error = run(['config', '--json', '--no-fetch'], { cwd: work });
  assert.equal(error.code, 1);
  assert.match(error.stderr, /expected one of/);
});

test('legacy .env still configures the tool', () => {
  const { work } = createFixture();
  writeFileSync(join(work, '.env'), 'TARGET_USERS=alice@example.com\n');

  const result = run(['config', '--json', '--no-fetch'], { cwd: work });
  const config = JSON.parse(result.stdout);
  assert.equal(config.targets.mode, 'allowlist');
  assert.deepEqual(config.targets.users, ['alice@example.com']);
});

test('legacy GIT_PATH from the cwd .env still finds the repo', () => {
  const { work, root } = createFixture();
  writeFileSync(join(root, '.env'), `GIT_PATH=${work}\n`);

  const result = run(['plan', '--json', '--no-fetch'], { cwd: root });
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.branches.length > 0, 'should have analysed the repo pointed at by GIT_PATH');
});

test('users lists authors with emails so config can be written from data', () => {
  const { work } = createFixture();
  const result = run(['users', '--no-fetch'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /santiago@example\.com/);
  assert.match(result.stdout, /alice@example\.com/);
});
