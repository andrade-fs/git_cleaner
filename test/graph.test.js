import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { layoutGraph, loadGraph } from '../src/core/graph.js';
import { paintLanes, renderGraph, renderCommitDetail } from '../src/ui/graph.js';
import { visibleLength } from '../src/ui/theme.js';
import { createFixture, isolatedEnv } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'topiary.js');

const commit = (hash, parents, extra = {}) => ({
  hash,
  short: hash.slice(0, 8),
  parents,
  authorName: 'Dev',
  authorEmail: 'dev@example.com',
  time: Date.parse('2026-01-01T00:00:00Z'),
  subject: `commit ${hash}`,
  refs: [],
  ...extra,
});

/**
 * c5 (merge) ─┬─ c4 ─ c3 ─┐
 *             └─ c2 ──────┴─ c1
 */
function mergeHistory() {
  return [
    commit('c5', ['c4', 'c2']),
    commit('c4', ['c3']),
    commit('c3', ['c1']),
    commit('c2', ['c1']),
    commit('c1', []),
  ];
}

test('the first parent continues in the same lane, the second one forks', () => {
  const { rows, laneCount } = layoutGraph(mergeHistory());

  assert.equal(rows[0].lane, 0, 'the head takes the first lane');
  assert.deepEqual(rows[0].edges.map((edge) => [edge.from, edge.to]), [[0, 1]], 'the merge forks to lane 1');
  assert.equal(laneCount, 2);

  assert.equal(rows[1].lane, 0, 'first parent stays in lane 0');
  assert.equal(rows[3].lane, 1, 'the merged branch lives in lane 1');
});

test('two lanes collapse when they reach their common ancestor', () => {
  const { rows } = layoutGraph(mergeHistory());
  const root = rows[4];

  assert.equal(root.commit.hash, 'c1');
  assert.equal(root.lane, 0);
  assert.deepEqual(root.collapsed, [1], 'lane 1 merges back into lane 0 at c1');
});

test('a linear history stays in one lane', () => {
  const { rows, laneCount } = layoutGraph([commit('a2', ['a1']), commit('a1', [])]);
  assert.equal(laneCount, 1);
  assert.ok(rows.every((row) => row.lane === 0));
  assert.ok(rows.every((row) => row.edges.length === 0));
});

test('a commit expected in two lanes is drawn once', () => {
  const history = [
    commit('m', ['x', 'y']),
    commit('x', ['base']),
    commit('y', ['base']),
    commit('base', []),
  ];
  const { rows } = layoutGraph(history);
  assert.equal(rows[3].commit.hash, 'base');
  assert.deepEqual(rows[3].collapsed, [1]);
});

test('every rendered line fits the pane width', () => {
  const { rows, laneCount } = layoutGraph(mergeHistory());
  for (const width of [60, 80, 96]) {
    const lines = renderGraph(rows, { width, height: 10, laneCount, cursor: 2 });
    for (const line of lines) {
      assert.ok(visibleLength(line) <= width, `line too wide (${visibleLength(line)} > ${width}): ${line}`);
    }
  }
});

test('the cursor row is marked and the node is drawn', () => {
  const { rows, laneCount } = layoutGraph(mergeHistory());

  const lines = renderGraph(rows, { width: 80, height: 10, laneCount, cursor: 1 });
  assert.match(lines[1], /▸/, 'the selected row carries the cursor');
  assert.doesNotMatch(lines[0], /▸/);

  const cells = paintLanes(rows[0], { laneCount });
  assert.equal(cells[0].main, '◆', 'a merge commit uses the merge glyph');
  assert.equal(cells[1].main, '╮', 'the fork lands in the second lane');
});

test('the detail pane shows the commit and its policy decision', () => {
  const { rows } = layoutGraph([commit('deadbeef', [], { refs: [{ name: 'feature/x', tag: false }] })]);
  const lines = renderCommitDetail(rows[0], {
    width: 44,
    decision: { reason: 'skip:unmerged', detail: 'holds 2 commits' },
  });
  const text = lines.join('\n');

  assert.match(text, /deadbeef/);
  assert.match(text, /feature\/x/);
  assert.match(text, /skip:unmerged/);
  assert.match(text, /holds 2 commits/);
});

test('loadGraph reads real history with refs and keeps parents', async () => {
  const { work } = createFixture();
  const graph = await loadGraph(work);

  assert.ok(graph.commits.length > 5, 'the fixture has commits');
  assert.ok(graph.head, 'HEAD resolves');

  const head = graph.commits[0];
  assert.equal(head.parents.length, 1, 'the tip has a parent');

  const withRefs = graph.commits.filter((item) => item.refs.length > 0);
  assert.ok(withRefs.length >= 2, 'branches are attached to their commits');
  assert.ok(withRefs.some((item) => item.refs.some((ref) => ref.name === 'feature/old-merged')));
});

test('graph prints a plain listing when there is no terminal', () => {
  const { work } = createFixture();
  const stdout = execFileSync(process.execPath, [BIN, 'graph', '--no-fetch', '--limit', '20'], {
    cwd: work,
    encoding: 'utf8',
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(stdout, /TOPIARY/);
  assert.match(stdout, /●|◆/, 'the graph glyphs are printed');
});
