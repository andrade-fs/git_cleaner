# GitKraken, analysed — and what of it belongs in a terminal tool

Research note. Sources: gitkraken.com (desktop, CLI, pricing), help.gitkraken.com and the `gk-cli`
docs, read in November 2026. Prices and tiers change; the shape of the product is what matters here.

---

## 1. What GitKraken actually ships

Not one product. Five, sold as a DevEx platform:

| Product | What it is | Where the money is |
|---|---|---|
| **GitKraken Desktop** | Electron GUI: commit graph, diff/blame/history, merge conflict tool with AI auto-resolution, interactive rebase, worktrees, agent sessions, Launchpad, CODEmaps, Automations, Security controls, self-hosted | per seat, Pro → Enterprise |
| **GitLens** | The same history/blame/Launchpad intelligence inside VS Code, Cursor, Windsurf, Trae, Kiro | per seat, gated |
| **GitKraken CLI (`gk`)** | Terminal client: Work Items across multi-repo workspaces, `gk graph`, PRs and issues from GitHub/GitLab/Bitbucket/Jira, AI commit + PR messages, MCP server, `gh gk` extension with a "Focus view" | free tier needs cloud auth; PR/issue tools are Pro+ |
| **Kepler** | Agentic dev environment: spawn parallel coding agents per worktree, track them in one view | new headline product |
| **Insights** | Engineering metrics (delivery, cycle time, review load) for team leads | enterprise |

The 2026 headline is not git anymore. The Desktop page opens with *"Launch and manage parallel
coding agents from a single surface"* — Claude Code, Codex, Copilot, Cursor, OpenCode, Gemini CLI.
Git is now the substrate under agent orchestration.

Pricing ladder: **Community** (free: local repos + public remotes, desktop + CLI + GitLens) →
**Pro** (private repos, all the useful cloud) → **Advanced** → **Business** → **Enterprise**.
AI requires a paid plan. The CLI's good parts require `gk auth login` and an organization.

## 2. Feature surface, one level down

Local git: commit graph, diff (side by side + hunk staging), file blame, file history, branch
create/checkout/merge/rebase, cherry-pick, revert, reset, stash, tags, worktrees, submodules, merge
conflict resolution (3-pane + AI suggestions with confidence levels), interactive rebase.

Remote/forge: pull requests (create, review, comment, approve), issues, CI status, Launchpad (a
triage dashboard: your PRs, review requests, recent work), Jira integration, multi-provider auth.

Team/platform: workspaces (local + cloud, clone a whole workspace), Work Items (one task across N
repos), Insights (DORA-ish metrics), Automations, audit/security controls, self-hosted server.

AI: commit messages, PR descriptions, conflict resolution, agent sessions, MCP tools, CODEmaps
(visual map of the codebase).

## 3. Can we replicate it?

Wrong question, asked honestly: **no, and it would be a bad trade**. Two of the five products are
GUI shells around git, one is an IDE extension, one is a SaaS metrics pipeline, and the newest one
is an agent orchestrator. That is a company, not a feature list.

The right question: *which layer of that surface is unserved in the terminal, and cheap for us?*

### Cost matrix for a zero-dependency TUI

| Layer | GitKraken equivalent | Verdict | Effort |
|---|---|---|---|
| Branch policy, stale detection, safe deletion, leak policy | nothing comparable (they don't do policy) | **already ours, keep as the core** | done |
| Commit graph with lanes | Desktop's Commit Graph / `gk graph` | **yes**, this is the one visual worth owning | M |
| Diff + hunk staging + commit | Desktop diff view | yes, but `git add -p` and lazygit/gitui exist | M |
| Multi-repo dashboard | Workspaces (needs cloud auth for the good part) | **yes**, local manifest, no auth | S |
| PR / issue / CI triage | Launchpad (Pro+, needs auth) | **yes**, via `gh`/`glab` when already authenticated | S–M |
| Conflict navigator (list + 3-pane, no editor) | merge tool + AI | partial: navigate and pick a side, don't build an editor | S |
| Interactive rebase | Desktop rebase UI | no: `git rebase -i` with `sequence.editor` is fine | — |
| Blame / file history | GitLens | no: `git blame` + `git log --follow` in a pager | — |
| Merge editor with AI | core Desktop feature | no: it is a product (and AI conflict resolution is Hermes' job) | XL |
| Insights / DORA | SaaS | maybe later: branch lifetime and time-to-merge approximate from git + `gh` | M |
| Agent sessions, CODEmaps, MCP, Jira sync, self-hosted | Kepler / platform | no: different product, and Hermes already orchestrates agents | XL |

### Where we actually win

1. **Policy is not their problem.** GitKraken shows you the graph; it does not tell you that 119 of
   your 186 branches are abandoned, that `.env` is tracked, or that a branch holds a secret. Our
   `reason` codes, backup refs and leak policy have no equivalent in that product line.
2. **No account.** `gk` needs `gk auth login` for anything interesting; the free tier is local +
   public remotes. A global npm package that works offline, with zero deps, is a different buyer.
3. **Composability.** `--json` + exit codes + `doctor` fit CI; a GUI product sells per seat.
4. **Terminal-native.** The people who would use our tool already live in tmux; opening an Electron
   app to delete branches is a downgrade.

## 4. What I would build, in order

**A. `topiary status` — multi-repo dashboard (S).**
A local workspace file (`~/.config/topiary/workspaces.json`) listing repo paths, and a table:
repo · branch · dirty · ahead/behind · last commit age · candidates for cleanup · leak count.
`--json` for scripts. This is GitKraken Workspaces without the cloud, and it is the cheapest thing
that changes daily behaviour when you have ten repos open.

**B. `topiary log` — commit graph in the TUI (M).**
Lanes painted with box-drawing characters, branch/tag labels in colour, `⏎` opens the diff of a
commit, `b` branches from that commit, `d` opens the delete flow. Reuses the analysis we already
have (ahead/behind, merged state) so the graph can annotate "stale" per lane — something the GUI
does not do.

**C. `topiary pr` — Launchpad-lite via `gh` (S–M).**
My open PRs, review requests, CI status, mergeable state; `--check` fails the build when a PR of
mine is stale or red. One `gh` call per list, already normalised by the provider adapter.

**D. `topiary conflicts` — navigator, not editor (S).**
List conflicted files with a 3-pane preview and `ours` / `theirs` / `skip` keys, then `git add`.
No AI, no editor: the 20% that unblocks a rebase at 2am.

**E. `topiary insights` — only if a team asks (M).**
Branch lifetime percentiles, review latency from `gh`, cleanup trend over time, from local data.
This is where the SaaS charges; from git alone we can approximate two of their four metrics.

### Explicit non-goals

GUI, Electron, OAuth flows per provider, AI commit messages (Hermes does it better), CODEmaps,
Jira sync, self-hosted server, agent orchestration, merge editor, interactive rebase UI.
Every one of those is a product line, and building them half-way would dilute the one thing that is
actually differentiated: a policy engine you can trust with a destructive action.

## 5. Shape of the answer

If the goal is "a nicer way to look at git", the answer is `lazygit` + `git gud`, both mature.
If the goal is "GitKraken, but in my terminal", the honest scope is **three commands** (status, log,
pr) that reuse the analysis, config and provider plumbing already in the repository — roughly a
week of work for the three, versus a company for the rest.

The bet worth making: stay the **hygiene and safety** tool, and borrow only the parts of the GUI
that make the state legible (a graph) and the state *actionable* (a multi-repo board).
