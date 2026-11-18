import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFixture, isolatedEnv, sh, writeConfig } from './helpers/fixture.js';

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

function trackEnv(work, name = '.env') {
  writeFileSync(join(work, name), 'API_KEY=not-a-real-key\n');
  sh(work, ['add', '-f', name]);
  sh(work, ['commit', '-m', 'oops: track env']);
}

test('a tracked .env is reported by the policy layer', () => {
  const { work } = createFixture();
  trackEnv(work);

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  const finding = payload.findings.find((item) => item.path === '.env');
  assert.ok(finding, `expected a finding for .env, got ${JSON.stringify(payload.findings)}`);
  assert.equal(finding.rule, 'tracked-sensitive');
  assert.equal(finding.severity, 'high');
});

test('--check exits 3 when findings reach the threshold', () => {
  const { work } = createFixture();
  trackEnv(work);

  const result = run(['leaks', '--check', '--no-history'], { cwd: work });
  assert.equal(result.code, 3);
  assert.match(result.stdout, /fails threshold/);
});

test('a clean repo passes --check', () => {
  const { work } = createFixture();
  const result = run(['leaks', '--check', '--no-history'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);
});

test('a sensitive file that is neither tracked nor ignored is a gitignore gap', () => {
  const { work } = createFixture();
  writeFileSync(join(work, 'id_rsa'), 'private key\n');

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  const payload = JSON.parse(result.stdout);
  const finding = payload.findings.find((item) => item.path === 'id_rsa');
  assert.ok(finding);
  assert.equal(finding.rule, 'gitignore-gap');
  assert.equal(finding.severity, 'medium');
});

test('--fix untracks the file, keeps it on disk and appends to .gitignore', () => {
  const { work } = createFixture();
  trackEnv(work);

  const result = run(['leaks', '--no-history', '--fix', '--yes'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);

  const tracked = execFileSync('git', ['ls-files'], { cwd: work, encoding: 'utf8' });
  assert.ok(!tracked.split('\n').includes('.env'), '.env should no longer be tracked');
  assert.ok(existsSync(join(work, '.env')), 'the file must stay on disk');

  const ignore = readFileSync(join(work, '.gitignore'), 'utf8');
  assert.match(ignore, /\.env/);
});

test('secrets are redacted in JSON output', () => {
  const { work } = createFixture();
  writeFileSync(join(work, 'config.js'), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
  sh(work, ['add', 'config.js']);
  sh(work, ['commit', '-m', 'add config']);

  const result = run(['leaks', '--json'], { cwd: work });
  const payload = JSON.parse(result.stdout);

  for (const finding of payload.findings) {
    if (finding.hint) {
      assert.doesNotMatch(finding.hint, /AKIAIOSFODNN7EXAMPLE/, 'raw secret must never be printed');
    }
  }
});

// --- custom team rules (the opengrep-lite slice) -----------------------------

const ACME = 'acme_9fK2mQ7pL4vR8tX1zB6nC3wY5jH0sD2g';

function repoWithRule(rule, { file = 'src/token.js', body = `const token = "${ACME}";\n` } = {}) {
  const fixture = createFixture();
  writeConfig(fixture.work, { leaks: { engine: 'none', rules: [rule] } });
  const dir = file.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(join(fixture.work, dir), { recursive: true });
  writeFileSync(join(fixture.work, file), body);
  sh(fixture.work, ['add', '-f', file]);
  sh(fixture.work, ['commit', '-m', 'add token']);
  return fixture.work;
}

test('a custom rule flags its pattern with the configured severity', () => {
  const work = repoWithRule({
    id: 'acme-token',
    description: 'Acme internal token',
    pattern: 'acme_[A-Za-z0-9]{32}',
    severity: 'critical',
  });

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  const payload = JSON.parse(result.stdout);
  const finding = payload.findings.find((item) => item.rule === 'acme-token');

  assert.ok(finding, `custom rule did not fire: ${JSON.stringify(payload.findings.map((f) => f.rule))}`);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.source, 'rules');
  assert.equal(finding.path, 'src/token.js');
  assert.equal(finding.line, 1);
});

test('--check fails on a custom rule hit', () => {
  const work = repoWithRule({ id: 'acme-token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'high' });
  const result = run(['leaks', '--check', '--no-history'], { cwd: work });
  assert.equal(result.code, 3);
});

test('the entropy gate rejects low-entropy matches', () => {
  const work = repoWithRule(
    { id: 'words', pattern: '[a-z]{8,}', entropy: 4.2, severity: 'medium' },
    { file: 'src/plain.js', body: 'const aaaaaaaaaaaa = 1;\n' },
  );

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.findings.filter((item) => item.rule === 'words').length, 0);
});

test('path excludes keep a rule away from generated code', () => {
  const work = repoWithRule(
    { id: 'acme-token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'high', paths: { exclude: ['src/**'] } },
  );

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.findings.filter((item) => item.rule === 'acme-token').length, 0);
});

test('an invalid custom pattern is reported, not thrown', () => {
  const work = repoWithRule({ id: 'broken', pattern: 'acme_[', severity: 'high' });

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.findings.some((item) => item.rule === 'invalid-rule'));
});

test('custom rule hits are redacted in the report', () => {
  const work = repoWithRule({ id: 'acme-token', pattern: 'acme_[A-Za-z0-9]{32}', severity: 'high' });

  const result = run(['leaks', '--no-history', '--json'], { cwd: work });
  assert.ok(!result.stdout.includes(ACME), 'the raw token must never reach stdout');
});
