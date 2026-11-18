import { renderHeader } from '../ui/banner.js';
import { loadConfig } from '../config/load.js';
import { analyzeRepo } from './analyze.js';
import { gitText } from './git.js';
import { buildPlan } from './plan.js';
import { fetchOpenPRs } from './provider.js';
import {
  fetchRemote,
  getDefaultBranch,
  getRemoteUrl,
  getWorktreeBranches,
  isDirty,
  parseRemoteUrl,
  resolveRepo,
  UsageError,
} from './repo.js';

export class ConfigError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const lastLine = (text = '') => {
  const lines = String(text).trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] || '';
};

const noopScreen = {
  interactive: false,
  withSpinner: async (_label, fn) => fn(),
};

/**
 * Everything a command needs: repo, resolved config, analysis, policy context.
 * `reload()` re-reads the config files and the refs in place, which is what lets
 * the TUI edit settings and show the new impact without restarting.
 */
export async function openSession({ cwd = process.cwd(), flags = {}, screen = noopScreen } = {}) {
  const repo = await resolveRepo(flags.cwd || cwd);

  const session = {
    repo,
    flags,
    screen,
    version: undefined,
    plan(options = {}) {
      return buildPlan(session.analysis.branches, session.config, session.ctx, options);
    },
    header() {
      const count = session.analysis.branches.length;
      const policyLabel =
        session.layers.length > 0 ? session.layers.map((layer) => layer.label).join(' → ') : 'defaults';
      return renderHeader({
        version: session.version,
        repo: repo.name,
        branches: count,
        head: repo.head || '(detached)',
        remote: `${session.remote}${session.remoteInfo?.host ? ` · ${session.remoteInfo.host}` : ''}`,
        defaultBranch: session.defaultBranch ? `${session.remote}/${session.defaultBranch}` : 'not found',
        policySource: policyLabel,
      });
    },
    reload: (options) => hydrate(session, options),
  };

  await hydrate(session, { fetch: true });
  return session;
}

async function hydrate(session, { fetch = true, prs = true } = {}) {
  const { repo, flags, screen } = session;

  const loaded = loadConfig({
    cwd: repo.root,
    root: repo.root,
    flags,
    configPath: flags.config,
  });
  if (loaded.errors.length > 0) throw new ConfigError(loaded.errors);

  const config = loaded.config;
  const warnings = [...loaded.warnings];
  const remote = flags.remote || config.remote;
  const remoteInfo = parseRemoteUrl(await getRemoteUrl(repo.root, remote));

  let fetchResult = null;
  if (config.fetch.enabled && !flags.noFetch && fetch) {
    fetchResult = await screen.withSpinner(`fetching ${remote}…`, () =>
      fetchRemote(repo.root, remote, { prune: config.fetch.prune }),
    );
    if (!fetchResult.ok) {
      warnings.push(
        `fetch failed: ${lastLine(fetchResult.stderr) || 'unknown error'} — using local refs, they may be stale`,
      );
    }
  }

  const defaultBranch =
    config.defaultBranch === 'auto' ? await getDefaultBranch(repo.root, remote) : config.defaultBranch;

  const me =
    (await gitText(['config', 'user.email'], { cwd: repo.root, allowFail: true })).toLowerCase().trim() || null;

  if (config.targets.mode === 'mine' && !me) {
    warnings.push('targets.mode is "mine" but git user.email is not set — falling back to every author');
    config.targets.mode = 'all';
  }

  const analysis = await analyzeRepo({
    root: repo.root,
    remote,
    defaultBranch,
    includeLocal: Boolean(config.includeLocal || flags.includeLocal),
  });
  warnings.push(...analysis.warnings);

  const worktreeBranches = await getWorktreeBranches(repo.root);

  let openPRs = null;
  let prNote = null;
  if (config.protect.openMR) {
    if (!prs) {
      // Reload without hitting the provider: keep what we already know, so the
      // plan never silently loses the open-PR protection.
      openPRs = session.ctx?.openPRs ?? null;
      prNote = session.prNote ?? null;
    } else {
      const result = await screen.withSpinner('checking open pull requests…', () =>
        fetchOpenPRs({ root: repo.root, remoteInfo }),
      );
      if (result.available) openPRs = result.refs;
      else prNote = result.reason;
    }
  }

  const dirty = await isDirty(repo.root);

  Object.assign(session, {
    config,
    sources: loaded.sources,
    layers: loaded.layers,
    warnings,
    remote,
    remoteInfo,
    defaultBranch,
    me,
    analysis,
    ctx: { defaultBranch, worktreeBranches, head: repo.head, openPRs, me },
    dirty,
    fetchResult,
    prNote,
  });

  return session;
}

export { UsageError, noopScreen };
