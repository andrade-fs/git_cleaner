import { gitText } from './git.js';

const FIELD_SEP = '\u0001';
const FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s', '%D'].join(FIELD_SEP);

/**
 * Reads the commit graph in one call. `--topo-order` keeps the lanes readable
 * (parents always below children), and the limit keeps it fast on big repos.
 */
export async function loadGraph(root, { limit = 300, refs = true } = {}) {
  const [log, head, decorations] = await Promise.all([
    gitText(
      [
        'log',
        '--all',
        '--topo-order',
        '--date=unix',
        `--format=${FORMAT}`,
        '-n',
        String(limit),
      ],
      { cwd: root, allowFail: true },
    ),
    gitText(['rev-parse', 'HEAD'], { cwd: root, allowFail: true }),
    refs
      ? gitText(['for-each-ref', '--format=%(objectname) %(refname:short) %(refname)'], {
          cwd: root,
          allowFail: true,
        })
      : '',
  ]);

  const commits = [];
  for (const line of log.split('\n')) {
    if (!line) continue;
    const [hash, parents, authorName, authorEmail, time, subject, decorate] = line.split(FIELD_SEP);
    commits.push({
      hash,
      short: hash.slice(0, 8),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      authorName,
      authorEmail,
      time: Number(time) * 1000,
      subject,
      refs: [],
      refsFromLog: decorate ? decorate.split(', ').filter(Boolean) : [],
    });
  }

  // One for-each-ref call beats parsing decorations per commit.
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  for (const line of decorations.split('\n')) {
    if (!line.trim()) continue;
    const [sha, short, full] = line.split(' ');
    // refs/remotes/origin/HEAD shortens to "origin" and is not a branch.
    if (full.endsWith('/HEAD')) continue;
    const commit = byHash.get(sha);
    if (!commit) continue;
    const isTag = full.startsWith('refs/tags/');
    const isRemote = full.startsWith('refs/remotes/');
    commit.refs.push({ name: short, tag: isTag, remote: isRemote });
  }

  // A branch that exists locally and on the remote is shown once.
  for (const commit of commits) {
    const local = new Set(commit.refs.filter((ref) => !ref.remote && !ref.tag).map((ref) => ref.name));
    commit.refs = commit.refs.filter(
      (ref) => !(ref.remote && local.has(ref.name.replace(/^[^/]+\//, ''))),
    );
    if (commit.refs.length === 0 && commit.refsFromLog.length > 0) {
      commit.refs = commit.refsFromLog.map((name) => ({ name, tag: false, remote: false }));
    }
    delete commit.refsFromLog;
  }

  return { commits, head, limit, truncated: commits.length >= limit };
}

/**
 * Assigns each commit a lane and records the edges to its parents, so a renderer
 * can draw the graph without any git knowledge.
 *
 * `lanes[i]` holds the hash the lane is waiting for; a commit whose hash sits in
 * the lane "arrives" there, its first parent continues in the same lane and the
 * extra parents fork or merge into another one.
 */
export function layoutGraph(commits) {
  const lanes = [];
  const rows = [];
  let maxLanes = 1;

  const takeLane = (hash) => {
    let index = lanes.indexOf(hash);
    if (index !== -1) return index;
    index = lanes.indexOf(null);
    if (index === -1) {
      lanes.push(hash);
      return lanes.length - 1;
    }
    lanes[index] = hash;
    return index;
  };

  for (const commit of commits) {
    const lane = takeLane(commit.hash);
    const verticals = lanes.map((value) => Boolean(value));
    verticals[lane] = true;

    // A commit can be expected in more than one lane (two children): collapse.
    const collapsed = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (index !== lane && lanes[index] === commit.hash) {
        collapsed.push(index);
        lanes[index] = null;
      }
    }

    const parents = commit.parents;
    lanes[lane] = parents[0] ?? null;

    const edges = [];
    for (const parent of parents.slice(1)) {
      const existing = lanes.indexOf(parent);
      if (existing !== -1) {
        edges.push({ from: lane, to: existing, merge: true });
      } else {
        const target = takeLane(parent);
        edges.push({ from: lane, to: target, merge: false });
      }
    }

    maxLanes = Math.max(maxLanes, lanes.length, lane + 1);
    rows.push({
      commit,
      lane,
      verticals,
      edges,
      collapsed,
      lanes: lanes.length,
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
  }

  return { rows, laneCount: maxLanes };
}

/** Branch tips: hash → names, for the "which branch is this" question. */
export function branchTips(commits) {
  const tips = new Map();
  for (const commit of commits) {
    const branches = commit.refs.filter((ref) => !ref.tag);
    if (branches.length > 0) tips.set(commit.hash, branches);
  }
  return tips;
}
