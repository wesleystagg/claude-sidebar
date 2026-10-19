# claude-sidebar

<!-- One or two sentences: what this is and who it's for. The audience matters more
     than the stack — it settles most close calls later. -->
A Claude Code plugin (function-hooks module) that docks a side panel showing
context, usage, tokens by model, and spawned agents. Built for the maintainer's own
sessions first; published so others can install it.

`README.md` is what exists. **This file is how we work.**

---

## Who this is for — it decides most arguments

<!-- Name the actual person. "Users" decides nothing; "a 78-year-old on an iPad who may
     not be well enough to do this twice" decides a lot. If there are two audiences
     (e.g. a buyer and an end user), say which one wins when they conflict. -->
The maintainer, running long multi-agent sessions and wanting to see the burn before
the usage window fills. Anyone else installing it comes second: a change that
makes the panel noisier for the daily driver is wrong even if it adds a feature.

## Working agreement

- **Ask before building anything non-trivial.** Comment a plan on the issue, set
  `feedback-wanted`, wait.
- **Mock 2–3 directions with real content** for design work rather than picking one.
- The maintainer is IT — detail-rich answers, root cause, file:line, real numbers. No
  simplified summaries.
- Concerns get raised once. If he reaffirms, that's the decision — proceed and say so.

## The issue loop

Work lives in GitHub issues, not in chat. Repo: `wesleystagg/claude-sidebar`.

- 🟡 `feedback-wanted` — waiting on the maintainer. Don't build it.
- 🟢 `feedback-given` — he replied. Ready to act.
- Comments post as the bot account; the account name and the `gh auth token -u <bot>` pattern live in the maintainer's private `~/.claude/docs/issue-queue.md`, not here.
- `/triage` runs a pass over open issues against the default branch.
- **Check for `feedback-given` issues when starting substantive work** — that's the
  queue, and nothing else surfaces it.

<!-- TODO: this project's own labels beyond bug/idea/ui/documentation. -->

## Git, PRs, and agents

The universal rules live in `~/.claude/CLAUDE.md` — never stack PRs, ~2 branches max in
flight, exclusive file ownership when parallelising agents, verify agent claims against
real data. **Don't duplicate them here.** This section is only for what differs.

- `hooks/register.tsx` is the whole plugin; only one writer at a time.
- Every change runs `claude plugin validate .` and `claude plugin test .`
  before it lands, and `hooks/register.test.tsx` grows with the behaviour.

## Docs rule

<!-- TODO: which files must be updated when a feature ships. If user-facing docs
     describe behaviour precisely, say so — that makes them testable copy, and they
     will drift into lying if nobody treats them that way. -->
`README.md` describes every section and command precisely; a change to what the
panel shows updates the README in the same commit.

## Architecture worth knowing before you dig

<!-- The expensive-to-rediscover things, not a file tour. Good candidates:
     - shared modules that MUST be reused (duplication that already caused a real bug)
     - anything deliberately built the harder way, and why, so nobody "simplifies" it
     - where authorization actually lives
     - schema/migration behaviour that bites (e.g. "re-applied on every deploy, so all
       DDL must be re-runnable")
     - a database or framework default that is a trap -->
- Built with the `plugin-authoring` skill's hooks API (early access; the types
  are written by the engine into `.claude-plugin/types/` on load, git-ignored).
- The validator is strict about shape: helpers that take `$` must be top-level
  function declarations; `turn.step` is a stream and its hook an async
  generator; matchers must be literals (no loops over `on(...)`).
- Drawing state lives in `$.state` atoms (survives hot reload); the on/off
  choice lives in `$.store` (survives restarts).
- Finished agent rows fade on a per-row `clock.after`; the minute tick also
  prunes, so rows settled on reload fade too.
- The engine reports no per-model rate-limit split and no other model's window
  size; both limits are stated in the README's "How it measures". The per-model
  USAGE row is a shim over `claude -p /usage` (polled every 5 minutes and on
  open, parsed in `parseModelUsage`) pending anthropics/claude-code#101847;
  drop it once the engine's `rateLimits` carries the split.

## Before any deploy

Nothing deploys. Publishing is a push to `main`; installs read the repo.
The maintainer's own machine installs from the local folder as marketplace
`claude-sidebar`, so a push is not needed for them to see a change (`/reload-plugins`).
