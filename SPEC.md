# Home Row Tutor — Technical Spec

Implements `PRD.md`. Design goal throughout: the fastest thing that works.

## 1. Run it

```
./tutor                  # starts the server and opens http://127.0.0.1:8421
```

`./tutor` creates `.venv` and installs the `anthropic` SDK on first run. Hints come from the first of these that is available:

1. **API:** `ANTHROPIC_API_KEY` is set and the SDK is installed.
2. **Claude CLI:** the `claude` command is on the PATH. Each hint runs `claude -p` headless with no tools, in an empty directory, using the CLI's existing login.
3. **Offline:** each task's authored hints.

| Env var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Use the Claude API for hints and reviews |
| `TUTOR_MODEL` | `claude-opus-5-5` | Model. `claude-haiku-5-5` is faster and far cheaper |
| `TUTOR_BACKEND` | unset | `offline` forces authored hints |
| `TUTOR_PORT` | `8421` | Port |

Other entry points:

| Command | What it does |
|---|---|
| `python3 server.py --selftest` | Runs every Python and Bash reference solution through its runner |
| `node scripts/check_vim.mjs` | Replays every Vim solution in headless Chrome (see the file header) |
| `python3 server.py --report` | Instructor view: per-task table from the saved session logs |
| `python3 server.py --rebuild-solutions [logs…]` | Rebuilds `solutions/` from the session logs |
| `python3 server.py --export dist` | Writes a static, server-less copy (section 12) |

URL parameters: `?pack=<id>&task=<id>` opens a specific exercise, `?speed=10` makes every timer ten times shorter, `?days=2` pretends it is two days later (to see reviews come due).

## 2. Architecture

```
Browser (static/)                         Python server (server.py, stdlib)
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ CodeMirror editor (+ Vim)    │          │ GET  /api/packs, /api/pack   │
│ capture → event log          │  JSON    │ POST /api/run     sandboxed  │
│ stuck detector (rules)       │ ───────► │ POST /api/eval    sandboxed  │
│ hint ladder, cooldown        │ ◄─────── │ POST /api/hint    Claude ⇄   │
│ spaced review, checkpoints   │          │ POST /api/review  Claude ⇄   │
│ Vim goal checking            │          │ POST /api/generate Claude ⇄  │
│ progress in localStorage     │          │ POST /api/log     sessions/  │
└──────────────────────────────┘          └──────────────────────────────┘
```

- **Server:** one file, Python standard library, plus the optional `anthropic` SDK. No framework, no database.
- **Client:** plain ES modules, no build step. CodeMirror 6, its Vim mode, and shell highlighting are pre-bundled into `static/vendor/cm.js` (`scripts/build_vendor.sh` rebuilds it; not needed to run).
- **Split of responsibility:** everything that decides *when* to speak runs in the browser, off the local event log. The server runs code and phrases hints. Typing never waits on the network.

### Files

```
tutor                      launcher (venv, install, start, open browser)
server.py                  HTTP server, runners, sandbox, Claude calls, CLI commands
static/app.js              editor, capture, detector, ladder, review schedule, menu
static/pyworker.js         Pyodide worker (static build only)
static/index.html, style.css, vendor/cm.js
packs/<id>/pack.py         a course (or pack.json for generated courses)
scripts/build_vendor.sh    rebuilds the editor bundle
scripts/check_vim.mjs      validates the Vim course in a browser
sessions/                  saved session logs (created at runtime)
solutions/<course>/        your latest solution to each task, plus README.md with all of them
```

## 3. Courses

| Course | Runner | Tasks | Content |
|---|---|---|---|
| Python syntax | python | 54 | print through classes, in six sections, each ending in an unaided checkpoint |
| Interview patterns | python | 11 | one classic problem per reusable pattern |
| Bash commands | bash | 38 | files, pipes, text tools, wildcards, variables, small scripts |
| Vim keybindings | vim | 51 | motions, operators, text objects, search, macros, each with a par |
| "Teach me…" | python | 8 | generated on request for any topic |

## 4. Keyboard

All commands are Ctrl + a home-row key (macOS; Ctrl + letter is not reserved by browsers there). The editor always has focus.

| Key | Action |
|---|---|
| `Ctrl-J` | Run the work against the checks (Vim course: start the exercise over) |
| `Ctrl-L` | Hint, or the next level of hint |
| `Ctrl-G` | Dismiss the hint |
| `Ctrl-S` | Next task (twice to skip an unsolved one) |
| `Ctrl-;` | Menu: courses, chattiness, Vim keys, cheat sheet, progress, Teach me |
| `#? question` + Enter | Ask the tutor |
| `#= expression` + Enter | Scratch: evaluate a Python expression or run a shell command and show the result, without affecting the task |
| `#<` / `#>` + Enter | Previous / next task |

In the menu: `j`/`k` move, `l` or Enter chooses, `h` goes back, `g` closes.

With Vim keys on (always in the Vim course, optional elsewhere via the menu): `jk` or `Ctrl-[` leaves insert mode, and `:ask question`, `:hint`, `:next`, `:prev`, `:menu` are available as commands.

Without Vim keys, cursor movement uses the macOS text bindings: `Ctrl-F/B/N/P`, `Ctrl-A/E`, `Ctrl-D/H`, `Ctrl-K`.

## 5. Event log

One array per task attempt, timestamps in ms since the task opened.

| Event | Fields |
|---|---|
| `ins` / `del` | `t`, `line`, `n` (chars) |
| `run` | `t`, `passed`, `total`, `err` (signature), `label` |
| `reset` | `t`, `keys` (Vim: keystrokes before starting over) |
| `hint` | `t`, `level`, `trigger`, `source` (`ai`/`pack`) |
| `dismiss`, `ask` (`q`), `scratch` (`expr`) | `t` |

Consecutive edits on one line less than 1 s apart are merged. In the Vim course every keystroke is also recorded as a token (`d`, `w`, `<Esc>`, `<C-r>`). For the model the log is compressed to a **digest**: totals, failure history, most-rewritten lines, and the last 25 events as text such as `+34 L3, -20 L3, pause 18s, run 1/4 IndexError`.

## 6. When the tutor speaks

A check runs once a second and after every run. Automatic triggers need: task unsolved, not a checkpoint, no request in flight, cooldown passed, and typing settled for 1.5 s.

| Trigger | Condition | quiet | normal | chatty |
|---|---|---|---|---|
| `pause` | No activity for this long (doubled before anything is typed) | 60 s | 25 s | 12 s |
| `churn` | Delete bursts (≥ 5 chars deleted, then retyped) in 90 s | 5 | 3 | 2 |
| `repeat_error` | Consecutive runs with the same failure signature (Vim: resets, +1) | 3 | 2 | 2 |
| `inefficient` | Vim: keystrokes exceed max(3 × par, par + 12) | yes | yes | yes |
| `checkpoint` | AI only: after this many new chars, the model looks at the approach and may answer `OK` to stay silent | off | 120 | 60 |
| cooldown | Minimum gap after a hint or a dismissal | 90 s | 45 s | 20 s |

**Boundaries.** An automatic hint is requested in the background and held. It appears only at the next gap in typing, never mid-line. The footer shows what the tutor is doing: watching, thinking, holding a hint, cooling down, or silent.

**Adaptive chattiness.** Dismissing three automatic hints in a row within 8 s of their appearing steps chattiness down one level. Asking for a hint four times in a row with no automatic hint in between steps it up. The menu sets it directly.

**Hint ladder.** Level 1 nudge, level 2 guiding question, level 3 an example on a different problem. Each task tracks its level; a run that passes more checks than before resets it.

**No clicking through.** `Ctrl-L` moves from level 1 to 2 only after an attempt or 8 s of reading time, and from 2 to 3 only after an attempt. An attempt is 10 characters of edits (3 keystrokes in Vim), a run, or a typed reply. Level 3 is the top.

**Leak guard.** The model is given the reference solution so it can judge the learner's approach. Before an AI hint is sent, the server compares it with that solution: a long solution line, or two shorter ones, appearing in the hint counts as a leak. The server retries once with the leaked line called out, then falls back to the authored hint. Vim key sequences are too short to match and rely on the prompt.

## 7. Learning features

**Spaced review.** Solving a task files it in a box; struggling (any hint, two failed runs, or more than twice par in Vim) halves the box, a clean solve moves it up. Intervals by box are 1, 3, 7, 16, and 35 days. Opening a course queues up to three due tasks first, with the lesson hidden and the editor empty.

**Unaided checkpoints.** Tasks marked `checkpoint` show no lesson and no example, and the tutor is silent: no automatic hints, no `Ctrl-L`, no questions. The result is recorded separately and shown under Progress. This is the product's own measure of whether learning stuck.

**Faded starters.** A `starter` containing `____` opens with the first blank selected; the learner types the missing pieces of an otherwise complete example.

**Skip-ahead.** After a first-run, no-hint solve, if the next task belongs to the same `group`, the footer offers to skip it.

**Cheat sheet.** Every concept the learner struggled with is collected, with its example and the errors hit, and shown from the menu.

**Progress.** Per course: solved, unaided checkpoints, reviews due; where the time went by concept; recent solves. Data is in `localStorage`.

**Error marker.** The line an error was reported on is highlighted until the next edit.

## 8. Runners

Every runner returns the same shape: `{passed, total, ok, error, stdout, stderr, tests: [{call, expected, got, ok, error}]}`. Any task may add `requires`: `[regex, label]` pairs the submission must match (for example "uses a list comprehension").

**Sandbox.** On macOS, learner code runs under `sandbox-exec` with network denied and file writes allowed only inside its temporary directory. Elsewhere it runs unconfined, and the server says so at startup. A run is killed after 5 s.

**python.** `tests` are `[expression, expected]` pairs evaluated after the learner's code. Expected values are Python literals (tuples and sets allowed). `"__stdout__"` as the expression compares what the module printed; a third element `"stdout"` compares what the expression printed. Floats are compared with a tolerance.

**bash.** `files` lists the fixture files (a name ending in `/` is a directory) created in a fresh directory, which is also `HOME`. The learner's lines run as a script with `LC_ALL=C`. `expect` may contain `stdout` (whitespace-insensitive; `sorted: true` ignores line order), `files` (path → content), `dirs`, `exists`, `absent`, and `executable`.

**vim.** Checked in the browser. `start` is the buffer, `cursor` is `[line, column]`, and `goal` may give `text`, `cursor`, and `keys` (a regex the keystroke log must match, used for undo and redo). The exercise completes by itself when the goal holds in normal mode. `par` defaults to the keystroke count of `solution`, with Esc counted as 2 because it is typed `jk`.

## 9. Server API

The server binds to `127.0.0.1` and rejects requests whose `Host` is not localhost or whose `Origin` is another site.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/packs` | | `{ai, model, sandbox, packs: [{id, name, runner, description, count}]}` |
| `GET /api/pack?id=` | | The course without tests, solutions, or fixtures |
| `POST /api/run` | `{pack_id, task_id, code}` | Runner result |
| `POST /api/eval` | `{pack_id, task_id, code, expr}` | `{output}` for the scratch line |
| `POST /api/hint` | `{pack_id, task_id, code, cursor_line, level, trigger, question, digest, keys, last_run, prior_hints}` | Plain text; header `X-Hint-Source: ai` or `pack` |
| `POST /api/review` | `{pack_id, task_id, code, digest, keys, stats}` | Plain text, streamed |
| `POST /api/generate` | `{topic}` | `{pack_id, tasks}` or `{error}` |
| `POST /api/log` | attempt record | Appends to `sessions/YYYY-MM-DD.jsonl` and updates `solutions/` |

Model calls use `output_config.effort = "low"` (medium for course generation) and, through the API, server-side refusal fallbacks. The hint system prompt is fixed; the user message carries the exercise, the reference solution, the author's hints, the current work with the cursor line marked, the last check, the digest, and earlier hints. Any AI failure falls back to authored text and is logged to the terminal.

**Course generation.** The model returns a JSON course of eight Python tasks. The server runs each reference solution against its own tests, drops any task that fails (or that passes with empty code), and saves the rest as `packs/gen-<topic>/pack.json`.

## 10. Course format

`packs/<id>/pack.py` defines `PACK`; generated courses use the same structure as `pack.json`.

```python
PACK = {
    "name": "Python syntax", "runner": "python", "order": 10, "description": "...",
    "tasks": [{
        "id": "greet", "title": "...", "concept": "...",
        "lesson": "Short teaching text.",
        "example": "A small example of the concept on a different problem.",
        "prompt": "What to do.",
        "hints": ["nudge", "guiding question"],   # 0 to 3; missing levels get defaults
        "solution": "...",                        # never sent to the browser
        # optional: "starter", "group", "checkpoint": True, "requires": [[regex, label]]
        # plus the runner's own fields (section 8)
    }],
}
```

Adding a course means adding a directory. Adding an environment means adding a runner function with the result shape above; the engine does not change.

## 11. Client state

`localStorage["hrt:v2"]`: current course, chattiness, Vim toggle, and per course the current task, saved code, solved ids, review boxes and due dates, and checkpoint results; plus a capped history of solves and the cheat sheet entries. Event logs are per attempt and are saved server-side when a task is solved.

## 12. Static build

`python3 server.py --export dist` writes a copy that any web server can host. Python exercises run in the browser through Pyodide (loaded from a CDN on first run, in a worker that is terminated if a run exceeds 8 s), and Vim exercises are client-side already. The Bash course is left out because it needs a real shell, and hints are the authored ones because there is no server to hold Claude credentials. Tests ship to the browser in this build.

## 13. Testing

- `python3 server.py --selftest`: 103 Python and Bash reference solutions pass in the sandbox; starters and empty answers do not.
- `node scripts/check_vim.mjs`: all 51 Vim solutions reach their goal at or under par in headless Chrome.
- Run during the build in headless Chrome against an offline server: 35 checks covering the ladder gating, scratch line, error marker, menu, course switching, checkpoints, faded starters, skip-ahead, adaptive chattiness, Vim toggle, spaced review, and Vim reset and `:ask`. The static build was checked the same way.
- Against the live model, by direct requests: hints for Python, Bash, and Vim, a Vim review, the leak guard's retry and fallback, and generating a course. Live hints rendering in the editor during a browser session has not been watched end to end.

## 14. Limits and open work

- Thresholds are first guesses. `sessions/` holds the data to tune them.
- The instructor view is a command-line report over one machine's logs. A multi-learner dashboard needs a hosted backend.
- The static build has no AI hints. A hosted version needs a server that holds the credentials and sandboxes code.
- Windows and Linux browsers reserve some of these Ctrl shortcuts, and learner code is not sandboxed there.
