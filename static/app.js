// Home Row Tutor client: editor, keystroke capture, stuck detection, hint ladder,
// spaced review, checkpoints, and the keyboard menu.
// Everything that decides WHEN to speak runs here, off the local event log.
// The server is only asked to run code and to phrase a hint. See SPEC.md.
import {
  EditorState, StateField, StateEffect, Prec, StreamLanguage, shell, vim, Vim, getCM,
  EditorView, Decoration, WidgetType, keymap, lineNumbers, highlightActiveLine, drawSelection,
  defaultKeymap, history, historyKeymap, indentMore, indentLess,
  indentUnit, bracketMatching, indentOnInput, python, oneDark,
} from "./vendor/cm.js";

// Seconds, except churn/repeat (counts) and checkpoint (chars typed; 0 = off).
const THRESHOLDS = {
  quiet:  { pause: 60, churn: 5, repeat: 3, checkpoint: 0,   cooldown: 90 },
  normal: { pause: 25, churn: 3, repeat: 2, checkpoint: 120, cooldown: 45 },
  chatty: { pause: 12, churn: 2, repeat: 2, checkpoint: 60,  cooldown: 20 },
};
const CHAT_LEVELS = Object.keys(THRESHOLDS);
const CHURN_WINDOW_S = 90;
const CHURN_MIN_DELETE = 5;
const CHECKPOINT_SETTLE_S = 4;
const SETTLE_S = 1.5;          // automatic hints wait for a gap in typing
const READ_HINT_S = 8;         // a hint must be on screen this long before ^L escalates
const QUICK_DISMISS_S = 8;     // dismissing faster than this counts as "not wanted"
const REVIEW_DAYS = [0, 1, 3, 7, 16, 35]; // days until the next review, by box
const MAX_REVIEWS = 3;

const params = new URLSearchParams(location.search);
// ?speed=10 makes every timer 10x shorter; ?days=2 pretends it is two days later.
const SPEED = Number(params.get("speed")) || 1;
const DAY_OFFSET = Number(params.get("days")) || 0;
const secs = (s) => (s * 1000) / SPEED;
const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 864e5) + DAY_OFFSET;

const $ = (id) => document.getElementById(id);
const STORE_KEY = "hrt:v2";

let backend;
let pack;
let view;
let store = { pack: null, chat: "normal", vim: false, dismissStreak: 0, requestStreak: 0, packs: {}, history: [], mistakes: {}, lastClean: null };
let A; // state of the current task attempt
let reviewQueue = [];
let menu = null;

// ---------------------------------------------------------------- backends

const post = (path, body, signal) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

async function readStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (onText) onText(text);
  }
  return text.trim();
}

function localReview(task, s) {
  const took = s.elapsed_s >= 60 ? `${Math.floor(s.elapsed_s / 60)}m${String(s.elapsed_s % 60).padStart(2, "0")}s` : `${s.elapsed_s}s`;
  const out = [`Solved in ${took} with ${s.runs} run${s.runs === 1 ? "" : "s"} and ${s.hints} hint${s.hints === 1 ? "" : "s"}.`];
  if (s.keys && s.par) out.push(s.keys > s.par ? `${s.keys} keys against a par of ${s.par}.` : `At par: ${s.keys} keys.`);
  else if (s.top_error) out.push(`Most of the friction was ${s.top_error} (${s.top_error_n}x).`);
  else out.push("Clean run.");
  out.push(`Keep: ${task.concept}.`);
  return out.join(" ");
}

async function serverBackend() {
  const res = await fetch("api/packs");
  if (!res.ok) throw new Error("no server");
  const meta = await res.json();
  return {
    static: false, ai: meta.ai, model: meta.model, packs: meta.packs,
    async refresh() { this.packs = (await (await fetch("api/packs")).json()).packs; },
    getPack: async (id) => (await fetch(`api/pack?id=${encodeURIComponent(id)}`)).json(),
    run: async (body) => (await post("api/run", body)).json(),
    scratch: async (body) => (await (await post("api/eval", body)).json()).output,
    async hint(body, signal) {
      const res = await post("api/hint", body, signal);
      if (!res.ok) throw new Error(`hint request failed (${res.status})`);
      return { text: await readStream(res), source: res.headers.get("X-Hint-Source") || "pack" };
    },
    async review(body, onText) {
      const res = await post("api/review", body);
      if (!res.ok) throw new Error("review failed");
      return readStream(res, onText);
    },
    log: (body) => post("api/log", body).catch(() => {}),
    generate: async (topic) => (await post("api/generate", { topic })).json(),
  };
}

// Server-less build (python3 server.py --export): Python runs in the browser via Pyodide.
async function staticBackend() {
  const data = await (await fetch("packs.json")).json();
  let worker = null;
  let seq = 0;
  let loaded = false;
  const runPy = (files, script, out) =>
    new Promise((resolve) => {
      if (!worker) {
        worker = new Worker("pyworker.js");
        loaded = false;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        worker.terminate();
        worker = null;
        resolve({ timeout: true });
      }, loaded ? 8000 : 90000);
      if (!loaded) flash("loading Python (first run only)…");
      worker.onmessage = (e) => {
        if (e.data.id !== id) return;
        clearTimeout(timer);
        loaded = true;
        resolve(e.data);
      };
      worker.postMessage({ id, files, script, out });
    });
  const find = (b) => data.packs.find((p) => p.id === b.pack_id).tasks.find((t) => t.id === b.task_id);
  return {
    static: true, ai: false, model: "", packs: data.packs.map((p) => ({ id: p.id, name: p.name, runner: p.runner, description: p.description, count: p.tasks.length })),
    async refresh() {},
    getPack: async (id) => data.packs.find((p) => p.id === id),
    async run(body) {
      const task = find(body);
      const r = await runPy({ "solution.py": body.code, "tests.json": JSON.stringify(task.tests) }, data.harness, "result.json");
      let result;
      if (r.timeout) result = { error: { type: "Timeout", message: "ran too long; is there a loop that never ends?", line: null }, tests: [], stdout: "" };
      else if (r.error) result = { error: { type: "RunnerError", message: r.error, line: null }, tests: [], stdout: "" };
      else result = JSON.parse(r.out);
      for (const [pattern, label] of task.requires || []) {
        result.tests.push({ call: label, note: true, ok: new RegExp(pattern, "m").test(body.code), expected: null, got: null, error: null });
      }
      result.total = result.tests.length;
      result.passed = result.tests.filter((t) => t.ok).length;
      result.ok = result.total > 0 && result.passed === result.total && !result.error;
      return result;
    },
    async scratch(body) {
      const r = await runPy({ "solution.py": body.code, "expr.txt": body.expr }, data.eval, null);
      return r.timeout ? "ran too long" : (r.stdout || r.error || "").trim();
    },
    hint: async (body) => ({ text: find(body).hints[Math.max(1, Math.min(3, body.level)) - 1], source: "pack" }),
    async review(body, onText) {
      const text = localReview(find(body), body.stats);
      onText(text);
      return text;
    },
    log: async () => {},
  };
}

// ---------------------------------------------------------------- storage

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) store = { ...store, ...saved };
  } catch {}
  if (!THRESHOLDS[store.chat]) store.chat = "normal";
}

const P = () => (store.packs[pack.id] ||= { task: 0, code: {}, done: [], sr: {}, cps: {} });

function saveStore() {
  if (A && view && A.mode === "task" && !A.vimTask) P().code[A.task.id] = view.state.doc.toString();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {}
}

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStore, 300);
}

// ---------------------------------------------------------------- editor decorations

const setHint = StateEffect.define();
const setErrorLine = StateEffect.define();

class HintWidget extends WidgetType {
  constructor(text, keys) {
    super();
    this.text = text;
    this.keys = keys;
  }
  eq(other) {
    return other.text === this.text && other.keys === this.keys;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "hint";
    el.append(this.text);
    const keys = document.createElement("span");
    keys.className = "hint-keys";
    keys.textContent = this.keys;
    el.append(keys);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// The hint is a decoration, not document text: it never touches code, cursor or undo.
const hintField = StateField.define({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos, 1) };
    for (const e of tr.effects) if (e.is(setHint)) value = e.value;
    return value;
  },
});

const hintDecorations = EditorView.decorations.compute([hintField], (state) => {
  const hint = state.field(hintField);
  if (!hint) return Decoration.none;
  const at = state.doc.lineAt(Math.min(hint.pos, state.doc.length)).to;
  return Decoration.set([
    Decoration.widget({ widget: new HintWidget(hint.text, hint.keys), block: true, side: 1 }).range(at),
  ]);
});

// Marks the line an error was reported on, until the next edit.
const errorLineField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none;
    for (const e of tr.effects) {
      if (!e.is(setErrorLine)) continue;
      const n = e.value;
      value = n && n <= tr.state.doc.lines
        ? Decoration.set([Decoration.line({ class: "error-line" }).range(tr.state.doc.line(n).from)])
        : Decoration.none;
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const hintVisible = () => view.state.field(hintField) !== null;
const clearHint = () => hintVisible() && view.dispatch({ effects: setHint.of(null) });

function showHint(text) {
  const current = view.state.field(hintField);
  const pos = current ? current.pos : view.state.selection.main.head;
  const keys = A.vimTask ? "^L more   ^G dismiss   :ask to reply" : "^L more   ^G dismiss   #? reply";
  view.dispatch({ effects: setHint.of({ text, pos, keys }) });
}

// ---------------------------------------------------------------- editor

function insertSoftTab(v) {
  const { main } = v.state.selection;
  if (!main.empty) return indentMore(v);
  const col = main.head - v.state.doc.lineAt(main.head).from;
  v.dispatch(v.state.replaceSelection(" ".repeat(4 - (col % 4))), { userEvent: "input" });
  return true;
}

const cmd = (fn) => () => (fn(), true);
const LANGS = { python: () => python(), bash: () => StreamLanguage.define(shell) };

function makeState(doc, { lang, vimOn }) {
  return EditorState.create({
    doc,
    extensions: [
      Prec.highest(keymap.of([
        { key: "Ctrl-j", run: cmd(runOrReset) },
        { key: "Ctrl-l", run: cmd(() => requestHint("request")) },
        { key: "Ctrl-g", run: cmd(dismiss) },
        { key: "Ctrl-s", run: cmd(next) },
        { key: "Ctrl-;", run: cmd(openMenu) },
        { key: "Tab", run: insertSoftTab },
        { key: "Shift-Tab", run: indentLess },
      ])),
      vimOn ? vim() : [],
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      indentUnit.of("    "),
      LANGS[lang] ? LANGS[lang]() : [],
      oneDark,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      hintField,
      hintDecorations,
      errorLineField,
      EditorView.updateListener.of(onUpdate),
    ],
  });
}

const posOf = (state, [line, col]) => {
  const l = state.doc.line(Math.min(line, state.doc.lines));
  return Math.min(l.from + col, l.to);
};

function loadEditor(doc, cursor) {
  const vimOn = A.vimTask || store.vim;
  const lang = A.vimTask ? A.task.lang : pack.runner;
  const state = makeState(doc, { lang, vimOn });
  if (view) view.setState(state);
  else view = new EditorView({ state, parent: $("editor") });
  const blank = doc.indexOf("____");
  if (cursor) view.dispatch({ selection: { anchor: posOf(view.state, cursor) } });
  else if (blank >= 0) view.dispatch({ selection: { anchor: blank, head: blank + 4 } });
  else view.dispatch({ selection: { anchor: doc.length } });
  view.focus();
}

// ---------------------------------------------------------------- capture

const now = () => performance.now() - A.t0;

function logEdit(type, line, n) {
  const t = now();
  const last = A.events.at(-1);
  if (last && last.type === type && last.line === line && t - last.t < 1000) {
    last.n += n;
    last.t = t;
  } else {
    A.events.push({ type, t, line, n });
  }
  if (type === "del") {
    A.deleted += n;
    A.pendingDelete += n;
  } else {
    // Retyping after a sizeable deletion is one "delete burst", the churn signal.
    if (A.pendingDelete >= CHURN_MIN_DELETE) A.bursts.push(t);
    A.pendingDelete = 0;
    A.typed += n;
    A.sinceCheckpoint += n;
  }
  A.editsSinceHint += n;
}

function onUpdate(update) {
  if (!A) return;
  if (A.vimTask && (update.docChanged || update.selectionSet)) setTimeout(checkGoal);
  if (!update.docChanged) return;
  let completedLine = null;
  update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    const line = update.state.doc.lineAt(fromB).number;
    if (toA > fromA) logEdit("del", line, toA - fromA);
    if (inserted.length) logEdit("ins", line, inserted.length);
    if (inserted.lines > 1 && toA === fromA) completedLine = line;
  });
  A.lastEdit = A.lastActivity = now();
  A.pauseArmed = true;
  saveSoon();
  if (completedLine === null || A.vimTask) return;
  // Typed commands: a finished comment line that starts with #? #= #< or #>.
  const text = update.state.doc.line(completedLine).text.trim();
  if (text === "#>" || text === "#<") {
    setTimeout(() => {
      removeLine(completedLine);
      text === "#>" ? next() : go(P().task - 1);
    });
  } else if (text.startsWith("#?") && text.length > 2) {
    setTimeout(() => ask(text.slice(2).trim()));
  } else if (text.startsWith("#=") && text.length > 2) {
    setTimeout(() => scratch(text.slice(2).trim()));
  }
}

function removeLine(n) {
  const line = view.state.doc.line(n);
  view.dispatch({ changes: { from: line.from, to: Math.min(line.to + 1, view.state.doc.length) } });
}

const KEY_NAMES = { Escape: "<Esc>", Enter: "<CR>", Backspace: "<BS>", Tab: "<Tab>", " ": " " };

// Vim exercises are judged on keystrokes, so those are logged as well as edits.
function onKeydown(e) {
  if (!A || menu || !A.vimTask || e.metaKey) return;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
  let token;
  if (e.ctrlKey) {
    if ("jlgs;".includes(e.key)) return; // tutor commands
    token = e.key === "[" ? "<Esc>" : `<C-${e.key.toLowerCase()}>`;
  } else {
    token = KEY_NAMES[e.key] || (e.key.length === 1 ? e.key : `<${e.key}>`);
  }
  A.keys += 1;
  A.keysSinceHint += 1;
  A.keyLog.push(token);
  A.lastEdit = A.lastActivity = now();
  A.pauseArmed = true;
  renderKeys();
  setTimeout(checkGoal, 30);
}

// ---------------------------------------------------------------- stuck detection

function detect() {
  renderTutorState();
  if (!A || menu || A.silent) return;
  const t = now();
  const settled = !A.lastEdit || t - A.lastEdit >= secs(SETTLE_S);
  if (A.pending) {
    // A hint that arrived mid-typing waits for the next gap, then appears.
    if (A.solved) A.pending = null;
    else if (settled) deliverPending();
    return;
  }
  if (A.solved || A.inflight || A.running || !settled) return;
  const th = THRESHOLDS[store.chat];
  if (t - A.lastHint < secs(th.cooldown)) return;

  if (A.repeat >= th.repeat + (A.vimTask ? 1 : 0)) {
    A.repeat = 0;
    return requestHint("repeat_error");
  }
  A.bursts = A.bursts.filter((b) => t - b < secs(CHURN_WINDOW_S));
  if (!A.vimTask && A.bursts.length >= th.churn) {
    A.bursts = [];
    return requestHint("churn");
  }
  if (A.vimTask && !A.inefficientFired && A.keys > Math.max(3 * A.task.par, A.task.par + 12)) {
    A.inefficientFired = true;
    return requestHint("inefficient");
  }
  // Before the learner has typed anything they may still be reading: wait twice as long.
  const started = A.typed || A.keys;
  const pause = secs(th.pause) * (started ? 1 : 2);
  if (A.pauseArmed && document.visibilityState === "visible" && t - A.lastActivity >= pause) {
    A.pauseArmed = false; // once per idle period
    return requestHint("pause");
  }
  if (
    backend.ai && !A.vimTask && th.checkpoint && A.sinceCheckpoint >= th.checkpoint &&
    t - A.lastEdit >= secs(CHECKPOINT_SETTLE_S)
  ) {
    A.sinceCheckpoint = 0;
    return requestHint("checkpoint");
  }
}

function renderTutorState() {
  if (!A) return;
  const th = THRESHOLDS[store.chat];
  const cooling = secs(th.cooldown) - (now() - A.lastHint);
  let state = "watching";
  if (A.silent) state = "silent (checkpoint)";
  else if (A.solved) state = "done";
  else if (A.inflight) state = "thinking";
  else if (A.pending) state = "has a hint, waiting for a gap";
  else if (cooling > 0) state = `cooling down ${Math.ceil((cooling * SPEED) / 1000)}s`;
  $("tutor").textContent = `tutor: ${state}`;
}

// ---------------------------------------------------------------- digest

const fmtTime = (ms) => {
  const s = Math.round((ms * SPEED) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

function describeEvent(e) {
  switch (e.type) {
    case "ins": return `+${e.n} L${e.line}`;
    case "del": return `-${e.n} L${e.line}`;
    case "run": return `run ${e.passed}/${e.total}${e.label ? " " + e.label : ""}`;
    case "reset": return `reset after ${e.keys} keys`;
    case "hint": return `hint level ${e.level} (${e.trigger})`;
    case "dismiss": return "dismissed hint";
    case "ask": return `asked "${e.q}"`;
    case "scratch": return `tried "${e.expr}"`;
  }
}

function hotLines() {
  const rewrites = new Map();
  for (const e of A.events) {
    if (e.type === "del" && e.n >= 3) rewrites.set(e.line, (rewrites.get(e.line) || 0) + 1);
  }
  return [...rewrites].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3);
}

const hintCount = () => A.events.filter((e) => e.type === "hint" && e.trigger !== "ask").length;

// Compact text form of the history, for the model.
function digest() {
  const runs = A.events.filter((e) => e.type === "run");
  const out = [
    `time on task ${fmtTime(now())}; runs ${runs.length}; typed ${A.typed} chars; ` +
      `deleted ${A.deleted} chars; hints so far ${hintCount()}`,
  ];
  if (A.vimTask) out.push(`keystrokes this attempt ${A.keys} (par ${A.task.par}); resets ${A.resets}`);
  if (A.mode === "review") out.push("this is a spaced review of a task solved before; the lesson is hidden");
  const errors = runs.filter((r) => r.label).map((r) => r.label).slice(-6);
  if (errors.length) out.push(`run failures in order: ${errors.join(" > ")}`);
  const hot = hotLines();
  if (hot.length) out.push(`most rewritten: ${hot.map(([l, n]) => `L${l} (${n}x)`).join(", ")}`);
  const tail = A.events.slice(-25);
  const timeline = [];
  let prev = tail.length ? tail[0].t : 0;
  for (const e of tail) {
    if (e.t - prev > secs(5)) timeline.push(`pause ${fmtTime(e.t - prev)}`);
    timeline.push(describeEvent(e));
    prev = e.t;
  }
  if (now() - prev > secs(5)) timeline.push(`pause ${fmtTime(now() - prev)} (now)`);
  out.push(`recent (+typed/-deleted chars, L=line): ${timeline.join(", ")}`);
  return out.join("\n");
}

function stats() {
  const fails = new Map();
  for (const e of A.events) {
    if (e.type === "run" && e.label) fails.set(e.label, (fails.get(e.label) || 0) + 1);
  }
  const top = [...fails].sort((a, b) => b[1] - a[1])[0];
  const hot = hotLines()[0];
  return {
    elapsed_s: Math.round((now() * SPEED) / 1000),
    runs: A.events.filter((e) => e.type === "run").length,
    hints: hintCount(),
    typed: A.typed,
    deleted: A.deleted,
    keys: A.vimTask ? A.keys : null,
    par: A.vimTask ? A.task.par : null,
    top_error: top && top[1] > 1 ? top[0] : null,
    top_error_n: top ? top[1] : 0,
    hot_line: hot ? hot[0] : null,
    mode: A.mode,
  };
}

// ---------------------------------------------------------------- hints

const attemptedSinceHint = () =>
  A.editsSinceHint >= 10 || A.keysSinceHint >= 3 || A.runsSinceHint > 0 || A.askedSinceHint;

function ask(q) {
  if (!q) return;
  A.events.push({ type: "ask", t: now(), q });
  A.askedSinceHint = true;
  requestHint("ask", q);
}

async function requestHint(trigger, question) {
  const explicit = trigger === "request" || trigger === "ask";
  if (A.silent) {
    if (explicit) flash("checkpoint: no hints here. ^S twice skips it");
    return;
  }
  if (A.solved && !explicit) return;
  if (trigger === "request" && A.level >= 1) {
    // The ladder cannot be clicked through: each step up needs an attempt (or, for the
    // first step, time to read the hint).
    const allowed = A.level === 1
      ? attemptedSinceHint() || now() - A.hintShownAt >= secs(READ_HINT_S)
      : attemptedSinceHint();
    if (A.level >= 3 || !allowed) {
      if (!hintVisible() && A.lastHintText) showHint(A.lastHintText);
      return flash(A.level >= 3
        ? "that is the biggest hint: try it, or ask a question"
        : "try it first: edit, run, or reply to the hint. Then ^L");
    }
  }
  if (A.inflight) {
    if (!explicit) return;
    A.inflight.abort();
  }
  A.pending = null;
  const attempt = A;
  const level = trigger === "ask" ? Math.max(A.level, 1) : Math.min(A.level + 1, 3);
  const ctrl = new AbortController();
  A.inflight = ctrl;
  // Asked-for hints acknowledge at once; automatic ones stay invisible until they have words.
  if (explicit) {
    clearHint();
    showHint("…");
  }
  try {
    const head = view.state.selection.main.head;
    const { text, source } = await backend.hint({
      pack_id: pack.id,
      task_id: A.task.id,
      code: view.state.doc.toString(),
      cursor_line: view.state.doc.lineAt(head).number,
      level,
      trigger,
      question: question || null,
      digest: digest(),
      keys: A.vimTask ? A.keyLog.slice(-80).join("") : null,
      last_run: A.lastRun,
      prior_hints: A.priorHints,
    }, ctrl.signal);
    if (attempt !== A || ctrl.signal.aborted) return;
    // A checkpoint reply of "OK" means "leave them alone".
    if (!text || (trigger === "checkpoint" && text === "OK")) {
      if (explicit) clearHint();
      return;
    }
    const hint = { text, level, trigger, source, explicit };
    if (explicit) commitHint(hint);
    else A.pending = hint; // shown by detect() at the next gap in typing
  } catch (err) {
    if (err.name !== "AbortError" && explicit) {
      clearHint();
      flash("tutor unavailable: is the server running?");
    }
  } finally {
    if (attempt.inflight === ctrl) attempt.inflight = null;
  }
}

function deliverPending() {
  const hint = A.pending;
  A.pending = null;
  clearHint();
  commitHint(hint);
}

function commitHint({ text, level, trigger, source, explicit }) {
  showHint(text);
  A.lastHintText = text;
  A.hintAuto = !explicit;
  A.lastHint = A.hintShownAt = now();
  if (trigger !== "ask") {
    A.level = level;
    A.editsSinceHint = A.keysSinceHint = A.runsSinceHint = 0;
    A.askedSinceHint = false;
  }
  A.priorHints.push(text);
  A.events.push({ type: "hint", t: now(), level, trigger, source });
  // Chattiness adapts: asking again and again turns the tutor up a notch.
  if (trigger === "request") {
    store.requestStreak += 1;
    if (store.requestStreak >= 4 && store.chat !== "chatty") shiftChat(1, "you keep asking for hints");
  } else if (!explicit) {
    store.requestStreak = 0;
  }
}

function dismiss() {
  if (A.inflight) A.inflight.abort();
  A.pending = null;
  if (!hintVisible()) return;
  clearHint();
  A.events.push({ type: "dismiss", t: now() });
  // ...and dismissing automatic hints on sight turns it down.
  if (A.hintAuto && now() - A.hintShownAt < secs(QUICK_DISMISS_S)) {
    store.dismissStreak += 1;
    if (store.dismissStreak >= 3 && store.chat !== "quiet") shiftChat(-1, "you keep dismissing hints");
  } else {
    store.dismissStreak = 0;
  }
  A.lastHint = now(); // a dismissal also means "not now"
}

function shiftChat(step, why) {
  store.chat = CHAT_LEVELS[CHAT_LEVELS.indexOf(store.chat) + step];
  store.dismissStreak = store.requestStreak = 0;
  saveStore();
  renderMode();
  flash(`tutor is now ${store.chat} (${why}); change it in the ^; menu`);
}

// ---------------------------------------------------------------- run (python, bash)

const strip = (s) => String(s).replace(/'[^']*'|"[^"]*"|\d+/g, "_");

function signature(res) {
  if (res.ok) return null;
  if (res.error) return `${res.error.type}: ${strip(res.error.message)}`;
  const raised = res.tests.find((t) => t.error);
  if (raised) return `${raised.error.type}: ${strip(raised.error.message)}`;
  return "wrong:" + res.tests.map((t, i) => (t.ok ? "" : i)).join(",") + strip(res.stderr || "");
}

function failureLabel(res) {
  if (res.ok) return null;
  if (res.error) return res.error.type;
  const raised = res.tests.find((t) => t.error);
  if (raised) return raised.error.type;
  if (res.stderr) return res.stderr.split("\n")[0].slice(0, 60);
  const failing = res.tests.find((t) => !t.ok);
  return failing && failing.note ? `missing: ${failing.call}` : "wrong result";
}

function line(cls, text) {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}

function renderRun(res) {
  const out = $("output");
  out.replaceChildren(line(res.ok ? "pass" : "summary", `${res.passed}/${res.total} checks passed`));
  if (res.error) {
    const where = res.error.line ? ` on line ${res.error.line}` : "";
    out.append(line("fail", `${res.error.type}${where}: ${res.error.message}`));
  }
  if (res.stderr) out.append(line("fail", res.stderr));
  const block = pack.runner === "bash";
  for (const t of res.error ? [] : res.tests) {
    if (t.ok) out.append(line("pass", `✓ ${t.call}`));
    else if (t.note) out.append(line("fail", `✗ not yet: ${t.call}`));
    else if (t.error) out.append(line("fail", `✗ ${t.call} raised ${t.error.type}: ${t.error.message}`));
    else if (t.expected === null || t.expected === undefined) out.append(line("fail", `✗ ${t.call}`));
    else if (block) out.append(line("fail", `✗ ${t.call}\n  got:\n${indent(t.got)}\n  expected:\n${indent(t.expected)}`));
    else out.append(line("fail", `✗ ${t.call}: got ${t.got}, expected ${t.expected}`));
  }
  if (res.stdout) out.append(line("", `printed:\n${res.stdout.trimEnd()}`));
  out.scrollTop = 0;
}

const indent = (s) => String(s).split("\n").map((l) => "    " + l).join("\n");

function runOrReset() {
  return A.vimTask ? resetVim() : run();
}

async function run() {
  if (A.running) return;
  const attempt = A;
  A.running = true;
  let res;
  try {
    res = await backend.run({ pack_id: pack.id, task_id: A.task.id, code: view.state.doc.toString() });
  } catch {
    attempt.running = false;
    return flash("could not run: is the server running?");
  }
  attempt.running = false;
  if (attempt !== A) return;

  const sig = signature(res);
  A.repeat = sig && sig === A.lastSig ? A.repeat + 1 : sig ? 1 : 0;
  A.lastSig = sig;
  A.lastRun = res;
  A.lastActivity = now();
  A.pauseArmed = true;
  A.runsSinceHint += 1;
  if (!res.ok) A.failedRuns += 1;
  A.events.push({ type: "run", t: now(), passed: res.passed, total: res.total, err: sig, label: failureLabel(res) });
  if (res.passed > A.best) {
    A.best = res.passed;
    A.level = 0; // moving again: the ladder starts over
  }
  renderRun(res);
  view.dispatch({ effects: setErrorLine.of(res.error && res.error.line ? res.error.line : firstErrorLine(res)) });
  if (res.ok && !A.solved) solved();
  else detect();
}

const firstErrorLine = (res) => {
  const raised = (res.tests || []).find((t) => t.error && t.error.line);
  return raised ? raised.error.line : null;
};

// Inline scratch: a line "#= expression" is evaluated and shown, without touching the task.
async function scratch(expr) {
  if (!expr || !backend.scratch) return;
  A.events.push({ type: "scratch", t: now(), expr });
  let output;
  try {
    output = await backend.scratch({ pack_id: pack.id, task_id: A.task.id, code: view.state.doc.toString(), expr });
  } catch {
    output = "could not run";
  }
  const el = line("scratch", `#= ${expr}\n${output}`);
  $("output").prepend(el);
  $("output").scrollTop = 0;
}

// ---------------------------------------------------------------- vim exercises

function vimState() {
  const cm = getCM(view);
  return (cm && cm.state.vim) || {};
}

function renderKeys() {
  if (!A.vimTask || A.goalReached) return;
  $("output").replaceChildren(line("", `keys: ${A.keys}   par: ${A.task.par}   ^J starts over`));
}

function checkGoal() {
  if (!A || !A.vimTask || A.goalReached || !A.keys) return;
  const vs = vimState();
  if (vs.insertMode || vs.visualMode) return; // finish in normal mode
  const goal = A.task.goal;
  const state = view.state;
  if (goal.text !== undefined && state.doc.toString().replace(/\n$/, "") !== goal.text.replace(/\n$/, "")) return;
  if (goal.cursor) {
    const head = state.selection.main.head;
    const l = state.doc.lineAt(head);
    if (l.number !== goal.cursor[0] || head - l.from !== goal.cursor[1]) return;
  }
  if (goal.keys && !new RegExp(goal.keys).test(A.keyLog.join(""))) return;
  A.goalReached = true;
  const par = A.task.par;
  A.events.push({ type: "run", t: now(), passed: 1, total: 1, err: null, label: null, keys: A.keys });
  A.bestKeys = Math.min(A.bestKeys ?? Infinity, A.keys);
  const verdict = A.keys <= par ? `at par (${par})` : `par is ${par}: ^J to try for it`;
  $("output").replaceChildren(line("pass", `✓ goal reached in ${A.keys} keys, ${verdict}`));
  if (!A.solved) solved();
}

function resetVim() {
  if (A.keys) {
    A.events.push({ type: "reset", t: now(), keys: A.keys });
    if (!A.goalReached) {
      A.resets += 1;
      A.repeat += 1;
      A.failedRuns += 1;
    }
    A.runsSinceHint += 1;
  }
  const hint = view.state.field(hintField);
  A.keys = 0;
  A.keyLog = [];
  A.goalReached = false;
  A.inefficientFired = false;
  loadEditor(A.task.start, A.task.cursor);
  if (hint) showHint(hint.text);
  renderKeys();
}

// ---------------------------------------------------------------- solving, review schedule, records

async function solved() {
  const attempt = A;
  const task = A.task;
  A.solved = true;
  if (A.inflight) A.inflight.abort();
  A.pending = null;
  clearHint();
  const s = stats();
  const overPar = A.vimTask && A.keys > 2 * task.par;
  const struggled = s.hints > 0 || A.failedRuns >= 2 || overPar;
  const clean = !struggled && A.failedRuns === 0 && (!A.vimTask || A.keys <= task.par);
  const p = P();
  if (!p.done.includes(task.id)) p.done.push(task.id);

  // Spaced review: struggling halves the box, a clean solve moves it up one.
  const prev = p.sr[task.id];
  const box = struggled ? Math.max(1, Math.floor((prev ? prev.box : 2) / 2)) : Math.min((prev ? prev.box : 1) + 1, REVIEW_DAYS.length);
  p.sr[task.id] = box >= REVIEW_DAYS.length ? { box, due: null } : { box, due: today() + REVIEW_DAYS[box] };
  if (A.silent) p.cps[task.id] = { s: s.elapsed_s, runs: s.runs, firstTry: A.failedRuns === 0 };
  if (struggled) {
    const key = `${pack.id}/${task.id}`;
    const m = (store.mistakes[key] ||= { pack: pack.name, title: task.title, concept: task.concept, example: task.example, count: 0, errors: {}, hints: 0 });
    m.count += 1;
    m.hints += s.hints;
    for (const e of A.events) if (e.type === "run" && e.label) m.errors[e.label] = (m.errors[e.label] || 0) + 1;
  }
  store.history.push({
    d: today(), pack: pack.id, id: task.id, title: task.title, concept: task.concept, s: s.elapsed_s,
    runs: s.runs, hints: s.hints, keys: s.keys, par: s.par, struggled,
    mode: A.silent ? "checkpoint" : A.mode,
  });
  store.history = store.history.slice(-400);
  store.lastClean = clean && A.mode === "task" ? { pack: pack.id, group: task.group || null, index: p.task } : null;
  saveStore();
  renderHeader();

  if (A.mode === "review") setMessage(reviewQueue.length > 1 ? "review done: ^S for the next one" : "review done: ^S to carry on");
  else if (P().task === pack.tasks.length - 1) setMessage("solved: that was the last task of this course");
  else setMessage("solved: ^S for the next task");

  const body = {
    pack_id: pack.id, task_id: task.id, code: view.state.doc.toString(), digest: digest(), stats: s,
    keys: A.vimTask ? A.keyLog.join("") : null,
  };
  backend.log({ ...body, events: A.events });
  const review = line("review", "");
  $("output").append(review);
  try {
    await backend.review(body, (text) => {
      if (attempt === A) review.textContent = `# review ▸ ${text.trim()}`;
    });
  } catch {
    review.remove();
  }
}

const dueReviews = () =>
  pack.tasks
    .map((t, i) => ({ i, sr: P().sr[t.id] }))
    .filter((x) => x.sr && x.sr.due !== null && x.sr.due <= today())
    .sort((a, b) => a.sr.due - b.sr.due)
    .slice(0, MAX_REVIEWS)
    .map((x) => x.i);

// ---------------------------------------------------------------- navigation

function next() {
  const armed = A.skipArmed !== null && performance.now() - A.skipArmed < 3000;
  if (A.mode === "review") {
    if (!A.solved && !armed) {
      A.skipArmed = performance.now();
      return flash("review not solved: ^S again to skip it for now");
    }
    reviewQueue.shift();
    if (reviewQueue.length) return openTask(reviewQueue[0], "review");
    openTask(P().task, "task");
    return flash("reviews done: back to where you were");
  }
  if (A.solved || P().done.includes(A.task.id) || armed) return go(P().task + 1);
  A.skipArmed = performance.now();
  flash("not solved yet: ^S again to skip");
}

function go(i) {
  if (A.mode === "review") return flash("finish or skip the review first (^S)");
  if (i < 0) return flash("this is the first task");
  if (i >= pack.tasks.length) return flash("that was the last task: ^; opens the course menu");
  openTask(i, "task");
}

let flashTimer;
let baseMessage = "";
function setMessage(text) {
  clearTimeout(flashTimer);
  baseMessage = text;
  $("message").textContent = text;
}
function flash(text) {
  clearTimeout(flashTimer);
  $("message").textContent = text;
  flashTimer = setTimeout(() => ($("message").textContent = baseMessage), 4000);
}

function renderMode() {
  const hints = backend.ai ? `ai hints (${backend.model})` : backend.static ? "authored hints" : "offline hints";
  $("mode").textContent = `${store.chat} · ${hints}`;
}

function renderHeader() {
  const p = P();
  const done = p.done.includes(A.task.id);
  const where = A.mode === "review" ? `review ${MAX_REVIEWS_LABEL()}` : `${p.task + 1}/${pack.tasks.length}`;
  $("progress").textContent = `${pack.name} · ${where}${done ? " ✓" : ""}`;
}
const MAX_REVIEWS_LABEL = () => `(${reviewQueue.length} due)`;

function openTask(i, mode) {
  if (A) {
    if (A.inflight) A.inflight.abort();
    saveStore();
  }
  const task = pack.tasks[i];
  const p = P();
  if (mode === "task") p.task = i;
  const vimTask = pack.runner === "vim";
  A = {
    task, mode, vimTask,
    silent: !!task.checkpoint,
    t0: performance.now(),
    events: [],
    typed: 0, deleted: 0, pendingDelete: 0, bursts: [], sinceCheckpoint: 0,
    keys: 0, keyLog: [], resets: 0, goalReached: false, inefficientFired: false, bestKeys: null,
    lastEdit: 0, lastActivity: 0, lastHint: -Infinity, pauseArmed: true,
    level: 0, hintShownAt: 0, hintAuto: false, lastHintText: "", pending: null,
    editsSinceHint: 0, keysSinceHint: 0, runsSinceHint: 0, askedSinceHint: false,
    best: 0, repeat: 0, failedRuns: 0, lastSig: null, lastRun: null, priorHints: [],
    inflight: null, running: false, solved: false, skipArmed: null,
  };
  const hidden = mode === "review" || A.silent;
  $("title").textContent = task.title;
  $("concept").textContent = A.silent ? "" : task.concept;
  $("lesson-text").textContent = A.silent
    ? "Checkpoint: no lesson, no example, and the tutor stays silent. This shows what has stuck."
    : mode === "review" ? "Review: the lesson is hidden. Rebuild it from memory; hints still work." : task.lesson;
  $("lesson-text").className = hidden ? "note" : "";
  $("example").textContent = hidden ? "" : task.example || "";
  $("example").hidden = hidden || !task.example;
  $("prompt").textContent = task.prompt;
  $("keys").innerHTML = vimTask
    ? "<kbd>^J</kbd> start over <kbd>^L</kbd> hint <kbd>^G</kbd> dismiss <kbd>^S</kbd> next <kbd>^;</kbd> menu <kbd>:ask</kbd> question <kbd>jk</kbd> Esc"
    : "<kbd>^J</kbd> run <kbd>^L</kbd> hint <kbd>^G</kbd> dismiss <kbd>^S</kbd> next <kbd>^;</kbd> menu <kbd>#?</kbd> ask <kbd>#=</kbd> try";
  $("output").replaceChildren(line("", vimTask
    ? `par: ${task.par} keys. The exercise completes by itself when the goal is reached.`
    : "^J runs your work against the checks."));
  renderHeader();

  let message = "";
  const lc = store.lastClean;
  if (mode === "task" && p.done.includes(task.id)) message = "already solved: ^S for the next task";
  else if (mode === "task" && lc && lc.pack === pack.id && lc.index === i - 1 && lc.group && lc.group === task.group) {
    message = "clean solve last time: ^S twice skips this similar task";
  }
  setMessage(message);
  renderTutorState();

  if (vimTask) loadEditor(task.start, task.cursor);
  else loadEditor(mode === "review" ? task.starter || "" : p.code[task.id] ?? task.starter ?? "");
  saveStore();
}

async function switchPack(id, taskId) {
  pack = await backend.getPack(id);
  store.pack = id;
  const p = P();
  p.task = Math.min(Math.max(0, p.task | 0), pack.tasks.length - 1);
  const wanted = pack.tasks.findIndex((t) => t.id === taskId);
  if (wanted >= 0) p.task = wanted;
  reviewQueue = wanted >= 0 ? [] : dueReviews();
  if (reviewQueue.length) {
    openTask(reviewQueue[0], "review");
    flash(`${reviewQueue.length} review${reviewQueue.length === 1 ? "" : "s"} due before new material`);
  } else {
    openTask(p.task, "task");
  }
  renderMode();
}

// ---------------------------------------------------------------- menu (^;)

function openMenu() {
  showMenu(mainMenu());
}

function closeMenu() {
  menu = null;
  $("overlay").hidden = true;
  if (A) A.lastActivity = now();
  view.focus();
}

function showMenu(m) {
  menu = { index: 0, ...m };
  $("overlay").hidden = false;
  renderMenu();
}

function renderMenu() {
  const panel = $("panel");
  panel.replaceChildren(line("menu-title", menu.title));
  if (menu.items) {
    menu.items.forEach((item, i) => {
      const row = line(i === menu.index ? "menu-item selected" : "menu-item", (i === menu.index ? "› " : "  ") + item.label);
      if (item.detail) row.append(Object.assign(document.createElement("span"), { className: "menu-detail", textContent: "  " + item.detail }));
      panel.append(row);
    });
    panel.append(line("menu-keys", "j/k move   l or Enter choose   h back   g close"));
  } else if (menu.input) {
    const input = Object.assign(document.createElement("input"), { id: "menu-input", placeholder: menu.placeholder || "", autocomplete: "off", spellcheck: false });
    panel.append(input, line("menu-keys", "Enter confirm   ^G cancel"));
    input.focus();
  } else {
    const body = line("menu-text", menu.text);
    body.id = "menu-text";
    panel.append(body, line("menu-keys", "j/k scroll   h back   g close"));
  }
}

function onMenuKey(e) {
  if (!menu) return;
  const key = e.key;
  const ctrl = e.ctrlKey;
  if (menu.input) {
    if (key === "Enter") {
      e.preventDefault();
      menu.submit($("menu-input").value);
    } else if (key === "Escape" || (ctrl && (key === "g" || key === ";"))) {
      e.preventDefault();
      openMenu();
    }
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (key === "Escape" || key === "g" || key === ";" || key === "q") return closeMenu();
  if (key === "h") return menu.root ? closeMenu() : openMenu();
  if (menu.items) {
    if (key === "j" || key === "ArrowDown") menu.index = (menu.index + 1) % menu.items.length;
    else if (key === "k" || key === "ArrowUp") menu.index = (menu.index + menu.items.length - 1) % menu.items.length;
    else if (key === "l" || key === "Enter" || key === "f") return menu.items[menu.index].run();
    renderMenu();
  } else {
    const el = $("menu-text");
    if (key === "j") el.scrollTop += 60;
    if (key === "k") el.scrollTop -= 60;
  }
}

function mainMenu() {
  const vimForced = pack.runner === "vim";
  const items = [
    { label: "Courses", detail: pack.name, run: coursesMenu },
    { label: `Chattiness: ${store.chat}`, detail: "how readily the tutor speaks up", run: () => {
      store.chat = CHAT_LEVELS[(CHAT_LEVELS.indexOf(store.chat) + 1) % CHAT_LEVELS.length];
      store.dismissStreak = store.requestStreak = 0;
      saveStore();
      renderMode();
      showMenu({ ...mainMenu(), index: 1 });
    } },
    { label: `Vim keys: ${vimForced || store.vim ? "on" : "off"}`, detail: vimForced ? "this course needs them" : "edit with Vim keybindings", run: () => {
      if (!vimForced) {
        store.vim = !store.vim;
        saveStore();
        loadEditor(view.state.doc.toString());
      }
      showMenu({ ...mainMenu(), index: 2 });
    } },
    { label: "Cheat sheet", detail: `${Object.keys(store.mistakes).length} things that tripped you up`, run: () => showMenu({ title: "Cheat sheet: built from your own mistakes", text: cheatSheet() }) },
    { label: "Progress", detail: "time, hints, checkpoints, reviews", run: () => showMenu({ title: "Progress", text: progressText() }) },
  ];
  if (backend.ai && backend.generate) items.push({ label: "Teach me…", detail: "generate a Python course on any topic", run: teachMe });
  return { title: "Home Row Tutor", items, root: true };
}

function coursesMenu() {
  const items = backend.packs.map((p) => {
    const sp = store.packs[p.id];
    return {
      label: p.name, detail: `${sp ? sp.done.length : 0}/${p.count} · ${p.description}`,
      run: async () => {
        closeMenu();
        await switchPack(p.id);
      },
    };
  });
  showMenu({ title: "Courses", items, index: Math.max(0, backend.packs.findIndex((p) => p.id === pack.id)) });
}

function teachMe() {
  showMenu({
    title: "Teach me… (a Python topic, for example: recursion, string formatting, sorting)",
    input: true, placeholder: "topic",
    submit: async (topic) => {
      if (!topic.trim()) return;
      showMenu({ title: "Teach me…", text: `Writing a course on "${topic.trim()}" and testing every exercise.\nThis takes a minute or two.` });
      let res;
      try {
        res = await backend.generate(topic);
      } catch {
        res = { error: "Could not reach the server." };
      }
      if (res.error) return showMenu({ title: "Teach me…", text: res.error });
      await backend.refresh();
      closeMenu();
      await switchPack(res.pack_id);
      flash(`new course ready: ${res.tasks} tasks`);
    },
  });
}

function cheatSheet() {
  const entries = Object.values(store.mistakes).sort((a, b) => b.count - a.count);
  if (!entries.length) return "Nothing here yet. Concepts you needed hints or several runs for will be collected here, with their example, so you can look them up without leaving the keyboard.";
  return entries.map((m) => {
    const errors = Object.entries(m.errors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, n]) => `${l} ×${n}`).join(", ");
    const why = [`struggled ${m.count}×`, m.hints ? `${m.hints} hints` : "", errors].filter(Boolean).join(" · ");
    return `${m.concept}\n  ${m.pack} · ${m.title} · ${why}\n${m.example ? m.example.split("\n").map((l) => "    " + l).join("\n") + "\n" : ""}`;
  }).join("\n");
}

function progressText() {
  const out = [];
  for (const p of backend.packs) {
    const sp = store.packs[p.id];
    if (!sp) continue;
    const cps = Object.values(sp.cps || {});
    const due = Object.values(sp.sr || {}).filter((x) => x.due !== null && x.due <= today()).length;
    out.push(`${p.name}: ${sp.done.length}/${p.count} solved · unaided checkpoints ${cps.length} solved, ${cps.filter((c) => c.firstTry).length} first try · ${due} reviews due`);
  }
  const h = store.history;
  if (!h.length) return (out.join("\n") || "No courses started yet.") + "\n\nSolve a task and it shows up here.";
  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);
  const slow = new Map();
  for (const e of h) {
    const cur = slow.get(e.concept) || { s: 0, hints: 0, n: 0 };
    slow.set(e.concept, { s: cur.s + e.s, hints: cur.hints + e.hints, n: cur.n + 1 });
  }
  out.push("", "Where your time went (top concepts):");
  for (const [concept, v] of [...slow].sort((a, b) => b[1].s - a[1].s).slice(0, 6)) {
    out.push(`  ${fmt(v.s).padStart(7)}  ${v.hints} hints  ${concept}`);
  }
  out.push("", "Recent:");
  for (const e of h.slice(-15).reverse()) {
    const extra = e.keys ? `${e.keys} keys (par ${e.par})` : `${e.runs} runs`;
    out.push(`  ${fmt(e.s).padStart(7)}  ${extra}, ${e.hints} hints${e.struggled ? "  struggled" : ""}  ${e.mode === "task" ? "" : `[${e.mode}] `}${e.title}`);
  }
  out.push("", "The raw keystroke logs are in sessions/; `python3 server.py --report` summarises them per task.");
  return out.join("\n");
}

// ---------------------------------------------------------------- start

function setupVim() {
  Vim.map("jk", "<Esc>", "insert"); // Esc without leaving the home row
  Vim.defineEx("ask", "ask", (_cm, p) => ask((p.argString || "").trim()));
  Vim.defineEx("hint", "hint", () => requestHint("request"));
  Vim.defineEx("next", "next", () => next());
  Vim.defineEx("prev", "prev", () => go(P().task - 1));
  Vim.defineEx("menu", "menu", () => openMenu());
}

async function main() {
  try {
    backend = await serverBackend();
  } catch {
    backend = await staticBackend();
  }
  loadStore();
  setupVim();
  const wanted = params.get("pack") || store.pack;
  const first = backend.packs.find((p) => p.id === wanted) || backend.packs[0];
  await switchPack(first.id, params.get("task"));
  setInterval(detect, 1000);

  // The editor is the only thing that can hold focus (apart from the menu and Vim's command line).
  const refocus = () => !menu && !view.dom.contains(document.activeElement) && view.focus();
  window.addEventListener("focus", refocus);
  view.contentDOM.addEventListener("blur", () => setTimeout(() => document.hasFocus() && refocus(), 50));
  window.addEventListener("keydown", onMenuKey, true);
  $("editor").addEventListener("keydown", onKeydown, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") A.lastActivity = now();
  });
  window.addEventListener("beforeunload", saveStore);
  window.__hrt = { get view() { return view; }, get A() { return A; }, get store() { return store; }, get pack() { return pack; } };
}

main().catch((err) => {
  $("output").textContent = `Could not start: ${err.message}`;
});
