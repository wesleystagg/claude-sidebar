# claude-sidebar

A docked side panel for [Claude Code](https://claude.com/claude-code) that keeps
the numbers you otherwise go looking for in one place: how full the context
window is and what fills it, how fast the rate-limit windows are burning, which
models this session has spent its tokens on, and every agent that was spawned,
on which model, with how full its own window is.

Toggle it with `/sidebar`.

```
MODEL  fable-5-1
effort max · plan
REPO   agency-os  main
~/Projects/agency-os

CONTEXT 42%  85k/200k
████████░░░░░░░░░░░░░░░▒▒▒▒▒
                    ▲ compact @ 83%
■ System prompt            12k
■ System tools              8k
■ Messages                 65k
░ Free space              82k
▒ Autocompact buffer      33k
compacted 1× · last 14 min ago

USAGE
5h ████░░░░░░░░░░░░░░   31.5%
   resets in 2h 5m · full in ~34m
7d ███████████░░░░░░░     60%
   resets in 3d

BY MODEL this session
fable-5-1      ██████████  1.2M
sonnet-5-5     ███░░░░░░░  300k
⌂ bigcoder                3 calls

AGENTS 1 running · 84k tok
● coder                      1m30s
  ⚠ frontier opus-5-5 · Build landing page
  ctx ██░░░░░░░░ 40k · 7 tools · Bash
✓ coder-quick                  12s
  haiku-5-5 · Fix typo in README

FILES main ↑1 · 3 changed
  ▸ docs                                   1
  ▾ hooks
  ◆ register.tsx                    M +41 −3
    register.test.tsx                  A +88
  ▸ node_modules
  ▾ types
  ◇ index.d.ts                             ↑
  README.md                          M +6 −1
```

## Install

In a Claude Code terminal session:

```
/plugin install sidebar --marketplace wesleystagg/claude-sidebar
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in
every session. Run `/sidebar` to open the panel. The choice is remembered, so
it comes back on its own next session; close it with `/sidebar off`, the
panel's close mark, or Escape while it holds the keys.

The panel docks beside the transcript in Claude Code's fullscreen layout
(`"tui": "fullscreen"` in settings, from 110 columns wide). On the plain
scrolling layout it seats inline above the prompt instead.

## What each section shows

**MODEL.** The session's model, shortened (`claude-fable-5-1` reads as
`fable-5-1`). Updates on `/model` and shows the model that actually answered
the last turn, so a fallback shows too. Under it, the reasoning effort and the
permission mode, with plan mode and accept-edits in their theme colors.

**REPO.** Repository folder, branch (read from `.git/HEAD`, worktrees
followed), and the working directory.

**CONTEXT.** The same breakdown as `/context`, in the same theme colors: a
stacked bar across the panel, one legend row per category with its token
count. Solid blocks are used content, hatched is the autocompact buffer, light
dots are free space. A ▲ marks the token count where auto-compaction fires;
the percentage turns amber from 90% of that point and red past it. Once the
conversation has been compacted, a line says how many times and how long ago.

**USAGE.** One bar per rate-limit window as `/usage` reports them, 5-hour in
orange, 7-day in blue, a gateway spend limit in yellow, with the reset time
counting down live. When the recent minutes' samples show a window filling
faster than it resets, a `full in ~Nm` estimate appears: amber under 30
minutes, red under 10.

**BY MODEL.** Tokens this session by the model that answered each request,
main loop and subagents alike, with bars scaled to the top model and colored
by tier (frontier orange, Sonnet blue, Haiku green). Local models reached
through the fleet tools show a call count instead. Resets with each session.

**AGENTS.** One row per delegated run: a subagent spawned through the Agent
tool, or a prompt sent to a local model through the `fleet` MCP tools or a
`cfn fleet ask` / `cfn node <name> ask` shell command. Each row shows the agent
type, elapsed time, the model it runs on and its task; a subagent row also
gets a small bar of its own context fill (its latest request's input side,
against the session model's window), its tool-call count and the tool it is
inside right now. Status drives the color: yellow dot running, green tick
done, red cross failed. A subagent on a frontier-tier model (Fable, Opus,
Mythos) is flagged `⚠ frontier`. Finished rows fade two minutes after they
end; the header keeps the session's total burn across all runs.

**FILES.** The working directory as a pruned tree, at the bottom of the
panel. Folders open (`▾`) only where a file needs your eye; every other folder
is one collapsed row (`▸`) with the number of files inside it at the right.
A file is flagged when it has a git change, is committed but not pushed, or
the session is touching it. Each row is coloured text plus a one-character
mark, with no background colours:

- `◆` (orange) the session is writing the file; `◇` (purple) it is reading
  it. The mark appears when the Read, Write, Edit or NotebookEdit call
  starts, so it shows while the tool runs, and fades 45 seconds after the
  last event. Subagents' calls count too. A write mark replaces a read mark,
  and a later read does not downgrade a live write mark.
- The letter at the right is git's state: `M` modified, `A` added, `D`
  deleted, `R` renamed, `C` copied, `?` untracked, followed by `+added −deleted`
  lines (staged and unstaged summed). An unstaged change shows over a staged
  one. `↑` alone marks a clean file that is committed but not yet pushed.
- The name and letter take the state colour: orange for a write, purple for
  a read, red deleted, green staged, amber unstaged, blue unpushed, dim for
  untracked and ignored, plain otherwise.
- Gitignored entries are shown, dim, not hidden. A fully ignored folder is
  one collapsed dim row with no count; an untracked folder is one collapsed
  row marked `?`.
- Folders sort before files, each case-insensitive alphabetical. The tree
  draws at most 40 rows and ends with a dim `… N more`.

The header shows `FILES`, the branch, `↑N` when commits are unpushed, `↓N`
when the upstream is ahead, and `· N changed` (untracked included, ignored
excluded) or `· clean`. Outside a git repository it reads `not a git repo`
and lists the top level of the working directory, folders collapsed.

## How it measures

Everything comes from the Claude Code plugin API, with no extra API calls:

- Context figures use the engine's local estimate (`breakdown: "summary"`),
  so they can differ slightly from `/context`, which counts with the
  token-count API.
- Rate-limit figures are whatever the last API reply reported. The panel
  samples them once a minute while open for the burn rate; the percentages
  themselves only move when a reply arrives.
- Per-agent and per-model figures come from each request's reported usage.
  Agent context bars are scaled to the session model's window, since the
  engine does not report another model's window size; the token figure
  beside the bar is exact.
- FILES state comes from git itself (`status`, `ls-files`, `diff --numstat`
  and `diff --name-only @{upstream}..HEAD`), run through the engine with
  repo hooks off. It is refreshed after Write, Edit, NotebookEdit and Bash
  calls, on each prompt and once a minute. There is no file watcher, so an
  edit from another terminal shows at the next refresh. Refreshes closer than
  a second apart are folded into one.
- Workflow agents and cloud-remote agents raise no local events and are not
  tracked.

## Commands

| Command | Effect |
| --- | --- |
| `/sidebar` | Toggle the panel |
| `/sidebar on` / `/sidebar off` | Set it explicitly |

## Development

The plugin is a single hooks module, `hooks/register.tsx`, with its state
contract in `types/index.d.ts` and a test beside it.

```bash
claude plugin validate .   # manifest, marketplace file and hooks module
claude plugin test .       # runs hooks/register.test.tsx against the engine
```

To run a working copy in a session without installing it:

```bash
claude --plugin-dir ~/Projects/claude-sidebar
```

Edits to an installed-from-folder copy reach a session with
`/reload-plugins`.

## License

MIT.
