import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86_400_000;

const BASE_ENV = {
  ...process.env,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: undefined,
  GIT_COMMITTER_DATE: undefined,
};

export function sh(cwd, args, { env = {}, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...BASE_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFail) return '';
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${error.stderr || error.message}`);
  }
}

export function daysAgo(days) {
  return new Date(Date.now() - days * DAY).toISOString();
}

/**
 * A bare "remote" plus a clone with a realistic mix of branches:
 * merged/unmerged, old/recent, several author identities, protected names.
 */
export function createFixture({ root } = {}) {
  const base = root || mkdtempSync(join(tmpdir(), 'gc-fixture-'));
  const remote = join(base, 'remote.git');
  const work = join(base, 'repo');
  mkdirSync(base, { recursive: true });

  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, work], { stdio: 'ignore' });

  sh(work, ['config', 'user.name', 'Santiago Andrade']);
  sh(work, ['config', 'user.email', 'santiago@example.com']);
  sh(work, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(work, 'README.md'), '# fixture\n');
  sh(work, ['add', '.']);
  commit(work, 'chore: initial', { days: 400, name: 'Santiago Andrade', email: 'santiago@example.com' });
  sh(work, ['push', '-u', 'origin', 'main']);

  const branches = [
    // branch, days, author, merged into main?
    ['feature/old-merged', 200, 'Santiago Andrade', 'santiago@example.com', true],
    ['feature/old-unmerged', 100, 'Santiago Andrade', 'santiago@example.com', false],
    ['feature/new', 5, 'Santiago Andrade', 'santiago@example.com', true],
    ['feature/alice', 200, 'Alice', 'alice@example.com', true],
    ['feature/bot', 400, 'ci-bot', 'ci@bots.example.com', true],
    ['release/1.0', 500, 'Santiago Andrade', 'santiago@example.com', true],
    ['dev', 600, 'Santiago Andrade', 'santiago@example.com', true],
    ['featuer/typo', 300, 'Santiago Andrade', 'santiago@example.com', true],
  ];

  for (const [name, days, authorName, authorEmail, merged] of branches) {
    sh(work, ['checkout', '-B', name, 'main']);
    commit(work, `feat: ${name}`, { days, name: authorName, email: authorEmail });
    if (merged) {
      sh(work, ['checkout', 'main']);
      sh(work, ['merge', '--no-ff', '-m', `merge ${name}`, name], {
        env: {
          GIT_AUTHOR_DATE: daysAgo(days - 1),
          GIT_COMMITTER_DATE: daysAgo(days - 1),
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: authorName,
          GIT_COMMITTER_EMAIL: authorEmail,
        },
      });
    }
    sh(work, ['push', 'origin', name]);
  }

  sh(work, ['checkout', 'main']);
  sh(work, ['push', 'origin', 'main']);

  return { root: base, remote, work };
}

export function commit(cwd, message, { days = 30, name, email } = {}) {
  const date = daysAgo(days);
  sh(cwd, ['commit', '--allow-empty', '-m', message], {
    env: {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

export function remoteHeads(remote) {
  return sh(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split('\n')
    .filter(Boolean);
}

export function writeConfig(work, config) {
  writeFileSync(join(work, '.git-cleaner.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export function isolatedEnv(extra = {}) {
  const configHome = mkdtempSync(join(tmpdir(), 'gc-config-'));
  const stateHome = mkdtempSync(join(tmpdir(), 'gc-state-'));
  return {
    ...process.env,
    NO_COLOR: '1',
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extra,
  };
}
