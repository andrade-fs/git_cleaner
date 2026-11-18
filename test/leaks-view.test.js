import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { maskSpan, readSourceFrame, redactLine } from '../src/core/leaks.js';
import { renderCodeFrame, renderFindingDetail, renderFindingsList } from '../src/ui/leaksView.js';
import { actionBar, statusStrip, twoPaneBody } from '../src/ui/frame.js';
import { stripAnsi, visibleLength } from '../src/ui/theme.js';
import { createFixture, isolatedEnv } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');
const CANARY = 'acme_9fK2mQ7pL4vR8tX1zB6nC3wY5jH0sD2g';

const finding = (extra = {}) => ({
  severity: 'critical',
  rule: 'acme-token',
  path: 'src/config.js',
  line: 3,
  message: 'acme token',
  hint: 'acme_9fK2…(37 chars)',
  source: 'rule',
  fixable: false,
  ...extra,
});

function repoWithSecret() {
  const { work } = createFixture();
  writeFileSync(
    join(work, 'src-config.js'),
    `export const config = {\n  region: 'eu',\n  token: '${CANARY}',\n};\n`,
  );
  writeFileSync(
    join(work, '.git-cleaner.json'),
    `${JSON.stringify(
      {
        leaks: {
          engine: 'none',
          history: { enabled: false },
          rules: [{ id: 'acme-token', description: 'acme token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'critical' }],
        },
      },
      null,
      2,
    )}\n`,
  );
  return work;
}

function trackAll(root) {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
}

test('redactLine masks every occurrence and never leaks the secret', () => {
  const line = `token = "${CANARY}"; retry = "${CANARY}";`;
  const masked = redactLine(line, CANARY);

  assert.ok(!masked.includes(CANARY), 'the secret is gone');
  assert.ok(!masked.includes('acme_'), 'no prefix survives');
  assert.equal(masked.match(/●/g).length, 24, 'both occurrences are masked');
  assert.match(masked, /^token = "/, 'the surrounding code survives');
});

test('redactLine keeps the line when there is no secret to mask', () => {
  assert.equal(redactLine('  plain text  ', null), 'plain text');
  assert.equal(redactLine('', CANARY), null);
});

test('maskSpan masks only the reported columns', () => {
  const masked = maskSpan('const token = "abcdef";', 15, 21);
  assert.equal(masked, 'const token = "●●●●●●";');
});

test('the findings list marks the cursor and keeps columns aligned', () => {
  const findings = [
    finding(),
    finding({ severity: 'medium', rule: 'entropy', path: 'deploy/id_rsa', line: 1, message: 'high entropy string' }),
  ];
  const lines = renderFindingsList(findings, { cursor: 1, height: 10, width: 70 });

  assert.match(lines[1], /▸/, 'the second row is selected');
  assert.doesNotMatch(lines[0], /▸/);
  assert.match(lines[0], /src\/config\.js:3/);
  assert.match(lines[0], /crit/, 'severity is abbreviated');
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 70, `row too wide: ${visibleLength(line)}`);
  }
});

test('the detail pane shows path, line number and the masked snippet', () => {
  const lines = renderFindingDetail(
    finding({ snippet: 'token: "●●●●●●●●●●●●"' }),
    { width: 48 },
  );
  const text = lines.join('\n');

  assert.match(text, /src\/config\.js:3/);
  assert.match(text, /3 │/, 'the line number is shown');
  assert.match(text, /token: "●/, 'the masked line is shown');
  assert.match(text, /acme-token/);
  assert.ok(!text.includes(CANARY));
});

test('a history finding without a worktree line says so instead of pretending', () => {
  const text = renderFindingDetail(finding({ line: 12, snippet: null, commit: 'deadbeef' }), { width: 48 }).join('\n');
  assert.match(text, /not in the worktree/);
  assert.match(text, /deadbeef/);
});

test('the code frame shows real source around the finding', () => {
  const work = repoWithSecret();
  const frame = readSourceFrame(work, 'src-config.js', 3, { context: 1 });

  assert.equal(frame.line, 3);
  assert.equal(frame.total, 4);
  assert.deepEqual(frame.lines.map((line) => line.number), [2, 3, 4]);
  assert.match(frame.lines[1].text, /token:/);
  assert.equal(frame.hiddenAbove, 1);
  assert.equal(frame.hiddenBelow, 0);
});

test('the code frame marks the line and shows the key unless masked', () => {
  const frame = readSourceFrame(repoWithSecret(), 'src-config.js', 3, { context: 1 });

  const visible = renderCodeFrame(frame, { width: 70, masked: false, secret: CANARY }).map(stripAnsi).join('\n');
  assert.match(visible, /▸ 3 │/, 'the finding line is marked');
  assert.ok(visible.includes(CANARY), 'the key is shown in full by default');
  assert.ok(!visible.includes('●'), 'nothing is masked');

  const hidden = renderCodeFrame(frame, { width: 70, masked: true, secret: CANARY }).map(stripAnsi).join('\n');
  assert.ok(!hidden.includes(CANARY), 'masking removes the key');
  assert.match(hidden, /token: '●●/);
});

test('a wrapped line pushes the key to its own row instead of cutting it', () => {
  const text = `  token: '${CANARY}', // notes`;
  const frame = { path: 'x.js', line: 1, total: 1, hiddenAbove: 0, hiddenBelow: 0, lines: [{ number: 1, text }] };

  const oneRow = renderCodeFrame(frame, { width: 72, masked: false, secret: CANARY });
  assert.equal(oneRow.length, 1, 'it fits in one row');
  assert.ok(oneRow[0].includes(CANARY), 'the key is intact');

  const wrapped = renderCodeFrame(frame, { width: 50, masked: false, secret: CANARY });
  assert.ok(wrapped.length > 1, 'the line wraps');
  assert.ok(wrapped.join('\n').includes(CANARY), 'the key stays in one piece across rows');
});

test('the raw key only exists when the scanner was asked for it', async () => {
  const work = repoWithSecret();
  trackAll(work);
  const { scanLeaks } = await import('../src/core/leaks.js');
  const { DEFAULTS } = await import('../src/config/defaults.js');

  const config = structuredClone(DEFAULTS);
  config.leaks.engine = 'none';
  config.leaks.history.enabled = false;
  config.leaks.rules = [
    { id: 'acme-token', description: 'acme token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'critical' },
  ];

  const plain = await scanLeaks({ root: work, config, engine: 'none' });
  const plainHit = plain.active.find((item) => item.rule === 'acme-token');
  assert.equal(plainHit.secret, undefined, 'a report scan carries no raw key');

  const viewer = await scanLeaks({ root: work, config, engine: 'none', withSecrets: true });
  const viewerHit = viewer.active.find((item) => item.rule === 'acme-token');
  assert.equal(viewerHit.secret, CANARY, 'the interactive scan can show it');
});

test('the shared chrome never exceeds the terminal width', () => {
  assert.equal(visibleLength(statusStrip({ width: 80, left: ['a', 'b'], right: ['c'] })), 78);
  assert.ok(visibleLength(actionBar({ width: 80, items: ['Fix', 'Baseline'], index: 0 })) <= 80);
  const body = twoPaneBody({ left: ['x'], right: ['y'], leftWidth: 20, height: 2 }).map(stripAnsi);
  assert.equal(body.length, 2);
  assert.match(body[0], /^  x +\S y$/);
});

test('a real scan produces a snippet where the secret is masked', async () => {
  const work = repoWithSecret();
  trackAll(work);
  const { scanLeaks } = await import('../src/core/leaks.js');
  const { DEFAULTS } = await import('../src/config/defaults.js');

  const config = structuredClone(DEFAULTS);
  config.leaks.engine = 'none';
  config.leaks.history.enabled = false;
  config.leaks.rules = [
    { id: 'acme-token', description: 'acme token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'critical' },
  ];

  const result = await scanLeaks({ root: work, config, engine: 'none' });
  const hit = result.active.find((item) => item.rule === 'acme-token');

  assert.ok(hit, 'the rule fired');
  assert.equal(hit.line, 3);
  assert.ok(hit.snippet, 'the finding carries the line');
  assert.ok(!hit.snippet.includes(CANARY), 'the snippet is masked');
  assert.match(hit.snippet, /token: '/);
});

test('a ref scope reads that branch, not the working tree', async () => {
  const work = repoWithSecret();
  trackAll(work);
  const git = (args) => execFileSync('git', args, { cwd: work, stdio: 'ignore' });

  git(['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'base']);
  git(['checkout', '-qb', 'feat/only-here']);
  writeFileSync(join(work, '.env'), `API_KEY=${CANARY}\n`);
  writeFileSync(join(work, 'notes.txt'), 'hello\n');
  git(['add', '-A']);
  git(['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'feat: branch only']);
  git(['checkout', '-q', 'main']);

  const { scanLeaks } = await import('../src/core/leaks.js');
  const { DEFAULTS } = await import('../src/config/defaults.js');
  const config = structuredClone(DEFAULTS);
  config.leaks.engine = 'none';
  config.leaks.history.enabled = false;
  config.leaks.rules = [
    { id: 'acme-token', description: 'acme token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'critical' },
  ];

  const checkout = await scanLeaks({ root: work, config, engine: 'none' });
  assert.equal(
    checkout.findings.some((finding) => finding.path === '.env'),
    false,
    'on main the .env is not there',
  );

  const branch = await scanLeaks({ root: work, config, engine: 'none', ref: 'feat/only-here' });
  const hit = branch.findings.find((finding) => finding.path === '.env');
  assert.ok(hit, 'the branch tree is scanned');
  assert.equal(hit.rule, 'tracked-sensitive');
  assert.equal(branch.scope.ref, 'feat/only-here');

  const frame = readSourceFrame(work, '.env', 1, { context: 1, ref: 'feat/only-here' });
  assert.match(frame.lines[0].text, /API_KEY=/, 'the frame reads the ref too');
});

test('--view falls back to the plain report without a terminal', () => {
  const work = repoWithSecret();
  trackAll(work);
  const stdout = execFileSync(process.execPath, [BIN, 'leaks', '--view', '--no-fetch'], {
    cwd: work,
    encoding: 'utf8',
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(stdout, /TOPIARY/);
  assert.match(stdout, /acme-token|findings/);
  assert.ok(!stdout.includes(CANARY), 'the report never prints the raw secret');
});
