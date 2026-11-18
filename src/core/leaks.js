import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { git, gitZ } from './git.js';
import { globToRegExp } from './policy.js';
import { sastFindings } from './sast.js';

const SEVERITY_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

export const SEVERITY_LABEL = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

const CRITICAL_RULE = /aws|gcp|github|gitlab|slack|stripe|openai|npm|private-key|jwt|password|token|twilio|sendgrid|shopify/i;

function matchesAny(patterns, target) {
  const base = posix.basename(target);
  return patterns.some((pattern) => globToRegExp(pattern).test(target) || globToRegExp(pattern).test(base));
}

/** Shannon entropy in bits per character — the cheap way to spot random-looking strings. */
export function entropy(value) {
  const text = String(value || '');
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const MAX_SCANNED_BYTES = 1024 * 1024;
const MAX_FINDINGS_PER_FILE = 20;
const MAX_RULE_FINDINGS = 500;

function looksBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
}

/**
 * Team rules: regex + optional entropy + path filters. This is the deliberate
 * 80% of a SAST rule engine — no AST, no language grammars — for the patterns a
 * team actually owns ("our tokens look like this", "no fixtures with real keys").
 */
export async function ruleFindings(root, config, { withSecrets = false, source = createSource(root) } = {}) {
  const rules = config?.leaks?.rules || [];
  if (rules.length === 0) return [];

  let compiled;
  try {
    compiled = rules.map((rule) => ({
      rule,
      regex: new RegExp(rule.pattern, 'g'),
      severity: rule.severity || 'high',
    }));
  } catch (error) {
    return [
      {
        rule: 'invalid-rule',
        severity: 'low',
        path: '.git-cleaner.json',
        message: `a custom rule has an invalid pattern: ${error.message}`,
        hint: null,
        source: 'rules',
        fixable: false,
      },
    ];
  }

  const files = await source.list();
  const findings = [];

  for (const path of files) {
    if (findings.length >= MAX_RULE_FINDINGS) break;

    const applicable = compiled.filter(({ rule }) => {
      const include = rule.paths?.include;
      const exclude = rule.paths?.exclude;
      if (include && include.length > 0 && !matchesAny(include, path)) return false;
      if (exclude && exclude.length > 0 && matchesAny(exclude, path)) return false;
      return true;
    });
    if (applicable.length === 0) continue;

    const text = await source.read(path);
    if (text === null || text === undefined) continue;
    if (Buffer.byteLength(text) > MAX_SCANNED_BYTES || text.includes('\u0000')) continue;
    const lines = text.split('\n');
    let perFile = 0;

    for (let index = 0; index < lines.length; index += 1) {
      if (perFile >= MAX_FINDINGS_PER_FILE) break;
      const line = lines[index];

      for (const { rule, regex, severity } of applicable) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(line)) !== null) {
          const value = match[0];
          if (rule.entropy && entropy(value) < rule.entropy) break;
          findings.push({
            rule: rule.id || 'custom-rule',
            severity,
            path,
            line: index + 1,
            message: rule.description || rule.message || 'matched a custom rule',
            hint: redact(value),
            snippet: redactLine(line, value),
            ...(withSecrets ? { secret: value } : {}),
            source: 'rules',
            fixable: Boolean(rule.fixable),
          });
          perFile += 1;
          if (perFile >= MAX_FINDINGS_PER_FILE || findings.length >= MAX_RULE_FINDINGS) break;
          if (value.length === 0) break; // avoid an infinite loop on empty matches
        }
        if (perFile >= MAX_FINDINGS_PER_FILE || findings.length >= MAX_RULE_FINDINGS) break;
      }
    }
  }

  return findings;
}

export function fingerprint(finding) {
  return createHash('sha256')
    .update(`${finding.rule}|${finding.path}|${finding.hint || ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Never print a secret; keep a hint that is useless to an attacker. */
export function redact(value) {
  const text = String(value || '');
  if (text.length <= 4) return `${'*'.repeat(text.length)}(${text.length})`;
  return `${text.slice(0, 4)}…(${text.length} chars)`;
}

// --- policy layer (always on) ------------------------------------------------

async function trackedFiles(root) {
  return gitZ(['ls-files', '-z'], { cwd: root, allowFail: true });
}

function gitText(root, args, maxBuffer = 32 * 1024 * 1024) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Where a scan reads its files from: the working tree, or the tree of a ref so a
 * branch can be audited without checking it out.
 */
export function createSource(root, ref = null) {
  if (!ref) {
    return {
      ref: null,
      label: 'worktree',
      list: async () => (await trackedFiles(root)).filter(Boolean),
      read: async (path) => {
        try {
          return readFileSync(join(root, path), 'utf8');
        } catch {
          return null;
        }
      },
      line: (path, lineNumber) => {
        try {
          return readFileSync(join(root, path), 'utf8').split('\n')[lineNumber - 1] ?? null;
        } catch {
          return null;
        }
      },
    };
  }

  return {
    ref,
    label: ref,
    list: async () => (gitText(root, ['ls-tree', '-r', '-z', '--name-only', ref]) || '').split('\0').filter(Boolean),
    read: async (path) => {
      const size = Number(gitText(root, ['cat-file', '-s', `${ref}:${path}`]) || NaN);
      if (!Number.isFinite(size) || size > MAX_SCANNED_BYTES) return null;
      return gitText(root, ['show', `${ref}:${path}`]);
    },
    line: (path, lineNumber) => {
      const text = gitText(root, ['show', `${ref}:${path}`]);
      return text === null ? null : (text.split('\n')[lineNumber - 1] ?? null);
    },
  };
}

async function trackedIgnored(root) {
  return gitZ(['ls-files', '-zci', '--exclude-standard'], { cwd: root, allowFail: true });
}

async function untrackedNotIgnored(root) {
  const entries = await gitZ(
    ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all'],
    { cwd: root, allowFail: true },
  );
  return entries.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3));
}

export async function policyFindings(root, config, { source = createSource(root) } = {}) {
  const leaks = config.leaks;
  const allow = leaks.paths.allow || [];
  const deny = leaks.paths.deny || [];
  const junk = leaks.junk || [];
  const findings = [];

  const tracked = await source.list();
  // A ref has no index and no ignore gaps: those rules describe your checkout.
  const worktree = !source.ref;

  for (const path of tracked) {
    if (!matchesAny(deny, path)) continue;
    if (matchesAny(allow, path)) continue;
    findings.push({
      rule: 'tracked-sensitive',
      severity: 'high',
      path,
      message: 'tracked sensitive file',
      hint: null,
      source: 'policy',
      fix: 'untrack',
      fixable: true,
    });
  }

  if (leaks.trackedIgnored && worktree) {
    for (const path of await trackedIgnored(root)) {
      findings.push({
        rule: 'tracked-ignored',
        severity: 'high',
        path,
        message: 'tracked but ignored',
        hint: null,
        source: 'policy',
        fix: 'untrack',
        fixable: true,
      });
    }
  }

  if (leaks.gitignoreGaps && worktree) {
    for (const path of await untrackedNotIgnored(root)) {
      if (!matchesAny(deny, path)) continue;
      if (matchesAny(allow, path)) continue;
      findings.push({
        rule: 'gitignore-gap',
        severity: 'medium',
        path,
        message: 'untracked and not ignored',
        hint: null,
        source: 'policy',
        fix: 'ignore',
        fixable: true,
      });
    }
  }

  for (const path of tracked) {
    if (!matchesAny(junk, path)) continue;
    if (matchesAny(allow, path)) continue;
    findings.push({
      rule: 'tracked-junk',
      severity: 'low',
      path,
      message: 'tracked junk file',
      hint: null,
      source: 'policy',
      fix: 'untrack',
      fixable: true,
    });
  }

  return findings;
}

// --- engine layer (delegated) ------------------------------------------------

export async function detectEngine(preferred = 'auto') {
  if (preferred === 'none' || preferred === 'builtin') return null;
  if (preferred === 'gitleaks' || preferred === 'auto') {
    if (await hasBinary('gitleaks')) return 'gitleaks';
  }
  return null;
}

function hasBinary(name) {
  return new Promise((resolve) => {
    execFile(name, ['version'], { timeout: 8000 }, (error) => resolve(!error));
  });
}

function runGitleaks(root, { history = true, logOpts = '--all' } = {}) {
  // `--report-path -` streams the JSON to stdout: no secret-bearing file is ever
  // written to disk, so we can keep the match in memory and mask it ourselves.
  const args = [
    history ? 'git' : 'dir',
    '.',
    '--report-format',
    'json',
    '--report-path',
    '-',
    '--no-banner',
    '--exit-code',
    '0',
  ];
  if (history) args.push(`--log-opts=${logOpts}`);

  return new Promise((resolve) => {
    execFile('gitleaks', args, { cwd: root, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed = [];
      try {
        const raw = String(stdout || '').trim();
        const start = raw.indexOf('[');
        if (start >= 0) parsed = JSON.parse(raw.slice(start));
      } catch {
        parsed = [];
      }
      resolve({
        ok: !error || Boolean(parsed.length),
        findings: Array.isArray(parsed) ? parsed : [],
        error: error && !parsed.length ? stderr || error.message : null,
      });
    });
  });
}

/** Masks every occurrence of the secret in a line — the only safe way to show it. */
export function redactLine(line, secret) {
  const text = String(line || '').trim();
  if (!text) return null;
  if (!secret) return text.slice(0, 120);
  const mask = '●'.repeat(Math.min(String(secret).length, 12));
  return text.split(secret).join(mask).slice(0, 140);
}

/** Masks a column span (opengrep reports columns, not the secret). */
export function maskSpan(line, from, to) {
  const text = String(line || '');
  if (!text) return null;
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start + 1, Math.min(to, text.length));
  return `${text.slice(0, start)}${'●'.repeat(Math.min(end - start, 12))}${text.slice(end)}`
    .trim()
    .slice(0, 140);
}

function fileLine(root, path, lineNumber, cache) {
  if (!path || !lineNumber) return null;
  if (cache.has(path)) return cache.get(path)[lineNumber - 1] ?? null;
  let lines = [];
  try {
    lines = readFileSync(join(root, path), 'utf8').split('\n');
  } catch {
    lines = [];
  }
  cache.set(path, lines);
  return lines[lineNumber - 1] ?? null;
}

/**
 * A window of real source around a finding: the code above, the line itself and
 * the code below. Read on demand by the viewer, never stored on the finding, so
 * reports and `--json` can't leak what only a human on this machine should see.
 */
export function readSourceFrame(root, path, line, { context = 6, ref = null } = {}) {
  if (!path || !line) return null;
  let text = null;
  try {
    text = ref ? gitText(root, ['show', `${ref}:${path}`]) : readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
  if (text === null) return null;
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < line) return null;

  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  return {
    path,
    line,
    total: lines.length,
    hiddenAbove: from - 1,
    hiddenBelow: lines.length - to,
    lines: lines.slice(from - 1, to).map((text, index) => ({ number: from + index, text })),
  };
}

function severityForRule(ruleId) {
  return CRITICAL_RULE.test(ruleId || '') ? 'critical' : 'high';
}

/** gitleaks descriptions are long paragraphs; keep the clause that matters. */
function shortMessage(text, limit = 42) {
  const first = String(text || '').split(/[,.;:]/)[0].trim();
  if (!first) return 'secret detected';
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
}

export async function engineFindings(root, config, engine, { withSecrets = false, logOpts = '--all', source = null } = {}) {
  if (!engine) return { findings: [], note: null };

  const { findings, error } = await runGitleaks(root, {
    history: config.leaks.history?.enabled !== false,
    logOpts,
  });
  if (error) return { findings: [], note: `gitleaks: ${error}` };

  const reader = source || createSource(root);
  const lineCache = new Map();
  const lineOf = (path, line) => {
    if (!path || !line) return null;
    const key = `${path}:${line}`;
    if (!lineCache.has(key)) lineCache.set(key, reader.line(path, line));
    return lineCache.get(key);
  };

  return {
    findings: findings.map((item) => {
      const secret = item.Secret || item.Match || '';
      const line = lineOf(item.File, item.StartLine);
      return {
        rule: item.RuleID || 'gitleaks',
        severity: severityForRule(item.RuleID),
        path: item.File || '?',
        line: item.StartLine || null,
        commit: item.Commit ? String(item.Commit).slice(0, 8) : null,
        author: item.Author || null,
        date: item.Date || null,
        message: shortMessage(item.Description),
        hint: secret ? redact(secret) : null,
        snippet: line ? redactLine(line, item.Secret) : null,
        ...(withSecrets && item.Secret ? { secret: item.Secret } : {}),
        source: 'gitleaks',
        fixable: false,
      };
    }),
    note: null,
  };
}

// --- baseline ----------------------------------------------------------------

export function loadBaseline(root, config) {
  const path = join(root, config.leaks.baseline || '.git-cleaner/leaks-baseline.json');
  if (!existsSync(path)) return { path, entries: [] };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const entries = Array.isArray(data) ? data : data.entries || [];
    return { path, entries };
  } catch {
    return { path, entries: [] };
  }
}

export function applyBaseline(findings, baseline) {
  const now = Date.now();
  const active = new Set(
    baseline.entries
      .filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > now)
      .map((entry) => entry.fingerprint),
  );
  return findings.map((finding) => ({
    ...finding,
    fingerprint: fingerprint(finding),
    baselined: active.has(fingerprint(finding)),
  }));
}

export function writeFindingToBaseline(root, config, finding, justification = 'accepted', days = 90) {
  const baseline = loadBaseline(root, config);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const entries = [
    ...baseline.entries.filter((entry) => entry.fingerprint !== fingerprint(finding)),
    {
      fingerprint: fingerprint(finding),
      rule: finding.rule,
      path: finding.path,
      justification,
      expiresAt,
    },
  ];
  writeFileSync(baseline.path, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  return baseline.path;
}

// --- orchestration -----------------------------------------------------------

export async function scanLeaks({ root, config, engine = 'auto', sast = false, ruleFile = null, withSecrets = false, ref = null }) {
  // One source of truth for the scope: the working tree, or a ref's tree.
  const source = createSource(root, ref);
  const policy = await policyFindings(root, config, { source });
  const rules = await ruleFindings(root, config, { withSecrets, source });
  const resolvedEngine = await detectEngine(engine);
  const engineResult = await engineFindings(root, config, resolvedEngine, {
    withSecrets,
    logOpts: ref || '--all',
    source,
  });
  const sastResult = ref
    ? { findings: [], engine: null, note: 'sast reads the worktree — not run for a ref' }
    : await sastFindings({ root, config, force: sast, ruleFile });
  const all = [...policy, ...rules, ...engineResult.findings, ...sastResult.findings];
  const baseline = loadBaseline(root, config);
  const withBaseline = applyBaseline(all, baseline);

  const active = withBaseline.filter((finding) => !finding.baselined);
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of active) bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;

  const bySource = {};
  for (const finding of active) bySource[finding.source] = (bySource[finding.source] || 0) + 1;

  return {
    findings: withBaseline,
    active,
    bySeverity,
    bySource,
    total: withBaseline.length,
    baselinedCount: withBaseline.filter((finding) => finding.baselined).length,
    engine: resolvedEngine,
    engineNote: engineResult.note,
    sastEngine: sastResult.engine,
    sastNote: sastResult.note,
    ruleCount: (config?.leaks?.rules || []).length,
    baselinePath: baseline.path,
    scope: { ref: ref || null, label: ref || 'all refs + worktree' },
  };
}

export function worstSeverity(findings) {
  return findings.reduce((worst, finding) => {
    if (!worst) return finding.severity;
    return SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[worst] ? finding.severity : worst;
  }, null);
}

export function failsThreshold(findings, failOn = 'high') {
  const threshold = SEVERITY_ORDER[failOn] || 0;
  return findings.some((finding) => SEVERITY_ORDER[finding.severity] >= threshold);
}

/** The only automatic fix we allow: untrack files that should never be tracked. */
export async function fixFindings(root, findings, { dryRun = true } = {}) {
  const targets = findings.filter((finding) => finding.fixable);
  // A file already untracked only needs the ignore entry; `git rm --cached` on it
  // fails with "pathspec did not match".
  const untrack = [...new Set(targets.filter((finding) => finding.fix !== 'ignore').map((finding) => finding.path))];
  const ignore = [...new Set(targets.map((finding) => finding.path))];
  if (untrack.length === 0 && ignore.length === 0) return { removed: [], ignored: [], dryRun };
  if (dryRun) return { removed: untrack, ignored: ignore, dryRun: true };

  if (untrack.length > 0) {
    const result = await git(['rm', '--cached', '--quiet', '--', ...untrack], { cwd: root, allowFail: true });
    if (!result.ok) return { removed: [], ignored: [], dryRun: false, error: result.stderr.trim() };
  }

  const ignorePath = join(root, '.gitignore');
  const header = '\n# topiary: sensitive files untracked automatically\n';
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const missing = ignore.filter((path) => !existing.includes(path));
  if (missing.length > 0) {
    appendFileSync(ignorePath, `${header}${missing.map((path) => `/${path}`).join('\n')}\n`, 'utf8');
  }

  return { removed: untrack, ignored: ignore, dryRun: false };
}
