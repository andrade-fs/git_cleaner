import { readSourceFrame, scanLeaks, fixFindings, writeFindingToBaseline, fingerprint } from '../core/leaks.js';
import { actionBar, statusStrip, twoPaneBody } from '../ui/frame.js';
import { renderFindingDetail, renderFindingsFooter, renderFindingsList } from '../ui/leaksView.js';
import { accent, bold, dim, green, red, yellow } from '../ui/theme.js';
import { attachKeys, waitForKey } from '../ui/tui.js';
import { runLeaks, scopeRef } from './leaks.js';

const ACTIONS = [
  { id: 'fix', label: 'Fix' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'rescan', label: 'Re-scan' },
  { id: 'quit', label: 'Quit' },
];

function readKey(screen) {
  return new Promise((resolve) => {
    const detach = attachKeys(screen.input, (str, key) => {
      detach();
      resolve({ str, key });
    });
  });
}

async function scan(session, flags) {
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
    // withSecrets: the raw key never leaves this process — not into --json, not
    // into a report, not into the baseline. Only the pane on this terminal.
    scanLeaks({
      root: session.repo.root,
      config,
      engine,
      sast: Boolean(flags.sast),
      withSecrets: true,
      ref: scopeRef(flags),
    }),
  );

  return {
    ...result,
    config,
    ref: scopeRef(flags),
    findings: result.active.map((finding) => ({ ...finding, fingerprint: fingerprint(finding) })),
  };
}

/**
 * Full-screen findings browser: list on the left, the file line and the rule on
 * the right. Same chrome as the commit graph — cursor, panes, action bar.
 */
export async function runLeaksView(session, flags = {}) {
  const screen = session.screen;
  if (!screen.interactive) return runLeaks(session, flags);

  let state = await scan(session, flags);
  let cursor = 0;
  let actionIndex = 0;
  let focus = 'list';
  let message = null;
  let masked = false;
  const frames = new Map();

  const rescan = async () => {
    state = await scan(session, flags);
    cursor = Math.min(cursor, Math.max(state.findings.length - 1, 0));
  };

  screen.enter();
  try {
    for (;;) {
      const width = screen.columns();
      const height = screen.rows();
      const split = width >= 92;
      const listWidth = split ? Math.max(Math.floor(width * 0.42), 34) : width - 4;
      const detailWidth = Math.max(width - listWidth - 3, 24);

      const findings = state.findings;
      const selected = findings[cursor] || null;

      // Real source around the finding, read once per location.
      let frame = null;
      if (selected?.line) {
        const cacheKey = `${selected.path}:${selected.line}`;
        if (!frames.has(cacheKey)) {
          frames.set(cacheKey, readSourceFrame(session.repo.root, selected.path, selected.line, { context: 5, ref: state.ref }));
        }
        frame = frames.get(cacheKey);
      }

      const head = [
        statusStrip({
          width,
          left: [
            `${accent('◆')} ${bold('TOPIARY')}`,
            session.repo.name,
            `${dim('leaks')} ${findings.length > 0 ? red(String(findings.length)) : green('clean')}`,
            state.ref ? `${dim('scope')} ${accent(state.ref)}` : dim('all refs'),
          ],
          right: [
            state.engine ? `${dim('engine')} ${state.engine}` : `${dim('engine')} ${yellow('none')}`,
            dim(`v${session.version}`),
          ],
        }),
        actionBar({
          width,
          items: ACTIONS.map((action) => action.label),
          index: actionIndex,
          focused: focus === 'bar',
          hint: focus === 'bar' ? '←→ move · ⏎ run · tab back' : 'tab actions',
        }),
        '',
      ];

      const chrome = head.length + 3; // + footer + blank
      const bodyHeight = Math.max(height - chrome, 5);

      const list = renderFindingsList(findings, { cursor, height: bodyHeight, width: listWidth });
      const detail = split
        ? renderFindingDetail(selected, { width: detailWidth, frame, masked, hint: message })
        : [];

      const body = split
        ? twoPaneBody({ left: list, right: detail, leftWidth: listWidth, height: bodyHeight })
        : list.slice(0, bodyHeight).map((line) => `  ${line}`);

      const footerLine = renderFindingsFooter({ findings, cursor, scan: state, width: width - 2, masked });
      screen.render([...head, ...body, '', `  ${footerLine}`]);

      const { key } = await readKey(screen);
      if (key.ctrl && key.name === 'c') break;
      if (key.name === 'q' || key.name === 'escape') {
        if (focus === 'bar') {
          focus = 'list';
          continue;
        }
        break;
      }

      if (focus === 'bar') {
        if (key.name === 'left' || key.name === 'h') {
          actionIndex = (actionIndex - 1 + ACTIONS.length) % ACTIONS.length;
        } else if (key.name === 'right' || key.name === 'l') {
          actionIndex = (actionIndex + 1) % ACTIONS.length;
        } else if (key.name === 'tab' || key.name === 'down' || key.name === 'j') {
          focus = 'list';
        } else if (key.name === 'return' || key.name === 'enter') {
          const result = await runAction(ACTIONS[actionIndex], { session, state, selected, rescan, screen });
          if (result === 'quit') break;
          message = result.message;
          focus = 'list';
        }
        continue;
      }

      if (key.name === 'tab' || (key.name === 'up' && cursor === 0)) {
        focus = 'bar';
        continue;
      }

      const page = Math.max(Math.floor(bodyHeight / 2), 5);
      if (key.name === 'up' || key.name === 'k') cursor = Math.max(cursor - 1, 0);
      else if (key.name === 'down' || key.name === 'j') cursor = Math.min(cursor + 1, findings.length - 1);
      else if (key.name === 'pageup' || (key.ctrl && key.name === 'u')) cursor = Math.max(cursor - page, 0);
      else if (key.name === 'pagedown' || (key.ctrl && key.name === 'd')) {
        cursor = Math.min(cursor + page, Math.max(findings.length - 1, 0));
      } else if (key.name === 'g' || key.name === 'home') cursor = 0;
      else if ((key.shift && key.name === 'g') || key.name === 'end') cursor = Math.max(findings.length - 1, 0);
      else if (key.name === 'h') {
        masked = !masked;
        message = masked ? yellow('key hidden — press h to show it') : dim('key visible — press h to hide it');
      } else if (key.name === 'r') {
        await rescan();
        message = dim('rescanned');
      } else if (key.name === 'f') {
        const result = await runAction(ACTIONS[0], { session, state, selected, rescan, screen });
        message = result.message;
      } else if (key.name === 'b') {
        const result = await runAction(ACTIONS[1], { session, state, selected, rescan, screen });
        message = result.message;
      }
    }
  } finally {
    screen.leave();
  }

  return 0;
}

async function runAction(action, { session, state, selected, rescan, screen }) {
  if (action.id === 'quit') return { quit: true };

  if (action.id === 'rescan') {
    screen.leave();
    try {
      await rescan();
      return { message: dim('rescanned') };
    } finally {
      screen.enter();
    }
  }

  if (!selected) return { message: yellow('nothing selected') };

  if (action.id === 'fix') {
    if (!selected.fixable) {
      return {
        message: `${yellow(`${selected.path} is not fixable here`)} ${dim('· rotate the secret, then purge history')}`,
      };
    }
    screen.leave();
    try {
      const result = fixFindings(session.repo.root, [selected], { dryRun: false });
      if (result.error) {
        await waitForKey(screen, `press any key · ${result.error}`);
        return { message: red(result.error) };
      }
      const done = [
        result.removed?.length ? `untracked ${result.removed.join(', ')}` : null,
        result.ignored?.length ? `added to .gitignore` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      await waitForKey(screen, `press any key · ${done}`);
      return { message: green(`fixed ${selected.path}${done ? ` · ${done}` : ''}`) };
    } catch (error) {
      await waitForKey(screen, `press any key · ${error.message}`);
      return { message: red(error.message) };
    } finally {
      screen.enter();
    }
  }

  if (action.id === 'baseline') {
    writeFindingToBaseline(session.repo.root, state.config, selected, 'accepted', 90);
    selected.baselined = true;
    return { message: green('accepted into the baseline (90 days)') };
  }

  return { message: null };
}
