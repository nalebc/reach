// Signing an agent in on the Mac from the phone. The sign-in itself happens
// on the Mac, with the agent's own login; Reach relays only the link and the
// code. It never sees a password, and nothing opens on the Mac's screen.
//
// Claude Code: `claude auth login` tries to open a link that calls back to
// localhost (useless from a phone), then prints a second link whose page
// shows a code, and waits at "Paste code here if prompted >" (verified with
// claude 2.1.289; the Mac's `open` was replaced so nothing opened).
// Codex: the shared daemon's device-code login returns a link and a one-time
// code and reports when the sign-in finishes (from its protocol schema).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { computerWord } from "../computer-word.mjs";
import { releaseExitedPty } from "../pty-helper.mjs";
import { claudeEnvironment } from "./claude-environment.mjs";

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
export const plainText = (text) => String(text).replace(ANSI, "").replace(/\r/g, "");
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// The link for signing in on another device: its page shows a code to paste
// back. Inside an OSC 8 hyperlink the target comes first and ends at ESC.
export function claudeSignInLink(output) {
  for (const m of String(output).matchAll(/https:\/\/[^\s\x07\x1b"'<>]+\/oauth\/authorize\?[^\s\x07\x1b"'<>]+/g))
    if (/[?&]redirect_uri=https%3A%2F%2F/i.test(m[0])) return m[0];
  return null;
}

// What the login printed last, for the phone when something goes wrong.
const lastLine = (output) =>
  plainText(output)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Paste code here/i.test(l))
    .pop() || "";

export function createSignIn({
  dataDir,
  claudeCommand, // async () => a shell command for claude, or null when not installed
  claudeHealth, // async () => { signedIn }
  daemon, // the shared Codex daemon
  spawn = pty.spawn,
  shell,
  env = process.env,
  now = Date.now,
  timeoutMs = 15 * 60 * 1000,
  linkMs = 10000,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
}) {
  const flows = new Map();
  const view = (flow) =>
    flow
      ? { agent: flow.agent, state: flow.state, url: flow.url, code: flow.code, error: flow.error }
      : { state: "idle", url: null, code: null, error: null };
  const finish = (flow, state, error = null) => {
    if (["done", "failed", "cancelled"].includes(flow.state)) return;
    clearTimeout(flow.timer);
    flow.state = state;
    flow.error = error;
    for (const wake of flow.waiters.splice(0)) wake();
  };
  const update = (flow) => {
    for (const wake of flow.waiters.splice(0)) wake();
  };
  const settled = (flow, ms) =>
    flow.state !== "starting"
      ? Promise.resolve()
      : new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          flow.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
  // A stand-in for the Mac's `open` and $BROWSER: the link goes to the phone.
  const shim = () => {
    const dir = path.join(dataDir, "sign-in");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const open = path.join(dir, platform === "win32" ? "open.cmd" : "open");
    if (!fs.existsSync(open))
      fs.writeFileSync(open, platform === "win32"
        ? "@echo off\r\nrem Reach shows sign-in links on the phone instead.\r\nexit /b 0\r\n"
        : "#!/bin/sh\n# Reach shows sign-in links on the phone instead.\nexit 0\n", { mode: 0o755 });
    return { dir, open };
  };

  daemon?.onNotification?.((m) => {
    if (m.method !== "account/login/completed") return;
    const flow = flows.get("codex");
    if (!flow || (m.params?.loginId && m.params.loginId !== flow.loginId)) return;
    if (m.params?.success) finish(flow, "done");
    else finish(flow, "failed", m.params?.error || "Codex sign-in didn't finish.");
  });

  async function startClaude(flow) {
    const command = await claudeCommand();
    if (flow.state !== "starting") return;
    if (!command) throw bad(`Claude Code isn't installed on this ${computerWord(platform)}.`, 404);
    const { dir, open } = shim();
    // Reach's own environment, never a host app's; the shim goes first even
    // after the login shell rebuilds PATH.
    const clean = claudeEnvironment(env);
    const windows = platform === "win32";
    if (windows) {
      // Windows environment names are case-insensitive. Avoid duplicate PATH
      // or BROWSER entries, and use cmd so npm's .cmd launcher works even when
      // PowerShell script execution is disabled. No shell profile is loaded.
      const previousPath = Object.entries(clean).find(([key]) => /^path$/i.test(key))?.[1] || "";
      for (const key of Object.keys(clean)) if (/^(path|browser)$/i.test(key)) delete clean[key];
      clean.PATH = `${dir};${previousPath}`;
      clean.BROWSER = open;
    }
    const proc = spawn(
      shell || (windows ? env.ComSpec || env.COMSPEC || "cmd.exe" : env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh")),
      windows
        ? `/d /s /c "${command} auth login"`
        : ["-lc", `PATH=${quote(dir)}:"$PATH" BROWSER=${quote(open)} exec ${command} auth login`],
      { name: "xterm-256color", cols: 400, rows: 40, cwd: os.homedir(), env: { ...clean, TERM: "xterm-256color" }, ...(windows ? { useConptyDll: true } : {}) },
    );
    flow.proc = proc;
    flow.output = "";
    proc.onData((data) => {
      flow.output = (flow.output + data).slice(-20000);
      if (flow.state === "starting") {
        const url = claudeSignInLink(flow.output);
        if (url) {
          flow.url = url;
          flow.state = "link";
          update(flow);
        }
      }
    });
    proc.onExit(async ({ exitCode }) => {
      releaseExitedPty(proc, platform);
      flow.proc = null;
      if (["done", "failed", "cancelled"].includes(flow.state)) return;
      const health = await claudeHealth().catch(() => null);
      if (health?.signedIn) finish(flow, "done");
      else finish(flow, "failed", lastLine(flow.output) || `Sign-in ended (code ${exitCode}).`);
    });
  }

  async function startCodex(flow) {
    if (!daemon) throw bad(`Codex isn't available on this ${computerWord(platform)}.`, 404);
    const r = await daemon.rpc("account/login/start", { type: "chatgptDeviceCode" });
    if (flow.state !== "starting") {
      if (r.loginId) await daemon.rpc("account/login/cancel", { loginId: r.loginId }).catch(() => {});
      return;
    }
    flow.loginId = r.loginId;
    flow.url = r.verificationUrl;
    flow.code = r.userCode;
    flow.state = "link";
  }

  return {
    async start(agent) {
      if (agent !== "claude" && agent !== "codex") throw bad("Unknown agent.", 404);
      const current = flows.get(agent);
      if (current && ["starting", "link", "checking"].includes(current.state)) return view(current);
      const flow = { agent, state: "starting", url: null, code: null, error: null, at: now(), waiters: [] };
      flows.set(agent, flow);
      flow.timer = setTimeout(() => {
        this.cancel(agent);
        flow.state = "failed";
        flow.error = "Sign-in timed out. Start again.";
      }, timeoutMs);
      try {
        if (agent === "claude") await startClaude(flow);
        else await startCodex(flow);
      } catch (e) {
        finish(flow, "failed", e.message);
        throw e;
      }
      // Answer with the link in the same round trip when it comes quickly.
      await settled(flow, linkMs);
      return view(flow);
    },
    // The code Claude's sign-in page shows, typed into the waiting login.
    submit(agent, code) {
      const flow = flows.get(agent);
      if (agent !== "claude" || !flow?.proc || flow.state !== "link")
        throw bad("There's no sign-in waiting for a code.", 409);
      const value = String(code ?? "").trim();
      if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))
        throw bad("Paste the code from the sign-in page.");
      flow.proc.write(`${value}\r`);
      flow.state = "checking";
      return view(flow);
    },
    view: (agent) => view(flows.get(agent)),
    cancel(agent) {
      const flow = flows.get(agent);
      if (!flow) return view(null);
      if (["starting", "link", "checking"].includes(flow.state)) {
        if (flow.proc) {
          try {
            flow.proc.kill();
          } catch {}
        }
        if (flow.loginId) daemon?.rpc("account/login/cancel", { loginId: flow.loginId }).catch(() => {});
        finish(flow, "cancelled");
      }
      return view(flow);
    },
  };
}
