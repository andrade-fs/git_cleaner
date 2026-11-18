import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULTS } from './defaults.js';
import { globalConfigPath, legacyGlobalConfigPath, repoConfigPaths } from './paths.js';
import { validateConfig } from './validate.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function mergeDeep(base, patch, path = '', sources = {}, label = 'merged') {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const result = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (Array.isArray(value)) {
      const previous = Array.isArray(result[key]) ? result[key] : [];
      const merged = [...previous];
      for (const item of value) {
        const exists = merged.some((existing) => JSON.stringify(existing) === JSON.stringify(item));
        if (!exists) merged.push(item);
      }
      result[key] = merged;
      sources[nextPath] = label;
    } else if (isPlainObject(value)) {
      result[key] = mergeDeep(result[key], value, nextPath, sources, label);
    } else if (value !== undefined) {
      result[key] = value;
      sources[nextPath] = label;
    }
  }
  return result;
}

export function splitList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,|]/);
  return list.map((item) => item.trim()).filter(Boolean);
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readLegacyEnv(cwd) {
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return null;
  try {
    return { path, values: parseEnvFile(readFileSync(path, 'utf8')) };
  } catch {
    return null;
  }
}

/** The old .env contract, mapped onto the new config so nothing breaks. */
export function legacyEnvToConfig(values) {
  const config = {};
  const targetUsers = splitList(values.TARGET_USERS);
  const excludeUsers = splitList(values.EXCLUDE_USERS);
  const protectedBranches = splitList(values.PROTECTED_BRANCHES);

  if (targetUsers.length > 0) {
    config.targets = { ...(config.targets || {}), mode: 'allowlist', users: targetUsers };
  }
  if (excludeUsers.length > 0) {
    config.targets = { ...(config.targets || {}), exclude: excludeUsers, mode: 'all' };
  }
  if (protectedBranches.length > 0) {
    const cleaned = protectedBranches
      .map((branch) => branch.replace(/^origin\//, ''))
      .filter(Boolean);
    config.protect = { ...(config.protect || {}), branches: cleaned };
  }
  return config;
}

const ENV_MAP = {
  GIT_CLEANER_REMOTE: ['remote', (v) => v],
  GIT_CLEANER_MODE: ['targets.mode', (v) => v],
  GIT_CLEANER_USERS: ['targets.users', splitList],
  GIT_CLEANER_EXCLUDE: ['targets.exclude', splitList],
  GIT_CLEANER_PROTECT: ['protect.branches', splitList],
  GIT_CLEANER_MIN_AGE: ['rules.minAgeDays', (v) => Number(v)],
  GIT_CLEANER_MERGED: ['rules.merged', (v) => v],
  GIT_CLEANER_ALLOW_UNMERGED: ['safety.protectUnmerged', (v) => v === '0' || v === 'false' || v === 'no'],
  GIT_CLEANER_BACKUP: ['safety.backup', (v) => !(v === '0' || v === 'false' || v === 'no')],
  GIT_CLEANER_INCLUDE_LOCAL: ['includeLocal', (v) => !(v === '0' || v === 'false' || v === 'no')],
  GIT_CLEANER_LEAKS_ENGINE: ['leaks.engine', (v) => v],
  GIT_CLEANER_FAIL_ON: ['leaks.failOn', (v) => v],
  GIT_CLEANER_JSON: ['output.format', (v) => (v === '0' || v === 'false' ? 'table' : 'json')],
};

function envToConfig(env) {
  const config = {};
  for (const [name, [path, transform]] of Object.entries(ENV_MAP)) {
    if (env[name] === undefined || env[name] === '') continue;
    const keys = path.split('.');
    let cursor = config;
    keys.forEach((key, index) => {
      if (index === keys.length - 1) cursor[key] = transform(env[name]);
      else {
        cursor[key] = cursor[key] || {};
        cursor = cursor[key];
      }
    });
  }
  return config;
}

/** Flags are the highest layer; they win over every file and env var. */
export function flagsToConfig(flags = {}) {
  const config = {};
  if (flags.remote) config.remote = flags.remote;
  if (flags.mode) config.targets = { ...(config.targets || {}), mode: flags.mode };
  if (flags.author?.length) {
    config.targets = { ...(config.targets || {}), mode: 'allowlist', users: flags.author };
  }
  if (flags.exclude?.length) config.targets = { ...(config.targets || {}), exclude: flags.exclude };
  if (flags.protect?.length) config.protect = { ...(config.protect || {}), branches: flags.protect };
  if (flags.minAge !== undefined) config.rules = { ...(config.rules || {}), minAgeDays: flags.minAge };
  if (flags.merged) config.rules = { ...(config.rules || {}), merged: flags.merged };
  if (flags.allowUnmerged) config.safety = { ...(config.safety || {}), protectUnmerged: false };
  if (flags.backup === false) config.safety = { ...(config.safety || {}), backup: false };
  if (flags.includeLocal) config.includeLocal = true;
  if (flags.engine) config.leaks = { ...(config.leaks || {}), engine: flags.engine };
  if (flags.json) config.output = { ...(config.output || {}), format: 'json' };
  return config;
}

function readJsonFile(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON — ${error.message}`);
  }
}

/** `extends` is resolved relative to the file, with a depth guard. */
function readWithExtends(path, depth = 0, seen = new Set()) {
  if (depth > 5) throw new Error(`${path}: extends chain too deep`);
  if (seen.has(path)) throw new Error(`${path}: circular extends`);
  seen.add(path);

  const data = readJsonFile(path);
  if (!data || typeof data !== 'object') return data;

  if (typeof data.extends === 'string') {
    const parentPath = isAbsolute(data.extends) ? data.extends : resolve(dirname(path), data.extends);
    const parent = readWithExtends(parentPath, depth + 1, seen);
    const { extends: _ignored, ...own } = data;
    return mergeDeep(parent, own);
  }
  return data;
}

/**
 * Layered config: defaults → global → repo → repo.local → legacy .env →
 * --config → env vars → flags.
 */
export function loadConfig({ cwd = process.cwd(), root, flags = {}, configPath } = {}) {
  const sources = {};
  const warnings = [];
  const errors = [];
  const layers = [];

  let config = mergeDeep({}, DEFAULTS, '', sources, 'defaults');

  const pushFile = (label, path) => {
    if (!path || !existsSync(path)) return;
    try {
      const data = readWithExtends(path);
      const check = validateConfig(data, path);
      errors.push(...check.errors);
      warnings.push(...check.warnings);
      config = mergeDeep(config, data, '', sources, label);
      layers.push({ label, path });
    } catch (error) {
      errors.push(error.message);
    }
  };

  pushFile('global', globalConfigPath());
  if (!existsSync(globalConfigPath())) {
    const legacy = legacyGlobalConfigPath();
    if (existsSync(legacy)) {
      pushFile('global (legacy)', legacy);
      warnings.push(`${legacy}: still reading the pre-rename global config — move it to ${globalConfigPath()}`);
    }
  }

  if (root) {
    const paths = repoConfigPaths(root);
    pushFile('repo', paths.repo);
    pushFile('local', paths.local);

    if (existsSync(paths.legacyEnv)) {
      const legacy = readLegacyEnv(root);
      if (legacy) {
        const mapped = legacyEnvToConfig(legacy.values);
        if (Object.keys(mapped).length > 0) {
          config = mergeDeep(config, mapped, '', sources, 'legacy .env');
          layers.push({ label: 'legacy .env', path: legacy.path });
          warnings.push(
            `${legacy.path}: legacy .env config detected — migrate to .git-cleaner.json (kept working for now)`,
          );
        }
      }
    }
  }

  if (configPath) pushFile('cli --config', resolve(cwd, configPath));

  const envLayer = envToConfig(process.env);
  if (Object.keys(envLayer).length > 0) {
    config = mergeDeep(config, envLayer, '', sources, 'env');
    layers.push({ label: 'env', path: 'GIT_CLEANER_*' });
  }

  const flagLayer = flagsToConfig(flags);
  if (Object.keys(flagLayer).length > 0) {
    config = mergeDeep(config, flagLayer, '', sources, 'flags');
    layers.push({ label: 'flags', path: 'argv' });
  }

  const final = validateConfig(config, 'merged config');
  errors.push(...final.errors);

  return { config, sources, layers, warnings, errors };
}
