// The agents' real logos, read from the apps installed on this Mac and never
// shipped with Reach: the Codex icons inside ChatGPT.app, the Claude app's
// icon and its spark mark (the one Claude Code animates while it works).
// Each is made small once with macOS's sips and kept in Reach's data folder;
// an app that isn't installed simply has no logo, and the phone shows the
// agent's name instead.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const LOGO_SOURCES = {
  codex: { file: "/Applications/ChatGPT.app/Contents/Resources/icon-codex-dark-color.png", size: 128 },
  "codex-light": { file: "/Applications/ChatGPT.app/Contents/Resources/icon-codex-light.png", size: 128 },
  claude: { file: "/Applications/Claude.app/Contents/Resources/electron.icns", size: 128 },
  "claude-spark": { file: "/Applications/Claude.app/Contents/Resources/TrayIconTemplate@3x.png", size: 72 },
  // Terminals on Home wear Terminal's own icon.
  terminal: { file: "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns", size: 128 },
  // Agents Reach knows of but doesn't drive yet (index.mjs KNOWN_AGENTS).
  antigravity: { file: "/Applications/Antigravity.app/Contents/Resources/icon.icns", size: 128 },
  cursor: { file: "/Applications/Cursor.app/Contents/Resources/Cursor.icns", size: 128 },
};

export function createLogos({ dataDir, sources = LOGO_SOURCES, run = exec, platform = process.platform }) {
  const dir = path.join(dataDir, "agent-logos");
  let cached = null;
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
  return async function logos() {
    const found = Object.entries(sources).map(([name, source]) => [name, source, stat(source.file)]);
    const key = found.map(([name, , s]) => `${name}=${s}`).join("|");
    if (cached?.key === key) return cached.value;
    const out = {};
    if (platform === "darwin") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [name, source, s] of found) {
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
    const value = { version: crypto.createHash("sha1").update(key).digest("base64url").slice(0, 12), logos: out };
    cached = { key, value };
    return value;
  };
}
