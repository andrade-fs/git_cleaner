/**
 * Schema-lite validator: enough to catch typos and wrong types with a useful
 * message, without dragging in ajv. Returns { errors, warnings }.
 */
const num = (min, max) => ({ type: 'number', min, max });
const str = () => ({ type: 'string' });
const bool = () => ({ type: 'boolean' });
const arr = (of) => ({ type: 'array', of });
const obj = (props) => ({ type: 'object', props });
const en = (...values) => ({ type: 'enum', values });

export const CONFIG_SPEC = obj({
  remote: str(),
  defaultBranch: str(),
  includeLocal: bool(),
  fetch: obj({ enabled: bool(), prune: bool() }),
  protect: obj({
    branches: arr(str()),
    patterns: arr(str()),
    users: arr({ type: 'any' }),
    openMR: bool(),
  }),
  targets: obj({
    mode: en('mine', 'allowlist', 'denylist', 'all'),
    users: arr(str()),
    exclude: arr(str()),
    aliases: obj({}),
  }),
  rules: obj({
    minAgeDays: num(0, 3650),
    dateField: en('committerdate', 'authordate'),
    merged: en('any', 'only', 'exclude'),
    maxAhead: { type: 'number', min: 0, nullable: true },
    detectSquashMerged: bool(),
  }),
  safety: obj({
    backup: bool(),
    requireConfirm: bool(),
    protectUnmerged: bool(),
  }),
  output: obj({
    format: en('table', 'json', 'md'),
    color: en('auto', 'always', 'never'),
    locale: en('en', 'es'),
  }),
  leaks: obj({
    enabled: bool(),
    paths: obj({ deny: arr(str()), allow: arr(str()) }),
    junk: arr(str()),
    trackedIgnored: bool(),
    gitignoreGaps: bool(),
    engine: en('auto', 'builtin', 'gitleaks', 'none'),
    requireEngine: bool(),
    rules: arr({ type: 'any' }),
    sast: obj({
      enabled: bool(),
      engine: en('opengrep', 'semgrep'),
      config: { type: 'string', nullable: true },
      timeout: num(1000, 900000),
    }),
    history: obj({ enabled: bool(), depth: { type: 'number', min: 1, nullable: true } }),
    redact: en('always'),
    baseline: str(),
    failOn: en('low', 'medium', 'high', 'critical'),
  }),
});

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describe(value) {
  const type = typeOf(value);
  if (type === 'string') return `"${value}"`;
  if (type === 'array') return `array(${value.length})`;
  if (type === 'object') return 'object';
  return String(value);
}

export function validateConfig(input, source = 'config') {
  const errors = [];
  const warnings = [];

  const check = (spec, value, path) => {
    if (value === undefined) return;
    const label = path || '(root)';

    if (value === null) {
      if (spec.nullable) return;
      // `"users": null` after deleting a list is a normal edit, not a typo.
      // Treat it as "not set" and keep the rest of the config usable.
      if (spec.type === 'object' || spec.type === 'array') {
        warnings.push(`${label}: null means "not set" — ignored (${source})`);
        return;
      }
      errors.push(`${label}: null is not allowed (${source})`);
      return;
    }

    switch (spec.type) {
      case 'object': {
        if (typeOf(value) !== 'object') {
          errors.push(`${label}: expected object, got ${describe(value)} (${source})`);
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          // Metadata keys are valid everywhere and must not warn.
          if (key === '$schema' || key === 'extends') continue;
          if (spec.props[key]) check(spec.props[key], child, path ? `${path}.${key}` : key);
          else if (Object.keys(spec.props).length > 0) {
            warnings.push(`${label ? `${label}.` : ''}${key}: unknown option, ignored (${source})`);
          }
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          errors.push(`${label}: expected array, got ${describe(value)} (${source})`);
          return;
        }
        value.forEach((item, index) => check(spec.of || { type: 'any' }, item, `${label}[${index}]`));
        break;
      }
      case 'enum': {
        if (!spec.values.includes(value)) {
          errors.push(`${label}: expected one of ${spec.values.join(' | ')}, got ${describe(value)} (${source})`);
        }
        break;
      }
      case 'string':
      case 'boolean':
      case 'number': {
        if (typeOf(value) !== spec.type) {
          errors.push(`${label}: expected ${spec.type}, got ${describe(value)} (${source})`);
          return;
        }
        if (spec.type === 'number') {
          if (spec.min !== undefined && value < spec.min) errors.push(`${label}: must be >= ${spec.min} (${source})`);
          if (spec.max !== undefined && value > spec.max) errors.push(`${label}: must be <= ${spec.max} (${source})`);
        }
        break;
      }
      default:
        break;
    }
  };

  check(CONFIG_SPEC, input, '');
  return { errors, warnings };
}
