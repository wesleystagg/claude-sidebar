# Sending feedback on claude-sidebar

Everything — bugs, ideas, "this feels wrong" — goes in one place: **GitHub Issues** on
[wesleystagg/claude-sidebar](https://github.com/wesleystagg/claude-sidebar/issues).

You don't need a GitHub account to *read* them, but you do need one (free) to file.

## Filing

Press **New issue** and pick one of three forms:

| | For |
|---|---|
| 🐛 **Bug** | Something is broken or doesn't do what it should |
| 💡 **Idea** | Something new, or something that could work better |
| 🎨 **UI change** | How it looks, reads, or feels |

Fill in what you can. One sentence and a screenshot is a genuinely useful report — don't
save it up until you can write a long one.

**The most useful thing you can include is what you were actually trying to do**, not
just what went wrong. "I was trying to X and Y happened instead" is worth ten times a
bare error description, because it says what should have happened.

## The two labels that keep us in sync

Claude reads the issues, investigates against the current code, and comments with what
it found and what it proposes. It can't change anything by itself — the maintainer reviews
everything it builds.

- 🟡 **`feedback-wanted`** — a plan or question on the issue is waiting for a human
  opinion (usually yours). Read the latest comment and reply with your thoughts.
- 🟢 **`feedback-given`** — after you reply, swap the labels: remove `feedback-wanted`,
  add `feedback-given` (the Labels box is in the right-hand sidebar). That's the signal
  it's ready to be acted on.

If an issue has neither label, nobody is blocked — it's just queued.

## Who's who

Comments from **campcheck-claude** are Claude's, posted through a machine account so
it's always obvious which notes are automated and which are the maintainer's. It's the same
Claude that writes the code; the separate account exists so you can tell at a glance.

<!-- TODO per project: anything specific about how feedback reaches this repo —
     e.g. an in-app feedback widget that files issues directly (label them so they're
     distinguishable), a beta tester group, or a support address that gets triaged
     into issues by hand. Delete this comment once filled in or confirmed N/A. -->
