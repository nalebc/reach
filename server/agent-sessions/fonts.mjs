// The Claude app's own typefaces (Anthropic Sans and Serif), read from the app
// installed on this Mac and never shipped with Reach, like the logos: the phone
// draws Claude's chats in them. The files carry a new hashed name with each app
// update, so the app's own stylesheet says which they are. Without the app (or
// on Windows) there are none and the phone uses its serif and sans.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLAUDE_ASSETS = "/Applications/Claude.app/Contents/Resources/ion-dist/assets/v1";
const FAMILIES = ["anthropic-sans", "anthropic-serif"];
// @font-face{font-family:anthropic-serif;src:url(/assets/v1/x.woff2)format("woff2");…font-style:normal…}
const FACE = /@font-face\{font-family:("?)(anthropic-(?:sans|serif))\1;src:url\(([^)]+?\.woff2)\)[^}]*?font-style:normal/g;

export function createAgentFonts({ dir = CLAUDE_ASSETS } = {}) {
  let cached = null;
  const stamp = () => {
    try {
      const s = fs.statSync(dir);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  };
  // { version, files: { family: absolute path } }, worked out once per app version.
  const scan = () => {
    const key = stamp();
    if (cached?.key === key) return cached.value;
    const files = {};
    if (key) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".css")) continue;
        let css;
        try {
          css = fs.readFileSync(path.join(dir, name), "utf8");
        } catch {
          continue;
        }
        if (!css.includes("anthropic-")) continue;
        for (const [, , family, url] of css.matchAll(FACE)) {
          if (files[family]) continue;
          const file = path.join(dir, path.basename(url));
          if (fs.existsSync(file)) files[family] = file;
        }
        if (FAMILIES.every((f) => files[f])) break;
      }
    }
    const version = crypto
      .createHash("sha1")
      .update(`${key}|${Object.values(files).join("|")}`)
      .digest("base64url")
      .slice(0, 12);
    cached = { key, value: { version, files } };
    return cached.value;
  };
  return {
    list() {
      const { version, files } = scan();
      return { version, fonts: Object.keys(files) };
    },
    // The file for one family, or null.
    file(family) {
      return scan().files[family] || null;
    },
  };
}
