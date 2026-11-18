import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULTS } from '../config/defaults.js';
import { globalConfigPath, repoConfigPaths } from '../config/paths.js';
import { accent, bold, dim, green, red, yellow } from '../ui/theme.js';
import { renderTable } from '../ui/table.js';
import { terminalWidth } from '../ui/banner.js';

export const STARTER_CONFIG = {
  $schema: 'https://raw.githubusercontent.com/andrade-fs/git_cleaner/main/schema.json',
  remote: DEFAULTS.remote,
  defaultBranch: 'auto',
  protect: {
    branches: DEFAULTS.protect.branches,
    patterns: DEFAULTS.protect.patterns,
    users: [],
    openMR: true,
  },
  targets: {
    mode: 'mine',
    users: [],
    exclude: [],
    aliases: {},
  },
  rules: {
    minAgeDays: DEFAULTS.rules.minAgeDays,
    merged: DEFAULTS.rules.merged,
    maxAhead: null,
  },
  safety: {
    backup: true,
    requireConfirm: true,
    protectUnmerged: true,
  },
  leaks: {
    enabled: true,
    engine: DEFAULTS.leaks.engine,
    failOn: DEFAULTS.leaks.failOn,
  },
};

function flatten(value, path = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, path ? `${path}.${key}` : key, out);
    }
  } else if (Array.isArray(value)) {
    out.push([path, value.length > 0 ? value.join(', ') : '[]']);
  } else {
    out.push([path, value === null ? 'null' : String(value)]);
  }
  return out;
}

export async function runConfig(session, flags = {}) {
  const { config, sources, layers } = session;

  if (flags.init) {
    const paths = repoConfigPaths(session.repo.root);
    const target = flags.path ? globalConfigPath() : paths.repo;
    if (existsSync(target) && !flags.yes) {
      process.stderr.write(`  ${yellow('▲')} ${target} already exists — not touching it\n`);
      return 1;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, 'utf8');
    process.stdout.write(`  ${green('✔')} wrote ${target}\n`);
    process.stdout.write(`  ${dim('edit it, then run')} ${accent('topiary plan --explain')}\n`);
    return 0;
  }

  if (flags.path) {
    const rows = layers.map((layer) => ({ layer: layer.label, path: layer.path }));
    rows.push({ layer: 'defaults', path: 'built-in' });
    process.stdout.write(
      `${renderTable({
        width: terminalWidth(),
        columns: [
          { key: 'layer', header: 'LAYER', minWidth: 12 },
          { key: 'path', header: 'SOURCE', minWidth: 30 },
        ],
        rows,
      }).split('\n').join('\n')}\n`,
    );
    return 0;
  }

  if (flags.explain) {
    const rows = flatten(config).map(([key, value]) => ({
      key,
      value,
      source: sources[key] || 'defaults',
    }));
    process.stdout.write(
      `${renderTable({
        width: terminalWidth(),
        columns: [
          { key: 'key', header: 'OPTION', minWidth: 20 },
          { key: 'value', header: 'VALUE', minWidth: 16, max: 42 },
          { key: 'source', header: 'FROM', max: 14 },
        ],
        rows,
      }).split('\n').join('\n')}\n`,
    );
    return 0;
  }

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

export function configSummaryLine(config) {
  const parts = [
    `${bold('mode')} ${config.targets.mode}`,
    `${bold('min-age')} ${config.rules.minAgeDays}d`,
    `${bold('merged')} ${config.rules.merged}`,
    `${bold('backup')} ${config.safety.backup ? green('on') : red('off')}`,
  ];
  return `  ${dim('policy')}   ${parts.join(dim(' · '))}`;
}
