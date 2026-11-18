import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLeaks } from './leaks.js';
import { DEFAULTS } from '../config/defaults.js';

/**
 * Self-test: builds a throwaway repo with one canary per detection path, runs
 * the real scanner over it, and reports which checks fired. This is how the user
 * verifies "does leaks actually work on this machine" instead of trusting docs.
 */
const CANARY_TOKEN = 'acme_9fK2mQ7pL4vR8tX1zB6nC3wY5jH0sD2g';
const CANARY_GH = 'ghp_' + 'aB3dE6fH9jK2mN5pQ8rS1tV4wX7yZ0cD2eF5g';
const CANARY_RULE = 'topiary-selftest-no-eval';

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'selftest@local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'topiary selftest'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
}

function gitAdd(dir, ...paths) {
  execFileSync('git', ['add', '-f', '--', ...paths], { cwd: dir, stdio: 'ignore' });
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gc-selftest-'));
  gitInit(root);

  // 1. tracked sensitive file
  writeFileSync(join(root, '.env'), 'API_KEY=abc123\n');
  // 2. tracked junk
  writeFileSync(join(root, '.DS_Store'), 'junk\n');
  // 3. tracked file that .gitignore says should not be there
  writeFileSync(join(root, 'old.env'), 'LEGACY=1\n');
  writeFileSync(join(root, '.gitignore'), 'old.env\nnode_modules/\n');
  // 4. sensitive file on disk, untracked and NOT ignored
  writeFileSync(join(root, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n');
  // 5. canary for the custom rule
  writeFileSync(join(root, 'src-token.js'), `const token = "${CANARY_TOKEN}";\n`);
  // 6. canary for the secret engine
  writeFileSync(join(root, 'ci-token.txt'), `GITHUB_TOKEN=${CANARY_GH}\n`);
  // 7. canary for the SAST adapter
  writeFileSync(join(root, 'app.js'), 'function run(input) { return eval(input); }\n');
  writeFileSync(
    join(root, '.opengrep.yml'),
    [
      'rules:',
      `  - id: ${CANARY_RULE}`,
      '    languages: [javascript]',
      '    severity: ERROR',
      '    message: eval() usage',
      '    patterns:',
      '      - pattern: eval(...)',
      '',
    ].join('\n'),
  );

  gitAdd(root, '.env', '.DS_Store', 'old.env', 'src-token.js', 'ci-token.txt', 'app.js', '.gitignore');
  execFileSync('git', ['commit', '-qm', 'selftest canaries'], { cwd: root, stdio: 'ignore' });

  return root;
}

function configFor(engine) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    leaks: {
      ...JSON.parse(JSON.stringify(DEFAULTS.leaks)),
      engine,
      history: { enabled: false, depth: null },
      rules: [
        {
          id: 'acme-token',
          description: 'Acme internal token',
          pattern: 'acme_[A-Za-z0-9]{32}',
          severity: 'critical',
        },
      ],
      sast: { enabled: true, engine: 'opengrep', config: '.opengrep.yml' },
    },
  };
}

const SEVERITY_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

export async function runLeakSelftest({ engine = 'auto', sast = true, mutate = null } = {}) {
  const root = buildFixture();
  const checks = [];

  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  try {
    const config = configFor(engine);
    // Test seam: lets the suite break one path and prove the self-test notices.
    if (typeof mutate === 'function') mutate(config);

    const result = await scanLeaks({ root, config, engine, sast });

    const has = (predicate) => result.findings.some(predicate);

    add(
      'tracked sensitive file',
      has((finding) => finding.rule === 'tracked-sensitive' && finding.path === '.env'),
      '.env should be reported as tracked',
    );
    add(
      'tracked junk',
      has((finding) => finding.rule === 'tracked-junk' && finding.path === '.DS_Store'),
      '.DS_Store should be reported',
    );
    add(
      'tracked but ignored',
      has((finding) => finding.rule === 'tracked-ignored' && finding.path === 'old.env'),
      'old.env is tracked even though .gitignore excludes it',
    );
    add(
      'gitignore gap',
      has((finding) => finding.rule === 'gitignore-gap' && finding.path === 'id_rsa'),
      'id_rsa sits on disk untracked and not ignored',
    );

    const ruleHit = result.findings.find((finding) => finding.rule === 'acme-token');
    add(
      'custom rule (regex)',
      Boolean(ruleHit),
      ruleHit ? `matched at ${ruleHit.path}:${ruleHit.line}` : 'the acme_* pattern was not reported',
    );

    const rawSecret = JSON.stringify(result.findings);
    add(
      'redaction',
      !rawSecret.includes(CANARY_TOKEN) && !rawSecret.includes(CANARY_GH),
      'no raw secret may appear in the report',
    );

    const engineHit = result.findings.find((finding) => finding.source === 'gitleaks');
    if (result.engine) {
      add(
        `secret engine (${result.engine})`,
        Boolean(engineHit),
        engineHit ? `${engineHit.rule} at ${engineHit.path}` : 'the engine ran but reported nothing',
      );
    } else {
      add('secret engine', true, 'gitleaks not installed — skipped (policy layer still ran)');
    }

    if (sast) {
      const sastHit = result.findings.find((finding) => finding.source === 'opengrep');
      if (result.sastEngine) {
        add(
          `sast engine (${result.sastEngine})`,
          Boolean(sastHit),
          sastHit ? `${sastHit.rule} at ${sastHit.path}:${sastHit.line}` : result.sastNote || 'no finding',
        );
      } else {
        add('sast engine', true, `skipped — ${result.sastNote || 'engine unavailable'}`);
      }
    }

    const worst = result.active.reduce(
      (acc, finding) => Math.max(acc, SEVERITY_ORDER[finding.severity] || 0),
      0,
    );
    add('severity model', worst >= SEVERITY_ORDER.critical, `worst severity seen: ${worst ? Object.keys(SEVERITY_ORDER).find((key) => SEVERITY_ORDER[key] === worst) : 'none'}`);

    const mandatory = checks.filter(
      (check) => !/engine/.test(check.name) || check.name === 'secret engine (gitleaks)',
    );
    const failed = mandatory.filter((check) => !check.ok);

    return {
      ok: failed.length === 0,
      checks,
      engine: result.engine,
      sastEngine: result.sastEngine,
      root,
      findings: result.findings.length,
      bySeverity: result.bySeverity,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
