import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

/**
 * Test entry point that owns its environment.
 *
 * `npm publish` (and any lifecycle hook) runs with FORCE_COLOR=1 when npm has a
 * TTY, which used to make colour-sensitive assertions fail only on a developer's
 * machine. Pin it here: the suite must produce the same result in a terminal, in
 * CI and inside `prepublishOnly`.
 */
const files = readdirSync('test')
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => `test/${name}`);

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
