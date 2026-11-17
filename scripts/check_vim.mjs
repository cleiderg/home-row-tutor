// Replays every Vim exercise's reference solution in headless Chrome and checks
// that it reaches the goal at or under par. The Python and Bash courses are
// checked by `python3 server.py --selftest`; Vim needs a real editor.
//
//   npm install --no-save puppeteer-core
//   TUTOR_BACKEND=offline TUTOR_PORT=8422 python3 server.py --no-open &
//   node scripts/check_vim.mjs            # CHROME=/path/to/chrome to override
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const BASE = process.env.TUTOR_URL || "http://127.0.0.1:8422";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tasks = JSON.parse(execFileSync("python3", ["-c",
  "import runpy, json; p = runpy.run_path('packs/vim/pack.py')['PACK'];" +
  "print(json.dumps([{k: t[k] for k in ('id', 'solution')} for t in p['tasks']]))"]).toString());

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function press(keys, escAsJk) {
  for (const tok of keys.match(/<[^<>]+>|[\s\S]/g)) {
    if (/^<esc>$/i.test(tok)) {
      if (escAsJk) await page.keyboard.type("jk", { delay: 15 });
      else await page.keyboard.press("Escape");
    } else if (/^<cr>$/i.test(tok)) {
      await page.keyboard.press("Enter");
    } else if (/^<c-(.)>$/i.test(tok)) {
      await page.keyboard.down("Control");
      await page.keyboard.press(tok[3]);
      await page.keyboard.up("Control");
    } else {
      await page.keyboard.type(tok);
    }
    await sleep(25);
  }
}

let fails = 0;
await page.goto(`${BASE}/?pack=vim`);
for (const [i, t] of tasks.entries()) {
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/?pack=vim&task=${t.id}`);
  await page.waitForSelector(".cm-content");
  await sleep(150);
  await press(t.solution, i % 2 === 0); // alternate real Esc and the jk mapping
  await sleep(250);
  const r = await page.evaluate(() => ({ solved: window.__hrt.A.solved, keys: window.__hrt.A.keys, par: window.__hrt.A.task.par }));
  if (!(r.solved && r.keys <= r.par)) {
    fails++;
    console.log("FAIL", t.id, JSON.stringify(r));
  }
}
console.log(`${tasks.length - fails}/${tasks.length} Vim solutions reach their goal at or under par`);
await browser.close();
process.exit(fails ? 1 : 0);
