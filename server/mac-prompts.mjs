// The Mac's own dialogs (privacy prompts such as "… wants access to control
// …", "downloaded from the internet" warnings, password requests), as
// scripts/native/mac-prompts.swift reports them. The phone shows them, marked
// as the Mac's; they're answered at the Mac (they grant privacy access, which
// macOS leaves to a person there). Nothing here can press their buttons.
import { spawn as spawnChild } from "node:child_process";
import { desktopBinary } from "./desktop-native.mjs";

const quoted = /[“"]([^”"]{1,80})[”"]/;

// One dialog as the phone shows it.
export function macPrompt(raw = {}) {
  const kind = ["privacy", "security", "password"].includes(raw.kind) ? raw.kind : "privacy";
  if (kind === "password")
    return { id: String(raw.id ?? ""), kind, title: "Your Mac is asking for your password", detail: "", app: null };
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
    // Drawn as macOS draws it: its message, then the rest, and the button
    // Return presses (the last one when macOS doesn't say).
    lines: texts.slice(0, 3).map((t) => t.slice(0, 600)),
    ...(buttons.length ? { default: buttons.includes(raw.default) ? raw.default : buttons.at(-1) } : {}),
    ...(typeof raw.image === "string" && raw.image.startsWith("data:image/png;base64,") ? { image: raw.image } : {}),
  };
}

export function createMacPrompts({
  dataDir,
  platform = process.platform,
  binary = () => desktopBinary({ dataDir }, "mac-prompts"),
  spawn = spawnChild,
  retryMs = 5000,
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
