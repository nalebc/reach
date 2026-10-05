// The Mac's own dialogs (privacy prompts such as "… wants access to control
// …", "downloaded from the internet" warnings, password requests), as
// scripts/native/mac-prompts.swift reports them. Owner devices can send an
// exact button press or a password to the guarded native helper. macOS may
// reject either action; callers must retain a live-screen fallback.
import { spawn as spawnChild } from "node:child_process";
import { desktopBinary } from "./desktop-native.mjs";

const quoted = /[“"]([^”"]{1,80})[”"]/;

// The System Settings page where what a prompt asks for is switched on, from
// its own words. Only these fixed pages are ever opened.
const PANE = "x-apple.systempreferences:com.apple.preference.security";
const SETTINGS = [
  [/accessibility features/i, "Accessibility", `${PANE}?Privacy_Accessibility`],
  [/wants access to control|would like to control “/i, "Automation", `${PANE}?Privacy_Automation`],
  [/record this computer|screen and system audio|screen recording/i, "Screen & System Audio Recording", `${PANE}?Privacy_ScreenCapture`],
  [/receive keystrokes|input monitoring/i, "Input Monitoring", `${PANE}?Privacy_ListenEvent`],
  [/access files in your|access files on a|files and folders|removable volumes|network volume/i, "Files & Folders", `${PANE}?Privacy_FilesAndFolders`],
  [/full disk access/i, "Full Disk Access", `${PANE}?Privacy_AllFiles`],
  [/access the camera/i, "Camera", `${PANE}?Privacy_Camera`],
  [/access the microphone/i, "Microphone", `${PANE}?Privacy_Microphone`],
  [/downloaded from the internet|can't be opened|cannot be opened|not opened|unidentified developer/i, "Privacy & Security", `${PANE}?General`],
];
export const SETTING_URLS = new Set(SETTINGS.map(([, , url]) => url));
export function macSetting(text = "") {
  const found = SETTINGS.find(([match]) => match.test(text));
  return found ? { name: found[1], url: found[2] } : null;
}

// One dialog as the phone shows it.
export function macPrompt(raw = {}) {
  const kind = ["privacy", "security", "password"].includes(raw.kind) ? raw.kind : "privacy";
  // Where the dialog is on screen (global points), for the phone's screen view.
  const b = raw.bounds || {};
  const bounds = ["x", "y", "width", "height"].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0
    ? { x: b.x, y: b.y, width: b.width, height: b.height }
    : null;
  if (kind === "password")
    return { id: String(raw.id ?? ""), kind, title: "Your Mac is asking for your password", detail: "", app: null, ...(bounds ? { bounds } : {}) };
  const texts = Array.isArray(raw.texts) ? raw.texts.map(String).filter(Boolean) : [];
  const buttons = Array.isArray(raw.buttons) ? raw.buttons.map(String).slice(0, 4) : [];
  // The question is the first sentence; what it means, and the app's own
  // reason, follow.
  const [first = "", ...more] = (texts[0] || "").split(/(?<=[.?!])\s+/);
  const title = first || (kind === "security" ? "Your Mac is asking about an app" : "Your Mac is asking for permission");
  return {
    id: String(raw.id ?? ""),
    kind,
    title: title.slice(0, 300),
    detail: [more.join(" "), ...texts.slice(1)].filter(Boolean).join(" ").slice(0, 600),
    // The app that asks ("“Claude” would like to…"), to point at its sessions.
    app: texts[0]?.match(quoted)?.[1] || null,
    buttons,
    ...(bounds ? { bounds } : {}),
    // Where it is switched on in System Settings (opened from the phone).
    ...(macSetting(texts.join(" ")) ? { setting: macSetting(texts.join(" ")) } : {}),
    // Drawn as macOS draws it: its message, then the rest, and the button
    // Return presses (the last one when macOS doesn't say).
    lines: texts.slice(0, 3).map((t) => t.slice(0, 600)),
    ...(buttons.length ? { default: buttons.includes(raw.default) ? raw.default : buttons.at(-1) } : {}),
    ...(typeof raw.image === "string" && raw.image.startsWith("data:image/png;base64,") ? { image: raw.image } : {}),
  };
}

// Runs scripts/native/mac-answer.swift once: arguments say what to do; a
// password comes on stdin (never on the command line, where any process can
// read it). Resolves with its one JSON line.
export function macAnswerRunner({ dataDir, spawn = spawnChild, binary = () => desktopBinary({ dataDir }, "mac-answer") }) {
  return async (args, input = "") => {
    const file = await binary();
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out.trim().split("\n").at(-1)));
        } catch {
          reject(Object.assign(new Error("Couldn't answer your Mac. Answer it there."), { status: 502 }));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  };
}

export function createMacPrompts({
  dataDir,
  platform = process.platform,
  binary = () => desktopBinary({ dataDir }, "mac-prompts"),
  spawn = spawnChild,
  retryMs = 5000,
  // Presses a dialog's button or types the Mac's password (mac-answer.swift).
  answer = macAnswerRunner({ dataDir, spawn }),
}) {
  let prompts = [];
  let version = 0;
  let child = null;
  let closed = false;
  let timer = null;
  const listeners = new Set();
  const update = (list) => {
    const next = list.map(macPrompt);
    if (JSON.stringify(next) === JSON.stringify(prompts)) return;
    prompts = next;
    version++;
    for (const listener of listeners) listener();
  };
  async function run() {
    if (closed || platform !== "darwin") return;
    let file;
    try {
      file = await binary();
    } catch {
      return; // no Command Line Tools: no Mac prompts on the phone
    }
    if (closed) return;
    child = spawn(file, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) buffer = "";
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const value = JSON.parse(line);
          if (Array.isArray(value.prompts)) update(value.prompts);
        } catch {
          /* a partial line */
        }
      }
    });
    child.on("error", () => {});
    child.on("exit", () => {
      child = null;
      update([]);
      if (!closed) timer = setTimeout(run, retryMs);
    });
  }
  return {
    start() {
      void run();
    },
    current: () => ({ version, prompts }),
    // Presses one of a dialog's own buttons, as read from it, while it's up.
    async press(id, button) {
      const prompt = prompts.find((p) => p.id === String(id));
      if (!prompt || !/^\d+$/.test(prompt.id)) throw Object.assign(new Error("That Mac prompt was already answered."), { status: 404 });
      if (prompt.kind === "password")
        throw Object.assign(new Error("A password dialog is answered with the password."), { status: 409 });
      if (typeof button !== "string" || !prompt.buttons?.includes(button))
        throw Object.assign(new Error("That isn't one of the dialog's buttons."), { status: 400 });
      const result = await answer(["--press", "--window", prompt.id, "--button", button]);
      if (result?.error) throw Object.assign(new Error(result.error), { status: result.gone ? 404 : 409, refused: !!result.refused });
      if (result?.pressed !== button)
        throw Object.assign(new Error("Your Mac didn't confirm the response. Check the dialog on the live screen."), { status: 502 });
      return { pressed: button };
    },
    // Types the Mac's password into its password dialog (only while that
    // dialog holds the keyboard; the helper checks), then Return. One try.
    async password(id, secret) {
      const prompt = prompts.find((p) => p.id === String(id));
      if (!prompt || !/^\d+$/.test(prompt.id)) throw Object.assign(new Error("That Mac prompt was already answered."), { status: 404 });
      if (prompt.kind !== "password") throw Object.assign(new Error("That dialog doesn't ask for a password."), { status: 409 });
      // No control characters: none can be typed into a password field, and
      // typed, Tab would move to another field and Escape cancel the dialog.
      if (typeof secret !== "string" || !secret || secret.length > 256 || /[\u0000-\u001f\u007f]/.test(secret))
        throw Object.assign(new Error("Enter your Mac's password."), { status: 400 });
      const result = await answer(["--password", "--window", prompt.id], `${secret}\n`);
      if (result?.error) throw Object.assign(new Error(result.error), { status: result.gone ? 404 : 409, refused: !!result.refused });
      if (result?.done !== true)
        throw Object.assign(new Error("Your Mac didn't confirm authentication. Check the dialog on the live screen."), { status: 502 });
      return { done: true };
    },
    // Opens the System Settings page a prompt on screen belongs to, so it's
    // one switch away at the Mac (macOS takes the answer only from there).
    async openSetting(id, open) {
      const prompt = prompts.find((p) => p.id === String(id));
      if (!prompt) throw Object.assign(new Error("That Mac prompt was already answered."), { status: 404 });
      if (!prompt.setting || !SETTING_URLS.has(prompt.setting.url))
        throw Object.assign(new Error("There's no setting for this one. Answer it on your Mac."), { status: 409 });
      await open(prompt.setting.url);
      return { opened: prompt.setting.name, app: prompt.app };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      child?.stdin?.end();
      child?.kill("SIGTERM");
    },
  };
}
