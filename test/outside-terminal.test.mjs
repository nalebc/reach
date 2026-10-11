import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hostApp, outsideTerminal, reachHosts, statusText, alreadyRunning, whereItRuns } from "../scripts/instances.mjs";
import { NativeScreenSource, permissionHint } from "../server/screen-stream.mjs";
import { RemoteBroadcast } from "../server/remote-screen.mjs";

// Oct 6: a Codex agent ran `reach restart` from its own shell. That shell has
// a terminal, so Reach restarted right there, inside ChatGPT, with no Screen
// Recording or Accessibility: the phone said "Connecting…" forever and
// `reach status` still said "in a Terminal window".
const ROOT = "/Users/me/reach";
const node = "/opt/homebrew/bin/node";
const viaCodex = [
  { pid: 628, ppid: 1, tty: "??", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
  { pid: 1366, ppid: 628, tty: "ttys002", command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" },
  { pid: 33124, ppid: 1366, tty: "ttys002", command: `${node} ${ROOT}/scripts/bootstrap.mjs` },
];
const viaTerminal = [
  { pid: 629, ppid: 1, tty: "??", command: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
  { pid: 814, ppid: 629, tty: "ttys000", command: "login -pf me" },
  { pid: 815, ppid: 814, tty: "ttys000", command: "-zsh" },
  { pid: 900, ppid: 815, tty: "ttys000", command: `${node} ${ROOT}/scripts/bootstrap.mjs` },
];
const exists = (p) => p.startsWith("/");

test("the app a Reach runs inside is the outermost one: ChatGPT for Codex's shell, Terminal for a Terminal window", () => {
  assert.equal(hostApp(viaCodex, 33124), "ChatGPT");
  assert.equal(hostApp(viaTerminal, 900), "Terminal");
  assert.equal(outsideTerminal("ChatGPT"), true);
  assert.equal(outsideTerminal("Terminal"), false);
  assert.equal(outsideTerminal(""), false);
});

test("status and a second start say Reach runs inside ChatGPT without permissions, and how to fix it", () => {
  const [host] = reachHosts(viaCodex, { self: 1, exists });
  assert.equal(whereItRuns(host), "inside ChatGPT (ttys002), not a Terminal window");
  const status = statusText([host], { runtime: () => ({}) });
  assert.match(status, /ChatGPT has no Screen Recording or Accessibility for Reach.*reach restart/);
  assert.match(alreadyRunning([host]), /ChatGPT has no Screen Recording or Accessibility/);
  const [ok] = reachHosts(viaTerminal, { self: 1, exists });
  assert.equal(whereItRuns(ok), "in a Terminal window (ttys000)");
  assert.doesNotMatch(statusText([ok], { runtime: () => ({}) }), /Screen Recording/);
});

test("restart and start open Terminal when run inside another app, even with a terminal", () => {
  const source = fs.readFileSync(new URL("../scripts/bootstrap.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "darwin" && \(!process\.stdin\.isTTY \|\| foreignApp\(\)\)\) \{\s*startInTerminal/);
  assert.match(source, /\} else if \(!options\.service && foreignApp\(\)\) \{[\s\S]*?startInTerminal\(root/);
});

test("no Screen Recording ends the stream with the reason, and the phone stops retrying", async () => {
  assert.match(permissionHint("ChatGPT"), /inside ChatGPT, which has no Screen Recording permission.*reach restart in Terminal/);
  // In Terminal the permission is Terminal's, applied once it's reopened:
  // never "Reach's screen helper" and "reconnect".
  assert.match(permissionHint("Terminal"), /Screen Recording is off for Terminal\..*Allow Terminal, then quit and reopen Terminal and restart Reach/);
  assert.match(permissionHint(""), /Allow the app running Reach, such as Terminal, then quit and reopen that app/);
  assert.doesNotMatch(permissionHint("Terminal"), /screen helper|then reconnect/);
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    "process.stderr.write('Allow Screen Recording for Reach’s screen helper in System Settings.'); process.exit(1)",
  ]);
  const error = await source.next().catch((e) => e);
  assert.equal(error.permanent, true);
  assert.match(error.message, /Screen Recording/);
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (m) => sent.push(m), close: () => {} };
  const group = new RemoteBroadcast(async () => () => ({ next: () => Promise.reject(error), stop() {} }), { fps: 30, quality: "auto", bitrate: 1e6 });
  group.add(ws, () => true);
  await new Promise((r) => setTimeout(r, 20));
  const message = JSON.parse(sent.find((m) => typeof m === "string"));
  assert.equal(message.type, "error");
  assert.equal(message.retryable, false);
});

test("the phone says it can't show the screen, not Connecting…, once the stream failed", () => {
  const screen = fs.readFileSync(new URL("../src/Screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /stream\.error && !stream\.ready\s*\?\s*"Can't show the screen"/);
});
