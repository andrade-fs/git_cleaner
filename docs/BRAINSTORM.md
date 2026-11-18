# topiary — Design & Roadmap

Internal design doc. Goal: turn `git_cleaner` from a one-off script into a globally installable
npm CLI (`npm i -g`) that a whole team can trust with destructive operations.

> **Status — v0.1 shipped.** The tool is now a zero-dependency ESM package with bins
> `topiary` / `gcl` (so `git cleaner` works), a full-screen TUI, layered config, email-based
> identity, backup/restore, verification and the leak policy layer. 39 tests against real fixture
> repos. What is still open from this document: squash-merge detection (P1), `sync` / `doctor` /
> `tags` / `worktrees` / `rename` (v0.4), trufflehog and provider-alert adapters (v0.3), i18n (v0.3).


---

## 0. TL;DR

The tool's value is **not** "delete branches" — `git push origin --delete` already exists. The value
is **deciding safely**: a policy engine that says *which* branches are garbage, *why*, and a way to
undo it. That means three things the current script does not have:

1. A real config layer (global → repo → env → flags), not a `.env` in the cwd.
2. Identity matching by **email**, not by commit display name.
3. Reversibility: backup refs + `restore`.

Ship those three as v0.1 and the rest is upside.

---

## 1. Where the current code stands

`index.js` is 174 lines, works, and is a good prototype. Concrete findings:

| # | Issue | Where | Impact |
|---|-------|-------|--------|
| 1 | 2 `git show` subprocesses **per branch** | `index.js:55-57` | ~380 processes for 190 branches. One `for-each-ref` does it in 1. |
| 2 | Hard crash if `TARGET_USERS` is unset | `index.js:8` | `.split()` on `undefined` → TypeError before any output. |
| 3 | Author matched on `%an` (display name) | `index.js:57,81` | Fragile. See §1.1 — the data proves it. |
| 4 | `EXCLUDE_USERS` silently overrides `TARGET_USERS` | `index.js:73-82` | Implicit precedence, no warning. |
| 5 | Merged check only against `origin/main` / `origin/master` | `index.js:29-38` | Wrong on repos with `develop`, `release/*`, or a different default branch. |
| 6 | `git push origin :branch` without backup | `index.js:155` | Irreversible. Remote reflog exists but nobody will find it. |
| 7 | No local-branch cleanup, no worktree check, no `origin/HEAD` guard | whole file | Deletes remote, leaves the local mess. |
| 8 | No `--json`, no `--yes`, no exit codes | whole file | Unusable in CI / scripts. |
| 9 | Protected list duplicates `origin/*` entries | `index.js:11` | Harmless (line 84 already matches by suffix) but noisy. |
| 10 | Config is cwd-`.env` only | `index.js:6,10` | A global CLI cannot depend on the cwd. |
| 11 | `nodemon` is a **production** dependency, `inquirer` + `simple-git` + `cli-progress` + `dotenv` for what is ~5 things | `package.json:13-19` | 100+ transitive packages, slow global install, supply-chain surface. |
| 12 | No tests, no `bin`, no `engines`, no `files`, no shebang | `package.json` | Not publishable as-is. |

### 1.1 Why name-based author matching must die

`history.txt` (a real run) has **186 branches**: 67 merged (36%), 119 unmerged (64%).
The same humans appear under multiple names:

| Person | Names seen in the repo |
|---|---|
| Santiago | `Santiago Andrade` (49), `andrade-fs` (6), `Santi AF` (3) |
| Alex | `Alex Gonzalez` (46), `alexgonzalezCB` (1) |
| Alexis | `Alexis Jesús Sierra Martínez` (19), `Alexis Jesús` (1) |
| Raúl | `raulbarranqueroguerrero` (7), `Raul Barranquero Guerrero` (1) |

So an allow/deny list keyed on `%an` **misses ~15% of a person's branches**, silently. Match on
`%ae` (email) with a name-alias map for display. That is not a detail, it is the feature.

### 1.2 Naming hygiene is also a real problem

Deletion is not the only mess: `featuer/OVAC-4351`, `fixOVAC-4003`, `fixed/OVAC-3708`,
`feature/OVAC-3919-` (trailing dash), `version/OVAC-7.3.0` vs `version/8.3.0`, and the
`*-dev` twin-branch convention (`OVAC-4349` + `OVAC-4349-dev`, 30+ pairs). A `rename`/`lint`
utility has obvious demand here.

---

## 2. Positioning

> **topiary** — policy-driven git hygiene. It tells you what is garbage, proves it, deletes it
> safely, and can put it back.

Three personas we're selling to:

- **The individual dev** who wants `topiary` and gets their own mess gone in 10 seconds → zero config must work.
- **The tech lead** who needs a committed team policy (`.git-cleaner.json`) so a junior cannot nuke `release/*`.
- **CI/bots** that need `--dry-run --json` and a non-zero exit when the repo exceeds a branch budget.

---

## 3. Configuration model

### 3.1 Layering (lowest → highest precedence)

```
1. built-in defaults                          (protected: main master dev develop version staging prod)
2. ~/.config/topiary/config.json          (user-global; XDG_CONFIG_HOME respected)
3. <repo>/.git-cleaner.json                   (team policy, committed)
4. <repo>/.git-cleaner.local.json             (personal overrides, should be gitignored)
5. env GIT_CLEANER_*                          (CI; never the primary path)
6. CLI flags                                  (--protect, --allow-user, --min-age, ...)
```

Rules:
- Arrays **merge** (union) going up, except lists that are explicitly replaced (`--no-protect`).
- `"extends": "./base.json"` supported in file layers for company-wide policies.
- `topiary config` prints the merged result **with the winning layer per key** and validates against a published JSON Schema (`$schema` in the file → editor autocomplete).
- Optional native integration: `git config --get gitcleaner.protectedBranches`, so teams that hate extra files can stay in `git config`. (Read-only mirror; files win.)

### 3.2 Schema v1 (draft)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/bitsentry/topiary/main/schema.json",

  "remote": "origin",
  "defaultBranch": "auto",              // auto → origin/HEAD, else main, master, develop, trunk

  "protect": {
    "branches": ["main", "master", "dev", "develop", "version/*", "release/*", "staging", "prod"],
    "patterns": ["^release/", "^hotfix/", "^version/"],
    "users": [                           // never delete anything authored by these
      { "email": "ci@company.com", "reason": "bot" },
      { "name": "/^(dependabot|renovate)/i" }
    ],
    "openMR": true,                      // treat branches with an open PR/MR as protected
    "tags": false
  },

  "targets": {                           // WHO gets cleaned
    "mode": "mine",                      // mine | allowlist | denylist | all
    "users": ["me@company.com"],         // allowlist (mode=allowlist)
    "exclude": ["lead@company.com"],     // denylist, always wins over allowlist
    "aliases": {                         // name → canonical identity
      "Santiago Andrade": "santiago@company.com",
      "andrade-fs": "santiago@company.com",
      "Santi AF": "santiago@company.com"
    }
  },

  "rules": {
    "minAgeDays": 30,                    // branch tip committerdate
    "dateField": "committerdate",        // committerdate | authordate
    "merged": "any",                     // any | only | exclude  (only = --merged to default)
    "detectSquashMerged": true,          // patch-id / gh PR state, not just --merged
    "behindDefault": false,              // if true, require 0 commits ahead of default
    "maxAhead": null,                    // refuse if branch holds > N unique commits
    "requireNoLocalChanges": true,
    "skipWorktreeBranches": true
  },

  "safety": {
    "backup": true,                      // write refs/gitcleaner/<ts>/<branch> before deleting
    "requireConfirm": true,
    "dryRunDefault": true,
    "protectUnmergedByDefault": true      // unmerged branches need --allow-unmerged
  },

  "output": { "format": "table", "color": "auto", "locale": "en" }
}
```

### 3.3 Precedence of protection (first match wins, all veto deletion)

```
1. branch is the default branch / origin/HEAD          → PROTECTED
2. branch matches protect.branches or protect.patterns → PROTECTED
3. branch author ∈ protect.users                       → PROTECTED
4. branch has an open PR/MR (if enabled)               → PROTECTED
5. branch is checked out in a worktree                 → PROTECTED (local step)
6. branch author ∈ targets.exclude                      → SKIPPED (denylist)
7. targets.mode allowlist/mine and author ∉ users       → SKIPPED (not a target)
8. rules.* (age, merged, ahead...)                     → CANDIDATE or SKIPPED with reason
```

Every decision carries a machine-readable `reason` (`protected:pattern`, `skip:too-recent`,
`skip:unmerged`, `candidate`). That's what powers `--explain` and the JSON output — the user should
never have to guess *why* a branch was left alone.

### 3.4 What "protected user" means in practice (answered)

Both of your cases are the same mechanism with different `targets.mode`:

| Intent | Config | Effect |
|---|---|---|
| "Clean **only** my branches" | `mode: "mine"` | Everything not authored by me is out of scope. |
| "Clean everyone's **except** Alice's" | `mode: "all"`, `exclude: [alice]` | Alice is untouchable, rest is fair game. |
| "Clean these 3 devs, nobody else" | `mode: "allowlist"`, `users: [a,b,c]` | Scope limited to those authors. |
| "Never touch CI/bot branches" | `protect.users: [ci@…]` | Veto, applies in every mode. |

`protect.users` always beats `targets.*` — a bot branch is never a candidate even in `mode: all`.

---

## 4. Feature map

Priority legend: **P0** = v0.1 must-have, **P1** = v0.2, **P2** = nice to have, **P3** = later/ask.

### Pillar A — Decide (analysis & policy)

| Feature | P | Notes |
|---|---|---|
| Single-pass analysis via `for-each-ref` | P0 | `%(refname:short)%00%(committerdate:unix)%00%(authorname)%00%(authoremail)%00%(objectname)` → 1 subprocess instead of 2N. |
| Per-branch "ahead/behind vs default" + unique commit count | P0 | `git rev-list --left-right --count default...branch`. Tells the human what they'd lose. |
| Machine-readable `reason` per branch | P0 | Powers `--explain` and JSON. |
| Merged detection beyond main/master (`defaultBranch: auto`) | P0 | `origin/HEAD` → fallback chain. |
| **Squash-merge detection** | P1 | 64% of the sample is unmerged, but many were squash-merged and GitHub shows no ancestry. `git cherry default branch` (patch-id) + provider API fallback. Huge real-world win. |
| Open PR/MR protection | P1 | `gh pr list --json` / `glab mr list`, or `--provider auto` sniffing the remote URL. |
| Author identity resolution + `topiary users` | P1 | Table of authors: emails, aliases, branch count, last activity — copy-paste straight into config. |
| Branch age histogram / report by author | P2 | `topiary stats`; also the "cleanup leaderboard" for team shaming. |
| Age by *last activity* not just tip commit | P2 | For local branches `reflog` gives true last touch; remote only has tip date. Document the limitation. |
| Branch name lint (`featuer/`, `fixOVAC-4003`) | P2 | `topiary lint --fix` with a naming regex + Jira key validation. |
| Stale/orphan detection: branches whose upstream is gone | P1 | `git branch -vv` → `[gone]`. Goes with `sync`. |

### Pillar B — Act

| Feature | P | Notes |
|---|---|---|
| Remote delete via `git push <remote> --delete <branch> --porcelain` | P0 | Parse porcelain output; don't scrape stderr inside a progress bar. |
| Batch deletes | P1 | One `git push remote --delete b1 b2 b3 …` per chunk of ~20 → 20x fewer round-trips. Falls back to one-by-one on failure to isolate the culprit. |
| Local branch delete (`-d` / `-D` gated) | P1 | With worktree guard and "merged into HEAD" check. |
| `--yes` / non-interactive + `--dry-run` default | P0 | Exit codes: `0` ok, `1` error, `2` nothing to do, `3` policy violation (font of CI trust). |
| Selection UI (`--pick`) | P2 | Multi-select list, pre-checked candidates, last chance to uncheck. |
| Rate-limit / retry on provider 429 | P2 | Only when API features are on. |

### Pillar C — Safety (the differentiator)

| Feature | P | Notes |
|---|---|---|
| **Backup refs before delete** | P0 | `git update-ref refs/gitcleaner/<ts>/<branch> <sha>` locally + state file. Free undo. |
| `topiary restore <id>` | P0 | Re-push the backed-up refs. Without this, `backup` is a half-feature. |
| JSONL audit log | P1 | `~/.local/state/topiary/<repo-id>/history.jsonl`: who, when, what, sha, outcome. |
| Post-delete verification | P0 | Re-`ls-remote`, assert refs gone, report and exit non-zero on partial failure. |
| `--confirm-token <n>` for CI | P2 | Delete N branches means you knew the count (blunt but effective). |
| Refuse to run on dirty worktree | P0 | `git status --porcelain`. |
| Refuse when `origin` is not reachable / behind | P0 | Stale local view = wrong decisions. Auto `fetch --prune` first (with `--no-fetch` to skip). |

### Pillar D — Interface

| Feature | P | Notes |
|---|---|---|
| `topiary list` (default), `delete`, `restore`, `config`, `users` | P0 | Subcommand layout from day one; the interactive menu becomes `topiary` with no args. |
| Table output with color, `--no-color`, `--quiet` | P0 | Own ~40-line table renderer, no dependency. |
| `--json` / `--ndjson` | P0 | Stable, versioned envelope: `{ version, repo, policy, branches: [...] }`. |
| i18n: English default, `es` available | P1 | Current strings are hardcoded Spanish; a CLI on npm should be English by default. |
| Shell completion (bash/zsh/fish) | P3 | `topiary completion zsh`. |
| Works as `git cleaner …` | P0 | Naming the bin `topiary` gets this for free — git resolves `git-<cmd>` on PATH. |

### Pillar E — The suite (your "podemos meter más tools")

One binary, `topiary <command>`. Don't turn it into a kitchen sink, but these share 90% of the
plumbing (config, remote handling, identity, output) and are the natural next verbs:

| Command | What it does | Value |
|---|---|---|
| `topiary sync` | `fetch --prune`, delete local branches whose upstream is `[gone]`, fast-forward the local default. | The daily driver. Highest usage of the whole suite. |
| `topiary doctor` | Repo health report: branch count vs budget, dangling refs, stale worktrees, repo size, branches violating naming policy, remote divergence. `--fix` for the safe subset. | Onboarding + the "why is this repo slow" answer. |
| `topiary tags` | Stale/duplicate/unsorted tags, `version/*` vs semver drift; delete only tag patterns you opt into. | Same problem as branches, one layer up. |
| `topiary worktrees` | `worktree prune`, list orphans pointing at dead paths. | Cheap, high hit rate on your machine. |
| `topiary stash` | Age/owner report, drop by index or older-than. | Small, forgotten mess. |
| `topiary rename` | Normalize branch names (`featuer/` → `feature/`, `fixOVAC-1` → `fix/OVAC-1`), verify the new ref, delete the old, push. | Concrete demand proven by `history.txt`. |
| `topiary report md\|csv` | Export the cleanup plan/results for a Jira ticket or the team channel. | Makes the tool political, in a good way. |
| `topiary size` | Biggest blobs / directories, LFS candidates. | Adjacent, sells to a different audience. |
| `topiary hook install` | pre-push hook: block pushes to protected branches, enforce the naming regex, warn on new branch from a stale base. | Prevents the mess instead of cleaning it. |
| `topiary guard` | `--check` mode for CI: fail if a protected branch was force-pushed / deleted, or if branch count > budget. | Turns hygiene into a gate. |

Skip: anything that rewrites history (`filter-repo`), merge/rebase automation, PR creation. Those
are different products.

### Pillar F — Leaks (secret & sensitive-file hygiene)

Scope decision first: **do not rebuild gitleaks.** There are 300+ rules with a CVE-like treadmill
and two mature engines already exist. This pillar is worth having because it covers the half that
gitleaks *structurally cannot*: **repo policy**. Gitleaks knows "this looks like an AWS key"; it does
not know "this repo must never track `.env*`".

Three layers, cheapest first:

**F1. Policy layer — built-in, deterministic, ~0 false positives (v0.2)**

| Check | Command | Severity |
|---|---|---|
| Sensitive files **tracked** (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12/.pfx`, `.npmrc`, `.aws/credentials`, `service-account*.json`, `kubeconfig`, `dump.sql`, `*.sqlite`) | `git ls-files` + patterns | high |
| **Tracked but ignored**: files that today's `.gitignore` says should not be there | `git ls-files -ci --exclude-standard` | high |
| **Gitignore gap**: sensitive file exists on disk, untracked **and** not ignored → one `git add -A` away from a leak | `git status --porcelain --ignored` + patterns | medium |
| Hygiene junk tracked (`.DS_Store`, `node_modules/`, `*.log`, `dist/`) | `git ls-files` | low |

This layer caught something real in this very repo: **`"env copy"` is tracked** while `.env` is
ignored, and `gitleaks dir` / `gitleaks git` report **0 findings** on it — because it has no
secret-shaped content. The policy is the thing that's wrong, and only this layer can see it.

**F2. Engine layer — delegate, normalize, never reimplement (v0.3)**

`leaks.engine: auto` → detect `gitleaks`, `trufflehog`, `ggshield` on `PATH` (both gitleaks 8.30 and
trufflehog 3.99 are already installed here), run them with our scope flags, parse their JSON, normalize
into one `Finding` shape. Absent engine → suggest the install, never fail the command.
Advantages over rolling our own: trufflehog gives **live credential verification** (is this key still
valid? that changes severity from "maybe" to "confirmed, rotate now"), gitleaks gives the rule corpus.

**F3. Provider layer — authoritative (v0.3)**

`gh api repos/{owner}/{repo}/secret-scanning/alerts` (already authenticated as `andrade-fs` here).
Normalize to the same `Finding`. Zero scanning cost, highest signal, and it is what security teams
actually look at.

**Cross-cutting rules (non-negotiable):**

- **Redact by default.** Never print the secret. `sk_live_4f2a…(48 chars)`. Our report ends up in Jira,
  Slack and CI logs; a scanner that leaks is worse than the leak.
- **Baseline with expiry.** `.git-cleaner/leaks-baseline.json`, fingerprint = `sha256(rule + path + context)`
  (path:line shifts, so don't key on line), with `justification` and `expiresAt`. Unexpired noise is
  how people learn to ignore the tool.
- **Never purge history.** We print the exact `git filter-repo` command and the rotate-first checklist;
  rewriting a shared repo is a human decision with a freeze window.
- **Rotate-first framing.** Every finding carries what to rotate, who introduced it, the commit, the
  branch and the date. The report is the deliverable, not the exit code.

**Integration points with what already exists:**

| Where | Behaviour |
|---|---|
| `topiary doctor` | one line: `leaks: 3 high, 1 medium (baseline: 0)`. |
| `topiary delete` | before deleting a candidate, warn if it contains findings — deleting hides the secret but **does not** revoke it. Tell the user to rotate. |
| `topiary hook install --secrets` | pre-commit/pre-push using the delegated engine in `--staged` mode. Prevention beats cleanup. |
| `topiary leaks --check` | CI gate, exit `3` when severity ≥ `leaks.failOn`. |
| `topiary leaks --fix` | only the safe subset: `git rm --cached` the tracked-but-ignored files, append the pattern to `.gitignore`, print the rotate reminder. |

Config block (lives in the same layered file, `leaks` key):

```jsonc
"leaks": {
  "enabled": true,
  "paths": {
    "deny": [".env*", "*.pem", "*.key", "id_rsa*", "*.p12", "*.pfx", "credentials*", ".npmrc",
             ".aws/credentials", "service-account*.json", "kubeconfig", "dump.sql"],
    "allow": [".env.example", ".env.sample", "*.pub", "test/fixtures/**"]
  },
  "trackedIgnored": true,
  "gitignoreGaps": true,
  "engine": "auto",                       // auto | builtin | gitleaks | trufflehog | ggshield | none
  "history": { "enabled": true, "since": null, "depth": null, "allRefs": true },
  "provider": "auto",                     // github secret-scanning alerts via gh
  "redact": "always",
  "baseline": ".git-cleaner/leaks-baseline.json",
  "failOn": "high",
  "severity": {
    "privateKey": "critical", "providerToken": "critical", "verifiedLive": "critical",
    "trackedSensitiveFile": "high", "gitignoreGap": "medium", "trackedJunk": "low"
  }
}
```

Command surface: `topiary leaks` (report), `--check` (CI), `--fix` (safe subset),
`--staged` (hook mode), `--history/--no-history`, `--json`, `--report md`. Alias `secrets`.

**F2b. Custom rules — the "opengrep-lite" slice (shipped).**

`leaks.rules[]`: `{id, pattern (regex), severity, entropy?, paths{include,exclude}, description}`.
Scanned over tracked files with a size cap, binary skip and per-file hit limit. This is where team
knowledge lives and it is the only part of a SAST engine worth owning: a YAML of AST patterns is a
maintenance treadmill, a regex of *your* token format is five lines.

**Decision — delegate, don't reimplement.** Opengrep/Semgrep = AST + taint + 30 languages + a rule
ecosystem + its own FPs. A branch-hygiene CLI that grows an AST engine is worse at both jobs. So:

| Need | Owner | Why |
|---|---|---|
| "this file must never be tracked", "our tokens look like X" | us (`policy` + `rules`) | deterministic, repo-specific, zero FPs |
| "is this a live credential", 300 secret formats, history | gitleaks / trufflehog | rule corpus, live verification |
| "is `eval(userInput)` reachable", AST/taint rules | opengrep (`leaks.sast`) | language grammars we will never write |

`leaks.sast` runs `opengrep scan --config <file> --json --quiet` over the repo, maps
`ERROR/WARNING/INFO` to `high/medium/low`, redacts the matched code and feeds the same finding shape,
baseline and exit code. Off by default: it needs the user's own rule file (`.opengrep.yml` is
auto-detected).

**Self-test (shipped).** `topiary leaks --selftest` builds a temp repo with one canary per
detection path — tracked `.env`, tracked-but-ignored, gitignore gap, custom-rule token, engine token,
`eval()` for SAST — runs the real scanner and prints a pass/fail table, exiting `1` if a path is
broken. It is repo-independent, so it answers "does this work on my machine" without trusting docs.


---

## 5. Package architecture

### 5.1 Layout

```
bin/topiary.js            # shebang + thin entry (import src/cli.js)
src/
  cli.js                      # parseArgs dispatch, global flags, exit codes
  commands/{list,delete,restore,config,users,sync,doctor,tags,rename}.js
  core/git.js                 # promisified execFile wrapper, single source of `git`
  core/analyze.js             # for-each-ref → Branch[]
  core/policy.js              # protection/allow/deny/rules → Decision[]
  core/plan.js                # Decision[] → Plan { candidates, skipped, warnings }
  core/backup.js              # update-ref / restore / audit log
  core/output/{table,json,markdown}.js
  core/i18n.js
config/load.js                # layering + schema validation + --explain
schema.json                   # published, versioned
test/                         # node:test + real fixture repos in tmp dirs
```

### 5.2 Dependencies

Target **zero runtime dependencies**. `git` is the engine; `node:child_process.execFile` is all we
need. Prompts via `node:readline/promises` (y/N) and, if the selection UI warrants it, one small
optional dep (`@clack/prompts`) instead of inquirer. Benefits for a `npm i -g` tool: instant install,
no supply chain, no CJS/ESM breakage, no 3-year-old `inquirer` CVE.

`devDependencies` only: `typescript` (JSDoc + `checkJs` is also fine), `nodemon` (move out of prod),
`c8` for coverage.

### 5.3 package.json essentials

```jsonc
{
  "name": "@bitsentry/topiary",     // `topiary` on npm is taken (1.0.7, unmaintained)
  "version": "0.1.0",
  "type": "module",
  "bin": { "topiary": "bin/topiary.js", "gcl": "bin/topiary.js" },
  "engines": { "node": ">=18" },
  "files": ["bin", "src", "schema.json", "README.md", "LICENSE"],
  "scripts": { "test": "node --test", "prepublishOnly": "npm test" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

- Name availability checked: `gitcleaner` and `gitclean` look free, `topiary` and `git-prune` are taken. Scoped `@bitsentry/topiary` is the safe bet — and it lets the suite grow (`@bitsentry/topiary-*`) without name fights.
- Publish with `--provenance` from GitHub Actions (OIDC) — cheap trust signal for a destructive tool.
- Semver: `0.x` until the config schema stops changing; then `1.0.0` freezes `schema.json` and the JSON output shape.

### 5.4 Testing (non-negotiable for a destructive CLI)

`node:test` + fixture repos built in `mkdtemp` with real `git init` / bare remote. Golden tests over
`--json` output for each policy permutation (protected branch, protected user, too recent, unmerged,
squash-merged, worktree, open PR mock). Plus one test per safety invariant: *no delete without
backup*, *no delete of a protected branch even with `--yes --force`*.

---

## 6. Roadmap

**v0.1 — "safe by default" (1-2 days of work)**
Single-pass analysis · layered config + schema · email-based identity + aliases · protected
branches/users with reasons · dry-run table · `--json` · delete with backup refs + confirmation ·
`--yes`/`--dry-run`/exit codes · tests for the plan engine. Publishable to npm.

**v0.2 — "trusted by a team"**
`restore` · `users` command · open-PR protection · squash-merge detection · local branch cleanup ·
`sync` · audit log · **`leaks` policy layer (F1: tracked sensitive files, tracked-but-ignored,
gitignore gaps, `--check`)** · `es` locale. F1 is ~100 lines and one `git ls-files -ci` call — it
ships here, not in a later phase.

**v0.3 — "leaks + prevention"**
Engine adapters (`gitleaks`/`trufflehog`/`ggshield`) + `gh` secret-scanning alerts · baseline file ·
redacted `--report md` · rotate checklist · `hook install --secrets` (pre-commit/pre-push staged scan).

**v0.4 — "suite"**
`doctor` (with the leaks summary line) · `tags` · `worktrees` · `rename` · `report md/csv`.

**v1.0 — "contract"**
Frozen schema (including `leaks`) + JSON output · shell completions · provenance CI · docs site ·
pre-push hook installer.

---

## 7. Open decisions

1. **Scope**: single-purpose cleaner, or the `topiary <verb>` suite above? (Recommended: build the subcommand skeleton now, ship only `list/delete/restore/config` in v0.1.)
2. **Name**: `@bitsentry/topiary` + bins `topiary`/`gcl`, or grab a free unscoped name (`gitcleaner`) for discoverability?
3. **`--dry-run` as default**: safest, but makes `delete` feel broken. (Recommended: dry-run unless `--yes`, and if the user runs `delete` interactively, show the plan then ask.)
4. **Provider API**: is GitHub/GitLab API access (`gh`/`glab` or tokens) acceptable as an *optional* feature, or should the tool stay pure-git? (Affects squash-merge + open-PR protection, the two biggest safety wins.)
5. **Config file name**: `.git-cleaner.json` vs `.gitcleanrc` vs `gitcleaner.config.json`.
6. **Interactive or flags-first**: keep the inquirer-style menu as the no-args experience, or make `topiary` print the plan and require an explicit subcommand? (Recommended: no args = plan + menu, everything scriptable via flags.)
7. **Leaks: subcommand or separate package?** `topiary leaks` reuses config/remote/identity/output and reaches the same audience, so it belongs here. But it doubles the maintenance surface (engine quirks, rule drift). (Recommended: subcommand; delegate the scanning, own only the policy layer. Split into `@bitsentry/topiary-leaks` later if it grows.)
8. **`leaks` scope on a huge repo**: full history on a monorepo can take minutes. Default to `--history --depth 500` + policy layer always, and require an explicit `--history-all`? (Recommended: yes — fast by default, verbose on request.)
