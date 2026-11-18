import { bold, dim, accent, gray, gradient, sym } from '../ui/theme.js';

const GROUPS = [
  {
    title: 'COMMANDS',
    rows: [
      ['plan', 'analyse the repo and show what would be deleted (default)'],
      ['delete', 'delete the planned branches, with backup + lease'],
      ['restore', 'list snapshots, or put deleted branches back'],
      ['leaks', 'scan for leaked secrets and sensitive files'],
      ['snapshot', 'checkpoint every branch under refs/gitcleaner (restorable)'],
      ['users', 'list branch authors, emails and aliases'],
      ['config', 'show the merged configuration and where it came from'],
      ['doctor', 'check node, git and the optional leak engines'],
      ['(no args)', 'open the interactive TUI'],
    ],
  },
  {
    title: 'PREREQUISITES (none required)',
    rows: [
      ['gitleaks', 'secret formats + history (brew install gitleaks)'],
      ['opengrep', 'SAST rules (github.com/opengrep/opengrep/releases)'],
      ['gh', 'open-PR protection (brew install gh)'],
    ],
  },
  {
    title: 'POLICY',
    rows: [
      ['--mode <m>', 'mine | allowlist | denylist | all'],
      ['--author <e>', 'only branches by this email (repeatable)'],
      ['--exclude <e>', 'never touch branches by this email (repeatable)'],
      ['--protect <g>', 'extra protected branch glob, e.g. "release/*"'],
      ['--min-age <d>', 'minimum age in days (default 30)'],
      ['--merged <m>', 'any | only | exclude'],
      ['--allow-unmerged', 'include branches that hold unmerged commits'],
      ['--local', 'include local branches'],
    ],
  },
  {
    title: 'SAFETY',
    rows: [
      ['-y, --yes', 'skip confirmation (required without a TTY)'],
      ['--dry-run', 'never delete, only print the plan'],
      ['--no-backup', 'do not write backup refs (dangerous)'],
      ['--no-fetch', 'skip git fetch --prune before analysing'],
      ['--remote <n>', 'remote to inspect (default origin)'],
    ],
  },
  {
    title: 'OUTPUT',
    rows: [
      ['--json', 'machine-readable output'],
      ['--explain', 'show the decision for every branch'],
      ['--no-color', 'disable colours'],
      ['-h, --help', 'this help'],
      ['-v, --version', 'print the version'],
    ],
  },
  {
    title: 'LEAKS',
    rows: [
      ['--selftest', 'plant canaries in a temp repo and prove the scanner works'],
      ['--check', 'CI mode: exit 3 when findings reach --fail-on'],
      ['--fix', 'untrack sensitive files and add them to .gitignore'],
      ['--sast', 'also run the delegated SAST engine (opengrep)'],
      ['--engine <e>', 'auto | builtin | gitleaks | none'],
      ['--branch <ref>', 'scan that branch tree + history, without checking it out'],
      ['--view', 'full-screen findings browser with a code frame'],
      ['--no-history', 'scan the worktree only, skip git history'],
    ],
  },
  {
    title: 'CONFIG',
    rows: [
      ['--init', 'write a starter .git-cleaner.json'],
      ['--explain', 'show every option with the layer that set it'],
      ['--path', 'list the config layers that were loaded'],
      ['--config <f>', 'load an extra config file (highest priority)'],
    ],
  },
];

export function helpText({ version = '0.0.0' } = {}) {
  const width = 78;
  const lines = [];

  lines.push('');
  lines.push(`  ${accent(sym.diamond)}  ${gradient('TOPIARY', '#5eead4', '#818cf8')}  ${dim(`v${version}`)}`);
  lines.push(`     ${dim('branch hygiene · leak policy · safe deletes')}`);
  lines.push('');
  lines.push(`  ${dim('USAGE')}`);
  lines.push(`    ${bold('topiary')} ${dim('[command] [options]')}`);
  lines.push(`    ${dim('also available as')} ${gray('bitpry')} ${dim('·')} ${gray('git cleaner')} ${dim('·')} ${gray('gcl')}`);

  for (const group of GROUPS) {
    lines.push('');
    lines.push(`  ${dim(group.title)}`);
    const pad = Math.max(...group.rows.map(([flag]) => flag.length)) + 2;
    for (const [flag, description] of group.rows) {
      lines.push(`    ${accent(flag.padEnd(pad))}${dim(description)}`);
    }
  }

  lines.push('');
  lines.push(`  ${dim('─'.repeat(width - 4))}`);
  lines.push(`  ${dim('EXAMPLES')}`);
  lines.push(`    ${gray('git cleaner')}                        ${dim('# TUI')}`);
  lines.push(`    ${gray('topiary plan --explain')}          ${dim('# every branch, every reason')}`);
  lines.push(`    ${gray('topiary delete --dry-run')}        ${dim('# same, but never deletes')}`);
  lines.push(`    ${gray('topiary delete --yes --merged only')} ${dim('# CI-friendly')}`);
  lines.push(`    ${gray('topiary leaks --check')}           ${dim('# fail the build on secrets')}`);
  lines.push('');
  lines.push(`  ${dim('config layers:')} ${gray('defaults → ~/.config/topiary/config.json → .git-cleaner.json → .git-cleaner.local.json → .env* → GIT_CLEANER_* → flags')}`);
  lines.push('');

  return lines.join('\n');
}

export function shortUsage() {
  return `  ${dim('usage:')} ${bold('topiary')} ${dim('<plan|delete|restore|leaks|users|config> [options]')}\n  ${dim('run')} ${accent('topiary --help')} ${dim('for the full list')}`;
}
