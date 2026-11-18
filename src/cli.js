import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, openSession } from './core/session.js';
import { readLegacyEnv } from './config/load.js';
import { UsageError, insideRepository } from './core/repo.js';
import { setColorEnabled } from './ui/theme.js';
import { createScreen } from './ui/tui.js';
import { helpText, shortUsage } from './commands/help.js';
import { runPlan } from './commands/plan.js';
import { runDelete } from './commands/delete.js';
import { runRestore } from './commands/restore.js';
import { runSnapshot } from './commands/snapshot.js';
import { runLeaks } from './commands/leaks.js';
import { runLeaksView } from './commands/leaksView.js';
import { runSelftest } from './commands/leaks.js';
import { runUsers } from './commands/users.js';
import { runConfig } from './commands/config.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runGraph } from './commands/graph.js';
import { runTui } from './commands/tui.js';
import { red, dim, yellow, accent } from './ui/theme.js';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const OPTIONS = {
  cwd: { type: 'string' },
  config: { type: 'string' },
  remote: { type: 'string' },
  json: { type: 'boolean' },
  color: { type: 'string' },
  'no-color': { type: 'boolean' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  'no-fetch': { type: 'boolean' },
  'no-backup': { type: 'boolean' },
  explain: { type: 'boolean' },
  mode: { type: 'string' },
  author: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  protect: { type: 'string', multiple: true },
  'min-age': { type: 'string' },
  merged: { type: 'string' },
  'allow-unmerged': { type: 'boolean' },
  local: { type: 'boolean' },
  list: { type: 'boolean' },
  id: { type: 'string' },
  branch: { type: 'string', multiple: true },
  all: { type: 'boolean' },
  prune: { type: 'boolean' },
  candidates: { type: 'boolean' },
  keep: { type: 'string' },
  limit: { type: 'string' },
  view: { type: 'boolean' },
  check: { type: 'boolean' },
  fix: { type: 'boolean' },
  strict: { type: 'boolean' },
  selftest: { type: 'boolean' },
  sast: { type: 'boolean' },
  'no-sast': { type: 'boolean' },
  'fail-on': { type: 'string' },
  engine: { type: 'string' },
  'no-history': { type: 'boolean' },
  init: { type: 'boolean' },
  path: { type: 'boolean' },
};

const ALIASES = {
  list: 'plan',
  ls: 'plan',
  clean: 'delete',
  rm: 'delete',
  secrets: 'leaks',
  authors: 'users',
  cfg: 'config',
  log: 'graph',
  backup: 'snapshot',
  save: 'snapshot',
  ui: 'tui',
};

export function buildFlags(values) {
  const csv = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  let minAge;
  if (values['min-age'] !== undefined) {
    minAge = Number(values['min-age']);
    if (!Number.isFinite(minAge) || minAge < 0) {
      throw new UsageError(`--min-age must be a number of days, got "${values['min-age']}"`);
    }
  }

  return {
    cwd: values.cwd,
    config: values.config,
    remote: values.remote,
    json: Boolean(values.json),
    noFetch: Boolean(values['no-fetch']),
    backup: values['no-backup'] ? false : undefined,
    yes: Boolean(values.yes),
    dryRun: Boolean(values['dry-run']),
    explain: Boolean(values.explain),
    mode: values.mode,
    author: csv(values.author),
    exclude: csv(values.exclude),
    protect: csv(values.protect),
    minAge,
    merged: values.merged,
    allowUnmerged: Boolean(values['allow-unmerged']),
    includeLocal: Boolean(values.local),
    list: Boolean(values.list),
    id: values.id,
    branch: csv(values.branch),
    all: Boolean(values.all),
    prune: Boolean(values.prune),
    keep: values.keep,
    limit: values.limit,
    check: Boolean(values.check),
    fix: Boolean(values.fix),
    candidates: Boolean(values.candidates),
    selftest: Boolean(values.selftest),
    strict: Boolean(values.strict),
    sast: Boolean(values.sast),
    noSast: Boolean(values['no-sast']),
    engine: values.engine,
    noHistory: Boolean(values['no-history']),
    init: Boolean(values.init),
    path: Boolean(values.path),
    // `--view` was parsed by parseArgs but never reached this object, so
    // `leaks --view` printed the plain report while the TUI opened the browser.
    view: Boolean(values.view),
  };
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${red('✖')} ${error.message}\n${shortUsage()}\n`);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    process.stdout.write(helpText({ version: VERSION }));
    return 0;
  }
  if (values['no-color'] || values.color === 'never') setColorEnabled(false);
  if (values.color === 'always') setColorEnabled(true);

  const requested = positionals[0] ? ALIASES[positionals[0]] || positionals[0] : null;
  const known = ['plan', 'delete', 'restore', 'snapshot', 'leaks', 'users', 'config', 'doctor', 'graph', 'tui'];
  if (requested && !known.includes(requested)) {
    process.stderr.write(`${red('✖')} unknown command "${positionals[0]}"\n${shortUsage()}\n`);
    return 1;
  }

  let flags;
  try {
    flags = buildFlags(values);
  } catch (error) {
    process.stderr.write(`${red('✖')} ${error.message}\n`);
    return 1;
  }

  // Legacy contract: GIT_PATH in the cwd .env pointed at the repo to clean.
  // It is a fallback, not an override: standing inside a repository means that
  // repository, and a stale path (deleted volume, renamed folder) must never
  // hijack the command.
  if (!flags.cwd) {
    const legacyTarget = readLegacyEnv(process.cwd())?.values?.GIT_PATH?.trim();
    if (legacyTarget && resolve(legacyTarget) !== process.cwd()) {
      const inside = await insideRepository(process.cwd());
      if (!inside && existsSync(legacyTarget)) {
        flags = { ...flags, cwd: legacyTarget };
      } else if (!inside) {
        process.stderr.write(
          `${yellow('▲')} ${dim(`ignoring GIT_PATH=${legacyTarget} from .env: that path does not exist`)}\n`,
        );
      }
    }
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const command = requested || (interactive && !flags.json ? 'tui' : 'plan');
  const screen = createScreen({});

  // Repo-independent: proves the scanner works before trusting it on a repo.
  if (flags.selftest) {
    try {
      return await runSelftest(flags, VERSION);
    } catch (error) {
      return reportError(error, screen);
    }
  }

  try {
    const session = await openSession({ flags, screen });
    session.version = VERSION;

    if (session.config.output.color === 'never') setColorEnabled(false);
    if (session.config.output.color === 'always') setColorEnabled(true);

    switch (command) {
      case 'plan':
        return await runPlan(session, flags);
      case 'delete':
        return await runDelete(session, flags);
      case 'restore':
        return await runRestore(session, flags);
      case 'snapshot':
        return await runSnapshot(session, flags);
      case 'leaks':
        return flags.view ? await runLeaksView(session, flags) : await runLeaks(session, flags);
      case 'users':
        return await runUsers(session, flags);
      case 'config':
        return await runConfig(session, flags);
      case 'doctor':
        return await runDoctorCommand(session, flags);
      case 'graph':
        return await runGraph(session, flags);
      case 'tui':
        return await runTui(session);
      default:
        process.stderr.write(`${red('✖')} unknown command "${command}"\n`);
        return 1;
    }
  } catch (error) {
    return reportError(error, screen);
  }
}

function reportError(error, screen) {
  screen?.leave();

  if (error instanceof UsageError) {
    process.stderr.write(`${red('✖')} ${error.message}\n`);
    process.stderr.write(`${dim('  hint: run topiary inside a git repository, or pass --cwd <path>')}\n`);
    return 1;
  }

  if (error instanceof ConfigError) {
    process.stderr.write(`${red('✖')} invalid configuration\n`);
    for (const message of error.errors) process.stderr.write(`  ${yellow('▲')} ${message}\n`);
    process.stderr.write(`${dim('  hint:')} ${accent('topiary config --path')} ${dim('shows every layer that was loaded')}\n`);
    return 1;
  }

  process.stderr.write(`${red('✖')} ${error.message}\n`);
  if (process.env.GIT_CLEANER_DEBUG) process.stderr.write(`${error.stack}\n`);
  return 1;
}
