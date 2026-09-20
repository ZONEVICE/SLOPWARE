# Frisbee

Read [`AGENTS.md`](AGENTS.md) in this directory before changing anything. It is
the single maintenance guide for every coding assistant working on Frisbee, and
this file only exists so that assistants looking for `CLAUDE.md` find it.

Quick reminders that `AGENTS.md` explains in full:

- Talk to the user in Spanish; write code, comments, and UI text in English.
- Standard-library Python only, compatible with Python 2.7 and Python 3.
  `python app.py` must remain the whole application.
- Filesystem logic lives in `frisbee_core/storage.py` and `frisbee_core/jobs.py`;
  HTTP lives in `frisbee_core/server.py`. Keep the two apart.
- Run `python -m unittest discover -s tests -v` (42 tests) after any change
  under `frisbee_core/`.
