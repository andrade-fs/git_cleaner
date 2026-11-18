import { failsThreshold, fixFindings, scanLeaks } from '../core/leaks.js';
import { runLeakSelftest } from '../core/selftest.js';
import { installHint } from '../core/doctor.js';
import { renderHeader, terminalWidth } from '../ui/banner.js';
import { renderTable } from '../ui/table.js';
import { accent, bold, dim, green, gray, padEnd, red, sym, yellow } from '../ui/theme.js';
import { askYesNo } from '../util/readline.js';

const TONE = { critical: red, high: red, medium: yellow, low: gray };
const SEV_LABEL = { critical: 'crit', high: 'high', medium: 'med', low: 'low' };

function severityCell(severity) {
  const paint = TONE[severity] || gray;
  const text = SEV_LABEL[severity] || severity;
  return paint(text.padEnd(4));
}

/**
 * The report has to survive an 80-column terminal: the HINT column only exists
 * when there is room, because DETAIL is the column people actually read.
 */
export function findingsTable(findings, { width = terminalWidth() } = {}) {
  const rows = findings.map((finding) => ({
    severity: severityCell(finding.severity),
    path: finding.path + (finding.line ? `:${finding.line}` : ''),
    rule: finding.rule,
    detail: finding.baselined ? dim(`${finding.message} (baselined)`) : dim(finding.message),
    hint: finding.hint ? gray(finding.hint) : '',
  }));

  const columns = [
    { key: 'severity', header: 'SEV', max: 5 },
    { key: 'path', header: 'PATH', minWidth: 14, max: 26 },
    { key: 'rule', header: 'RULE', minWidth: 12, max: 20 },
    { key: 'detail', header: 'DETAIL', minWidth: 20, max: 34 },
  ];
  if (width >= 92) columns.push({ key: 'hint', header: 'HINT', max: 20 });

  return renderTable({ width, columns, rows });
}

export function leaksSummary(session, result) {
  const { bySeverity, active, baselinedCount, engine, engineNote } = result;
  const parts = [];
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    if (bySeverity[severity] > 0) {
      const paint = TONE[severity] || gray;
      parts.push(`${paint(String(bySeverity[severity]))} ${dim(severity)}`);
    }
  }

  // Same label/value grid as the header, so the block reads as one table.
  const label = (text) => dim(padEnd(text, 9));

  const headline =
    active.length === 0
      ? `${green('✔')} ${bold('0 findings')} ${dim('· clean')}`
      : `${accent(sym.diamond)} ${bold(String(active.length))} ${dim(
          `finding${active.length === 1 ? '' : 's'}`,
        )}${parts.length ? ` ${dim('·')} ${parts.join(dim(' · '))}` : ''}`;

  const rulesLabel =
    result.ruleCount > 0
      ? green(`${result.ruleCount} custom rule${result.ruleCount === 1 ? '' : 's'}`)
      : dim('none');
  const sastLabel = result.sastEngine ? green(result.sastEngine) : dim('off');

  return [
    `  ${label('result')} ${headline}`,
    `  ${label('scope')} ${
      result.scope?.ref ? accent(result.scope.ref) : dim('all refs')
    } ${dim(`· ${result.scope?.ref ? 'tree + history of that ref' : 'history of every ref · current worktree'}`)}`,
    `  ${label('engine')} ${engine ? green(engine) : yellow('builtin policy only')}${
      engineNote ? ` ${dim(`(${engineNote})`)}` : ''
    }`,
    `  ${label('rules')} ${rulesLabel} ${dim('· sast')} ${sastLabel}`,
    `  ${label('baseline')} ${dim(`${baselinedCount} accepted in ${result.baselinePath.replace(`${session.repo.root}/`, '')}`)}`,
  ];
}

export function scopeRef(flags = {}) {
  const branch = Array.isArray(flags.branch) ? flags.branch[0] : flags.branch;
  return branch || null;
}

export async function runLeaks(session, flags = {}) {
  const engine = flags.engine || session.config.leaks.engine;
  const config = {
    ...session.config,
    leaks: {
      ...session.config.leaks,
      engine,
      history: {
        ...session.config.leaks.history,
        enabled: session.config.leaks.history?.enabled !== false && !flags.noHistory,
      },
    },
  };

  const result = await session.screen.withSpinner('scanning for leaked secrets…', () =>
    scanLeaks({ root: session.repo.root, config, engine, sast: Boolean(flags.sast), ref: scopeRef(flags) }),
  );

  const failOn = session.config.leaks.failOn;
  const failing = failsThreshold(result.active, failOn);

  // A missing engine used to read as "clean". Say it out loud, and let
  // requireEngine turn it into a failure for CI.
  const engineWanted = engine === 'auto' || engine === 'gitleaks';
  const engineMissing = engineWanted && !result.engine;
  const engineRequired = engineMissing && Boolean(session.config.leaks.requireEngine);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          engine: result.engine,
          engineMissing,
          requireEngine: Boolean(session.config.leaks.requireEngine),
          total: result.total,
          active: result.active.length,
          bySeverity: result.bySeverity,
          baseline: result.baselinePath,
          scope: result.scope,
          failOn,
          fails: failing,
          findings: result.findings,
        },
        null,
        2,
      )}\n`,
    );
    return flags.check && (failing || engineRequired) ? 3 : 0;
  }

  const lines = [];
  lines.push(session.header());
  lines.push('');
  lines.push(...leaksSummary(session, result));

  if (result.findings.length > 0) {
    lines.push('');
    lines.push(`  ${findingsTable(result.findings, { width: terminalWidth() }).split('\n').join('\n  ')}`);
  } else {
    lines.push('');
    lines.push(`  ${dim('verify the scanner')}  ${accent('topiary leaks --selftest')}`);
  }

  if (result.active.length > 0) {
    const baselineLabel = result.baselinePath.replace(`${session.repo.root}/`, '');
    lines.push('');
    lines.push(`  ${dim('fix tracked files')}  ${accent('topiary leaks --fix')}`);
    lines.push(`  ${dim('accept a finding')}  ${dim(`add its fingerprint to ${baselineLabel}`)}`);
    if (result.engine) {
      lines.push(`  ${dim('rotate first')}      ${dim('deleting a branch does not revoke a secret')}`);
    }
  }

  if (engineMissing) {
    lines.push('');
    lines.push(`  ${yellow('▲')} ${dim('gitleaks is not installed: only the built-in policy layer ran')}`);
    lines.push(`  ${dim('install')}     ${accent(installHint('gitleaks'))}`);
    lines.push(`  ${dim('check')}       ${accent('topiary doctor')}`);
  }

  if (flags.check) {
    lines.push('');
    lines.push(
      failing
        ? `  ${red('✖')} fails threshold ${dim(`(failOn: ${failOn})`)}`
        : `  ${green('✔')} below threshold ${dim(`(failOn: ${failOn})`)}`,
    );
    if (engineRequired) {
      lines.push(`  ${red('✖')} ${dim('leaks.requireEngine is on and gitleaks is missing')}`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);

  if (flags.fix) {
    if (result.active.length === 0) return 0;
    const fixable = result.active.filter((finding) => finding.fixable);
    if (fixable.length === 0) {
      process.stderr.write(`  ${yellow('▲')} nothing auto-fixable here — rotate the secret and rewrite history by hand\n`);
      return failing ? 3 : 0;
    }

    const dryRun = !flags.yes;
    if (dryRun && session.screen.interactive) {
      const confirmed = await askYesNo(
        `  ${bold(`Untrack ${fixable.length} sensitive files?`)} ${dim('git rm --cached + append to .gitignore')}`,
      );
      if (!confirmed) return failing ? 3 : 0;
    } else if (dryRun) {
      process.stdout.write(
        `  ${dim('would untrack')} ${fixable.map((finding) => finding.path).join(', ')} ${dim('— re-run with --yes')}\n`,
      );
      return failing ? 3 : 0;
    }

    const fixed = await fixFindings(session.repo.root, fixable, { dryRun: false });
    if (fixed.error) {
      process.stderr.write(`  ${red('✖')} ${fixed.error}\n`);
      return 1;
    }
    process.stdout.write(`  ${green('✔')} untracked ${fixed.removed.length} files and updated .gitignore\n`);
    process.stdout.write(`  ${dim('commit the removal; the file stays on disk and is now ignored')}\n`);
  }

  return flags.check && (failing || engineRequired) ? 3 : 0;
}

/**
 * `leaks --selftest`: plants one canary per detection path in a throwaway repo
 * and proves the scanner fires. Repo-independent, so it runs anywhere.
 */
export async function runSelftest(flags = {}, version = '0.0.0') {
  const result = await runLeakSelftest({
    engine: flags.engine || 'auto',
    sast: !flags.noSast,
  });

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          engine: result.engine,
          sastEngine: result.sastEngine,
          findings: result.findings,
          bySeverity: result.bySeverity,
          checks: result.checks,
        },
        null,
        2,
      )}\n`,
    );
    return result.ok ? 0 : 1;
  }

  const passed = result.checks.filter((check) => check.ok).length;
  const lines = [
    renderHeader({ version, tagline: 'leak scanner self-test' }),
    '',
    `  ${accent(sym.diamond)} ${bold(`${passed}/${result.checks.length}`)} ${dim('checks passed')} ${dim('·')} ${dim(
      `${result.findings} finding${result.findings === 1 ? '' : 's'} planted and detected`,
    )}`,
    '',
    `  ${renderTable({
      width: terminalWidth(),
      columns: [
        { key: 'status', header: 'STATUS', max: 7 },
        { key: 'name', header: 'CHECK', minWidth: 22, max: 30 },
        { key: 'detail', header: 'DETAIL', minWidth: 20 },
      ],
      rows: result.checks.map((check) => ({
        status: check.ok ? green('✔') : red('✖'),
        name: check.name,
        detail: dim(check.detail),
      })),
    })
      .split('\n')
      .join('\n  ')}`,
    '',
    `  ${dim('engine')}  ${result.engine ? green(result.engine) : dim('none')} ${dim('·')} ${dim('sast')} ${
      result.sastEngine ? green(result.sastEngine) : dim('off')
    }`,
    result.ok
      ? `  ${green('✔')} ${dim('the leak scanner works on this machine')}`
      : `  ${red('✖')} ${dim('some checks failed — the scanner would miss those cases')}`,
    '',
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
  return result.ok ? 0 : 1;
}
