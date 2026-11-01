# Session protocol

The entry point for any new session. Read this first, then the most recent session
doc in this directory. If the two disagree, the session doc wins on state and this
file wins on process.

## Where things live

| Path | Role |
|---|---|
| `docs/plan.md` | Design of record: decisions, measured numbers, verification log |
| `docs/ideas.md` | Original brainstorm. Historical input, not a spec |
| `docs/sessions/NN-<slug>.md` | One per session: what was done, what was verified, what is next |
| `.omp/RULES.md` | Standing rules: roles, commit policy, delegation, evidence |
| `AGENTS.md` | Project background and orientation |

Session docs are numbered, contiguous, and never edited after the fact. Only the
`Next` section of the newest one may be superseded, and only by the next doc.

## Start of session

Run these before writing code. Each is a command or a read; none is optional.

1. **Orient on state.**
   ```bash
   git log --oneline -15
   git status --short
   ```
   An empty status output means clean. If the tree is dirty, decide before anything
   else whether that work is yours to continue, yours to discard, or the previous
   session's unfinished work — and write the answer in the new session doc.

2. **Read the latest session doc.**
   ```bash
   ls docs/sessions/[0-9]*.md | sort | tail -1
   ```
   Read that file. The `Next` section is the task queue. The glob matters: a bare
   `ls docs/sessions/` sorts `README.md` and `TEMPLATE.md` after the numbered docs and
   will point you at the wrong file.

3. **Check for stale docs.** `docs/` must not contradict reality. Verify at least:
   - the plan's `Open items` and `Milestones` still describe what is undone;
   - measured numbers quoted in `plan.md` match the session doc that produced them;
   - anything the last session marked "next" is not already implemented on disk.

   The check that catches the most drift:
   ```bash
   git log --oneline --stat -10 -- docs/     # skip while the repo has no commits
   ```
   If code changed in a session but `plan.md` did not, either the change was
   incidental (say so) or the doc is stale (fix it now). Exit code 128 here means the
   repository has no commits yet, not that something is wrong.

4. **Verify the environment.** Cheap, and it prevents an hour lost to a wrong host.
   ```bash
   git branch --show-current                # expected: master
   node --version                          # expected: 24.x
   curl -sS -m 5 http://127.0.0.1:11434/api/version
   curl -sS -m 5 http://192.168.40.247:8080/v1/models | head -c 200
   ```
   Use `git branch --show-current`, not `git rev-parse --abbrev-ref HEAD`: the latter
   exits non-zero on a repository with no commits. Both model endpoints are optional —
   record which were reachable and which arms are therefore available this session.

5. **Re-run the acceptance test for what already exists.** Do not start new work on a
   base you have not seen work this session:
   ```bash
   npm test        # once package.json exists
   ```
   If it fails, that failure is the session's first task, not a footnote. While the
   repository has no code, this step is vacuous — record that, do not skip silently.

6. **Create the session doc** from `docs/sessions/TEMPLATE.md` before the first edit.
   A session that starts without one tends to end without one.

## End of session

Do not close a session with work in an unknown state.

1. **Run what you changed.** Exercise the changed path and paste the real output
   into the session doc. Tests alone are not proof for a behavioural change.
2. **Update `docs/plan.md`** if a decision, number, or risk changed. Rewrite in place.
3. **Write the session doc**: what was attempted, what worked, what failed, what was
   verified and how, and the `Next` queue in priority order.
4. **Re-check for stale docs.** Grep the plan for anything you just invalidated:
   ```bash
   grep -n "TODO\|TBD\|FIXME" docs/plan.md
   grep -nE "[0-9]+(\.[0-9]+)? ?(ms|KB|MB|wall-min|tokens|×)" docs/plan.md
   ```
   The second command is not a pass/fail gate — it lists the ~40 lines carrying
   measured numbers, so you re-read each one and confirm it is still true. Every number
   must be one you would defend this session.
5. **Commit if the rules allow it.** See `.omp/RULES.md` → Committing. The session doc
   states whether you committed and which commits carry the session's work; name them
   by short subject, not by hash, because a hash cannot be recorded inside the commit
   that creates it. `git log --oneline` resolves the subject to a hash.
6. **Never push.** The user pushes.

## What "no stale docs" means concretely

A doc is stale when any of these is true:

- it presents as existing a file, package, or command that does not exist (a planned
  path is fine only when the surrounding text says it is planned — check the tense);
- it quotes a measurement the current code no longer produces;
- it lists a decision as open that the code has already made (in either direction);
- it names a default (model, port, path, budget) that the config no longer uses;
- two docs disagree and neither says which supersedes the other.

Staleness is not a formatting concern. In this project the docs carry the
experimental design and the measured evidence, so a stale doc is a wrong result
waiting to be reported.

## Session doc numbering

`docs/sessions/README.md` is this file's companion and holds the index:

| # | Date | Slug | Outcome |
|---|---|---|---|
| 01 | 2026-10-31 | research-and-plan | plan written; provider layer and M0 replay verified |
| 02 | 2026-11-01 | bootstrap | workspace, contracts, world config; no world behaviour yet |
| 03 | 2026-11-01 | sim-and-live-run | sim core, M0 replay, HTTP, agents, orchestrator; live 3-model run |

Append a row when a session doc is created. Never renumber.
