import { execFile } from 'node:child_process';

/**
 * Prerequisites and optional engines. This tool never installs binaries by
 * itself: it detects what is there, what is missing, and how to get it.
 */
const PROBE_TIMEOUT = 8000;

const INSTALL_HINTS = {
  gitleaks: {
    darwin: 'brew install gitleaks',
    linux: 'brew install gitleaks   # or: https://github.com/gitleaks/gitleaks/releases',
    win32: 'winget install gitleaks   # or scoop install gitleaks',
    other: 'https://github.com/gitleaks/gitleaks/releases',
  },
  opengrep: {
    darwin: 'download the release: https://github.com/opengrep/opengrep/releases',
    linux: 'download the release: https://github.com/opengrep/opengrep/releases',
    win32: 'download the release: https://github.com/opengrep/opengrep/releases',
    other: 'https://github.com/opengrep/opengrep/releases',
  },
  gh: {
    darwin: 'brew install gh',
    linux: 'sudo apt install gh   # or https://cli.github.com',
    win32: 'winget install GitHub.cli',
    other: 'https://cli.github.com',
  },
};

export function installHint(binary, platform = process.platform) {
  const hints = INSTALL_HINTS[binary];
  if (!hints) return `install ${binary}`;
  return hints[platform] || hints.other;
}

function probe(binary, args) {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: PROBE_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`.trim();
      resolve({ found: !error, raw: text, message: error ? error.message : null });
    });
  });
}

const semver = (text) => text.match(/(\d+)\.(\d+)(?:\.(\d+))?/)?.[0] || null;

function compare([a, b]) {
  return a - b;
}

const atLeast = (version, major, minor) => {
  if (!version) return false;
  const [maj, min] = version.split('.').map(Number);
  return maj > major || (maj === major && min >= minor);
};

/** One probe per dependency, in parallel. */
export async function runDoctor({ config } = {}) {
  const [gitProbe, gitleaks, opengrep, gh, ghAuth] = await Promise.all([
    probe('git', ['--version']),
    probe('gitleaks', ['version']),
    probe('opengrep', ['--version']),
    probe('gh', ['--version']),
    probe('gh', ['auth', 'status']),
  ]);

  const nodeVersion = process.version.replace(/^v/, '');
  const gitVersion = gitProbe.found ? semver(gitProbe.raw) : null;
  const leaks = config?.leaks || {};
  const engineSetting = leaks.engine || 'auto';
  const wantsGitleaks = engineSetting !== 'none' && engineSetting !== 'builtin';
  // `auto` degrades gracefully; an explicit engine that is missing is a real
  // configuration error, not a suggestion.
  const requiresGitleaks = engineSetting === 'gitleaks';
  const wantsSast = Boolean(leaks.sast?.enabled);

  const checks = [];

  // --- required ------------------------------------------------------------
  checks.push({
    group: 'runtime',
    name: 'node',
    status: atLeast(nodeVersion, 18, 17) ? 'ok' : 'missing',
    detail: `v${nodeVersion}`,
    fix: atLeast(nodeVersion, 18, 17) ? null : 'install Node 18.17 or newer',
    required: true,
  });

  checks.push({
    group: 'runtime',
    name: 'git',
    status: gitProbe.found ? 'ok' : 'missing',
    detail: gitVersion ? `${gitVersion}${atLeast(gitVersion, 2, 41) ? '' : ' · no ahead-behind atom (git 2.41+)'}` : 'not found',
    fix: gitProbe.found ? null : 'install git',
    required: true,
  });

  // --- optional engines ----------------------------------------------------
  checks.push({
    group: 'leak engines',
    name: 'gitleaks',
    status: gitleaks.found ? 'ok' : wantsGitleaks ? 'missing' : 'optional',
    detail: gitleaks.found
      ? semver(gitleaks.raw) || 'installed'
      : wantsGitleaks
        ? 'policy layer still runs; secret formats and history are not scanned'
        : 'not needed with leaks.engine=none|builtin',
    fix: gitleaks.found ? null : installHint('gitleaks'),
    required: requiresGitleaks,
  });

  checks.push({
    group: 'leak engines',
    name: 'opengrep',
    status: opengrep.found ? 'ok' : wantsSast ? 'missing' : 'optional',
    detail: opengrep.found
      ? semver(opengrep.raw) || 'installed'
      : wantsSast
        ? 'leaks.sast.enabled but no binary: SAST rules will not run'
        : 'static analysis (SAST) is off by default',
    fix: opengrep.found ? null : installHint('opengrep'),
    required: wantsSast,
  });

  checks.push({
    group: 'leak engines',
    name: 'gh',
    status: gh.found ? 'ok' : 'optional',
    detail: gh.found
      ? ghAuth.found
        ? 'authenticated · open-PR protection available'
        : 'installed but not authenticated · open-PR protection off'
      : 'open-PR protection needs it (protect.openMR)',
    fix: gh.found && ghAuth.found ? null : installHint('gh'),
    required: false,
  });

  // --- config --------------------------------------------------------------
  checks.push({
    group: 'config',
    name: 'policy',
    status: 'ok',
    detail: `engine ${engineSetting} · sast ${leaks.sast?.enabled ? leaks.sast.engine || 'on' : 'off'} · scope ${config?.targets?.mode || 'mine'} · min age ${config?.rules?.minAgeDays ?? 30}d`,
    fix: null,
    required: false,
  });

  const missingRequired = checks.filter((check) => check.required && check.status !== 'ok');
  const missingOptional = checks.filter((check) => !check.required && check.status === 'missing');

  return {
    checks,
    ok: missingRequired.length === 0,
    missing: [...missingRequired, ...missingOptional],
    missingRequired: missingRequired.length,
    missingOptional: missingOptional.length,
  };
}
