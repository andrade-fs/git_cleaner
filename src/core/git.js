import { execFile } from 'node:child_process';

const MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitError';
    this.args = details.args;
    this.code = details.code;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
  }
}

const baseEnv = {
  // Never hang waiting for credentials in a non-interactive CLI.
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  LANGUAGE: 'C',
};

/**
 * Run `git` with explicit args. Never goes through a shell, so branch names with
 * spaces/quotes/unicode are safe.
 */
export async function git(args, options = {}) {
  const { cwd = process.cwd(), timeout = 120_000, allowFail = false, env = {}, input } = options;

  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd,
          timeout,
          maxBuffer: MAX_BUFFER,
          env: { ...process.env, ...baseEnv, ...env },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });

    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    const result = {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? '',
      code: typeof error.code === 'number' ? error.code : 1,
    };
    if (allowFail) return result;
    const message = (result.stderr || result.stdout || error.message || 'git failed').trim();
    throw new GitError(`git ${args.join(' ')} failed: ${message}`, { args, ...result });
  }
}

export async function gitText(args, options) {
  const { stdout } = await git(args, options);
  return stdout.trim();
}

export async function gitLines(args, options) {
  const text = await gitText(args, options);
  return text ? text.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean) : [];
}

/** NUL-delimited output (`-z`), the only safe way to parse untrusted paths. */
export async function gitZ(args, options) {
  const { stdout } = await git(args, options);
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

export async function gitVersion() {
  const { stdout } = await git(['--version'], { allowFail: true });
  const match = stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, raw: stdout.trim() };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
    raw: stdout.trim(),
  };
}

export async function refExists(cwd, ref) {
  const { ok } = await git(['show-ref', '--verify', '--quiet', ref], { cwd, allowFail: true });
  return ok;
}
