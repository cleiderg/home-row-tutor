# Home Row Tutor — Product Requirements

This document describes the product and the decisions behind it. The technical design is in `SPEC.md`.

## 1. Problem

Learning to code today means constant context switching: read a tutorial, click to an editor, type, click Run, alt-tab to search for syntax, paste an error into a chat sidebar. Every existing AI helper either writes the code for you (Copilot, Cursor, Replit) or waits in a sidebar until asked (Khanmigo, Codecademy). None of them watch *how* you get to an answer, so none can step in at the moment you are actually stuck.

## 2. Product

A single-screen editor with a tutor that watches every keystroke. The learner reads a short lesson, types code, and runs it, all without leaving the home row. The tutor stays silent during steady progress and speaks, inline in the editor, only when the edit history shows the learner is stuck. When the task is solved it reviews the process, not just the result.

## 3. Target user (v1)

One person learning a keyboard skill by typing it: Python, the command line, or Vim. Comfortable at a keyboard, new or rusty at the subject, wants muscle memory rather than reading. Runs the tool locally on their own machine.

## 4. Key decisions

| Question | Decision | Why |
|---|---|---|
| First topic | **Python syntax first**, then interview patterns, Bash, and Vim on the same engine | Python is what the first user wants to learn. Three different environments (code with tests, a shell with fixture files, an editor judged on keystrokes) now run on one engine, which is the test of the platform idea. |
| Stuck detection | **Deterministic rules in the client decide *when*; the model decides *what to say*** | Rules cost nothing, fire instantly, and are tunable. A model call on every keystroke would be slow and expensive. One model-judged check ("is this path going to work?") covers the signal rules cannot see. |
| Editor and shortcuts | **Browser page served from localhost, CodeMirror editor, Ctrl + home-row keys** | A real editor (highlighting, indentation, inline widgets) for free, and nothing to install beyond Python. Every command is Ctrl plus a home-row letter. |

## 5. Principles

1. **Hands stay on the home row.** No mouse target exists in the UI. Every action is Ctrl + a home-row key, or plain typing.
2. **Silence is the default.** Typos and half-written lines are normal. An interruption must be earned by a stuck signal.
3. **Teach, don't solve.** Hints escalate from a nudge, to a guiding question, to a worked example of a *different* problem. The tutor never writes the learner's solution.
4. **Process over result.** The tutor is given the edit history, and the end-of-task review talks about how the learner got there.
5. **Fast.** Typing never waits on the network. Runs return in well under a second. Hints stream in as they are generated.
6. **Works without the AI.** With no model available the product still runs, checks, and gives authored hints on the same stuck signals.
7. **Measure learning, not practice.** Research on AI tutors shows help can raise practice scores while lowering unaided performance, so the product tests the learner without help at regular intervals.

## 6. Requirements

### Built

- **R1 Editor.** Highlighting and auto-indent, optional Vim keybindings, no autocomplete and no bracket auto-closing: the learner types every character.
- **R2 Lessons in place.** Each task shows a short lesson and an example above the editor.
- **R3 Run and check.** One shortcut runs the work against the task's checks, sandboxed, and marks the failing line.
- **R4 Keystroke capture.** Every edit, pause, run, keystroke (in Vim), and hint is logged with a timestamp.
- **R5 Stuck detection.** Long pause, repeated delete-and-retype, the same failure on consecutive runs, far too many keystrokes (Vim), and a model-judged dead-end approach.
- **R6 Hint ladder.** Nudge, guiding question, example on a different problem, shown inline. It cannot be clicked through: each step up needs an attempt.
- **R7 Interruptions at boundaries.** Automatic hints wait for a gap in typing, and the footer shows what the tutor is doing.
- **R8 Ask and try by typing.** `#?` asks the tutor; `#=` evaluates an expression or runs a command as a scratch experiment.
- **R9 Chattiness.** Three levels that scale every threshold, adjusted automatically from how the learner treats hints.
- **R10 Process review.** On solving, a short review of how the learner got there.
- **R11 Answers do not leak.** AI hints are checked against the reference solution before they are shown.
- **R12 Spaced review.** Tasks the learner struggled with come back sooner; reviews open each session with the lesson hidden.
- **R13 Unaided checkpoints.** Regular tasks with no lesson and a silent tutor, to measure what stuck.
- **R14 Faded starters, skip-ahead, cheat sheet, progress view.**
- **R15 Courses.** Python syntax (54 tasks), interview patterns (11), Bash commands (38), Vim keybindings (51), and generated courses on any Python topic.
- **R16 Works without the AI.** Authored hints on the same triggers.
- **R17 Works without the server.** A static build runs Python in the browser and the Vim course client-side.
- **R18 Instructor report.** A per-task summary of the saved session logs.

### Later

- Hosted version with accounts, AI hints, and server-side sandboxing; a multi-learner instructor dashboard.
- Threshold tuning from the saved logs.
- Generated courses for Bash and Vim.
- More environments: Git, SQL, regex.

### Non-goals

- Writing or completing work for the learner.
- Mobile.

## 7. Success criteria

- A learner can finish a whole course without touching the mouse.
- Unaided checkpoints are solved on the first run more often as a course goes on.
- Keystroke-to-screen latency is indistinguishable from a plain editor; a run returns in under 500 ms; the first words of a hint appear within about 2 s of the trigger.
- During steady typing the tutor produces zero automatic interruptions.
- When a hint appears, the learner more often keeps it than dismisses it (dismissals are logged, so this is measurable).
- A new course on an existing runner is a new directory and nothing else.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Hints interrupt at the wrong time and feel annoying | Conservative defaults, cooldown, one-key dismiss, chattiness setting, all thresholds in one table |
| The model gives the answer away | Instructions in the system prompt, plus a server-side check of every hint against the reference solution, with a retry and an authored fallback |
| Learners click through hints instead of thinking | Each step up the ladder needs an attempt; checkpoints have no hints at all |
| The tutor helps practice scores but not learning | Unaided checkpoints and spaced reviews with the lesson hidden measure it directly |
| Learner code damages the machine | macOS sandbox: no network, writes confined to a temporary directory |
| Model latency breaks flow | Hints are requested asynchronously, streamed, and never block typing; low effort setting |
| Browser reserves some Ctrl shortcuts on Windows/Linux | Targets macOS, where Ctrl + letter is free in browsers; bindings live in one map |
