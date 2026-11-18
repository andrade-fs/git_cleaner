import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where this tool keeps its own files. Config files *inside* a repo keep their
 * historical `.git-cleaner.json` name so nothing breaks on upgrade. */
const BRAND = 'topiary';
const LEGACY_BRAND = 'git-cleaner';

export function configHome() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return join(homedir(), '.config');
}

export function stateHome() {
  if (process.env.XDG_STATE_HOME) return process.env.XDG_STATE_HOME;
  return join(homedir(), '.local', 'state');
}

export function globalConfigPath() {
  return join(configHome(), BRAND, 'config.json');
}

/** Pre-rename location, still read when the new one is absent. */
export function legacyGlobalConfigPath() {
  return join(configHome(), LEGACY_BRAND, 'config.json');
}

export function stateDir(repoId) {
  return join(stateHome(), BRAND, repoId);
}

/** Files that carry team/personal policy inside a repo. */
export function repoConfigPaths(root) {
  return {
    repo: join(root, '.git-cleaner.json'),
    local: join(root, '.git-cleaner.local.json'),
    legacyEnv: join(root, '.env'),
  };
}
