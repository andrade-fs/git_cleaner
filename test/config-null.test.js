import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config/validate.js';
import { saveDraft } from '../src/commands/settings.js';
import { createFixture, isolatedEnv } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');

function plan(work) {
  const result = execFileSync(process.execPath, [BIN, 'plan', '--no-fetch'], {
    cwd: work,
    encoding: 'utf8',
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { out: result, code: 0 };
}

function planRaw(work) {
  try {
    const out = execFileSync(process.execPath, [BIN, 'plan', '--no-fetch'], {
      cwd: work,
      encoding: 'utf8',
      env: isolatedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (error) {
    return { out: `${error.stdout || ''}${error.stderr || ''}`, code: error.status };
  }
}

test('null on a list field is a warning, not an error', () => {
  const { errors, warnings } = validateConfig({ targets: { mode: 'allowlist', users: null } }, 'repo');

  assert.deepEqual(errors, [], 'the config still loads');
  assert.ok(
    warnings.some((warning) => warning.includes('targets.users') && warning.includes('not set')),
    `expected a warning about targets.users, got ${JSON.stringify(warnings)}`,
  );
});

test('null on a scalar is still an error', () => {
  const { errors } = validateConfig({ rules: { minAgeDays: null } }, 'repo');
  assert.ok(errors.some((error) => error.includes('minAgeDays: null is not allowed')));
});

test('an unsatisfiable allowlist is reported, not read as "clean"', () => {
  const { work } = createFixture();
  writeFileSync(
    join(work, '.git-cleaner.json'),
    `${JSON.stringify({ targets: { mode: 'allowlist', users: null } }, null, 2)}\n`,
  );

  const { out, code } = planRaw(work);
  assert.equal(code, 2, 'nothing to delete');
  assert.match(out, /nothing can match/, 'it says the policy blocks everything');
  assert.match(out, /targets\.users is empty/, 'and how to fix it');
  assert.match(out, /Settings/, 'pointing at the editor');
});

test('saving the editor drops stray nulls but keeps "no limit"', () => {
  const { work } = createFixture();
  const path = join(work, '.git-cleaner.json');

  saveDraft(path, { targets: { mode: 'allowlist', users: null }, rules: { maxAhead: null, minAgeDays: 7 } });
  const saved = JSON.parse(readFileSync(path, 'utf8'));

  assert.equal('users' in saved.targets, false, 'the null list is gone');
  assert.equal(saved.targets.mode, 'allowlist');
  assert.equal(saved.rules.maxAhead, null, 'null is a real value for maxAhead');
  assert.equal(saved.rules.minAgeDays, 7);
  assert.equal(saved.$schema.length > 0, true);
});

test('the same config with authors produces candidates', () => {
  const { work } = createFixture();
  writeFileSync(
    join(work, '.git-cleaner.json'),
    `${JSON.stringify({ targets: { mode: 'allowlist', users: ['santiago@example.com'] } }, null, 2)}\n`,
  );

  const { out } = plan(work);
  assert.doesNotMatch(out, /nothing can match/);
  assert.match(out, /\d+ candidate/, 'branches are in scope again');
});
