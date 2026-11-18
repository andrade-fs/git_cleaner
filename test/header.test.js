import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHeader, terminalWidth } from '../src/ui/banner.js';
import { stripAnsi, visibleLength } from '../src/ui/theme.js';

const FULL = {
  version: '0.1.0',
  repo: 'my-repo',
  branches: 186,
  head: 'main',
  remote: 'origin · github.com',
  defaultBranch: 'origin/main',
  policySource: 'repo → local',
};

const withColumns = (cols, fn) => {
  const original = process.stdout.columns;
  try {
    process.stdout.columns = cols;
    return fn();
  } finally {
    process.stdout.columns = original;
  }
};

test('every header line is exactly as wide as the terminal', () => {
  for (const cols of [56, 64, 72, 80, 96]) {
    withColumns(cols, () => {
      const lines = renderHeader(FULL).split('\n');
      for (const line of lines) {
        assert.equal(visibleLength(line), cols, `at ${cols} cols this line is off: "${line}"`);
      }
    });
  }
});

test('the brand breaks the top border and the maker closes the bottom', () => {
  // Colour must never change what the frame says: strip it before asserting.
  const lines = withColumns(96, () => renderHeader(FULL).split('\n').map(stripAnsi));

  assert.match(lines[0], /^\u256d\u2500 /, 'top border starts with ╭─ ');
  assert.match(lines[0], /TOPIARY/, 'the brand lives in the border');
  assert.match(lines[0], /v0\.1\.0/, 'the version closes the top border');
  assert.match(lines[lines.length - 1], /by @bitsentry/, 'the maker mark closes the panel');
  assert.ok(lines[lines.length - 1].includes('\u256f'), 'bottom right corner is present');
});

test('the context grid is inside the frame', () => {
  const lines = withColumns(96, () => renderHeader(FULL).split('\n').map(stripAnsi));
  const body = lines.slice(1, -1);

  assert.ok(body.every((line) => line.startsWith('\u2502') || line.startsWith('\u251c')), 'each row is framed');
  const flat = body.join('\n');
  for (const label of ['repo', 'head', 'remote', 'default', 'branches', 'policy']) {
    assert.match(flat, new RegExp(`\\b${label}\\b`), `missing ${label}`);
  }
  assert.match(flat, /186/, 'the branch count is its own cell');
});

test('without context the panel is a compact three lines', () => {
  const lines = withColumns(80, () => renderHeader({ version: '1.0.0', tagline: 'leak scanner self-test' }).split('\n'));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /leak scanner self-test/);
});

test('the width is clamped to a sane range', () => {
  assert.equal(withColumns(30, terminalWidth), 56);
  assert.equal(withColumns(200, terminalWidth), 96);
});
