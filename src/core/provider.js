import { gitText } from './git.js';
/**
 * Open pull/merge requests, when the provider CLI is available.
 * One call for the whole repo — never one call per branch.
 */
export async function fetchOpenPRs({ root, remoteInfo, timeout = 20_000 }) {
  if (!remoteInfo || remoteInfo.kind !== 'github') {
    return { available: false, refs: new Set(), reason: 'not a github remote' };
  }

  const { ok, stdout } = await runGh(root, timeout).catch((error) => ({
    ok: false,
    stdout: '',
    stderr: error.message,
  }));

  if (!ok) {
    return { available: false, refs: new Set(), reason: 'gh CLI not available or not authenticated' };
  }

  try {
    const list = JSON.parse(stdout);
    const refs = new Set(list.map((item) => item.headRefName).filter(Boolean));
    return { available: true, refs, reason: null };
  } catch {
    return { available: false, refs: new Set(), reason: 'could not parse gh output' };
  }
}

async function runGh(root, timeout) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', '300', '--json', 'headRefName,number'],
      { cwd: root, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}
