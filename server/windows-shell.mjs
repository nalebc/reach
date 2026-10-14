import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The owner's own shell for Reach's terminals on Windows, as a Mac starts
// $SHELL (owner, Oct 12: the same decision on both): Windows Terminal's
// default profile, else PowerShell 7, else Windows PowerShell.
// { file, args, kind, name }: `kind` says how a command is written for it
// ("powershell", "cmd" or "other"); `args` is a string when it's the
// profile's own command line, as node-pty passes it on Windows.
const p = path.win32;
const envOf = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
// Windows Terminal's settings: the Store's build, its Preview, then one
// installed without a package (winget's portable build, Scoop).
export function terminalSettingsFiles({ env = process.env, home = os.homedir() } = {}) {
  const local = envOf(env, "LOCALAPPDATA") || p.join(home, "AppData", "Local");
  return [
    p.join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    p.join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    p.join(local, "Microsoft", "Windows Terminal", "settings.json"),
  ];
}
// Its settings are JSON with comments and trailing commas.
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
// %SystemRoot% and the like, as Windows Terminal expands them.
const expand = (value, env) => value.replace(/%([^%]+)%/g, (whole, name) => envOf(env, name.toUpperCase()) ?? whole);
// A command line's program and the rest, as Windows splits the first token.
export function splitCommandLine(line) {
  const text = String(line).trim();
  const m = text.match(/^"([^"]*)"\s*(.*)$/s) || text.match(/^(\S+)\s*(.*)$/s);
  return m ? { file: m[1], rest: m[2] } : null;
}
const kindOf = (file) => {
  const base = p.basename(file).toLowerCase();
  return base === "powershell.exe" || base === "pwsh.exe" || base === "powershell" || base === "pwsh" ? "powershell" : base === "cmd.exe" || base === "cmd" ? "cmd" : "other";
};
// Windows Terminal's own two profiles, when its settings name them without a command line.
const BUILT_IN = {
  "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}": "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}": "%SystemRoot%\\System32\\cmd.exe",
};
// A program on PATH or where it's installed, as Windows would start it.
function located(file, { env, exists }) {
  if (/[\\/]/.test(file)) return exists(file) ? file : null;
  const name = /\.[a-z0-9]+$/i.test(file) ? file : `${file}.exe`;
  const dirs = [...(envOf(env, "PATH") || "").split(";"), p.join(envOf(env, "SYSTEMROOT") || "C:\\Windows", "System32")];
  for (const dir of dirs.map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean)) {
    const full = p.join(dir, name);
    if (exists(full)) return full;
  }
  return null;
}
function pwsh({ env, exists }) {
  const programFiles = envOf(env, "PROGRAMFILES") || "C:\\Program Files";
  return located("pwsh.exe", { env, exists }) || [p.join(programFiles, "PowerShell", "7", "pwsh.exe")].find((f) => exists(f)) || null;
}
// What Windows Terminal opens by default, or null when it can't be told.
function terminalDefault({ env, home, read, exists }) {
  for (const file of terminalSettingsFiles({ env, home })) {
    let settings;
    try {
      settings = parseJsonc(read(file));
    } catch {
      continue;
    }
    const list = Array.isArray(settings?.profiles) ? settings.profiles : settings?.profiles?.list;
    const wanted = String(settings?.defaultProfile || "").toLowerCase();
    if (!Array.isArray(list) || !wanted) return null;
    const profile = list.find((entry) => String(entry?.guid || "").toLowerCase() === wanted) || list.find((entry) => String(entry?.name || "").toLowerCase() === wanted);
    if (!profile) return null;
    const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 60) : "";
    let line = typeof profile.commandline === "string" && profile.commandline.trim() ? profile.commandline : BUILT_IN[String(profile.guid || "").toLowerCase()];
    if (!line && profile.source === "Windows.Terminal.PowershellCore") {
      const found = pwsh({ env, exists });
      return found ? { file: found, args: ["-NoLogo"], kind: "powershell", name: name || "PowerShell" } : null;
    }
    if (!line && profile.source === "Windows.Terminal.Wsl" && name) {
      const wsl = located("wsl.exe", { env, exists });
      return wsl ? { file: wsl, args: ["-d", name], kind: "other", name } : null;
    }
    if (!line) return null;
    const split = splitCommandLine(expand(line, env));
    const found = split && located(split.file, { env, exists });
    if (!found) return null;
    return { file: found, args: split.rest, kind: kindOf(found), name: name || p.basename(found, ".exe") };
  }
  return null;
}
// PowerShell 7 when it's installed, else Windows PowerShell.
export function windowsPowerShell({ env = process.env, exists = fs.existsSync } = {}) {
  const seven = pwsh({ env, exists });
  if (seven) return { file: seven, args: ["-NoLogo"], kind: "powershell", name: "PowerShell" };
  const root = envOf(env, "SYSTEMROOT") || "C:\\Windows";
  const classic = p.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { file: exists(classic) ? classic : "powershell.exe", args: ["-NoLogo"], kind: "powershell", name: "Windows PowerShell" };
}
export function windowsShell({ env = process.env, home = os.homedir(), read = (file) => fs.readFileSync(file, "utf8"), exists = fs.existsSync } = {}) {
  return terminalDefault({ env, home, read, exists }) || windowsPowerShell({ env, exists });
}
// A program and its arguments as Reach gives them (a quoted path, or two),
// written so this shell runs it: PowerShell calls a quoted path with &, cmd
// runs it as it is. Another shell (bash, WSL) isn't given one: the caller
// opens PowerShell for it.
export function commandFor(kind, command, powershellCall) {
  if (kind === "powershell") return powershellCall(command);
  if (kind === "cmd") return command;
  return null;
}
// What a Reach terminal on Windows starts and types: the owner's shell, an
// agent's command written for it (PowerShell for a shell that can't run one
// by its path), and PowerShell for an install or update, whose command is
// PowerShell's own text (agent-install.mjs). { shell, typed }.
export function windowsTerminal({ command = "", powershell = false, call, own = () => windowsShell(), fallback = () => windowsPowerShell() } = {}) {
  if (powershell) return { shell: fallback(), typed: command };
  const shell = own();
  if (!command) return { shell, typed: "" };
  const typed = commandFor(shell.kind, command, call);
  return typed == null ? { shell: fallback(), typed: call(command) } : { shell, typed };
}
