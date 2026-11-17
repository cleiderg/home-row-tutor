#!/usr/bin/env bash
# Rebuilds static/vendor/cm.js (CodeMirror 6, bundled once so the app has no
# runtime CDN or node dependency). Only needed when upgrading the editor.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
cat > entry.js <<'JS'
export { EditorState, StateField, StateEffect, Prec } from "@codemirror/state";
export { StreamLanguage } from "@codemirror/language";
export { shell } from "@codemirror/legacy-modes/mode/shell";
export { vim, Vim, getCM } from "@replit/codemirror-vim";
export { EditorView, Decoration, WidgetType, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
export { defaultKeymap, history, historyKeymap, indentMore, indentLess } from "@codemirror/commands";
export { indentUnit, bracketMatching, indentOnInput } from "@codemirror/language";
export { python } from "@codemirror/lang-python";
export { oneDark } from "@codemirror/theme-one-dark";
JS
npm init -y >/dev/null
npm install --silent @codemirror/state @codemirror/view @codemirror/commands \
  @codemirror/language @codemirror/lang-python @codemirror/theme-one-dark \
  @codemirror/legacy-modes @replit/codemirror-vim esbuild
npx esbuild entry.js --bundle --format=esm --minify --outfile="$root/static/vendor/cm.js"
