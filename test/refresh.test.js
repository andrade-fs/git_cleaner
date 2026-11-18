import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScreen } from '../src/ui/tui.js';
import { openSession } from '../src/core/session.js';
import { performDeletion } from '../src/commands/delete.js';
import { createFixture } from './helpers/fixture.js';

function fakeScreen() {
  const input = new PassThrough();
  input.isTTY = false;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = false;
  output.columns = 100;
  output.rows = 30;
  output.on('data', () => {});
  return createScreen({ input, output });
}

async function openAt(work) {
  const env = {
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'gc-cfg-')),
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'gc-state-')),
  };
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await openSession({ cwd: work, flags: { noFetch: true }, screen: fakeScreen() });
  } finally {
    Object.assign(process.env, before);
  }
}

test('a deleted branch disappears from the plan once the session is reloaded', async () => {
  const { work } = createFixture();
  const session = await openAt(work);

  const total = session.plan({}).summary.total;
  const [victim] = session.plan({}).candidates;
  assert.ok(victim, 'the fixture has something to delete');

  const outcome = await performDeletion(session, [victim]);
  assert.ok(
    outcome.results.some((result) => result.ok),
    `delete failed: ${JSON.stringify(outcome.results)}`,
  );

  await session.reload({ fetch: false, prs: false });

  const after = session.plan({});
  assert.equal(after.summary.total, total - 1, 'one branch fewer');
  assert.equal(
    after.decisions.some((branch) => branch.name === victim.name),
    false,
    `${victim.name} is gone from the analysis`,
  );
});
