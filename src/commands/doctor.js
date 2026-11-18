import { runDoctor } from '../core/doctor.js';
import { renderHeader, terminalWidth } from '../ui/banner.js';
import { renderTable } from '../ui/table.js';
import { accent, bold, dim, green, gray, red, sym, yellow } from '../ui/theme.js';

const STATUS = {
  ok: () => green('ok'),
  optional: () => dim('optional'),
  missing: () => red('missing'),
};

/**
 * `topiary doctor`: what is installed, what is missing, and the exact
 * command to fix it. The tool never installs binaries behind your back.
 */
export async function runDoctorCommand(session, flags = {}) {
  const result = await session.screen.withSpinner('probing the environment…', () =>
    runDoctor({ config: session.config }),
  );

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          missingRequired: result.missingRequired,
          missingOptional: result.missingOptional,
          checks: result.checks,
        },
        null,
        2,
      )}\n`,
    );
    return exitCode(result, flags);
  }

  const grouped = new Map();
  for (const check of result.checks) {
    if (!grouped.has(check.group)) grouped.set(check.group, []);
    grouped.get(check.group).push(check);
  }

  const lines = [session.header(), ''];
  lines.push(
    `  ${accent(sym.diamond)} ${bold(`${result.checks.length}`)} ${dim('checks')} ${dim('·')} ${
      result.missing.length === 0
        ? green('everything it can use is available')
        : `${yellow(String(result.missing.length))} ${dim(`${result.missing.length === 1 ? 'needs' : 'need'} attention`)}`
    }`,
  );

  const rows = [];
  for (const [group, checks] of grouped) {
    rows.push({ status: '', name: bold(group.toUpperCase()), detail: '' });
    for (const check of checks) {
      rows.push({
        status: (STATUS[check.status] || STATUS.optional)(),
        name: check.name,
        detail: check.status === 'missing' ? yellow(check.detail) : dim(check.detail),
      });
    }
  }

  lines.push('');
  lines.push(
    renderTable({
      width: terminalWidth(),
      columns: [
        { key: 'status', header: 'STATUS', max: 9 },
        { key: 'name', header: 'CHECK', minWidth: 10, max: 16 },
        { key: 'detail', header: 'DETAIL', minWidth: 24 },
      ],
      rows,
    })
      .split('\n')
      .join('\n  '),
  );

  const fixes = result.checks.filter((check) => check.fix && check.status !== 'ok');
  if (fixes.length > 0) {
    lines.push('');
    for (const check of fixes) {
      lines.push(`  ${dim('install')} ${check.name.padEnd(9)} ${accent(check.fix)}`);
    }
  }

  lines.push('');
  if (result.missingRequired > 0) {
    lines.push(`  ${red('✖')} ${dim('something the tool needs is missing')}`);
  } else if (result.missing.length > 0) {
    lines.push(
      `  ${yellow('▲')} ${dim('the tool works, but with less coverage — the leak scan says so in its report')}`,
    );
  } else {
    lines.push(`  ${green('✔')} ${dim('no action needed')}`);
  }
  lines.push('');

  process.stdout.write(`${lines.join('\n')}\n`);
  return exitCode(result, flags);
}

function exitCode(result, flags) {
  if (result.missingRequired > 0) return 1;
  if (flags.strict && result.missing.length > 0) return 1;
  return 0;
}
