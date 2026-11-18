import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SAST adapter: opengrep (the Semgrep-compatible engine) is delegated to, never
 * reimplemented. It brings AST patterns and taint analysis; we bring the policy,
 * the redaction, the baseline and the exit codes.
 *
 * Configure with:
 *   "leaks": { "sast": { "enabled": true, "config": ".semgrep.yml" } }
 */
const SEVERITY_MAP = {
  CRITICAL: 'critical',
  ERROR: 'high',
  WARNING: 'medium',
  INFO: 'low',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

const CANDIDATE_CONFIGS = ['.opengrep.yml', '.opengrep.yaml', '.semgrep.yml', '.semgrep.yaml', 'semgrep.yml'];

export function sastSettings(config) {
  const sast = config?.leaks?.sast || {};
  return {
    enabled: Boolean(sast.enabled),
    engine: sast.engine || 'opengrep',
    config: sast.config || null,
    timeout: sast.timeout || 300_000,
  };
}

export function resolveRuleFile(root, settings) {
  if (settings.config) {
    const path = join(root, settings.config);
    return existsSync(path) ? path : null;
  }
  for (const candidate of CANDIDATE_CONFIGS) {
    const path = join(root, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function hasBinary(name) {
  return new Promise((resolve) => {
    execFile(name, ['--version'], { timeout: 8000 }, (error) => resolve(!error));
  });
}

export function redactLine(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (value.length <= 8) return `${'*'.repeat(value.length)}(${value.length})`;
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

function normalize(result) {
  const severity = SEVERITY_MAP[String(result.extra?.severity || '').toUpperCase()] || 'medium';
  return {
    rule: result.check_id || 'opengrep',
    severity,
    path: result.path || '?',
    line: result.start?.line || null,
    column: result.start?.col || null,
    message: result.extra?.message || 'static analysis finding',
    hint: redactLine(result.extra?.lines),
    source: 'opengrep',
    fixable: false,
  };
}

/**
 * Runs opengrep when enabled and available. Never throws: a missing binary or a
 * missing rule file is reported as a note, not as a failure of the tool.
 */
export async function sastFindings({ root, config, force = false, ruleFile = null, timeoutMs = null }) {
  const settings = sastSettings(config);
  if (!settings.enabled && !force) return { findings: [], note: null, engine: null };

  if (!(await hasBinary(settings.engine))) {
    return { findings: [], note: `${settings.engine} not installed — SAST skipped`, engine: null };
  }

  const rules = ruleFile || resolveRuleFile(root, settings);
  if (!rules) {
    return {
      findings: [],
      note: `no SAST rule file found (set leaks.sast.config, looked for ${CANDIDATE_CONFIGS.join(', ')})`,
      engine: settings.engine,
    };
  }

  const args = ['scan', '--config', rules, '--json', '--quiet', '--no-rewrite-rule-ids', '.'];
  const output = await new Promise((resolve) => {
    execFile(
      settings.engine,
      args,
      {
        cwd: root,
        timeout: timeoutMs || settings.timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, SEMGREP_SEND_METRICS: 'off' },
      },
      (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }),
    );
  });

  let parsed = null;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    const start = output.stdout.indexOf('{');
    if (start >= 0) {
      try {
        parsed = JSON.parse(output.stdout.slice(start));
      } catch {
        parsed = null;
      }
    }
  }

  if (!parsed) {
    return {
      findings: [],
      note: `${settings.engine} produced no parsable output${output.stderr ? `: ${output.stderr.split('\n')[0]}` : ''}`,
      engine: settings.engine,
    };
  }

  const findings = (parsed.results || []).map(normalize);
  return {
    findings,
    note: findings.length > 0 ? null : 'no SAST findings',
    engine: settings.engine,
    scanned: parsed.paths?.scanned?.length ?? null,
    rules: rules.replace(`${root}/`, ''),
  };
}
