// The agents' real logos, read from the apps installed on this Mac and never
// shipped with Reach: the Codex icons inside ChatGPT.app, the Claude app's
// icon and its spark mark (the one Claude Code animates while it works).
// Each is made small once with macOS's sips and kept in Reach's data folder;
// an app that isn't installed simply has no logo, and the phone shows the
// agent's name instead.
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readWindowsIcons } from "../app-icons.mjs";
import { apps as startApps } from "../platform.mjs";

const exec = promisify(execFile);
// Windows: the same marks from the apps installed on this PC, found by name
// in Start's own list and drawn by Windows (app-icons.mjs). Marks a Windows
// app doesn't carry (Claude's spark, Codex's light variant) stay unshown.
export const WINDOWS_LOGO_SOURCES = {
  claude: ["Claude"],
  codex: ["Codex"],
  terminal: ["Terminal", "Windows Terminal"],
  // A Windows PC's own prompts wear Settings' icon, as a Mac's wear System Settings'.
  macos: ["Settings"],
  antigravity: ["Antigravity"],
  cursor: ["Cursor"],
};
export const LOGO_SOURCES = {
  codex: { file: "/Applications/ChatGPT.app/Contents/Resources/icon-codex-dark-color.png", size: 128, app: "com.openai.codex" },
  "codex-light": { file: "/Applications/ChatGPT.app/Contents/Resources/icon-codex-light.png", size: 128, app: "com.openai.codex" },
  // Its icon's file named, should it change, by the app itself (Info.plist).
  claude: { file: "/Applications/Claude.app/Contents/Resources/electron.icns", size: 128, app: "com.anthropic.claudefordesktop", icon: true },
  "claude-spark": { file: "/Applications/Claude.app/Contents/Resources/TrayIconTemplate@3x.png", size: 72 },
  // The Mac's own prompts wear System Settings' icon.
  macos: { file: "/System/Applications/System Settings.app/Contents/Resources/SystemSettings.icns", size: 128 },
  // Terminals on Home wear Terminal's own icon.
  terminal: { file: "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns", size: 128 },
  // Agents Reach knows of but doesn't drive yet (index.mjs KNOWN_AGENTS).
  antigravity: { file: "/Applications/Antigravity.app/Contents/Resources/icon.icns", size: 128, app: "com.google.antigravity", icon: true },
  cursor: { file: "/Applications/Cursor.app/Contents/Resources/Cursor.icns", size: 128, app: "com.todesktop.230313mzl4w4u92", icon: true },
};

// Where an icon is when its usual file isn't there: the app found by its
// bundle id wherever it lives (Spotlight), its file under the same name
// there, or (icon) the icon its Info.plist names. Looked up once a while.
const APP_DIR = /^(.*?\.app)\/Contents\//;
export function resolveIcon(source, { look = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 }) } = {}) {
  if (fs.existsSync(source.file) || !source.app) return source.file;
  const usual = source.file.match(APP_DIR);
  let app = null;
  try {
    app = String(look("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${source.app}'`])).split("\n").find((l) => l.endsWith(".app")) || null;
  } catch {}
  if (!app && usual && fs.existsSync(usual[1])) app = usual[1];
  if (!app) return source.file;
  if (usual) {
    const same = path.join(app, source.file.slice(usual[1].length));
    if (fs.existsSync(same)) return same;
  }
  if (source.icon)
    try {
      const name = String(look("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", path.join(app, "Contents", "Info.plist")])).trim();
      if (name && !name.includes("/")) {
        const icon = path.join(app, "Contents", "Resources", path.extname(name) ? name : `${name}.icns`);
        if (fs.existsSync(icon)) return icon;
      }
    } catch {}
  return source.file;
}

export function createLogos({ dataDir, sources = LOGO_SOURCES, run = exec, platform = process.platform, resolve = resolveIcon, windows = WINDOWS_LOGO_SOURCES, listApps = startApps, readIcons = (ids, options) => readWindowsIcons(ids, { size: 128, dataDir, ...options }) }) {
  let closed = false, stopping;
  const pending = new Set(), empty = { version: "", logos: {} };
  const authorize = () => {
    if (closed) throw Object.assign(new Error("Reach is shutting down."), { status: 503 });
  };
  const own = (load) => {
    const logos = () => {
      if (closed) return Promise.resolve(empty);
      const result = Promise.resolve().then(() => closed ? empty : load());
      pending.add(result);
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    };
    logos.close = () => {
      if (stopping) return stopping;
      closed = true;
      return stopping = Promise.allSettled([...pending]).then(() => {});
    };
    return logos;
  };
  if (platform === "win32") return own(windowsLogos({ windows, listApps, readIcons, authorize, stopped: () => closed, empty }));
  const dir = path.join(dataDir, "agent-logos");
  let cached = null;
  // Each source's file as last found, looked up again every ten minutes.
  const where = new Map();
  const fileOf = (name, source) => {
    const seen = where.get(name);
    if (seen && Date.now() - seen.at < 10 * 60 * 1000) return seen.file;
    const file = platform === "darwin" ? resolve(source) : source.file;
    where.set(name, { file, at: Date.now() });
    return file;
  };
  const stat = (file) => {
    try {
      const s = fs.statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  };
  // { version, logos: { name: data URL } }; the version changes when an app
  // updates its icon, so the phone keeps its copy until then.
  return own(async function logos() {
    const found = Object.entries(sources).map(([name, source]) => {
      const file = fileOf(name, source);
      return [name, { ...source, file }, stat(file)];
    });
    const key = found.map(([name, , s]) => `${name}=${s}`).join("|");
    if (cached?.key === key) return cached.value;
    const out = {};
    if (platform === "darwin") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [name, source, s] of found) {
        if (closed) break;
        if (!s) continue;
        const tag = crypto.createHash("sha1").update(`${source.file}|${s}|${source.size}`).digest("hex").slice(0, 12);
        const file = path.join(dir, `${name}-${tag}.png`);
        try {
          if (!fs.existsSync(file))
            await run("/usr/bin/sips", ["-s", "format", "png", "-Z", String(source.size), source.file, "--out", file], {
              timeout: 20000,
            });
          out[name] = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
        } catch {
          /* no logo for this one; the phone shows the name */
        }
      }
    }
    if (closed) return empty;
    const value = { version: crypto.createHash("sha1").update(key).digest("base64url").slice(0, 12), logos: out };
    cached = { key, value };
    return value;
  });
}

// Each mark's app as Start lists it, looked up again every ten minutes; the
// version changes when an app comes or goes.
function windowsLogos({ windows, listApps, readIcons, authorize, stopped, empty, now = Date.now }) {
  let cached = null;
  return async function logos() {
    if (cached && now() - cached.at < 10 * 60 * 1000) return cached.value;
    let list = [];
    try {
      list = await listApps({ authorize });
    } catch {
      /* no list: no logos; the phone shows the names */
    }
    if (stopped()) return empty;
    const byName = new Map(list.map((app) => [String(app.name).toLowerCase(), app.id]));
    const found = Object.entries(windows)
      .map(([name, names]) => [name, names.map((n) => byName.get(n.toLowerCase())).find(Boolean)])
      .filter(([, id]) => id);
    let icons = [];
    try {
      icons = await readIcons(found.map(([, id]) => id), { authorize });
    } catch {}
    if (stopped()) return empty;
    const logos = Object.fromEntries(found.map(([name], i) => [name, icons[i]]).filter(([, icon]) => icon));
    const key = found.map(([name, id]) => `${name}=${id}`).join("|");
    const value = { version: crypto.createHash("sha1").update(key).digest("base64url").slice(0, 12), logos };
    cached = { at: now(), value };
    return value;
  };
}
