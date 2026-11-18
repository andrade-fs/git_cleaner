import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createFixture } from './helpers/fixture.js';

process.env.NO_COLOR = '1';
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'gc-cfg-'));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'gc-state-'));
process.env.GIT_CONFIG_GLOBAL = '/dev/null';

const { createScreen } = await import('../src/ui/tui.js');
const { openSession } = await import('../src/core/session.js');
const { runSettings } = await import('../src/commands/settings.js');

const KEYS = { down: 'j', enter: '\r', clear: '\u0015' };

/**
 * Deterministic TUI driver: every render consumes the next queued key, so the
 * sequence does not depend on timers.
 */
function scriptedTerminal(keys, { onFrame } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 40;

  const screen = createScreen({ input, output });
  const queue = [...keys];

  output.on('data', (chunk) => {
    onFrame?.(chunk.toString());
    if (queue.length > 0) {
      const next = queue.shift();
      setTimeout(() => input.write(next), 3);
    }
  });

  return { screen, input, output, pending: () => queue.length };
}

async function sessionFor(work, screen) {
  return openSession({ cwd: work, flags: { noFetch: true }, screen });
}

test('editing min age picks a preset instead of typing', async () => {
  const { work } = createFixture();
  // index 3 is rules.minAgeDays → opens the preset list, current is 30d (index 2)
  const { screen } = scriptedTerminal([KEYS.down, KEYS.down, KEYS.down, KEYS.enter, 'k', 'k', KEYS.enter, 's', 'q']);
  const session = await sessionFor(work, screen);

  const baseline = session.plan({}).summary.candidates;
  await runSettings(session);

  const written = JSON.parse(readFileSync(join(work, '.git-cleaner.json'), 'utf8'));
  assert.equal(written.rules.minAgeDays, 7);

  assert.equal(session.config.rules.minAgeDays, 7, 'the session reloads after saving');
  assert.ok(session.plan({}).summary.candidates >= baseline, 'the plan follows the new policy');
});

test('the author picker selects detected identities and switches the mode', async () => {
  const { work } = createFixture();
  // index 1 is targets.users: space picks the first detected author, enter saves
  const { screen } = scriptedTerminal([KEYS.down, KEYS.enter, ' ', KEYS.enter, 's', 'q']);
  const session = await sessionFor(work, screen);

  await runSettings(session);

  const written = JSON.parse(readFileSync(join(work, '.git-cleaner.json'), 'utf8'));

  assert.equal(written.targets.mode, 'allowlist', 'picking authors must flip the scope');
  assert.equal(written.targets.users.length, 1);
  assert.match(written.targets.users[0], /@/, 'the picked entry is an email, not a name');
  assert.equal(session.config.targets.users.length, 1);
});

test('toggling a boolean writes just that boolean', async () => {
  const { work } = createFixture();
  // index 11 is safety.backup (0-2 scope, 3-6 rules, 7-10 protection)
  const { screen } = scriptedTerminal([
    KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down,
    KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.down,
    KEYS.enter, 's', 'q',
  ]);
  const session = await sessionFor(work, screen);

  await runSettings(session);

  const written = JSON.parse(readFileSync(join(work, '.git-cleaner.json'), 'utf8'));
  assert.equal(written.safety.backup, false);
});

test('leaving without saving writes nothing', async () => {
  const { work } = createFixture();
  const { screen } = scriptedTerminal([KEYS.down, KEYS.enter, KEYS.clear, '0', KEYS.enter, 'q']);
  const session = await sessionFor(work, screen);

  await runSettings(session);

  assert.throws(() => readFileSync(join(work, '.git-cleaner.json'), 'utf8'));
  assert.equal(session.config.rules.minAgeDays, 30);
});

test('the screen renders the impact and the modified marker', async () => {
  const { work } = createFixture();
  const frames = [];
  const { screen } = scriptedTerminal(
    [KEYS.down, KEYS.down, KEYS.down, KEYS.enter, KEYS.clear, '0', KEYS.enter, 'q'],
    { onFrame: (frame) => frames.push(frame) },
  );
  const session = await sessionFor(work, screen);

  await runSettings(session);

  const rendered = frames.join('');
  assert.match(rendered, /SETTINGS/);
  assert.match(rendered, /candidates/);
  assert.match(rendered, /unsaved/, 'an edited row is flagged as unsaved');
});

test('a value that came from the repo file reads as repo, not unsaved', async () => {
  const { work } = createFixture();
  writeFileSync(
    join(work, '.git-cleaner.json'),
    `${JSON.stringify({ rules: { minAgeDays: 45 } }, null, 2)}\n`,
  );

  const frames = [];
  // Enter settings, look at the first frame, leave without touching anything.
  const { screen } = scriptedTerminal(['q'], { onFrame: (frame) => frames.push(frame) });
  const session = await sessionFor(work, screen);

  await runSettings(session);

  const rendered = frames.join('');
  assert.match(rendered, /45d/, 'the repo value is on screen');
  assert.match(rendered, /repo/, 'and the badge says where it came from');
  assert.doesNotMatch(rendered, /unsaved/, 'nothing was edited yet');
});
