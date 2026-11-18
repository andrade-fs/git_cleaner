import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sastFindings } from '../src/core/sast.js';

const RULES = `rules:
  - id: selftest-no-eval
    languages: [javascript]
    severity: ERROR
    message: eval usage
    patterns:
      - pattern: eval(...)
  - id: selftest-warning
    languages: [javascript]
    severity: WARNING
    message: debugger statement
    patterns:
      - pattern: debugger
`;

function hasOpengrep() {
  try {
    execFileSync('opengrep', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function repoWithRule() {
  const root = mkdtempSync(join(tmpdir(), 'gc-sast-'));
  writeFileSync(join(root, 'app.js'), 'function run(input){ return eval(input); }\n');
  writeFileSync(join(root, '.opengrep.yml'), RULES);
  return root;
}

test('SAST is off unless enabled', async () => {
  const result = await sastFindings({ root: tmpdir(), config: { leaks: {} } });
  assert.deepEqual(result.findings, []);
  assert.equal(result.note, null);
  assert.equal(result.engine, null);
});

test('opengrep output is normalized into findings and redacted', { skip: !hasOpengrep() }, async () => {
  const root = repoWithRule();
  const config = { leaks: { sast: { enabled: true, engine: 'opengrep' } } };

  const result = await sastFindings({ root, config });

  assert.equal(result.engine, 'opengrep');
  assert.equal(result.findings.length, 1, `expected one finding, got ${JSON.stringify(result.findings)}`);

  const finding = result.findings[0];
  assert.equal(finding.rule, 'selftest-no-eval');
  assert.equal(finding.source, 'opengrep');
  assert.equal(finding.severity, 'high', 'ERROR maps to high');
  assert.equal(finding.path, 'app.js');
  assert.equal(finding.line, 1);
  assert.ok(finding.hint, 'a redacted hint is kept');
  assert.ok(!finding.hint.includes('eval(input)'), 'the matched code must not be printed');
});

test('a missing rule file is a note, not a crash', { skip: !hasOpengrep() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'gc-sast-'));
  const result = await sastFindings({ root, config: { leaks: { sast: { enabled: true } } } });

  assert.deepEqual(result.findings, []);
  assert.match(result.note, /rule file/);
});

test('an explicit rule file wins over auto-detection', { skip: !hasOpengrep() }, async () => {
  const root = repoWithRule();
  const alt = join(root, 'custom-rules.yml');
  writeFileSync(alt, 'rules:\n  - id: only-debugger\n    languages: [javascript]\n    severity: INFO\n    message: debugger\n    patterns:\n      - pattern: debugger\n');

  const result = await sastFindings({
    root,
    config: { leaks: { sast: { enabled: true, config: 'custom-rules.yml' } } },
  });

  assert.equal(result.findings.length, 0, 'app.js has no debugger statement');
  assert.equal(result.rules, 'custom-rules.yml');
});

test('SAST can be forced for a single run', { skip: !hasOpengrep() }, async () => {
  const root = repoWithRule();
  const result = await sastFindings({ root, config: { leaks: {} }, force: true });

  assert.equal(result.engine, 'opengrep');
  assert.equal(result.findings.length, 1);
});
