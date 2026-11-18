import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isolatedEnv } from './helpers/fixture.js';

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

test('the self-test plants canaries and detects every one of them', async () => {
  const { runLeakSelftest } = await import('../src/core/selftest.js');

  const result = await runLeakSelftest({ engine: 'builtin', sast: false });

  assert.equal(result.ok, true, `failed checks: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);

  const names = result.checks.map((check) => check.name);
  for (const expected of [
    'tracked sensitive file',
    'tracked junk',
    'tracked but ignored',
    'gitignore gap',
    'custom rule (regex)',
    'redaction',
    'severity model',
  ]) {
    assert.ok(names.includes(expected), `missing check: ${expected}`);
  }
});

test('the self-test reports a failure when a detection path is broken', async () => {
  const { runLeakSelftest } = await import('../src/core/selftest.js');

  // A config with no custom rules cannot detect the planted acme token.
  const result = await runLeakSelftest({ engine: 'builtin', sast: false, mutate: (config) => {
    config.leaks.rules = [];
  } });

  assert.equal(result.ok, false);
  const ruleCheck = result.checks.find((check) => check.name === 'custom rule (regex)');
  assert.equal(ruleCheck.ok, false);
});

test('leaks --selftest works outside a git repository', () => {
  const result = run(['leaks', '--selftest', '--engine', 'builtin', '--no-sast', '--json'], {
    cwd: '/tmp',
  });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.length >= 7);
  assert.equal(payload.engine, null);
});

test('leaks --selftest prints a readable report', () => {
  const result = run(['leaks', '--selftest', '--engine', 'builtin', '--no-sast'], { cwd: '/tmp' });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /checks passed/);
  assert.match(result.stdout, /tracked sensitive file/);
  assert.match(result.stdout, /the leak scanner works on this machine/);
});
