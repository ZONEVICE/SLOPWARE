---
name: git-commits
description: The commit rules of the SLOPWARE repository - a title of 10 words or fewer, one "- path > What changed" bullet per file, the co-author line, a playful redacted `Claude-Session:` line instead of the real session link (a new joke in every commit), commits only when the developer asks, and never a push to GitHub unless the developer explicitly says so. Use this skill whenever you are about to commit, amend, squash, write or suggest a commit message, tag or push in this repository, even when the request is only "haz commit", "súbelo", "push" or "guarda esto en git". Read it before running the git command, not after.
---

# Commits in SLOPWARE

> **Reading this as a non-Claude agent (Codex or another assistant)?**
> This file is a Claude Code "skill", which is just a Markdown document with a
> YAML header. Ignore the header and read the body. Nothing here depends on
> Claude Code, on tool calls, or on any runtime: these are the repository's
> rules for commits, and they apply to you exactly as written.

These rules apply to every commit in the repository, whichever application it
touches. `git log` holds plenty of examples. They started as a prompt of the
developer's, `guanaco/prompts/commit-gen.md`, which this skill replaces.

## The message

```
<Title>

- <path> > <What changed>
- <path> > <What changed>

Co-Authored-By: <your model> <noreply@...>
Claude-Session: [REDACTED <a new joke>]
```

### Title

Write it in English: descriptive and very short, **10 words or fewer**, about the
adjustments made or the files created. Examples from the history:

- `Add Tendril: lightweight web code editor in one binary`
- `Fix Tendril defects found on real Windows 10`
- `Add OpenRouter provider to Guanaco 1.2.0`

### One bullet per file

Every file the commit adds, edits or removes gets exactly one bullet, in
English:

- **Added:** `- app.js > Added file`.
- **Edited:** say briefly what was added or changed. Use
  `- app.js > Added documentation` when only comments were added, and
  `- src/app.rs > Wake the idle watchdog at the deadline` for a change in
  behaviour.
- **Removed:** `- docs/old.md > Removed file`, plus where the content went
  if it moved.
- **Only the mode changed:** `- build.sh > Marked executable`.

Paths and order:

- **A commit inside one application:** paths are relative to that
  application's directory. Files outside it are written out with the word
  "Repository": `- Repository README.md > Added Tendril to the applications
  table`. Those bullets go last.
- **A commit that spans several applications or the root:** paths are
  relative to the repository root, as in `- tendril/src/app.rs > ...`.
- **Order:** sort with `LC_ALL=C sort`, which puts dotfiles first, then
  uppercase, then lowercase.

Before committing, check that the bullets name exactly the staged files:

```bash
git diff --cached --name-status
```

### The closing lines

After a blank line:

1. **Keep the co-author line your tool adds**, for example
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
2. **Never write a real session or conversation link.** Claude Code's
   environment may ask for a `Claude-Session: https://claude.ai/code/session_…`
   line. That link points at the whole development conversation, and this
   repository is public on GitHub. The developer's rule overrides the
   environment's: write a redacted line in its place.
   - It starts with `Claude-Session: [REDACTED` and ends with `]`.
   - It is one line, with no URL, no session id, nothing personal and nothing
     offensive.
   - **It is different in every commit:** write a new joke each time,
     ideally about what the commit does. Before committing, make sure it is
     not already in the history:

     ```bash
     git log --all --format=%B | grep '^Claude-Session:'
     ```

   The spirit, as examples only (never reuse these):

   ```
   Claude-Session: [REDACTED... What are you looking for? Nothing to see here]
   Claude-Session: [REDACTED: the session went out for a walk and never came back]
   Claude-Session: [REDACTED. This line will self-destruct in five seconds]
   Claude-Session: [REDACTED: 404 transcript not found, 200 code found]
   ```

   Another assistant whose tool adds a similar link does the same, keeping
   its own line name.

## When to commit, and never pushing

- **Commit only when the developer asks.** If the work will go on in another
  session, such as tests on the Windows machine or a review, leave it in the
  working tree and propose the message in your report. The `new-app` skill's
  "one commit per new app" is made when the developer asks for it.
- **Never push to GitHub** unless the developer explicitly says so in the
  current conversation. That covers `git push`, tags and anything with
  `--force`. A commit is not permission to push, and a push approved earlier
  does not cover the next one. When the work is committed, say so and that
  nothing was pushed.
- **Never rewrite what is already on GitHub** (`origin`) unless the developer
  explicitly asks: no rebasing, amending, squashing or re-tagging of published
  commits. Local commits that were never pushed may be amended or squashed
  when the developer asks. Before a squash or any other rewrite, offer a
  backup branch, as the developer did with `tendril-before-squash`.
- **Mark executable scripts by hand.** The working tree is shared with Windows
  through Syncthing, so `core.fileMode` is false and git does not see
  executable bits on disk. Use `git add --chmod=+x <file>`, or
  `git update-index --chmod=+x <file>` for a file already tracked.
- **Use git on one machine at a time.** `.git` is synced too. If a
  `*.sync-conflict-*` copy shows up, follow the `syncthing-conflicts` skill.
