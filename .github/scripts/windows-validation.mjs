// Runs the test files the Windows validation workflow was asked for (names
// under test/, without .test.mjs; one folder down too, as journeys/home),
// through npm so each carries the runaway guard. Names are checked, never
// passed to a shell.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const names = String(process.env.TESTS || "").split(/\s+/).filter(Boolean);
if (!names.length) throw Error("Name at least one test file.");
const files = names.map((name) => {
  if (!/^(?:[a-z0-9][a-z0-9-]{0,40}\/)?[a-z0-9][a-z0-9-]{0,80}$/.test(name)) throw Error(`Not a test name: ${name}`);
  const file = `test/${name}.test.mjs`;
  if (!fs.existsSync(file)) throw Error(`No such test: ${file}`);
  return file;
});
fs.mkdirSync("reports", { recursive: true });
const result = spawnSync(process.execPath, [
  process.env.npm_execpath || require_npm(),
  "run", "test:file", "--",
  "--test-timeout=300000", "--test-concurrency=1",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=junit", "--test-reporter-destination=reports/windows-validation.xml",
  ...files,
], { stdio: "inherit" });
process.exitCode = result.status ?? 1;

// npm's own CLI script: Node for Windows keeps npm beside node.exe.
function require_npm() {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(cli)) throw Error("npm's CLI wasn't found beside node.");
  return cli;
}
