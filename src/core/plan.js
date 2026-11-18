import { decide, reasonText } from './policy.js';

/**
 * Turns analysed branches into an explainable plan: candidates plus everything
 * that was left alone and why.
 */
export function buildPlan(branches, config, ctx, options = {}) {
  const includeLocal = options.includeLocal ?? config.includeLocal;
  const scoped = branches.filter((branch) => includeLocal || branch.kind !== 'local');

  const decisions = scoped.map((branch) => decide(branch, config, ctx, options));

  const candidates = decisions
    .filter((item) => item.decision === 'candidate')
    .sort((a, b) => a.time - b.time);

  const protectedBranches = decisions.filter((item) => item.decision === 'protected');
  const skipped = decisions.filter((item) => item.decision === 'skip');

  const byReason = {};
  for (const item of decisions) {
    byReason[item.reason] = (byReason[item.reason] || 0) + 1;
  }

  const ages = candidates.map((item) => (Date.now() - item.time) / 86_400_000);
  const totalAge = ages.reduce((sum, value) => sum + value, 0);

  return {
    candidates,
    protected: protectedBranches,
    skipped,
    decisions,
    summary: {
      total: decisions.length,
      candidates: candidates.length,
      protected: protectedBranches.length,
      skipped: skipped.length,
      byReason,
      oldestDays: ages.length ? Math.round(Math.max(...ages)) : 0,
      averageDays: ages.length ? Math.round(totalAge / ages.length) : 0,
    },
    warnings: planWarnings(config, decisions),
  };
}

/**
 * A policy nobody can satisfy looks exactly like a clean repo: zero candidates.
 * Say the difference out loud instead of letting an empty allowlist read as "done".
 */
function planWarnings(config, decisions) {
  const warnings = [];
  const mode = config.targets?.mode;
  const users = config.targets?.users || [];

  if ((mode === 'allowlist' || mode === 'denylist') && users.length === 0) {
    warnings.push({
      code: 'empty-allowlist',
      message:
        mode === 'allowlist'
          ? 'targets.mode is allowlist but targets.users is empty — no branch can match. Add emails in Settings, or switch mode to "mine" / "all".'
          : 'targets.mode is denylist but targets.users is empty — nothing is excluded, every branch is in scope.',
    });
  }

  if (mode === 'mine' && decisions.length > 0 && decisions.every((item) => item.reason === 'skip:not-target')) {
    warnings.push({
      code: 'no-own-branches',
      message: 'mode "mine" matched no branch — check your git email against the branch authors (`topiary users`).',
    });
  }

  return warnings;
}

export function explain(plan) {
  return plan.decisions.map((item) => ({
    branch: item.name,
    scope: item.kind,
    author: item.authorEmail,
    ageDays: Math.floor((Date.now() - item.time) / 86_400_000),
    ahead: item.ahead,
    merged: item.merged,
    decision: item.decision,
    reason: item.reason,
    detail: item.detail,
    label: reasonText(item.reason),
  }));
}

export function planToJSON(plan, extra = {}) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    ...extra,
    summary: plan.summary,
    branches: explain(plan),
  };
}
