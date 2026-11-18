# Topiary

**Policy-driven git hygiene.** It tells you which branches are garbage, proves why, deletes them
safely, and can put them back. It also shapes the branch tree instead of guessing.

```bash
npm i -g bitpry
topiary               # TUI, no arguments needed
bitpry plan           # same binary, shorter name
```

Zero runtime dependencies. Node 18+. Available as `topiary`, `bitpry`, and the legacy aliases
`git cleaner` / `gcl`.

```
╭─ ◆ TOPIARY ───────────────────────────────────────────────────── v0.2.0 ─╮
│  branch hygiene · leak policy · safe deletes                                 │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  repo      my-repo                        head      main                    │
│  remote    origin · github.com            default   origin/main              │
│  branches  186                            policy    repo → local             │
╰────────────────────────────────────────────────────────────── by @bitsentry ─╯

  ◆ 12 candidates · 186 branches analysed · 174 left alone · threshold 30d
    left alone  118 not merged · 26 too recent · 4 name pattern · 2 open PR

  BRANCH                          AUTHOR             AGE  AHEAD  MERGED
  feature/OVAC-4334               Alex Gonzalez      45d      0  yes
  fix/OVAC-4559                   Alex Gonzalez      52d      0  yes
  featuer/OVAC-4351               Alex Gonzalez      75d      0  yes
```

## Why another branch cleaner

`git push origin --delete` already exists. What was missing is **deciding safely**:

1. **Identity by email, not by display name.** In a real repo of 186 branches we found the same
   person as `Santiago Andrade` (49 branches), `andrade-fs` (6) and `Santi AF` (3). An allow/deny
   list keyed on the commit author **name** silently misses ~15% of a person's branches.
2. **A policy file, not a `.env` in the cwd.** Layers: global → repo → personal → env → flags, each
   option traceable with `config --explain`.
3. **Reversibility.** Every deletion writes `refs/gitcleaner/<id>/<branch>` first, and
   `restore --id <id>` puts it back. No backup, no big red button.
4. **Secrets get their own policy.** Not a gitleaks clone: the tool knows *your* repo must never
   track `.env*`, and delegates the scanning to gitleaks when it is installed.

## Install

```bash
npm i -g @bitsentry/topiary    # global, both bins
npx @bitsentry/topiary plan    # or without installing
```

## Prerequisites

**None.** `npm i -g` installs one package with no runtime dependencies: the branch policy, the leak
policy layer, custom rules and everything else work with nothing else installed. Three optional
binaries add coverage, and the tool **never installs them for you**:

| Tool | Buys you | Install |
|---|---|---|
| `gitleaks` | 300+ secret formats and history scanning | `brew install gitleaks` |
| `opengrep` | AST / SAST rules via `leaks.sast` | [releases](https://github.com/opengrep/opengrep/releases) (no brew, no PyPI) |
| `gh` | open-PR protection and PR-aware cleanup | `brew install gh` |

Why not a `postinstall` script that fetches them? An npm package that downloads 20–40 MB binaries at
install time is a supply-chain risk: no pinned checksums, a platform matrix to maintain, and it
breaks in CI behind a proxy. The npm packages published under those names are third-party wrappers,
not the real tools, so there is nothing trustworthy to depend on.

Instead the tool answers the question for you:

```bash
topiary doctor           # what is installed, what is missing, and the exact command
topiary doctor --strict  # exit 1 if an optional engine is missing (CI gate)
```

```
  STATUS    CHECK         DETAIL
            RUNTIME
  ok        node          v22.16.0
  ok        git           2.54.0
            LEAK ENGINES
  missing   gitleaks      policy layer still runs; secret formats and history are not scanned
  optional  opengrep      static analysis (SAST) is off by default
  optional  gh            open-PR protection needs it (protect.openMR)

  install gitleaks  brew install gitleaks
  install opengrep  download the release: https://github.com/opengrep/opengrep/releases
  install gh        brew install gh
```

And it no longer hides the gap: `leaks` prints the install line when gitleaks is absent, and
`leaks.requireEngine: true` makes `--check` fail (exit `3`) instead of reporting a clean repo that
was never fully scanned.

## Quick start

```bash
git cleaner                 # interactive TUI
topiary plan            # what would be deleted, and why
topiary plan --explain  # every branch, every decision
topiary delete          # plan + confirm + backup + delete
topiary restore --list  # snapshots
topiary restore --id 20261118T143000Z
topiary leaks           # secret + sensitive-file policy
topiary users           # authors with emails, ready to paste into config
topiary doctor          # node, git and the optional leak engines
```

Non-interactive runs refuse to delete without `--yes`:

```bash
topiary delete --yes --merged only      # merged into the default branch
topiary delete --yes --mode all --exclude bot@ci.example.com
```

## The TUI

No arguments opens a full-screen menu: analyse, multi-select cleanup (with checkboxes and an
"include unmerged" variant), restore, leak scan, authors and settings. `↑↓` moves, `space` toggles,
`a`/`n`/`i` select all/none/invert, `⏎` confirms, `q` quits. Everything you can do in the TUI has a
flag, so it is scriptable too.

### Settings without touching a file

`git cleaner` → **Settings** edits the policy in place: who is in scope (`mine` / `allowlist` /
`denylist` / `all`), the allow and deny lists, minimum age, merge state, max commits ahead, protected
branches and authors, backup, the unmerged guard, the leak scanner and its threshold, even the list
of sensitive path patterns.

**You pick, you don't type.** Authors are detected from the branch history: the allow / deny /
protected rows open a checklist of the identities found in the repo, with branch counts, the names
they commit under and a `· you` marker on your own email. `space` toggles, `a`/`n` all/none,
`A` adds an email by hand (for a contractor or a bot with no branches yet), `x` removes a manual one.
Common numbers are presets (`7 / 14 / 30 / 60 / 90 / 180 / 365` days, plus `custom…`), and enums show
what each option means instead of a bare word.

Two things happen for you:

- Picking authors under `mode: mine` **switches the mode to `allowlist`** and tells you, because the
  selection would otherwise be ignored.
- Every row shows **where its value comes from** (`defaults`, `repo`, `local`, `global`, `env`,
  `flags`) or `unsaved` the moment you change it.
- The footer recomputes the impact live: `◆ 3 candidates (was 2) · 2 overrides`.
- `s` saves, `r` clears the overrides, `t` switches the target between the **repo** file (team,
  committed), the **local** file (personal, gitignored) and the **global** file (all repos). Only the
  keys you actually touched are written — never the whole defaults blob.
- Saving reloads the config in place, so the menu and the cleanup list reflect it immediately.

For scripts and CI, the same values come from `topiary config --explain` and the usual flags.

## Protection model

Protection is a **veto**, evaluated before any other rule, in this order:

| # | Rule | Reason code |
|---|------|-------------|
| 1 | default branch (`origin/HEAD`, else `main`, `master`, `develop`, `trunk`) | `protected:default` |
| 2 | `protect.branches` glob or `protect.patterns` regex | `protected:pattern` |
| 3 | `protect.users` — the author is untouchable | `protected:user` |
| 4 | open pull request (via `gh`, GitHub remotes) | `protected:open-pr` |
| 5 | branch checked out or used by a worktree | `protected:head` / `protected:worktree` |
| 6 | `targets.exclude` — out of scope | `skip:excluded-user` |
| 7 | `targets.mode` scope (`mine` / `allowlist` / `denylist` / `all`) | `skip:not-target` |
| 8 | `rules.merged`, `rules.minAgeDays`, `rules.maxAhead` | `skip:merged`, `skip:too-recent`, `skip:ahead` |
| 9 | `safety.protectUnmerged` (needs `--allow-unmerged` to widen) | `skip:unmerged` |

Default protected branches: `main master dev develop version/* release/* staging prod trunk`.

## Safety model

- **Backup refs.** Before deleting, each branch tip is written to
  `refs/gitcleaner/<snapshot>/<branch>` inside the repo. No objects are copied, it is free.
- **Restore.** `restore --id <snapshot>` re-pushes those refs, individually or with `--branch`.
- **Lease.** Remote deletions use `--force-with-lease=<ref>:<sha>`: if somebody pushed to a branch
  between the analysis and the delete, that branch is **refused**, not silently removed.
- **Verification.** After deleting, refs are re-checked with `ls-remote`; anything still alive is
  reported and the exit code is non-zero.
- **Audit log.** `~/.local/state/topiary/<repo>/audit.jsonl` records who deleted what, when,
  with which snapshot.
- **No TTY, no deletion.** Without a terminal, `delete` exits `2` unless you pass `--yes`.

## Configuration

Layers, lowest to highest precedence:

```
1. built-in defaults
2. ~/.config/topiary/config.json          (XDG_CONFIG_HOME respected)
3. <repo>/.git-cleaner.json                   (team policy, commit it)
4. <repo>/.git-cleaner.local.json             (personal, gitignore it)
5. <repo>/.env                                (legacy, migrated automatically)
6. GIT_CLEANER_* environment variables        (CI)
7. CLI flags
```

Arrays are unioned across layers, scalars are overridden, and `extends` lets one file inherit from
another. `topiary config --explain` prints every resolved option **with the layer that set it**;
`config --path` lists the files that were loaded; `config --init` writes a starter file.

```json
{
  "$schema": "https://raw.githubusercontent.com/andrade-fs/git_cleaner/main/schema.json",
  "targets": {
    "mode": "allowlist",
    "users": ["me@company.com", "team-lead@company.com"],
    "exclude": ["contractor@company.com"]
  },
  "protect": {
    "branches": ["main", "master", "dev", "version/*", "release/*"],
    "users": [{ "email": "ci@company.com", "reason": "bot branches" }],
    "openMR": true
  },
  "rules": { "minAgeDays": 30, "merged": "only", "maxAhead": null },
  "safety": { "backup": true, "protectUnmerged": true }
}
```

The published [schema.json](schema.json) gives autocomplete and validation in your editor.
An unknown key is a warning; a wrong type is an error that names the option and the file.

### Users, the two ways

| Intent | Config |
|--------|--------|
| Clean **only** my branches | `targets.mode: "mine"` (default, uses your `git config user.email`) |
| Clean everyone **except** Alice | `targets.mode: "all"`, `targets.exclude: ["alice@…"]` |
| Clean only these three devs | `targets.mode: "allowlist"`, `targets.users: [a, b, c]` |
| Never touch CI bot branches | `protect.users: [{ "email": "ci@…" }]` — a veto in every mode |

`topiary users` prints the authors with their emails and the names they use, so the config is
written from data instead of from memory.

## Leaks

Three layers, one report:

- **Policy (built-in, deterministic).** Sensitive files that are *tracked*, files that are tracked
  even though `.gitignore` excludes them, sensitive files that exist on disk **untracked and not
  ignored** (one `git add -A` away from a leak), and tracked junk.
- **Team rules (`leaks.rules`).** Your own patterns: regex + optional entropy + path filters +
  severity. This is the deliberate 80% of a rule engine — no AST, no language grammars — for the
  things only your team knows: `acme_[A-Za-z0-9]{32}`, "no fixtures with real keys", "our internal
  headers look like this".
- **Engines (delegated).** `gitleaks` for secrets over history and `opengrep`/`semgrep` for AST-based
  SAST, when present. We normalize their JSON into one finding shape, redact it, baseline it, and
  turn it into an exit code. We do not reimplement them.

```bash
topiary leaks              # report
topiary leaks --view       # full-screen browser: code frame + actions
topiary leaks --branch feat/x  # that branch's tree + history, no checkout
topiary leaks --check      # CI: exit 3 at or above leaks.failOn
topiary leaks --fix        # git rm --cached + append to .gitignore
topiary leaks --no-history # worktree/junk only, fastest
topiary leaks --sast       # also run opengrep (needs a rule file)
topiary leaks --selftest   # prove it works on this machine
```

### The viewer, and where the secret is allowed to exist

`leaks --view` opens the same chrome as the commit graph: findings on the left, and on the right a
**frame of real source around the finding** with the offending line marked, plus the rule, the key
and the one-line fix. `h` masks the key when you share your screen; `f` fixes the file, `b` accepts
it into the baseline, `r` re-scans.

The raw key is only ever rendered here, in a process attached to your terminal. `scanLeaks()` takes
`withSecrets: true` **only** for the viewer — reports, `--json`, `--check` and the baseline run
without it, so the friction of leaking a secret into a Jira ticket or a CI log stays in the code, not
in the discipline of whoever runs the command. The gitleaks adapter streams its JSON report to stdout
instead of writing a temp file, so no secret-bearing artifact is created at all.

### Scope: which branch, which history

By default the policy and the team rules read the **working tree**, while gitleaks reads the
**history of every ref** — two different questions answered in one report. `--branch <ref>` makes both
halves describe that ref: files are listed with `git ls-tree` and read with `git show ref:path`, so a
feature branch can be audited **without checking it out**, and the summary always says which scope
produced the findings. The commit graph passes the branch under the cursor, so selecting a branch and
pressing `Leaks` answers "what does this branch carry". Rules that only make sense in a checkout
(tracked-but-ignored, ignore gaps) are skipped for a ref instead of lying about it.

### Prove it works before you trust it

`--selftest` builds a throwaway repo, plants **one canary per detection path** (a tracked `.env`, a
tracked-but-ignored file, a sensitive file with no ignore rule, a custom-rule token, a live-looking
token for the engine, an `eval()` for the SAST engine) and reports which checks fired. It needs no
git repo, touches nothing, and exits `1` if any path is broken.

```
  STATUS  CHECK                     DETAIL
  ✔       tracked sensitive file    .env should be reported as tracked
  ✔       tracked but ignored       old.env is tracked even though .gitignore exc…
  ✔       gitignore gap             id_rsa sits on disk untracked and not ignored
  ✔       custom rule (regex)       matched at src-token.js:1
  ✔       redaction                 no raw secret may appear in the report
  ✔       secret engine (gitleaks)  generic-api-key at src-token.js
  ✔       sast engine (opengrep)    no-eval at app.js:1
  ✔       severity model            worst severity seen: critical
```

### Custom rules

```json
{
  "leaks": {
    "rules": [
      {
        "id": "acme-token",
        "description": "Acme internal token",
        "pattern": "acme_[A-Za-z0-9]{32}",
        "severity": "critical",
        "entropy": 3.5,
        "paths": { "include": ["src/**", "infra/**"], "exclude": ["**/*.test.js"] }
      }
    ],
    "sast": { "enabled": true, "engine": "opengrep", "config": ".opengrep.yml" }
  }
}
```

Rules scan **tracked files** (1 MB cap, binary skipped, 20 hits per file) so the cost stays
predictable. History scanning is gitleaks' job.

### Why not make opengrep the core?

Because it is a different product. Opengrep/Semgrep is AST-based SAST: language grammars, taint
tracking, a large rule ecosystem — and its own install, config and false-positive profile. A git
hygiene CLI that grew an AST engine would be worse at both jobs. The useful slice is what shipped:
delegate the engine when the user already has it, and keep a small regex+entropy rule format for the
policy only the team can write. `--selftest` covers both, so the delegation is verified, not assumed.

Secrets are **always redacted** (`AKIA…(20 chars)`) — the report ends up in tickets and CI logs.
Accepted findings go to `.git-cleaner/leaks-baseline.json` with a justification and an expiry date.
The tool never rewrites history: it prints what to rotate and what to run.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | done |
| `1` | error (bad config, git failure, partial deletion) |
| `2` | nothing to do |
| `3` | `leaks --check` found findings at or above the threshold |

## CI recipes

```yaml
- name: branch hygiene
  run: npx @bitsentry/topiary plan --json > plan.json
- name: no leaked secrets
  run: npx @bitsentry/topiary leaks --check
- name: nightly cleanup
  run: npx @bitsentry/topiary delete --yes --merged only --min-age 30
  env:
    GIT_CLEANER_MODE: all
    GIT_CLEANER_EXCLUDE: ci@company.com
```

## Migrating from the old `.env` script

The previous contract still works: `TARGET_USERS`, `EXCLUDE_USERS`, `PROTECTED_BRANCHES` and
`GIT_PATH` are read from `<repo>/.env`, mapped onto the new model, and reported with a deprecation
warning. Move them to `.git-cleaner.json` when convenient.

## Development

```bash
npm test     # node:test, real fixture repos in temp dirs, no network
```

The suite covers the policy matrix, delete + restore round-trips, leak policy, config layering and
the TUI key handling. Design notes and the roadmap live in [docs/BRAINSTORM.md](docs/BRAINSTORM.md).

## License

MIT
