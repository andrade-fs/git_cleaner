import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture } from './helpers/fixture.js';

// Isolate config/state before the modules read process.env.
process.env.NO_COLOR = '1';
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'gc-cfg-'));
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'gc-state-'));
process.env.GIT_CONFIG_GLOBAL = '/dev/null';

const { openSession, noopScreen } = await import('../src/core/session.js');
const settings = await import('../src/commands/settings.js');

function sessionFor(work, flags = {}) {
  return openSession({ cwd: work, flags: { noFetch: true, ...flags }, screen: noopScreen });
}

test('getPath / setPath / hasPath handle nested paths', () => {
  const object = {};
  settings.setPath(object, 'rules.minAgeDays', 7);
  assert.equal(settings.getPath(object, 'rules.minAgeDays'), 7);
  assert.equal(settings.hasPath(object, 'rules.minAgeDays'), true);
  assert.equal(settings.hasPath(object, 'rules.merged'), false);

  settings.setPath(object, 'leaks.paths.deny', ['.env']);
  assert.deepEqual(settings.getPath(object, 'leaks.paths.deny'), ['.env']);
});

test('saveDraft writes only the overrides, with the schema reference', () => {
  const { work } = createFixture();
  const path = join(work, '.git-cleaner.json');

  settings.saveDraft(path, { rules: { minAgeDays: 90 } });

  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(written.$schema, settings.SCHEMA_URL);
  assert.deepEqual(written.rules, { minAgeDays: 90 });
  assert.equal(Object.keys(written).length, 2, 'no default blob should be written');
});

test('loadDraft round-trips and strips $schema', () => {
  const { work } = createFixture();
  const path = join(work, '.git-cleaner.json');

  settings.saveDraft(path, { targets: { mode: 'all' } });
  const draft = settings.loadDraft(path);

  assert.equal(draft.$schema, undefined);
  assert.equal(draft.targets.mode, 'all');
  assert.deepEqual(settings.loadDraft(join(work, 'nope.json')), {});
});

test('the preview shows the impact before saving anything', async () => {
  const { work } = createFixture();
  const session = await sessionFor(work);

  const before = settings.previewPlan(session, {}).summary.candidates;
  const after = settings.previewPlan(session, { rules: { minAgeDays: 0 }, safety: { protectUnmerged: false } })
    .summary.candidates;

  assert.equal(before, session.plan({}).summary.candidates);
  assert.ok(after > before, `expected more candidates with a looser policy (${before} → ${after})`);
  assert.equal(existsSync(join(work, '.git-cleaner.json')), false, 'preview must not write files');
});

test('edits are marked as unsaved in the rows', async () => {
  const { work } = createFixture();
  const session = await sessionFor(work);

  const draft = { rules: { minAgeDays: 12 } };
  const rows = settings.buildRows(session, draft);
  const row = rows.find((item) => item.field.path === 'rules.minAgeDays');

  assert.match(row.badge, /unsaved/);
  assert.match(row.display, /12d/);

  const untouched = rows.find((item) => item.field.path === 'rules.merged');
  assert.doesNotMatch(untouched.badge, /unsaved/);
});

test('save + reload makes the new policy live in the same session', async () => {
  const { work } = createFixture();
  const session = await sessionFor(work);

  const baseline = session.plan({}).summary.candidates;
  assert.ok(baseline > 0);

  settings.saveDraft(settings.targetPath(session, 'repo'), {
    rules: { minAgeDays: 3650 },
  });

  await session.reload({ fetch: false, prs: false });

  assert.equal(session.config.rules.minAgeDays, 3650, 'reload should re-read the file');
  assert.equal(session.plan({}).summary.candidates, 0, 'and the plan should follow');
  assert.ok(session.layers.some((layer) => layer.label === 'repo'));
});

test('saving to the local layer does not touch the repo layer', async () => {
  const { work } = createFixture();
  const session = await sessionFor(work);

  settings.saveDraft(settings.targetPath(session, 'repo'), { rules: { merged: 'only' } });
  settings.saveDraft(settings.targetPath(session, 'local'), { rules: { minAgeDays: 5 } });

  await session.reload({ fetch: false, prs: false });

  assert.equal(session.config.rules.merged, 'only');
  assert.equal(session.config.rules.minAgeDays, 5);
  assert.equal(session.sources['rules.merged'], 'repo');
  assert.equal(session.sources['rules.minAgeDays'], 'local');
});

test('targetPath points at the three writable layers', async () => {
  const { work } = createFixture();
  const session = await sessionFor(work);

  assert.match(settings.targetPath(session, 'repo'), /\.git-cleaner\.json$/);
  assert.match(settings.targetPath(session, 'local'), /\.git-cleaner\.local\.json$/);
  assert.match(settings.targetPath(session, 'global'), /topiary\/config\.json$/);
});

test('every editable field exists in the published schema', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'));

  const resolve = (path) =>
    path
      .split('.')
      .reduce((node, key) => (node && node.properties ? node.properties[key] : undefined), schema);

  for (const field of settings.FIELDS) {
    assert.ok(resolve(field.path), `${field.path} is editable but missing from schema.json`);
  }
});

test('a value rejected by validation is not written', async () => {
  const { work } = createFixture();
  const session = await sessionFor(work);
  const path = settings.targetPath(session, 'repo');

  // The TUI validates before writing; make sure bad input fails loudly.
  const check = settings.validateDraftForTest({ rules: { minAgeDays: 'soon' } });
  assert.ok(check.errors.length > 0);
  assert.equal(existsSync(path), false);
});

test('a draft with an unknown option only warns', async () => {
  const check = settings.validateDraftForTest({ rules: { minAgeDayz: 3 } });
  assert.equal(check.errors.length, 0);
  assert.ok(check.warnings.length > 0);
});

test('writeFileSync is not called by preview (no side effects)', async () => {
  const { work } = createFixture();
  writeFileSync(join(work, '.git-cleaner.json'), '{"rules":{"minAgeDays":45}}');
  const session = await sessionFor(work);

  settings.previewPlan(session, { rules: { minAgeDays: 1 } });
  const onDisk = JSON.parse(readFileSync(join(work, '.git-cleaner.json'), 'utf8'));
  assert.equal(onDisk.rules.minAgeDays, 45);
});
