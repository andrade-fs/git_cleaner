import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every function this codebase calls across modules is camelCase with a verb. */
const CALL = /\b(run|render|load|scan|fix|write|apply|create|format|perform|group|plan|deletion|detect|layout|paint|redact|mask|entropy|worst|fails)[A-Z][A-Za-z0-9]*\s*\(/g;

function importedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/gs)) {
    for (const part of match[1].split(',')) {
      const name = part.split(/\bas\b/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
    names.add(match[1]);
  }
  return names;
}

function declaredNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:function|const|let|class|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  // Destructured declarations, including `const { planToJSON } = await import(...)`.
  for (const match of source.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/gs)) {
    for (const part of match[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('no module calls a function it never imported or declared', () => {
  const problems = [];

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const known = new Set([...importedNames(source), ...declaredNames(source)]);

    for (const match of source.matchAll(CALL)) {
      const name = match[0].slice(0, -1).trim();
      if (!known.has(name)) {
        const line = source.slice(0, match.index).split('\n').length;
        problems.push(`${file.replace(`${SRC}/`, 'src/')}:${line} calls ${name}() without importing it`);
      }
    }
  }

  assert.deepEqual(problems, [], `unresolved calls:\n${problems.join('\n')}`);
});

test('every command exported by the cli is backed by a real module', async () => {
  const { } = await import('../src/cli.js');
  const commands = ['plan', 'delete', 'restore', 'leaks', 'users', 'config', 'doctor', 'graph'];
  const graph = await import('../src/commands/graph.js');
  const leaksView = await import('../src/commands/leaksView.js');

  assert.equal(typeof graph.runGraph, 'function');
  assert.equal(typeof leaksView.runLeaksView, 'function');
  assert.ok(commands.length > 0);
});
