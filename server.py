#!/usr/bin/env python3
"""Home Row Tutor server: static files, code runners, and Claude-backed hints.

Standard library only, plus the optional `anthropic` SDK. See SPEC.md.
"""
import datetime
import json
import os
import re
import runpy
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PACKS_DIR = ROOT / "packs"
SESSIONS = ROOT / "sessions"
PORT = int(os.environ.get("TUTOR_PORT", "8421"))
MODEL = os.environ.get("TUTOR_MODEL", "claude-opus-5-5")
RUN_TIMEOUT_S = 5
MAX_BODY = 1_000_000

try:
    import anthropic
except ImportError:
    anthropic = None

HAS_KEY = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
CLAUDE_CLI = shutil.which("claude")
# Where hints come from: the API (needs a key), else the Claude Code CLI in
# headless mode (uses its existing login), else the pack's authored hints.
if os.environ.get("TUTOR_BACKEND") == "offline":
    BACKEND = None
elif anthropic is not None and HAS_KEY:
    BACKEND = "api"
elif CLAUDE_CLI:
    BACKEND = "cli"
else:
    BACKEND = None
AI = BACKEND is not None
client = anthropic.Anthropic(timeout=30.0, max_retries=1) if BACKEND == "api" else None

# Models that accept the server-side refusal fallback parameter.
FALLBACK_MODELS = ("claude-opus-5", "claude-fable-5", "claude-sonnet-5-5")

# ---------------------------------------------------------------- packs

DEFAULT_HINTS = [
    "Re-read the task, then the lesson: {concept}.",
    "Look at the example again. Which part of it does the job you need here?",
    "The pattern from the lesson:\n{example}",
]


def key_count(keys):
    """Keystrokes in a Vim key string. <Esc> counts 2, since it is typed as jk."""
    tokens = re.findall(r"<[^<>]+>|.", keys, flags=re.S)
    return sum(2 if t.lower() == "<esc>" else 1 for t in tokens)


def normalise_pack(pack, pack_id):
    pack["id"] = pack_id
    pack.setdefault("runner", "python")
    pack.setdefault("description", "")
    pack.setdefault("order", 100)
    for task in pack["tasks"]:
        task.setdefault("lesson", "")
        task.setdefault("example", "")
        task.setdefault("concept", task["title"])
        hints = list(task.get("hints") or [])[:3]
        for i in range(len(hints), 3):
            hints.append(DEFAULT_HINTS[i].format(concept=task["concept"], example=task["example"]))
        task["hints"] = hints
        if pack["runner"] == "vim":
            task.setdefault("par", key_count(task["solution"]))
    return pack


def load_packs():
    packs = {}
    for d in sorted(PACKS_DIR.iterdir()):
        try:
            if (d / "pack.py").exists():
                pack = runpy.run_path(str(d / "pack.py"))["PACK"]
            elif (d / "pack.json").exists():
                pack = json.loads((d / "pack.json").read_text())
            else:
                continue
            packs[d.name] = normalise_pack(pack, d.name)
        except Exception as exc:
            print(f"[tutor] skipping pack {d.name}: {type(exc).__name__}: {exc}", file=sys.stderr)
    return dict(sorted(packs.items(), key=lambda kv: (kv[1]["order"], kv[1]["name"])))


PACKS = load_packs()
HIDDEN = {"tests", "solution", "expect", "requires", "files"}


def public_task(task, keep=()):
    return {k: v for k, v in task.items() if k not in HIDDEN or k in keep}


def public_pack(pack, keep=()):
    out = {k: v for k, v in pack.items() if k != "tasks"}
    out["tasks"] = [public_task(t, keep) for t in pack["tasks"]]
    return out


def find_task(body):
    pack = PACKS.get(body.get("pack_id"))
    if not pack:
        return None, None
    return pack, next((t for t in pack["tasks"] if t["id"] == body.get("task_id")), None)


# ---------------------------------------------------------------- sandbox


def _sandbox_works():
    if sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"):
        return False
    try:
        return subprocess.run(
            ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"],
            capture_output=True, timeout=5,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


SANDBOX = _sandbox_works()


def sandboxed(cmd, root):
    """On macOS, confine learner code: no network, writes only inside its temp dir."""
    if not SANDBOX:
        return cmd
    real = os.path.realpath(root)
    profile = (
        "(version 1)(allow default)(deny network*)(deny file-write*)"
        f'(allow file-write* (subpath "{real}") (literal "/dev/null"))'
    )
    return ["/usr/bin/sandbox-exec", "-p", profile, *cmd]


def run_confined(cmd, root, cwd, env=None):
    return subprocess.run(
        sandboxed(cmd, root), cwd=cwd, env=env, capture_output=True, text=True,
        timeout=RUN_TIMEOUT_S, stdin=subprocess.DEVNULL,
    )


TIMEOUT_ERROR = {
    "type": "Timeout",
    "message": f"ran longer than {RUN_TIMEOUT_S}s; is there a loop that never ends?",
    "line": None,
}


def finish(result, task, code):
    """Add `requires` checks (patterns the code must contain) and the totals."""
    for pattern, label in task.get("requires", []):
        result["tests"].append({
            "call": label, "expected": None, "got": None, "error": None, "note": True,
            "ok": re.search(pattern, code, flags=re.M) is not None,
        })
    result["total"] = len(result["tests"])
    result["passed"] = sum(1 for t in result["tests"] if t["ok"])
    result["ok"] = result["total"] > 0 and result["passed"] == result["total"] and not result.get("error")
    return result


# ---------------------------------------------------------------- python runner

PY_HARNESS = r'''
import ast, contextlib, io, json, math, traceback

def describe(exc):
    if isinstance(exc, SyntaxError):
        return {"type": type(exc).__name__, "message": exc.msg, "line": exc.lineno}
    line = None
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == "solution.py":
            line = frame.lineno
    return {"type": type(exc).__name__, "message": str(exc), "line": line}

def same(got, exp):
    if isinstance(exp, float) and isinstance(got, (int, float)) and not isinstance(got, bool):
        return math.isclose(got, exp, rel_tol=1e-9, abs_tol=1e-9)
    return got == exp and isinstance(got, bool) == isinstance(exp, bool)

def lines(text):
    return [l.rstrip() for l in text.rstrip().split("\n")]

src = open("solution.py").read()
tests = json.load(open("tests.json"))
out = {"error": None, "tests": []}
ns = {"__name__": "solution"}
module_out = io.StringIO()
with contextlib.redirect_stdout(module_out):
    try:
        exec(compile(src, "solution.py", "exec"), ns)
    except BaseException as exc:
        out["error"] = describe(exc)
for test in tests:
    expr, expected = test[0], ast.literal_eval(test[1])
    mode = test[2] if len(test) > 2 else "value"
    res = {"call": expr, "expected": repr(expected), "got": None, "ok": False, "error": None}
    if out["error"] is None:
        buf = io.StringIO()
        try:
            if expr == "__stdout__":
                res["call"] = "printed output"
                got = module_out.getvalue()
                res["ok"] = lines(got) == lines(expected)
            else:
                with contextlib.redirect_stdout(buf):
                    got = eval(expr, ns)
                if mode == "stdout":
                    res["call"] = expr + " prints"
                    got = buf.getvalue()
                    res["ok"] = lines(got) == lines(expected)
                else:
                    res["ok"] = same(got, expected)
            res["got"] = repr(got)
        except BaseException as exc:
            res["error"] = describe(exc)
    out["tests"].append(res)
out["stdout"] = module_out.getvalue()[-2000:]
json.dump(out, open("result.json", "w"))
'''

PY_EVAL = r'''
import contextlib, io, sys
src = open("solution.py").read()
expr = open("expr.txt").read()
ns = {"__name__": "solution"}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    try:
        exec(compile(src, "solution.py", "exec"), ns)
    except BaseException as exc:
        print(f"(your code stops with {type(exc).__name__}: {exc})")
    try:
        try:
            code = compile(expr, "scratch", "eval")
        except SyntaxError:
            exec(compile(expr, "scratch", "exec"), ns)
        else:
            print(repr(eval(code, ns)))
    except BaseException as exc:
        print(f"{type(exc).__name__}: {exc}")
sys.stdout.write(buf.getvalue()[-2000:])
'''


def py_tests(task):
    return [[t[0], repr(t[1]), *t[2:]] for t in task["tests"]]


def run_python(task, code):
    tests = py_tests(task)
    with tempfile.TemporaryDirectory(prefix="hrt-") as tmp:
        tmp = Path(tmp)
        (tmp / "solution.py").write_text(code)
        (tmp / "tests.json").write_text(json.dumps(tests))
        (tmp / "harness.py").write_text(PY_HARNESS)
        proc = None
        try:
            proc = run_confined([sys.executable, "-I", "harness.py"], tmp, tmp)
            result = json.loads((tmp / "result.json").read_text())
        except subprocess.TimeoutExpired:
            result = {
                "error": TIMEOUT_ERROR, "stdout": "",
                "tests": [{"call": t[0], "expected": t[1], "got": None, "ok": False, "error": None} for t in tests],
            }
        except (OSError, ValueError):
            message = proc.stderr.strip()[-500:] if proc else "could not start Python"
            result = {"error": {"type": "RunnerError", "message": message, "line": None}, "tests": [], "stdout": ""}
    return finish(result, task, code)


def eval_python(task, code, expr):
    with tempfile.TemporaryDirectory(prefix="hrt-") as tmp:
        tmp = Path(tmp)
        (tmp / "solution.py").write_text(code)
        (tmp / "expr.txt").write_text(expr)
        (tmp / "harness.py").write_text(PY_EVAL)
        try:
            proc = run_confined([sys.executable, "-I", "harness.py"], tmp, tmp)
            return (proc.stdout or proc.stderr).strip()[-2000:]
        except subprocess.TimeoutExpired:
            return TIMEOUT_ERROR["message"]


# ---------------------------------------------------------------- bash runner

BASH = shutil.which("bash") or "/bin/bash"


def squash(text):
    """Compare shell output ignoring spacing differences (BSD and GNU tools pad differently)."""
    return [" ".join(line.split()) for line in (text or "").strip().split("\n")]


def bash_workspace(task, tmp):
    work = tmp / "work"
    work.mkdir()
    (tmp / "tmp").mkdir()
    for name, content in (task.get("files") or {}).items():
        path = work / name
        if name.endswith("/"):
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(work),
        "TMPDIR": str(tmp / "tmp"), "LC_ALL": "C", "TERM": "dumb",
    }
    return work, env


def run_bash(task, code):
    expect = task.get("expect", {})
    tests = []

    def add(call, ok, expected=None, got=None):
        tests.append({"call": call, "expected": expected, "got": got, "ok": bool(ok), "error": None})

    with tempfile.TemporaryDirectory(prefix="hrt-") as tmp:
        tmp = Path(tmp)
        work, env = bash_workspace(task, tmp)
        (tmp / "script.sh").write_text(code)
        try:
            proc = run_confined([BASH, "--noprofile", "--norc", str(tmp / "script.sh")], tmp, work, env)
        except subprocess.TimeoutExpired:
            return finish({"error": TIMEOUT_ERROR, "tests": [], "stdout": ""}, task, code)
        stderr = proc.stderr.replace(str(tmp / "script.sh") + ": ", "").strip()
        if "stdout" in expect:
            got, want = squash(proc.stdout), squash(expect["stdout"])
            if expect.get("sorted"):
                got, want = sorted(got), sorted(want)
            add("output", got == want, expect["stdout"].strip(), proc.stdout.strip() or "(nothing)")
        for name, want in (expect.get("files") or {}).items():
            path = work / name
            if not path.is_file():
                add(f"file {name}", False, want.strip(), "(no such file)")
            else:
                got = path.read_text(errors="replace")
                add(f"file {name}", squash(got) == squash(want), want.strip(), got.strip() or "(empty)")
        for name in expect.get("dirs", []):
            add(f"directory {name} exists", (work / name).is_dir())
        for name in expect.get("exists", []):
            add(f"{name} exists", (work / name).exists())
        for name in expect.get("absent", []):
            add(f"{name} is gone", not (work / name).exists())
        for name in expect.get("executable", []):
            add(f"{name} is executable", (work / name).is_file() and os.access(work / name, os.X_OK))
    result = {"error": None, "tests": tests, "stdout": "", "stderr": stderr[-800:], "exit": proc.returncode}
    if "stdout" not in expect:
        result["stdout"] = proc.stdout[-2000:]
    return finish(result, task, code)


def eval_bash(task, code, expr):
    with tempfile.TemporaryDirectory(prefix="hrt-") as tmp:
        tmp = Path(tmp)
        work, env = bash_workspace(task, tmp)
        try:
            proc = run_confined([BASH, "--noprofile", "--norc", "-c", expr], tmp, work, env)
            return (proc.stdout + proc.stderr).strip()[-2000:] or "(no output)"
        except subprocess.TimeoutExpired:
            return TIMEOUT_ERROR["message"]


RUNNERS = {"python": run_python, "bash": run_bash}
EVALS = {"python": eval_python, "bash": eval_bash}

# ---------------------------------------------------------------- tutor prompts

HINT_SYSTEM = """\
You are a tutor built into a keyboard-only practice editor. A learner is working through a \
small exercise by typing: Python code, shell commands, or Vim keystrokes, depending on the \
course. You are shown the exercise, what they have typed so far, their last check, and a digest \
of their history: what they typed and deleted, on which lines, how long they paused, and what \
happened each time they ran or reset.

Whatever you write appears as one faint comment under their cursor while they are mid-thought, \
so keep it short and plain: no markdown, no code fences, no greeting, no praise padding.

Your job is to get them moving again while leaving the thinking and the typing to them, because \
that is how they learn. You are given a reference solution so you can judge their approach; \
never reveal it, never write the solution to their exercise, and never write a line they could \
copy into it. Their approach does not have to match the reference. Use the history to aim at \
the real sticking point, for example a line they have rewritten several times or an error they \
keep hitting, rather than describing the exercise in general.

The hint level sets how much you give:
- Level 1, nudge: one sentence that points at where to look.
- Level 2, guiding question: one question whose answer is the missing idea.
- Level 3, concrete example: one sentence, then a tiny example of the same concept applied to a \
different problem with different names and data. At most five short lines in total. In a Vim \
exercise you may name one command and what it does, but not the whole key sequence.

The trigger says why you were called:
- pause: they stopped typing for a while.
- churn: they keep deleting and retyping the same area.
- repeat_error: several checks in a row failed the same way, or they keep resetting.
- inefficient: (Vim) they are using far more keystrokes than the exercise needs.
- request: they pressed the hint key.
- ask: they typed a question. Answer it directly in at most two sentences. If it is about \
syntax, show the general form. Still do not write their solution.
- checkpoint: a routine look while they are typing. If their approach can reach a working \
solution, reply with exactly OK and nothing else, even if the work is unfinished or has typos \
they will find on the next run. Only if the approach cannot work, give a hint at the stated \
level about why.

Unfinished lines and typos on the line they are currently typing are normal; leave them alone \
unless that is what they are stuck on. Do not repeat an earlier hint; build on it."""

REVIEW_SYSTEM = """\
You are a tutor built into a keyboard-only practice editor. The learner has just solved an \
exercise (Python, shell, or Vim keystrokes). You are shown the exercise, their final answer, \
and a digest of how they got there: edits, deletions, pauses, runs, errors, keystrokes, and hints.

Write a review of their process in at most three short sentences, addressed to them as "you". \
Be specific to what the digest shows: say where the time went (for example, a line rewritten \
many times, an error hit repeatedly, or many more keystrokes than needed) and name the one \
pattern worth remembering so that part goes faster next time. Now that they have solved it, you \
may show a short idiom or the efficient key sequence. If the process was clean, say so in one \
sentence. Plain text only, no markdown, no greeting."""

GENERATE_SYSTEM = """\
You write short hands-on Python practice courses for a keyboard-only tutor. Reply with one JSON \
object and nothing else: no prose, no code fences.

Schema:
{"name": str, "description": str, "tasks": [{"id": snake_case str, "title": str, "concept": str,
"lesson": str, "example": str, "prompt": str, "tests": [[expression str, expected JSON value], ...],
"hints": [nudge str, guiding question str], "solution": str}]}

Rules:
- 8 tasks that build on each other, easiest first, each teaching one idea of the requested topic.
- lesson: two or three plain sentences teaching the idea. example: a few lines of Python showing \
the idea on a DIFFERENT problem than the task, so it cannot be copied.
- prompt: exactly what to write, naming the function and giving one concrete input and output.
- tests: 3 or 4 [expression, expected] pairs. Each expression is evaluated after the learner's \
code runs and compared with == to the expected value, so expected values must be JSON (use \
lists, not tuples or sets). Only the Python standard library; no files, network, or randomness.
- solution: a correct reference solution that passes every test.
- hints: a one-sentence nudge, then a guiding question. Neither gives the answer away."""


def numbered(code, cursor_line):
    return "\n".join(
        f"{'>>' if i == cursor_line else '  '}{i:3} | {line}"
        for i, line in enumerate(code.split("\n"), 1)
    )


def describe_run(run):
    if not run:
        return "They have not run a check yet."
    parts = [f"{run.get('passed', 0)}/{run.get('total', 0)} checks passed."]
    err = run.get("error")
    if err:
        where = f" on line {err['line']}" if err.get("line") else ""
        parts.append(f"Error{where}: {err.get('type')}: {err.get('message')}")
    if run.get("stderr"):
        parts.append(f"stderr: {run['stderr'][:300]}")
    for t in run.get("tests", []):
        if t.get("ok"):
            continue
        if t.get("error"):
            parts.append(f"{t['call']} raised {t['error'].get('type')}: {t['error'].get('message')}")
        elif t.get("got") is not None:
            parts.append(f"{t['call']}: got {str(t['got'])[:200]}, expected {str(t['expected'])[:200]}")
        else:
            parts.append(f"not satisfied: {t['call']}")
    return "\n".join(parts[:8])


def task_block(pack, task):
    lines = [
        f"Course: {pack['name']} ({pack['runner']})", f"Title: {task['title']}",
        f"Concept: {task['concept']}", f"Lesson shown to the learner: {task['lesson']}",
        f"Example shown: {task['example']}", f"Task: {task['prompt']}",
    ]
    if task.get("checkpoint") or False:
        lines.append("This is an unaided checkpoint.")
    if pack["runner"] == "bash":
        files = ", ".join(task.get("files") or {}) or "none"
        lines.append(f"Files in the working directory before their commands run: {files}")
        lines.append(f"Checked outcome: {json.dumps(task.get('expect', {}))[:600]}")
    if pack["runner"] == "vim":
        lines.append(f"Start buffer (cursor at line {task['cursor'][0]}, column {task['cursor'][1]}):\n{task['start']}")
        lines.append(f"Goal: {json.dumps(task['goal'])}")
        lines.append(f"Par: {task['par']} keystrokes (Esc is typed as jk and counts 2).")
    return (
        "<exercise>\n" + "\n".join(lines) + "\n</exercise>\n\n"
        f"<reference_solution>\nFor your eyes only. Never reveal it.\n{task.get('solution', '')}\n</reference_solution>"
    )


def hint_prompt(pack, task, body):
    prior = body.get("prior_hints") or []
    prior_text = "\n".join(f"- {h}" for h in prior[-4:]) or "none"
    authored = "\n".join(f"- level {i}: {h}" for i, h in enumerate(task["hints"], 1))
    question = body.get("question")
    work = "buffer" if pack["runner"] == "vim" else "code"
    return "\n\n".join(filter(None, [
        task_block(pack, task),
        f"<author_hints>\nThe exercise author's idea of each hint level, for orientation:\n{authored}\n</author_hints>",
        f"<{work}>\nCursor is on the line marked >>.\n{numbered(body.get('code', ''), body.get('cursor_line'))}\n</{work}>",
        f"<keys_typed>\n{body['keys']}\n</keys_typed>" if body.get("keys") else None,
        f"<last_check>\n{describe_run(body.get('last_run'))}\n</last_check>",
        f"<history>\n{body.get('digest', '')}\n</history>",
        f"<previous_hints>\n{prior_text}\n</previous_hints>",
        f"<learner_question>\n{question}\n</learner_question>" if question else None,
        f"Trigger: {body.get('trigger')}\nHint level: {body.get('level')}",
    ]))


def review_prompt(pack, task, body):
    return "\n\n".join(filter(None, [
        task_block(pack, task),
        f"<final_answer>\n{body.get('code', '')}\n</final_answer>",
        f"<keys_typed>\n{body['keys']}\n</keys_typed>" if body.get("keys") else None,
        f"<history>\n{body.get('digest', '')}\n</history>",
    ]))


# ---------------------------------------------------------------- claude


def cli_stream(system, user, effort, timeout):
    """Yield text chunks from `claude -p` (headless Claude Code, no tools)."""
    workdir = tempfile.mkdtemp(prefix="hrt-cli-")  # empty dir: no project context is loaded
    proc = subprocess.Popen(
        [
            CLAUDE_CLI, "-p", "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--system-prompt", system, "--model", MODEL,
            "--effort", effort, "--tools", "", "--strict-mcp-config",
            "--disable-slash-commands", "--no-session-persistence", "--setting-sources", "",
        ],
        cwd=workdir, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    watchdog = threading.Timer(timeout, proc.kill)
    watchdog.start()
    got_text = False
    try:
        proc.stdin.write(user)
        proc.stdin.close()
        for raw in proc.stdout:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            delta = (msg.get("event") or {}).get("delta") or {}
            if msg.get("type") == "stream_event" and delta.get("type") == "text_delta":
                got_text = True
                yield delta["text"]
        if proc.wait() != 0 and not got_text:
            raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.read().strip()[-300:]}")
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.kill()  # learner dismissed the hint or moved on
        shutil.rmtree(workdir, ignore_errors=True)


def ai_stream(system, user, effort="low", timeout=60, max_tokens=4000):
    """Yield text chunks from Claude."""
    if BACKEND == "cli":
        yield from cli_stream(system, user, effort, timeout)
        return
    kwargs = dict(
        model=MODEL, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": user}], output_config={"effort": effort},
    )
    api = client.with_options(timeout=float(timeout))
    if MODEL.startswith(FALLBACK_MODELS):
        # If a safety classifier declines, the API reruns the request on a fallback model.
        stream_cm = api.beta.messages.stream(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
        )
    else:
        stream_cm = api.messages.stream(**kwargs)
    with stream_cm as stream:
        yield from stream.text_stream


def ai_text(system, user, **kw):
    return "".join(ai_stream(system, user, **kw)).strip()


# ---------------------------------------------------------------- hints

def squeeze(s):
    return re.sub(r"\s+", "", s)


def leaked_line(pack, task, text):
    """Return a line of the reference solution that the hint gives away, if any."""
    if pack["runner"] == "vim":
        return None  # key sequences are too short to match; the prompt covers it
    lines = [l.strip() for l in (task.get("solution") or "").splitlines()]
    distinct = [l for l in lines if len(squeeze(l)) >= 10 and not l.startswith(("def ", "class ", "#"))]
    hint = squeeze(text)
    hits = [l for l in distinct if squeeze(l) in hint]
    # One long line is a giveaway by itself; short generic lines only count in pairs.
    long_hits = [l for l in hits if len(squeeze(l)) >= 16]
    if long_hits or (hits and len(distinct) <= 2) or len(hits) >= 2:
        return (long_hits or hits)[0]
    return None


def pack_hint(task, body):
    if body.get("trigger") == "checkpoint":
        return "OK"
    level = max(1, min(3, int(body.get("level") or 1)))
    return task["hints"][level - 1]


def make_hint(pack, task, body):
    """Return (text, source). AI hints are checked for solution leaks before they are shown."""
    fallback = pack_hint(task, body)
    if not AI:
        return fallback, "pack"
    prompt = hint_prompt(pack, task, body)
    try:
        text = ai_text(HINT_SYSTEM, prompt)
        leak = text and leaked_line(pack, task, text)
        if leak:
            print(f"[tutor] hint leaked a solution line, retrying: {leak!r}", file=sys.stderr)
            text = ai_text(HINT_SYSTEM, prompt + (
                f"\n\nYour previous draft contained this line of the reference solution: {leak}\n"
                "Write the hint again without it or anything equivalent."
            ))
            if text and leaked_line(pack, task, text):
                return fallback, "pack"
        return (text, "ai") if text else (fallback, "pack")
    except Exception as exc:
        print(f"[tutor] AI hint failed, using authored hint: {type(exc).__name__}: {exc}", file=sys.stderr)
        return fallback, "pack"


def pack_review(task, body):
    s = body.get("stats") or {}
    secs = int(s.get("elapsed_s", 0))
    took = f"{secs // 60}m{secs % 60:02d}s" if secs >= 60 else f"{secs}s"
    runs, hints = s.get("runs", 0), s.get("hints", 0)
    out = [f"Solved in {took} with {runs} run{'s' * (runs != 1)} and {hints} hint{'s' * (hints != 1)}."]
    typed, deleted = s.get("typed", 0), s.get("deleted", 0)
    if s.get("keys") and s.get("par"):
        over = s["keys"] - s["par"]
        out.append(f"{s['keys']} keys against a par of {s['par']}." if over > 0 else f"At par: {s['keys']} keys.")
    elif s.get("top_error"):
        out.append(f"Most of the friction was {s['top_error']} ({s.get('top_error_n', 1)}x).")
    elif typed and deleted / typed > 0.4:
        out.append(f"You deleted {round(100 * deleted / typed)}% of what you typed, so try sketching the steps as a comment first.")
    elif s.get("hot_line"):
        out.append(f"Line {s['hot_line']} took the most rewrites.")
    else:
        out.append("Clean run.")
    out.append(f"Keep: {task['concept']}.")
    return " ".join(out)


# ---------------------------------------------------------------- generated courses

gen_lock = threading.Lock()


def generate_pack(topic):
    """Ask Claude for a Python course on a topic; keep only tasks whose solution passes its tests."""
    if not AI:
        return {"error": "Generating a course needs AI hints to be on."}
    topic = " ".join(str(topic).split())[:120]
    if not topic:
        return {"error": "Type a topic first."}
    try:
        raw = ai_text(GENERATE_SYSTEM, f"Topic: {topic}", effort="medium", timeout=280, max_tokens=16000)
        start, end = raw.find("{"), raw.rfind("}")
        pack = json.loads(raw[start:end + 1])
        tasks, seen = [], set()
        for task in pack["tasks"]:
            task["id"] = re.sub(r"[^a-z0-9_]", "_", str(task["id"]).lower())
            if task["id"] in seen or not task.get("tests") or not task.get("solution"):
                continue
            if run_python(task, task["solution"])["ok"] and not run_python(task, "")["ok"]:
                seen.add(task["id"])
                tasks.append(task)
        if len(tasks) < 3:
            return {"error": "The generated course did not pass its own tests. Try again or rephrase the topic."}
    except Exception as exc:
        print(f"[tutor] course generation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return {"error": "Could not generate a course. Try again."}
    slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:40] or "course"
    pack_id = f"gen-{slug}"
    out = {
        "name": str(pack.get("name") or topic)[:60], "runner": "python", "order": 900,
        "description": str(pack.get("description") or f"Generated course on {topic}")[:200], "tasks": tasks,
    }
    with gen_lock:
        (PACKS_DIR / pack_id).mkdir(exist_ok=True)
        (PACKS_DIR / pack_id / "pack.json").write_text(json.dumps(out, indent=2))
        PACKS[pack_id] = normalise_pack(out, pack_id)
    return {"pack_id": pack_id, "tasks": len(tasks)}


# ---------------------------------------------------------------- http

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
}
LOCAL_HOSTS = {"127.0.0.1", "localhost"}
log_lock = threading.Lock()


def pack_index():
    return [
        {"id": p["id"], "name": p["name"], "runner": p["runner"], "description": p["description"], "count": len(p["tasks"])}
        for p in PACKS.values()
    ]


class Handler(BaseHTTPRequestHandler):
    server_version = "HomeRowTutor/0.2"

    def log_message(self, fmt, *args):
        pass

    # The server executes code, so only this machine's own page may call it.
    def trusted(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in LOCAL_HOSTS:
            return False
        origin = self.headers.get("Origin")
        return origin is None or urlparse(origin).hostname in LOCAL_HOSTS

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_text_stream(self, chunks, source):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Hint-Source", source)
        self.end_headers()  # HTTP/1.0: body ends when the connection closes
        try:
            for chunk in chunks:
                self.wfile.write(chunk.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # learner moved on
        except Exception as exc:
            print(f"[tutor] stream interrupted: {type(exc).__name__}: {exc}", file=sys.stderr)

    def stream_ai_or_fallback(self, system, user, fallback):
        """Stream from Claude; if it fails before any text, send the fallback."""
        if AI:
            gen = ai_stream(system, user)
            try:
                first = next(gen, None)
            except Exception as exc:
                print(f"[tutor] AI call failed, using authored text: {type(exc).__name__}: {exc}", file=sys.stderr)
                first = None
            if first is not None:
                def chunks():
                    yield first
                    yield from gen
                return self.send_text_stream(chunks(), "ai")
        self.send_text_stream([fallback], "pack")

    def do_GET(self):
        if not self.trusted():
            return self.send_error(403)
        url = urlparse(self.path)
        if url.path == "/api/packs":
            return self.send_json({"ai": AI, "model": MODEL, "sandbox": SANDBOX, "packs": pack_index()})
        if url.path == "/api/pack":
            pack = PACKS.get((parse_qs(url.query).get("id") or [""])[0])
            return self.send_json(public_pack(pack)) if pack else self.send_error(404)
        rel = "index.html" if url.path == "/" else url.path.lstrip("/")
        target = (STATIC / rel).resolve()
        if not target.is_relative_to(STATIC) or not target.is_file():
            return self.send_error(404)
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.trusted() or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_error(403)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.send_error(413)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_error(400)
        path = urlparse(self.path).path
        if path == "/api/log":
            SESSIONS.mkdir(exist_ok=True)
            body["saved_at"] = datetime.datetime.now().isoformat(timespec="seconds")
            with log_lock, open(SESSIONS / f"{datetime.date.today()}.jsonl", "a") as f:
                f.write(json.dumps(body) + "\n")
            return self.send_json({"ok": True})
        if path == "/api/generate":
            return self.send_json(generate_pack(body.get("topic", "")))
        pack, task = find_task(body)
        if task is None:
            return self.send_error(404)
        if path == "/api/run" and pack["runner"] in RUNNERS:
            return self.send_json(RUNNERS[pack["runner"]](task, body.get("code", "")))
        if path == "/api/eval" and pack["runner"] in EVALS:
            return self.send_json({"output": EVALS[pack["runner"]](task, body.get("code", ""), str(body.get("expr", "")))})
        if path == "/api/hint":
            text, source = make_hint(pack, task, body)
            return self.send_text_stream([text], source)
        if path == "/api/review":
            return self.stream_ai_or_fallback(REVIEW_SYSTEM, review_prompt(pack, task, body), pack_review(task, body))
        self.send_error(404)


# ---------------------------------------------------------------- command line


def selftest():
    """Run every reference solution through its runner. Vim packs are checked in the browser."""
    failures = 0
    for pack in PACKS.values():
        runner = RUNNERS.get(pack["runner"])
        ids = [t["id"] for t in pack["tasks"]]
        if len(ids) != len(set(ids)):
            failures += 1
            print(f"FAIL {pack['id']}: duplicate task ids")
        if not runner:
            print(f"skip {pack['id']}: {len(ids)} {pack['runner']} tasks (validated in the browser)")
            continue
        bad = []
        for task in pack["tasks"]:
            good = runner(task, task["solution"])
            empty = runner(task, task.get("starter", ""))
            if not good["ok"] or empty["ok"]:
                bad.append(task["id"])
                print(f"FAIL {pack['id']}/{task['id']}: solution ok={good['ok']}, starter ok={empty['ok']}")
                print("     ", json.dumps(good)[:700])
        failures += len(bad)
        print(f"{'FAIL' if bad else 'ok  '} {pack['id']}: {len(ids) - len(bad)}/{len(ids)} solutions pass")
    py = next((p for p in PACKS.values() if p["runner"] == "python"), None)
    if py:
        loop = run_python(py["tasks"][0], "while True:\n    pass\n")
        ok = bool(loop["error"]) and loop["error"]["type"] == "Timeout"
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} infinite loop times out")
    print(f"sandbox: {'on' if SANDBOX else 'off (not available on this system)'}")
    return 1 if failures else 0


def report():
    """Instructor view: aggregate the saved session logs per task."""
    rows = {}
    for path in sorted(SESSIONS.glob("*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                s = json.loads(line)
            except ValueError:
                continue
            rows.setdefault((s.get("pack_id", "?"), s.get("task_id", "?")), []).append(s)
    if not rows:
        return print("No sessions saved yet. Solve a task first.")
    print(f"{'course/task':<34}{'solves':>7}{'median time':>13}{'runs':>6}{'hints':>7}{'dismissed':>11}  top failure")
    for (pack_id, task_id), sessions in sorted(rows.items(), key=lambda kv: -statistics.median(s.get("stats", {}).get("elapsed_s", 0) for s in kv[1])):
        st = [s.get("stats", {}) for s in sessions]
        events = [e for s in sessions for e in s.get("events", [])]
        fails = {}
        for e in events:
            if e.get("type") == "run" and e.get("label"):
                fails[e["label"]] = fails.get(e["label"], 0) + 1
        top = max(fails, key=fails.get) if fails else "-"
        hints = sum(1 for e in events if e.get("type") == "hint")
        dismissed = sum(1 for e in events if e.get("type") == "dismiss")
        med = int(statistics.median(x.get("elapsed_s", 0) for x in st))
        print(
            f"{(pack_id + '/' + task_id)[:33]:<34}{len(sessions):>7}{f'{med // 60}m{med % 60:02d}s':>13}"
            f"{statistics.mean(x.get('runs', 0) for x in st):>6.1f}{hints / len(sessions):>7.1f}"
            f"{(f'{round(100 * dismissed / hints)}%' if hints else '-'):>11}  {top}"
        )
    print("\nSorted by median time, slowest first. 'dismissed' is the share of hints the learner dismissed.")


def export(dest):
    """Write a static, server-less copy: Python runs in the browser (Pyodide), Vim is client-side."""
    dest = Path(dest).resolve()
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(STATIC, dest)
    packs = [public_pack(p, keep=("tests",)) for p in PACKS.values() if p["runner"] in ("python", "vim")]
    for pack in packs:
        if pack["runner"] == "python":
            for task, full in zip(pack["tasks"], PACKS[pack["id"]]["tasks"]):
                task["tests"] = py_tests(full)
                task["requires"] = full.get("requires", [])
    (dest / "packs.json").write_text(json.dumps({"packs": packs, "harness": PY_HARNESS, "eval": PY_EVAL}))
    print(f"Static site written to {dest} ({len(packs)} courses). Serve it with any web server, e.g.\n"
          f"  python3 -m http.server -d {dest} 8000")


def main():
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if "--report" in sys.argv:
        return report()
    if "--export" in sys.argv:
        i = sys.argv.index("--export")
        return export(sys.argv[i + 1] if len(sys.argv) > i + 1 else "dist")
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        sys.exit(f"Cannot listen on port {PORT} ({exc}). Set TUTOR_PORT to use another port.")
    url = f"http://127.0.0.1:{PORT}"
    if BACKEND == "api":
        mode = f"AI hints on ({MODEL}, via the API)"
    elif BACKEND == "cli":
        mode = f"AI hints on ({MODEL}, via the claude CLI and its login)"
    else:
        mode = "offline hints (set ANTHROPIC_API_KEY or install the claude CLI for AI hints)"
    courses = ", ".join(f"{p['name']} ({len(p['tasks'])})" for p in PACKS.values())
    print(f"Home Row Tutor: {url}\nCourses: {courses}\n{mode}\n"
          f"Learner code sandbox: {'on' if SANDBOX else 'off'}\nCtrl-C to stop.", flush=True)
    if "--no-open" not in sys.argv:
        threading.Timer(0.3, webbrowser.open, [url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
