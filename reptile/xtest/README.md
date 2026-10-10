# xtest: cross-machine interoperability testing

What was used to test Reptile 1.1.0 on a real Windows 10 PC against a Linux
PC on the same LAN, kept so the same exercise can be repeated when features are
added. Nothing here is part of the product, and nothing here is needed to build
or run it.

```
reptile-xtest.py        the helper (Python 3.8+, standard library only)
playbook/               the instructions given to the AI session on the other
                        machine, and the checklist and form for this side
windows-1.1.0/          what that exercise produced
  report.es.md          the report: environment, results, findings, fixes
  changes.es.md         the fixes made during the exercise, one by one
  results/              raw evidence: test runs, scenario results, states
```

The documents under `playbook/` and `windows-1.1.0/` ending in `.es.md` are
kept verbatim, in Spanish, as a record of those sessions (like
`../prompts/init.md`). They use paths and names of that exercise
(`reptile-xtest.py` and the instructions at the repository root, a `scratch`
directory, `resultados-windows`): adjust them when reusing the playbook.

## `reptile-xtest.py`

Run a copy on each machine. It builds a deterministic test tree, makes a
scripted series of changes in it, and verifies that the other machine ended up
with exactly the same content. The verification travels through Reptile
itself: whoever makes the changes writes the expected result (a SHA-256 per
file) as the last file of the synchronised directory, so it reaches the other
side by the very synchronisation being tested.

| Command | Does |
| --- | --- |
| `populate DIR` | creates the tree (`r1/`, `r2/`; `--hostile` adds names only Linux can hold) |
| `churn DIR -r N` | create, edit, rename, move, delete, replace, a 16 MB file, a burst of 100 files; then writes the expected digest |
| `converge DIR -r N` | waits for the other side's digest, then compares real content byte for byte |
| `api URL METHOD PATH [JSON\|@file]` | calls an instance's HTTP API |
| `wait URL KEY VALUE` | waits for a field of `GET /api/state` (e.g. `syncing.state live`) |
| `agent` / `remote` | a small token-protected HTTP agent that lets one machine run the commands above on the other, and measures clock skew |

Run it with `--help` for the details. The agent listens on every interface and
writes where it is told: run it only on a trusted LAN, for the length of a test.
