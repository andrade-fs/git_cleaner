/** Built-in defaults — layer 0. Everything else merges on top. */
export const DEFAULTS = {
  remote: 'origin',
  defaultBranch: 'auto',
  includeLocal: false,

  fetch: { enabled: true, prune: true },

  protect: {
    branches: ['main', 'master', 'dev', 'develop', 'version/*', 'release/*', 'staging', 'prod', 'trunk'],
    patterns: ['^release/', '^version/'],
    users: [],
    openMR: true,
  },

  targets: {
    mode: 'mine', // mine | allowlist | denylist | all
    users: [],
    exclude: [],
    aliases: {},
  },

  rules: {
    minAgeDays: 30,
    dateField: 'committerdate',
    merged: 'any', // any | only | exclude
    maxAhead: null,
    detectSquashMerged: false,
  },

  safety: {
    backup: true,
    requireConfirm: true,
    protectUnmerged: true,
  },

  output: {
    format: 'table', // table | json | md
    color: 'auto',
    locale: 'en',
  },

  leaks: {
    enabled: true,
    paths: {
      deny: [
        '.env*',
        '*.env',
        '*.pem',
        '*.key',
        'id_rsa*',
        'id_ed25519*',
        '*.p12',
        '*.pfx',
        '*.jks',
        'credentials',
        'credentials.json',
        '.npmrc',
        '.aws/credentials',
        '.aws/config',
        'service-account*.json',
        'kubeconfig',
        'dump.sql',
        '*.sqlite',
        '*.sqlite3',
        '.htpasswd',
      ],
      allow: ['.env.example', '.env.sample', '.env.template', '*.pub', 'test/fixtures/**', '**/__fixtures__/**'],
    },
    junk: ['.DS_Store', 'Thumbs.db', 'node_modules/**', '*.log', 'dist/**', 'build/**', 'coverage/**'],
    trackedIgnored: true,
    gitignoreGaps: true,
    engine: 'auto', // auto | builtin | gitleaks | none
    requireEngine: false,
    rules: [],
    sast: { enabled: false, engine: 'opengrep', config: null, timeout: 300_000 },
    history: { enabled: true, depth: 500 },
    redact: 'always',
    baseline: '.git-cleaner/leaks-baseline.json',
    failOn: 'high',
  },
};

/** Which file each default came from, for `config --explain`. */
export function defaultSources() {
  const sources = {};
  const walk = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    } else {
      sources[path] = 'defaults';
    }
  };
  walk(DEFAULTS, '');
  return sources;
}
