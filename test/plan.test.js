import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFixture, isolatedEnv, writeConfig } from './helpers/fixture.js';

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

function planJSON(args, options) {
  const result = run(['plan', '--json', '--no-fetch', ...args], options);
  return { ...JSON.parse(result.stdout), code: result.code };
}

const names = (payload, decision = 'candidate') =>
  payload.branches.filter((branch) => branch.decision === decision).map((branch) => branch.branch).sort();

test('default policy only touches my old merged branches', () => {
  const { work } = createFixture();
  const payload = planJSON([], { cwd: work });

  assert.deepEqual(names(payload), ['featuer/typo', 'feature/old-merged']);
});

test('protected branches by name and pattern are never candidates', () => {
  const { work } = createFixture();
  const payload = planJSON(['--mode', 'all', '--allow-unmerged', '--min-age', '0'], { cwd: work });

  const protectedNames = names(payload, 'protected');
  assert.ok(protectedNames.includes('dev'));
  assert.ok(protectedNames.includes('release/1.0'));
  assert.ok(!names(payload).includes('dev'));
  assert.ok(!names(payload).includes('release/1.0'));
});

test('recent branches are left alone', () => {
  const { work } = createFixture();
  const payload = planJSON(['--mode', 'all', '--allow-unmerged'], { cwd: work });
  const recent = payload.branches.find((branch) => branch.branch === 'feature/new');
  assert.equal(recent.decision, 'skip');
  assert.equal(recent.reason, 'skip:too-recent');
});

test('unmerged branches need --allow-unmerged', () => {
  const { work } = createFixture();

  const strict = planJSON([], { cwd: work });
  const unmerged = strict.branches.find((branch) => branch.branch === 'feature/old-unmerged');
  assert.equal(unmerged.reason, 'skip:unmerged');

  const loose = planJSON(['--allow-unmerged'], { cwd: work });
  assert.ok(names(loose).includes('feature/old-unmerged'));
});

test('allowlist mode scopes to the given authors, deny list wins', () => {
  const { work } = createFixture();

  const allow = planJSON(['--mode', 'allowlist', '--author', 'alice@example.com', '--min-age', '0'], { cwd: work });
  assert.deepEqual(names(allow), ['feature/alice']);

  const deny = planJSON(
    ['--mode', 'all', '--allow-unmerged', '--min-age', '0', '--exclude', 'alice@example.com'],
    { cwd: work },
  );
  assert.ok(!names(deny).includes('feature/alice'));
});

test('protect.users blocks an author even in mode all', () => {
  const { work } = createFixture();
  writeConfig(work, {
    targets: { mode: 'all' },
    protect: { users: [{ email: 'ci@bots.example.com', reason: 'bot' }] },
  });

  const payload = planJSON(['--allow-unmerged', '--min-age', '0'], { cwd: work });
  const bot = payload.branches.find((branch) => branch.branch === 'feature/bot');
  assert.equal(bot.decision, 'protected');
  assert.equal(bot.detail, 'bot');
});

test('repo config beats defaults and flags beat the repo config', () => {
  const { work } = createFixture();
  writeConfig(work, { rules: { minAgeDays: 500 } });

  const fromRepo = planJSON(['--mode', 'all', '--allow-unmerged'], { cwd: work });
  assert.deepEqual(names(fromRepo), []);

  const fromFlag = planJSON(['--mode', 'all', '--allow-unmerged', '--min-age', '0'], { cwd: work });
  assert.ok(names(fromFlag).length > 0);
});

test('missing git repository is a clean error, not a stack trace', () => {
  const { root } = createFixture();
  const result = run(['plan'], { cwd: root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not a git repository/);
  assert.doesNotMatch(result.stderr, /at Object/);
});

test('invalid config names the option and the file', () => {
  const { work } = createFixture();
  writeConfig(work, { rules: { minAgeDays: 'thirty' } });

  const result = run(['plan', '--no-fetch'], { cwd: work });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rules\.minAgeDays/);
  assert.match(result.stderr, /expected number/);
});

test('exit code 2 when there is nothing to do', () => {
  const { work } = createFixture();
  const result = run(['plan', '--json', '--no-fetch', '--min-age', '3000'], { cwd: work });
  assert.equal(result.code, 2);
});
