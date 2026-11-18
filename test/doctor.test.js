import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createFixture, isolatedEnv } from './helpers/fixture.js';
import { runDoctor, installHint } from '../src/core/doctor.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');

/** A PATH that still has git and node but no gitleaks/opengrep/gh. */
const BARE_PATH = '/usr/bin:/bin';

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
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

test('doctor reports node, git and the engines it can use', async () => {
  const result = await runDoctor({ config: { leaks: { engine: 'auto' } } });

  assert.equal(result.ok, true, `required checks failed: ${JSON.stringify(result.missing)}`);

  const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]));
  assert.equal(byName.node.status, 'ok');
  assert.equal(byName.git.status, 'ok');
  assert.ok(byName.gitleaks, 'gitleaks is always reported');
});

test('install hints come from a platform table, not from guesswork', async () => {
  const result = await runDoctor({ config: { leaks: { engine: 'gitleaks' } } });
  const gitleaks = result.checks.find((check) => check.name === 'gitleaks');

  // On this machine gitleaks exists, so there is nothing to fix.
  if (gitleaks.status === 'ok') assert.equal(gitleaks.fix, null);
  else assert.match(gitleaks.fix, /gitleaks/);

  assert.match(installHint('gitleaks'), /gitleaks/);
  assert.equal(installHint('opengrep'), 'download the release: https://github.com/opengrep/opengrep/releases');
  assert.match(installHint('gh'), /gh/);
});

test('an explicit engine that is missing counts as required, auto does not', async () => {
  const auto = await runDoctor({ config: { leaks: { engine: 'auto' } } });
  const explicit = await runDoctor({ config: { leaks: { engine: 'gitleaks' } } });

  const autoMissing = auto.checks.find((check) => check.name === 'gitleaks')?.required;
  const explicitMissing = explicit.checks.find((check) => check.name === 'gitleaks')?.required;

  assert.equal(autoMissing, false, 'auto degrades, it does not fail');
  assert.equal(explicitMissing, true, 'engine: gitleaks means it must be there');
});

test('doctor --json is machine readable and exits 0 when nothing required is missing', () => {
  const { work } = createFixture();
  const result = run(['doctor', '--json', '--no-fetch'], { cwd: work });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.checks.some((check) => check.name === 'node'));
});

test('a missing gitleaks prints the install line instead of pretending it is clean', () => {
  const { work } = createFixture();

  const result = run(['leaks', '--no-history', '--check'], { cwd: work, env: { PATH: BARE_PATH } });

  assert.equal(result.code, 0, 'policy layer found nothing, and requireEngine is off by default');
  assert.match(result.stdout, /gitleaks is not installed/);
  assert.match(result.stdout, /install/);
});

test('requireEngine turns a missing engine into a failed check', () => {
  const { work } = createFixture();
  writeFileSync(
    join(work, '.git-cleaner.json'),
    JSON.stringify({ leaks: { engine: 'gitleaks', requireEngine: true } }),
  );

  const result = run(['leaks', '--no-history', '--check'], { cwd: work, env: { PATH: BARE_PATH } });

  assert.equal(result.code, 3, result.stdout);
  assert.match(result.stdout, /requireEngine is on and gitleaks is missing/);
});

test('doctor --strict fails when an optional engine is missing', () => {
  const { work } = createFixture();

  const loose = run(['doctor', '--no-fetch'], { cwd: work, env: { PATH: BARE_PATH } });
  const strict = run(['doctor', '--strict', '--no-fetch'], { cwd: work, env: { PATH: BARE_PATH } });

  assert.equal(loose.code, 0, 'the tool still works without the engines');
  assert.equal(strict.code, 1, 'strict mode refuses to call a partial setup healthy');
  assert.match(strict.stdout, /missing/);
});
