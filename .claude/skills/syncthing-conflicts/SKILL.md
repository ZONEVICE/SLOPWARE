---
name: syncthing-conflicts
description: How to handle a Syncthing conflict file (a file named like `<name>.sync-conflict-<date>-<time>-<device>.<ext>`) in the SLOPWARE repository - tell the developer, review the conflict, merge it keeping the most recent/coherent/working content, ask when unsure what to keep, and delete the conflict file once it is no longer needed. Use this skill whenever you see a `sync-conflict` file anywhere in the repository (in `git status`, a directory listing or a search), or when a file looks like it lost or reverted recent edits after a sync between the Windows and Linux machines. Read it before touching the file, not after.
---

# Resolving Syncthing conflict files

> **Reading this as a non-Claude agent (Codex or another assistant)?**
> This file is a Claude Code "skill", which is just a Markdown document with a
> YAML header. Ignore the header and read the body. Nothing here depends on
> Claude Code, on tool calls, or on any runtime: it is a procedure for this
> repository, and it applies to you exactly as written.

The working tree is shared between machines (Windows and Linux) with Syncthing.
When two machines change the same file before they have synced, Syncthing keeps
one version under the original name and writes the other beside it as
`<name>.sync-conflict-<date>-<time>-<device>.<ext>`, for example
`CLAUDE.sync-conflict-20261009-225223-3RORLDK.md`. Nothing merges them: until
someone does, edits can be silently lost or a stale version can stay in use.

These files are deliberately **not** ignored by Git, so they show up in
`git status` and can be found. Do not add `*.sync-conflict-*` to `.gitignore`: a
conflict that is hidden from `git status` is a conflict nobody resolves.

## Procedure

When you find one, anywhere in the repository:

1. **Tell the developer** that it exists, which file it belongs to, and that you
   are going to resolve it. Do this even when the fix looks trivial.
2. **Review the conflict.** Diff it against the file it conflicts with. Compare
   modification times and `git log` / `git diff` to see which side is newer and
   what each side was trying to do. Often one side is a stale copy that only
   carries a small intentional change; sometimes both sides hold real work.
3. **Resolve it** by merging the two into the original file. Keep the content
   that is the most recent, the most coherent and the one that works, and carry
   over anything intentional from the other side. Do not take a whole side
   blindly. If the file is code, check that it still builds and its tests pass
   (or at least that it parses, when the toolchain is unavailable) and say what
   you could not verify.
4. **Ask the developer when in doubt** about what to keep: two sides that
   disagree on behaviour, a rule or a decision, or changes you cannot tell apart
   as deliberate or stale. Do not guess; the cost of a wrong guess is a silent
   error.
5. **Delete the conflict file** once nothing in it is still needed, and tell the
   developer what was kept from each side. Never leave a resolved conflict file
   behind, and never commit one.

## Worked example

`reptile/CLAUDE.md` and `reptile/CLAUDE.sync-conflict-…md`: the conflict copy was
older (modified hours earlier on the Linux machine) and differed from the
original in two ways. The original had newer Windows-testing content (a "Known
gaps" section, updated test counts); the conflict copy had one intentional
addition (a rule to change both implementations together). The right merge was
the original plus that addition, with the section numbers it referred to fixed
for the renumbering, then deleting the conflict file. Taking either side whole
would have lost real work.
