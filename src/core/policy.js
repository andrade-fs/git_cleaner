/**
 * Policy engine. Every branch gets exactly one decision and a machine-readable
 * reason — that reason is the product: the user must never wonder why a branch
 * was left alone.
 */
const DAY = 86_400_000;

const globCache = new Map();

/** `*` = any chars except `/`, `**` = any chars, `?` = one char. */
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += '$';
  const regex = new RegExp(out);
  globCache.set(glob, regex);
  return regex;
}

/** Looser glob for emails/names: `*` matches everything. */
function starGlob(pattern) {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return regex;
}

export function normalizeUser(entry) {
  if (typeof entry === 'string') return { email: entry };
  if (!entry || typeof entry !== 'object') return {};
  return entry;
}

function matchesUser(entry, branch) {
  const { email, name } = normalizeUser(entry);
  if (email && branch.authorEmail) {
    if (starGlob(email).test(branch.authorEmail)) return true;
  }
  if (name) {
    const pattern = String(name);
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const end = pattern.lastIndexOf('/');
      const body = pattern.slice(1, end);
      const flags = pattern.slice(end + 1) || 'i';
      try {
        if (new RegExp(body, flags).test(branch.authorName)) return true;
      } catch {
        /* invalid regex in config: ignored, validated elsewhere */
      }
    } else if (starGlob(pattern).test(branch.authorName)) {
      return true;
    }
  }
  return false;
}

export function matchesProtectedBranch(name, ref, config) {
  for (const glob of config.protect.branches || []) {
    const regex = globToRegExp(glob);
    if (regex.test(name) || regex.test(ref)) return `branch ${glob}`;
  }
  for (const pattern of config.protect.patterns || []) {
    try {
      if (new RegExp(pattern).test(name) || new RegExp(pattern).test(ref)) return `pattern ${pattern}`;
    } catch {
      /* validated elsewhere */
    }
  }
  return null;
}

function ageDays(branch, config) {
  const time = config.rules.dateField === 'authordate' ? branch.authorTime : branch.time;
  return (Date.now() - time) / DAY;
}

const decision = (branch, kind, reason, detail) => ({
  ...branch,
  decision: kind,
  reason,
  detail: detail || null,
});

export function decide(branch, config, ctx, options = {}) {
  const { defaultBranch, worktreeBranches = new Map(), head, openPRs } = ctx;
  const allowUnmerged = Boolean(options.allowUnmerged);

  // --- vetoes -------------------------------------------------------------
  if (defaultBranch && branch.name === defaultBranch) {
    return decision(branch, 'protected', 'protected:default', `default branch`);
  }

  const protectedBy = matchesProtectedBranch(branch.name, branch.ref, config);
  if (protectedBy) return decision(branch, 'protected', 'protected:pattern', protectedBy);

  for (const entry of config.protect.users || []) {
    if (matchesUser(entry, branch)) {
      return decision(branch, 'protected', 'protected:user', normalizeUser(entry).reason || 'protected author');
    }
  }

  if (openPRs && openPRs.has(branch.name)) {
    return decision(branch, 'protected', 'protected:open-pr', 'open pull request');
  }

  if (branch.kind === 'local') {
    if (head && branch.name === head) {
      return decision(branch, 'protected', 'protected:head', 'currently checked out');
    }
    if (worktreeBranches.has(branch.name)) {
      return decision(branch, 'protected', 'protected:worktree', worktreeBranches.get(branch.name));
    }
  }

  // --- scope --------------------------------------------------------------
  for (const entry of config.targets.exclude || []) {
    if (matchesUser(entry, branch)) {
      return decision(branch, 'skip', 'skip:excluded-user', normalizeUser(entry).reason || 'excluded author');
    }
  }

  const mode = config.targets.mode;
  if (mode === 'allowlist' || mode === 'mine') {
    const list = mode === 'mine' ? [ctx.me].filter(Boolean) : config.targets.users || [];
    const inScope = list.some((entry) => matchesUser(entry, branch));
    if (!inScope) {
      return decision(branch, 'skip', 'skip:not-target', mode === 'mine' ? 'not your branch' : 'author not in allowlist');
    }
  }
  if (mode === 'denylist') {
    const denied = (config.targets.users || []).some((entry) => matchesUser(entry, branch));
    if (denied) return decision(branch, 'skip', 'skip:not-target', 'author is in the denylist');
  }

  // --- rules --------------------------------------------------------------
  const merged = config.rules.merged;
  if (merged === 'only' && !branch.merged) {
    return decision(branch, 'skip', 'skip:unmerged', 'not merged into default');
  }
  if (merged === 'exclude' && branch.merged) {
    return decision(branch, 'skip', 'skip:merged', 'already merged');
  }

  const age = ageDays(branch, config);
  if (age < config.rules.minAgeDays) {
    return decision(branch, 'skip', 'skip:too-recent', `${Math.floor(age)}d < ${config.rules.minAgeDays}d`);
  }

  const maxAhead = config.rules.maxAhead;
  if (typeof maxAhead === 'number' && branch.ahead !== null && branch.ahead > maxAhead) {
    return decision(branch, 'skip', 'skip:ahead', `${branch.ahead} unique commits > ${maxAhead}`);
  }

  if (!branch.merged && config.safety.protectUnmerged && !allowUnmerged) {
    return decision(
      branch,
      'skip',
      'skip:unmerged',
      branch.ahead === null ? 'not merged' : `holds ${branch.ahead} commits`,
    );
  }

  return decision(branch, 'candidate', 'candidate', null);
}

export const REASON_TEXT = {
  'protected:default': 'protected: default branch',
  'protected:pattern': 'protected: name pattern',
  'protected:user': 'protected: author',
  'protected:open-pr': 'protected: open PR',
  'protected:worktree': 'protected: in use by a worktree',
  'protected:head': 'protected: checked out',
  'skip:excluded-user': 'skip: excluded author',
  'skip:not-target': 'skip: out of scope',
  'skip:unmerged': 'skip: not merged',
  'skip:merged': 'skip: already merged',
  'skip:too-recent': 'skip: too recent',
  'skip:ahead': 'skip: holds commits',
  candidate: 'candidate',
};

export function reasonText(reason) {
  return REASON_TEXT[reason] || reason;
}
