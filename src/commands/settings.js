import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globalConfigPath, repoConfigPaths } from '../config/paths.js';
import { mergeDeep } from '../config/load.js';
import { validateConfig } from '../config/validate.js';
import { buildPlan } from '../core/plan.js';
import { normalizeUser } from '../core/policy.js';
import { padEnd, accent, bold, dim, gray, green, red, yellow, sym } from '../ui/theme.js';
import { terminalWidth } from '../ui/banner.js';
import { attachKeys, inputPrompt, selectList } from '../ui/tui.js';
import { groupAuthors } from './users.js';

export const SCHEMA_URL = 'https://raw.githubusercontent.com/andrade-fs/git_cleaner/main/schema.json';

/** Everything the TUI can change. Order here is the order on screen. */
export const FIELDS = [
  {
    group: 'scope',
    path: 'targets.mode',
    label: 'who',
    kind: 'enum',
    choices: ['mine', 'allowlist', 'denylist', 'all'],
    describe: {
      mine: 'only the branches I authored',
      allowlist: 'only the authors picked below',
      denylist: 'everyone except the authors below',
      all: 'every author',
    },
  },
  { group: 'scope', path: 'targets.users', label: 'allow / deny', kind: 'authors', hint: 'pick from detected authors' },
  { group: 'scope', path: 'targets.exclude', label: 'never touch', kind: 'authors', hint: 'pick from detected authors' },

  { group: 'rules', path: 'rules.minAgeDays', label: 'min age', kind: 'number', suffix: 'd', presets: [7, 14, 30, 60, 90, 180, 365] },
  {
    group: 'rules',
    path: 'rules.merged',
    label: 'merge state',
    kind: 'enum',
    choices: ['any', 'only', 'exclude'],
    describe: { any: 'ignore merge state', only: 'candidates must be merged', exclude: 'skip merged branches' },
  },
  { group: 'rules', path: 'rules.maxAhead', label: 'max commits ahead', kind: 'number', nullable: true, presets: [0, 1, 3, 5, 10] },
  { group: 'rules', path: 'includeLocal', label: 'local branches', kind: 'bool' },

  { group: 'protection', path: 'protect.branches', label: 'protected branches', kind: 'list', hint: 'globs: release/*' },
  { group: 'protection', path: 'protect.users', label: 'protected authors', kind: 'authors', hint: 'never delete their branches' },
  { group: 'protection', path: 'protect.openMR', label: 'branches with open PRs', kind: 'bool' },
  { group: 'protection', path: 'remote', label: 'remote', kind: 'text' },

  { group: 'safety', path: 'safety.backup', label: 'back up refs', kind: 'bool' },
  { group: 'safety', path: 'safety.protectUnmerged', label: 'protect unmerged', kind: 'bool' },
  { group: 'safety', path: 'safety.requireConfirm', label: 'ask before deleting', kind: 'bool' },

  {
    group: 'leaks',
    path: 'leaks.engine',
    label: 'scanner',
    kind: 'enum',
    choices: ['auto', 'builtin', 'gitleaks', 'none'],
    describe: { auto: 'gitleaks when installed', builtin: 'policy layer only', gitleaks: 'always gitleaks', none: 'off' },
  },
  {
    group: 'leaks',
    path: 'leaks.failOn',
    label: 'CI fails on',
    kind: 'enum',
    choices: ['low', 'medium', 'high', 'critical'],
    describe: { low: 'any finding fails the build', critical: 'only critical fails the build' },
  },
  { group: 'leaks', path: 'leaks.gitignoreGaps', label: 'report gitignore gaps', kind: 'bool' },
  { group: 'leaks', path: 'leaks.paths.deny', label: 'sensitive paths', kind: 'list', hint: '.env*, *.pem' },
];

export function getPath(object, path) {
  return path.split('.').reduce((cursor, key) => (cursor === undefined || cursor === null ? undefined : cursor[key]), object);
}

export function setPath(object, path, value) {
  const keys = path.split('.');
  let cursor = object;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) cursor[key] = value;
    else {
      if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key];
    }
  });
  return object;
}

export function hasPath(object, path) {
  const keys = path.split('.');
  let cursor = object;
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) return false;
    cursor = cursor[key];
  }
  return true;
}

export function targetPath(session, targetId) {
  const paths = repoConfigPaths(session.repo.root);
  if (targetId === 'global') return globalConfigPath();
  if (targetId === 'local') return paths.local;
  return paths.repo;
}

export const TARGETS = [
  { id: 'repo', label: 'repo (team)' },
  { id: 'local', label: 'local (personal)' },
  { id: 'global', label: 'global' },
];

export function loadDraft(path) {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data && typeof data === 'object') {
      delete data.$schema;
      return data;
    }
  } catch {
    /* an unreadable file shows up as an empty draft; saving rewrites it */
  }
  return {};
}

export function saveDraft(path, draft) {
  const payload = { $schema: SCHEMA_URL, ...pruneNulls(draft) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

/** Fields where `null` is a real value ("no limit"), not a leftover. */
const NULLABLE_PATHS = new Set(FIELDS.filter((field) => field.nullable).map((field) => field.path));

/** Drops `x: null` leaves left behind by a picker, so a saved file is honest. */
function pruneNulls(value, path = '') {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (child === null && !NULLABLE_PATHS.has(childPath)) continue;
    out[key] = pruneNulls(child, childPath);
  }
  return out;
}

/** The config as it would look with the draft applied — used for the live impact. */
export function previewConfig(session, draft) {
  const base = JSON.parse(JSON.stringify(session.config));
  return mergeDeep(base, draft);
}

export function previewPlan(session, draft) {
  const config = previewConfig(session, draft);
  return buildPlan(session.analysis.branches, config, session.ctx, {});
}

/** Exposed so the editor and its tests agree on what is valid. */
export function validateDraftForTest(draft) {
  return validateConfig(draft, 'draft');
}

function displayValue(field, value) {
  if (field.kind === 'bool') return value ? green('on') : gray('off');
  if (value === undefined || value === null || value === '') return dim('—');
  if (field.kind === 'list') {
    const items = Array.isArray(value) ? value : [value];
    if (items.length === 0) return dim('—');
    const shown = items.slice(0, 2).map((item) => {
      const user = normalizeUser(item);
      return user.email || user.name || String(item);
    });
    const suffix = items.length > 2 ? dim(` +${items.length - 2}`) : '';
    return `${shown.join(', ')}${suffix}`;
  }
  if (field.kind === 'number') return `${value}${field.suffix || ''}`;
  return String(value);
}

/**
 * Where a row's value comes from — and, separately, whether it has been edited
 * but not written.
 *
 * `draft` is the file's own contents, so a value loaded from
 * `.git-cleaner.json` used to be flagged `unsaved` on the first frame, before
 * anyone touched anything. The badge is only honest if it compares the draft
 * against what was loaded.
 */
function sourceBadge(session, draft, baseline, path) {
  const changed = JSON.stringify(getPath(draft, path) ?? null) !== JSON.stringify(getPath(baseline, path) ?? null);
  if (changed) return yellow('unsaved');
  return dim(session.sources?.[path] || 'defaults');
}

function clip(text, width) {
  const plain = String(text);
  return plain.length > width ? `${plain.slice(0, width - 1)}…` : plain;
}

export function buildRows(session, draft, baseline = {}) {
  return FIELDS.map((field) => {
    const value = getPath(previewConfig(session, draft), field.path);
    return {
      field,
      value,
      display: clip(displayValue(field, value), 26),
      badge: sourceBadge(session, draft, baseline, field.path),
    };
  });
}

/** Counts the leaves a draft overrides, not its top-level keys. */
export function countOverrides(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.values(value);
    if (entries.length === 0) return 1;
    return entries.reduce((sum, child) => sum + countOverrides(child), 0);
  }
  return 1;
}

function settingsFrame({ session, rows, index, targetLabel, targetId, message, plan, saved, overrides }) {
  const width = terminalWidth();
  const rule = dim('─'.repeat(Math.max(width - 4, 20)));
  const head = [
    ...session.header().split('\n'),
    '',
    `  ${bold('SETTINGS')}   ${dim('saved to')} ${accent(targetLabel)} ${dim(`· ${targetId}`)}`,
    `  ${rule}`,
    '',
  ];

  const body = [];
  let focusIndex = 0;
  let group = null;

  rows.forEach((row, position) => {
    if (row.field.group !== group) {
      if (group !== null) body.push('');
      body.push(`  ${dim(row.field.group.toUpperCase())}`);
      group = row.field.group;
    }
    const focused = position === index;
    if (focused) focusIndex = body.length;
    const pointer = focused ? accent(sym.arrow) : ' ';
    const label = padEnd(row.field.label, 24);
    const hint = row.field.hint && focused ? `   ${dim(row.field.hint)}` : '';
    body.push(
      `  ${pointer} ${focused ? bold(label) : label}${padEnd(row.display, 28)}${row.badge}${hint}`.replace(/\s+$/, ''),
    );
  });

  const impact =
    plan.summary.candidates === saved
      ? `${bold(String(plan.summary.candidates))} ${dim('candidates')}`
      : `${bold(String(plan.summary.candidates))} ${dim('candidates')} ${dim(`(was ${saved})`)}`;

  const tail = ['', `  ${rule}`];
  if (message) tail.push(`  ${message}`);
  tail.push(
    `  ${accent(sym.diamond)} ${impact} ${dim('·')} ${dim(`${overrides} override${overrides === 1 ? '' : 's'}`)}`,
  );
  tail.push(`  ${dim('↑↓ move · ⏎ edit · s save · r reset · t target · q back')}`);

  return { head, body, focusIndex, tail };
}

function windowBody(body, focusIndex, available) {
  if (body.length <= available) return body;
  const start = Math.max(0, Math.min(focusIndex - Math.floor(available / 2), body.length - available));
  const slice = body.slice(start, start + available);
  if (start > 0) slice[0] = `  ${dim(`↑ ${start} more`)}`;
  if (start + available < body.length) {
    slice[slice.length - 1] = `  ${dim(`↓ ${body.length - (start + available)} more`)}`;
  }
  return slice;
}

function readKey(screen) {
  return new Promise((resolve) => {
    const detach = attachKeys(screen.input, (str, key) => {
      detach();
      resolve({ str, key });
    });
  });
}

async function editList({ screen, session, field, current }) {
  let items = Array.isArray(current) ? [...current] : [];
  let index = 0;

  for (;;) {
    const head = [...session.header().split('\n'), '', `  ${bold(field.label)}`, ''];
    const body = [];
    if (items.length === 0) body.push(`  ${dim('empty')}`);
    items.forEach((item, position) => {
      const user = normalizeUser(item);
      const label = user.email || user.name || String(item);
      const focused = position === index;
      body.push(`  ${focused ? accent(sym.arrow) : ' '} ${focused ? bold(label) : label}`);
    });
    const tail = ['', `  ${dim('a add · x remove · ⏎ save · q cancel')}`];

    const available = Math.max(screen.rows() - head.length - tail.length, 5);
    const start = Math.max(0, Math.min(index - Math.floor(available / 2), Math.max(body.length - available, 0)));
    screen.render([...head, ...body.slice(start, start + available), ...tail]);

    const { str, key } = await readKey(screen);
    // Cancel means "leave it alone". Returning null here used to write
    // `targets.users: null` and silently disable the allowlist.
    if (key.name === 'q' || key.name === 'escape') return undefined;
    if (key.name === 'return' || key.name === 'enter') return items;
    if (key.name === 'up' || key.name === 'k') index = items.length ? (index - 1 + items.length) % items.length : 0;
    else if (key.name === 'down' || key.name === 'j') index = items.length ? (index + 1) % items.length : 0;
    else if (key.name === 'x' || key.name === 'backspace' || key.name === 'delete') {
      if (items.length > 0) {
        items.splice(index, 1);
        index = Math.max(0, Math.min(index, items.length - 1));
      }
    } else if (key.name === 'a' || str === 'a') {
      const added = await inputPrompt({
        screen,
        header: session.header().split('\n'),
        title: `add to ${field.label}`,
        placeholder: field.hint || 'email, glob or branch name',
        validate: (text) => (text.length === 0 ? 'type something' : null),
      });
      if (added) items.push(added);
    }
  }
}

/**
 * Author picker: the identities are detected from the branch history, so the
 * user only selects. Typing an email is the fallback for people who have no
 * branches yet (contractors, a bot's rename, a fresh teammate).
 */
function entryEmail(entry) {
  const user = normalizeUser(entry);
  return String(user.email || '').toLowerCase();
}

function entryMatches(entry, email) {
  const pattern = entryEmail(entry);
  if (!pattern) return false;
  if (pattern === email) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    return regex.test(email);
  }
  return false;
}

async function editAuthors({ screen, session, field, current }) {
  const entries = Array.isArray(current) ? current : [];
  const detected = groupAuthors(session.analysis.branches).filter((author) => author.email);

  const rows = detected.map((author) => ({
    email: author.email.toLowerCase(),
    display: author.email,
    branches: author.branches,
    names: author.names,
  }));

  // Keep manual entries that the history does not know about yet.
  for (const entry of entries) {
    const user = normalizeUser(entry);
    const email = entryEmail(entry);
    if (!email) continue;
    if (rows.some((row) => row.email === email)) continue;
    rows.push({
      email,
      display: user.email || user.name || email,
      branches: 0,
      names: ['added by you'],
    });
  }

  const selected = new Set(rows.filter((row) => entries.some((entry) => entryMatches(entry, row.email))).map((row) => row.email));
  let cursor = 0;

  for (;;) {
    const head = [
      ...session.header().split('\n'),
      '',
      `  ${bold(field.label)}   ${dim(`${rows.length} authors detected from branch history`)}`,
      '',
    ];
    const labelWidth = Math.min(
      Math.max(...rows.map((row) => row.display.length + (row.email === session.me ? 6 : 0)), 12),
      36,
    );

    const body = rows.map((row, position) => {
      const focused = position === cursor;
      const box = selected.has(row.email) ? green(sym.checkOn) : gray(sym.checkOff);
      const isMe = row.email === session.me;
      const label = isMe ? `${row.display} ${dim('· you')}` : row.display;
      const pad = ' '.repeat(Math.max(labelWidth - row.display.length - (isMe ? 6 : 0), 0));
      const count =
        row.branches > 0 ? `${row.branches} branch${row.branches === 1 ? '' : 'es'}` : dim('manual');
      const hint = `${count} · ${dim(row.names.slice(0, 2).join(', '))}`;
      return `  ${focused ? accent(sym.arrow) : ' '} ${box} ${focused ? bold(label) : label}${pad}  ${dim(hint)}`;
    });
    const tail = [
      '',
      `  ${selected.size} selected · ${dim('space toggle · a all · n none · A add email · x remove · ⏎ save · q cancel')}`,
    ];

    const available = Math.max(screen.rows() - head.length - tail.length, 5);
    const start = Math.max(0, Math.min(cursor - Math.floor(available / 2), Math.max(body.length - available, 0)));
    screen.render([...head, ...body.slice(start, start + available), ...tail]);

    const { str, key } = await readKey(screen);
    // Same contract: cancel must not mutate the draft.
    if (key.name === 'q' || key.name === 'escape') return undefined;
    if (key.name === 'return' || key.name === 'enter') {
      const picked = [];
      for (const row of rows) {
        if (!selected.has(row.email)) continue;
        const existing = entries.find((entry) => entryMatches(entry, row.email));
        picked.push(existing ?? row.display);
      }
      return picked;
    }

    if (key.name === 'up' || key.name === 'k') cursor = rows.length ? (cursor - 1 + rows.length) % rows.length : 0;
    else if (key.name === 'down' || key.name === 'j') cursor = rows.length ? (cursor + 1) % rows.length : 0;
    else if (key.name === 'space') {
      const row = rows[cursor];
      if (row) {
        if (selected.has(row.email)) selected.delete(row.email);
        else selected.add(row.email);
      }
    } else if (key.name === 'a' && !key.shift) {
      rows.forEach((row) => selected.add(row.email));
    } else if (key.name === 'n' && !key.shift) {
      selected.clear();
    } else if (key.name === 'x' || key.name === 'backspace') {
      const row = rows[cursor];
      if (row && row.branches === 0) {
        selected.delete(row.email);
        rows.splice(cursor, 1);
        cursor = Math.max(0, Math.min(cursor, rows.length - 1));
      }
    } else if ((key.shift && key.name === 'a') || key.name === 'e' || key.name === 'insert') {
      const added = await inputPrompt({
        screen,
        header: session.header().split('\n'),
        title: `add an author to ${field.label}`,
        placeholder: 'email or *glob* · e.g. ci@company.com',
        validate: (text) => (text.length === 0 ? 'type an email or a glob' : null),
      });
      if (added) {
        const email = added.toLowerCase();
        if (!rows.some((row) => row.email === email)) {
          rows.push({ email, display: added, branches: 0, names: ['added by you'] });
        }
        selected.add(email);
        cursor = rows.findIndex((row) => row.email === email);
      }
    }
  }
}

async function editField({ screen, session, field, current }) {
  if (field.kind === 'bool') {
    return !current;
  }

  if (field.kind === 'enum') {
    const value = await selectList({
      screen,
      header: session.header().split('\n'),
      title: field.label,
      items: field.choices.map((choice) => ({
        label: choice,
        value: choice,
        hint: [field.describe?.[choice], choice === current ? 'current' : ''].filter(Boolean).join(' · '),
      })),
      initial: Math.max(field.choices.indexOf(current), 0),
      footer: '↑↓ move · ⏎ select · q cancel',
    });
    return value ?? undefined;
  }

  if (field.kind === 'number') {
    // Presets first: the common answers should never require typing.
    if (field.presets) {
      const NONE = '\u0000none';
      const CUSTOM = '\u0000custom';
      const items = [
        ...(field.nullable
          ? [{ label: 'no limit', value: NONE, hint: current === null ? 'current' : '' }]
          : []),
        ...field.presets.map((value) => ({
          label: `${value}${field.suffix || ''}`,
          value: String(value),
          hint: value === current ? 'current' : '',
        })),
        { label: 'custom…', value: CUSTOM, hint: 'type a number' },
      ];
      const index = field.presets.findIndex((value) => value === current);
      const initial = field.nullable && current === null ? 0 : Math.max(index, 0) + (field.nullable ? 1 : 0);

      const picked = await selectList({
        screen,
        header: session.header().split('\n'),
        title: field.label,
        items,
        initial,
        footer: '↑↓ move · ⏎ select · q cancel',
      });

      if (picked === null) return undefined;
      if (picked === NONE) return null;
      if (picked !== CUSTOM) return Number(picked);
    }

    const text = await inputPrompt({
      screen,
      header: session.header().split('\n'),
      title: `${field.label}${field.nullable ? ' (empty = no limit)' : ''}`,
      value: current === undefined || current === null ? '' : String(current),
      placeholder: field.nullable ? 'empty to disable' : 'a number',
      validate: (input) => {
        if (input === '') return field.nullable ? null : 'a number is required';
        const number = Number(input);
        if (!Number.isFinite(number) || number < 0) return 'must be a positive number';
        if (field.path === 'rules.minAgeDays' && number > 3650) return 'at most 3650 days';
        return null;
      },
    });
    if (text === null) return undefined;
    if (text === '') return null;
    return Number(text);
  }

  if (field.kind === 'authors') {
    return editAuthors({ screen, session, field, current });
  }

  if (field.kind === 'list') {
    const items = await editList({ screen, session, field, current });
    return items === null ? undefined : items;
  }

  const text = await inputPrompt({
    screen,
    header: session.header().split('\n'),
    title: field.label,
    value: current === undefined || current === null ? '' : String(current),
    placeholder: field.hint || '',
  });
  return text === null ? undefined : text;
}

/**
 * The settings screen. Everything is written to a config file (repo, local or
 * global) — no hand editing — and the candidate count updates as you change it.
 */
export async function runSettings(session) {
  const screen = session.screen;
  if (!screen.interactive) {
    process.stderr.write(`  ${yellow('▲')} settings need an interactive terminal; use topiary config --explain\n`);
    return 1;
  }

  let targetId = 'repo';
  let draft = loadDraft(targetPath(session, targetId));
  // What the target file says right now. The badge compares against it, so a
  // value that came from the file reads as `repo` until it is actually edited.
  let baseline = JSON.parse(JSON.stringify(draft));
  let index = 0;
  let message = null;

  for (;;) {
    const rows = buildRows(session, draft, baseline);
    const plan = previewPlan(session, draft);
    const saved = session.plan({}).summary.candidates;
    const overrides = countOverrides(draft);
    const targetLabel = targetPath(session, targetId).replace(`${session.repo.root}/`, '');

    const frame = settingsFrame({
      session,
      rows,
      index,
      targetLabel,
      targetId,
      message,
      plan,
      saved,
      overrides,
    });

    const available = Math.max(screen.rows() - frame.head.length - frame.tail.length, 6);
    screen.render([...frame.head, ...windowBody(frame.body, frame.focusIndex, available), ...frame.tail]);

    const { str, key } = await readKey(screen);
    message = null;

    if (key.ctrl && key.name === 'c') return 0;
    if (key.name === 'q' || key.name === 'escape') return 0;

    if (key.name === 'up' || key.name === 'k') index = (index - 1 + rows.length) % rows.length;
    else if (key.name === 'down' || key.name === 'j') index = (index + 1) % rows.length;
    else if (key.name === 'home') index = 0;
    else if (key.name === 'end') index = rows.length - 1;
    else if (key.name === 't') {
      const next = (TARGETS.findIndex((target) => target.id === targetId) + 1) % TARGETS.length;
      targetId = TARGETS[next].id;
      draft = loadDraft(targetPath(session, targetId));
      baseline = JSON.parse(JSON.stringify(draft));
      message = `${dim('now editing')} ${accent(TARGETS[next].label)}`;
    } else if (key.name === 'r') {
      draft = {};
      message = `${yellow('▲')} ${dim('overrides cleared — press')} s ${dim('to write it')}`;
    } else if (key.name === 's') {
      const check = validateConfig(draft, targetPath(session, targetId));
      if (check.errors.length > 0) {
        message = `${red('✖')} ${dim(check.errors[0])}`;
      } else {
        const path = saveDraft(targetPath(session, targetId), draft);
        try {
          await session.reload({ fetch: false, prs: false });
          // Re-read the file: `saveDraft` prunes null leaves, and the screen
          // must not keep calling what it just wrote "unsaved".
          draft = loadDraft(path);
          baseline = JSON.parse(JSON.stringify(draft));
          message = `${green('✔')} ${dim('saved to')} ${accent(path.replace(`${session.repo.root}/`, ''))}`;
        } catch (error) {
          message = `${red('✖')} ${dim(error.message)}`;
        }
      }
    } else if (key.name === 'return' || key.name === 'enter') {
      const row = rows[index];
      const next = await editField({ screen, session, field: row.field, current: row.value });
      if (next !== undefined) {
        // Only a field that declares itself nullable may store null.
        if (next === null && row.field.nullable) setPath(draft, row.field.path, null);
        else if (next !== null) setPath(draft, row.field.path, next);

        // Picking authors is useless under mode=mine: switch it so the
        // selection actually takes effect, and say so.
        const mode = getPath(draft, 'targets.mode') || session.config.targets.mode;
        if (row.field.path === 'targets.users' && Array.isArray(next) && next.length > 0 && mode === 'mine') {
          setPath(draft, 'targets.mode', 'allowlist');
          message = `${green('✔')} ${dim('mode switched to')} ${accent('allowlist')} ${dim('so the picked authors apply')}`;
        }
      }
    }
  }
}
