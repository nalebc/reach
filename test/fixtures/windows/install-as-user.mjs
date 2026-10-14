// Reach's background install (`reach install`, scripts/background-service.mjs)
// as whoever runs this, for the real-Windows test only
// (test/windows-standard-task.test.mjs): run as a standard account made for
// the test, it makes that account's own Scheduled Task, as Reach does.
//
//   node install-as-user.mjs <Reach's folder> <its state folder> <out folder>
//
// Writes installed.json to <out>: { ok, name, said, run } or { ok: false,
// error }; `run` is what Windows said to running the task now ("ok" or its
// refusal), kept apart: install made the task either way.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, state, out] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { backgroundService } = await import(pathToFileURL(path.join(repo, "scripts", "background-service.mjs")).href);
const { windowsTask } = await import(pathToFileURL(path.join(repo, "scripts", "windows-task.mjs")).href);
const env = { ...process.env, REACH_HOME: state };
const real = windowsTask({ env });
let ran = "not asked";
const task = {
  ...real,
  run() {
    try {
      real.run();
      ran = "ok";
    } catch (error) {
      ran = String(error.stderr || error.message).trim().split(/\r?\n/)[0];
    }
  },
};
const said = [];
try {
  await backgroundService({ command: "install", local: true, folders: [], httpsPort: 8443 }, root, {
    platform: "win32",
    env,
    task,
    privateNode: () => process.execPath,
    allocatePort: async () => 4322,
    print: (line) => said.push(line),
  });
  fs.writeFileSync(path.join(out, "installed.json"), JSON.stringify({ ok: true, name: task.name(), said, run: ran }));
} catch (error) {
  fs.writeFileSync(path.join(out, "installed.json"), JSON.stringify({ ok: false, error: error.message, said }));
}
