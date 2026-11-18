import { formatSnapshotId, listSnapshots } from '../core/backup.js';
import { formatAge } from '../util/format.js';
import { accent, bold, dim, green, red, yellow } from '../ui/theme.js';
import { confirmPrompt, multiSelectList, selectList, waitForKey } from '../ui/tui.js';
import { groupAuthors } from './users.js';
import { deletionReportLines, performDeletion } from './delete.js';
import { planLines, runPlan } from './plan.js';
import { runLeaks } from './leaks.js';
import { runLeaksView } from './leaksView.js';
import { runSelftest } from './leaks.js';
import { runDoctorCommand } from './doctor.js';
import { runGraph } from './graph.js';
import { runConfig } from './config.js';
import { runUsers } from './users.js';
import { runRestore } from './restore.js';
import { runSnapshot } from './snapshot.js';
import { runSettings } from './settings.js';

/**
 * The interactive face of the tool: a menu in the alternate screen, and plain
 * scrolled output for anything the user may want to copy or read later.
 */
export async function runTui(session) {
  const screen = session.screen;
  if (!screen.interactive) {
    process.stderr.write(`  ${yellow('▲')} no interactive terminal — running the plan instead\n`);
    return runPlan(session, {});
  }

  screen.enter();
  try {
    for (;;) {
      const plan = session.plan({});
      const wider = session.plan({ allowUnmerged: true });
      const extraUnmerged = wider.summary.candidates - plan.summary.candidates;
      const snapshots = await listSnapshots(session.repo.root);
      const authors = groupAuthors(session.analysis.remoteBranches);

      const items = [
        {
          label: 'Analyze & plan',
          value: 'plan',
          hint: `${plan.summary.candidates} to delete · ${plan.summary.total} branches`,
        },
        { label: 'Commit graph', value: 'graph', hint: 'history · branches · policy per lane' },
        {
          label: 'Clean up',
          value: 'clean',
          hint: plan.summary.candidates > 0 ? 'pick branches, back up, delete' : 'nothing matches the policy',
        },
      ];

      if (extraUnmerged > 0) {
        items.push({
          label: 'Clean up + unmerged',
          value: 'clean-unmerged',
          hint: `+${extraUnmerged} branch${extraUnmerged === 1 ? '' : 'es'} that are not merged`,
        });
      }

      items.push(
        {
          label: 'Restore a backup',
          value: 'restore',
          hint: `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`,
        },
        { label: 'Snapshot branches', value: 'snapshot', hint: 'checkpoint now · restorable later' },
        { label: 'Leak scan', value: 'leaks', hint: 'findings · file line · fix or baseline' },
        { label: 'Verify leak scanner', value: 'selftest', hint: 'plant canaries · prove it works' },
        { label: 'Doctor', value: 'doctor', hint: 'node · git · optional engines' },
        { label: 'Authors', value: 'users', hint: `${authors.length} identities` },
        {
          label: 'Settings',
          value: 'settings',
          hint: 'edit the policy in-app · live impact',
        },
        { label: 'Quit', value: 'quit', hint: '' },
      );

      const header = [...session.header().split('\n'), ''];
      const action = await selectList({
        screen,
        header,
        title: 'What do you want to do?',
        items,
        footer: '↑↓ move · ⏎ select · q quit',
      });

      if (!action || action === 'quit') break;

      if (action === 'clean' || action === 'clean-unmerged') {
        await cleanFlow(session, { allowUnmerged: action === 'clean-unmerged' });
        continue;
      }

      if (action === 'settings') {
        await runSettings(session);
        continue;
      }

      if (action === 'graph') {
        screen.leave();
        await runGraph(session, {});
        screen.enter();
        continue;
      }

      // Long text output belongs in the normal buffer, not the alt screen.
      screen.leave();
      try {
        if (action === 'plan') await runPlan(session, {});
        else if (action === 'restore') await runRestore(session, { list: true });
        else if (action === 'snapshot') await runSnapshot(session, {});
        else if (action === 'leaks') {
          screen.leave();
          await runLeaksView(session, {});
          screen.enter();
        }
        else if (action === 'selftest') await runSelftest({}, session.version);
        else if (action === 'doctor') await runDoctorCommand(session, {});
        else if (action === 'users') await runUsers(session, {});
        else if (action === 'config') await runConfig(session, { explain: true });
      } catch (error) {
        process.stderr.write(`  ${red('✖')} ${error.message}\n`);
      }
      await waitForKey(screen, 'press any key to return to the menu');
      screen.enter();
    }
  } finally {
    screen.leave();
  }

  process.stdout.write(`\n  ${dim('bye')} ${green('✦')}\n`);
  return 0;
}

async function cleanFlow(session, { allowUnmerged }) {
  const screen = session.screen;
  const plan = session.plan({ allowUnmerged });

  if (plan.candidates.length === 0) {
    screen.render([...session.header().split('\n'), '', `  ${green('✔')} ${dim('nothing to delete')}`, '', `  ${dim('press any key')}`]);
    await waitForKey(screen, '');
    return;
  }

  const items = plan.candidates.map((branch) => ({
    label: branch.name,
    value: branch.name,
    hint: `${branch.authorName || branch.authorEmail} · ${formatAge(branch.time)} · ${
      branch.merged ? 'merged' : `ahead ${branch.ahead ?? '?'}`
    }`,
  }));

  const chosen = await multiSelectList({
    screen,
    header: [...session.header().split('\n'), ''],
    title: `Select branches to delete from ${session.remote}`,
    subtitle: `${plan.summary.candidates} candidates · space toggles · all preselected`,
    items,
    preselected: items.map((_, index) => index),
  });

  if (!chosen || chosen.length === 0) {
    screen.render([...session.header().split('\n'), '', `  ${dim('nothing selected')}`, '', `  ${dim('press any key')}`]);
    await waitForKey(screen, '');
    return;
  }

  const selected = plan.candidates.filter((branch) => chosen.includes(branch.name));

  const confirmed = await confirmPrompt({
    screen,
    header: [...session.header().split('\n'), ''],
    title: `Delete ${selected.length} branches from ${session.remote}?`,
    subtitle: session.config.safety.backup
      ? 'refs are backed up locally first; restore with topiary restore'
      : 'backup is disabled — this cannot be undone',
    yesLabel: `Yes, delete ${selected.length}`,
    noLabel: 'No, go back',
    defaultYes: false,
  });

  if (!confirmed) return;

  screen.render(['', `  ${dim(`deleting ${selected.length} branches…`)}`]);
  const outcome = await performDeletion(session, selected);
  // Refresh in place: the menu, the graph and the next plan must not keep
  // showing branches that no longer exist.
  try {
    await session.reload({ fetch: false, prs: false });
  } catch (error) {
    process.stderr.write(`  ${red('✖')} could not refresh: ${error.message}\n`);
  }
  const report = deletionReportLines(session, outcome);
  screen.render([...session.header().split('\n'), '', ...report, '', `  ${dim('press any key')}`]);
  await waitForKey(screen, '');
}
