// A throwaway stand-in for Reach (test/windows-agent-desktop-native.test.mjs):
// starts the agent helper as Reach does (detached, at medium integrity
// through the fixture's launcher, with this process as Reach's), hands it
// rules and one action, echoes its answers, and waits to be killed. The
// helper must let go of anything it holds when this process dies.
import { spawn } from "node:child_process";

const [launcher, helper, rules, action] = process.argv.slice(2);
const child = spawn(launcher, ["medium", helper, "--reach-pid", String(process.pid), "--reach-console", "0"],
  { stdio: ["pipe", "pipe", "ignore"], detached: true, windowsHide: true });
child.stdout.pipe(process.stdout);
child.stdin.write(`${rules}\n`);
child.stdin.write(`${JSON.stringify({ op: "act", action: JSON.parse(action) })}\n`);
setInterval(() => {}, 1000);
