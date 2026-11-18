import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { buildFlags } from '../src/cli.js';

/**
 * A flag that parseArgs accepts but buildFlags forgets is worse than a flag that
 * does not exist: it is documented in `--help`, quoted in the README, and then
 * silently ignored. `leaks --view` shipped exactly like that.
 *
 * These cases are the flags whose absence changes what the tool does rather
 * than only how loud it is, so each one is asserted by hand.
 */
const CASES = [
  [['--view'], 'view'],
  [['--selftest'], 'selftest'],
  [['--check'], 'check'],
  [['--fix'], 'fix'],
  [['--strict'], 'strict'],
  [['--sast'], 'sast'],
  [['--no-sast'], 'noSast'],
  [['--no-history'], 'noHistory'],
  [['--init'], 'init'],
  [['--path'], 'path'],
  [['--prune'], 'prune'],
  [['--all'], 'all'],
  [['--candidates'], 'candidates'],
];

const OPTIONS = {
  view: { type: 'boolean' },
  selftest: { type: 'boolean' },
  check: { type: 'boolean' },
  fix: { type: 'boolean' },
  strict: { type: 'boolean' },
  sast: { type: 'boolean' },
  'no-sast': { type: 'boolean' },
  'no-history': { type: 'boolean' },
  init: { type: 'boolean' },
  path: { type: 'boolean' },
  prune: { type: 'boolean' },
  all: { type: 'boolean' },
  candidates: { type: 'boolean' },
};

for (const [argv, key] of CASES) {
  test(`${argv.join(' ')} reaches buildFlags as ${key}`, () => {
    const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    assert.equal(buildFlags(values)[key], true);
  });
}

test('an absent flag stays falsy instead of becoming truthy by default', () => {
  const { values } = parseArgs({ args: [], options: OPTIONS, allowPositionals: true, strict: true });
  assert.equal(buildFlags(values).view, false);
});
