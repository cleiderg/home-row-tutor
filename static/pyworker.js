// Runs learner Python in the browser (static build only). The page terminates
// this worker if a run takes too long, which is how infinite loops are stopped.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");
const ready = loadPyodide();

onmessage = async (e) => {
  const { id, files, script, out } = e.data;
  try {
    const py = await ready;
    const printed = [];
    py.setStdout({ batched: (s) => printed.push(s) });
    py.FS.mkdirTree("/work");
    py.FS.chdir("/work");
    for (const [name, content] of Object.entries(files)) py.FS.writeFile(name, content);
    const globals = py.toPy({});
    py.runPython(script, { globals });
    globals.destroy();
    postMessage({ id, out: out ? py.FS.readFile(out, { encoding: "utf8" }) : null, stdout: printed.join("\n") });
  } catch (err) {
    postMessage({ id, error: String(err).slice(-400) });
  }
};
