import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "./platform.mjs";
import { readMacIcons, valid } from "./app-icons.mjs";
import { readWindowsFileTypeIcons } from "./windows-shell-data.mjs";

// The icon each platform's own file manager shows for a file type: Finder on a
// Mac, Explorer on Windows, the desktop icon theme on Linux. Containers and
// machines without a desktop icon set return null, and Reach's own icons stay.
export const isIconType = (value) =>
  typeof value === "string" && /^(?:folder|file|[a-z0-9]{1,16})$/.test(value);

export const inContainer = (exists = existsSync) =>
  exists("/.dockerenv") || exists("/run/.containerenv");

export async function readFileIcons(
  types,
  { platform = process.platform, run = exec, linux = {}, windows = {}, authorize = () => {} } = {},
) {
  if (!types.length) return [];
  const nativeRun = (...args) => { authorize(); return run(...args); };
  authorize();
  if (platform === "darwin") return readMacIcons(types, nativeRun);
  if (platform === "win32") return (await readWindowsFileTypeIcons(types, { run: nativeRun, ...windows,
    authorize: () => { authorize(); windows.authorize?.(); },
  })).map(valid);
  if (platform === "linux" && !inContainer())
    return readLinuxIcons(types, { ...linux,
      run: (...args) => { authorize(); return (linux.run || exec)(...args); },
    });
  return types.map(() => null);
}

// freedesktop.org: extension → MIME type (shared-mime-info) → icon name →
// file in the user's icon theme or one it inherits from.
const MAX_ICON = 60 * 1024;
async function read(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}
async function currentTheme(run) {
  try {
    const { stdout } = await run(
      "gsettings",
      ["get", "org.gnome.desktop.interface", "icon-theme"],
      { timeout: 3000 },
    );
    const name = String(stdout).trim().replace(/^'|'$/g, "");
    if (name) return name;
  } catch {}
  const kde = await read(path.join(os.homedir(), ".config", "kdeglobals"));
  return kde.match(/^\[Icons\][^[]*?^Theme=(.+)$/m)?.[1]?.trim() || "";
}
function parseTheme(text) {
  const sections = {};
  let current = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^\[(.+)\]\s*$/);
    if (header) current = sections[header[1]] = {};
    else if (current) {
      const pair = line.match(/^([\w-]+)\s*=\s*(.*)$/);
      if (pair) current[pair[1]] = pair[2].trim();
    }
  }
  return sections;
}
export async function readLinuxIcons(
  types,
  {
    dataDirs = [
      path.join(os.homedir(), ".local", "share"),
      ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(
        ":",
      ),
    ],
    theme,
    run = exec,
  } = {},
) {
  // Extension → MIME type, and each type's generic fallback icon.
  const mime = new Map(),
    generic = new Map();
  for (const dir of dataDirs) {
    for (const line of (await read(path.join(dir, "mime", "globs2"))).split(
      "\n",
    )) {
      const match = line.match(/^\d+:([^:]+):\*\.([a-z0-9]+)$/i);
      if (match && !mime.has(match[2].toLowerCase()))
        mime.set(match[2].toLowerCase(), match[1]);
    }
    for (const line of (
      await read(path.join(dir, "mime", "generic-icons"))
    ).split("\n")) {
      const [type, icon] = line.split(":");
      if (type && icon && !generic.has(type)) generic.set(type, icon.trim());
    }
  }
  // The theme and everything it inherits, ending with hicolor.
  const bases = [
    path.join(os.homedir(), ".icons"),
    ...dataDirs.map((dir) => path.join(dir, "icons")),
  ];
  const themes = [];
  const queue = [theme ?? (await currentTheme(run)), "Adwaita", "hicolor"];
  while (queue.length && themes.length < 8) {
    const name = queue.shift();
    if (!name || themes.some((t) => t.name === name)) continue;
    for (const base of bases) {
      const index = await read(path.join(base, name, "index.theme"));
      if (!index) continue;
      const sections = parseTheme(index);
      const info = sections["Icon Theme"] || {};
      // Prefer scalable art, then the size closest to 128 px.
      const dirs = [info.Directories, info.ScaledDirectories]
        .filter(Boolean)
        .flatMap((list) => list.split(","))
        .map((dir) => dir.trim())
        .filter((dir) =>
          /^(mimetypes|places)$/i.test(sections[dir]?.Context || ""),
        )
        .sort((a, b) => {
          const rank = (dir) =>
            sections[dir].Type === "Scalable"
              ? 0
              : Math.abs(Number(sections[dir].Size || 0) - 128) + 1;
          return rank(a) - rank(b);
        });
      themes.push({ name, root: path.join(base, name), dirs });
      queue.splice(
        0,
        0,
        ...(info.Inherits || "").split(",").map((t) => t.trim()),
      );
      break;
    }
  }
  const names = (type) => {
    if (type === "folder") return ["folder"];
    const kind = mime.get(type);
    return [
      ...(kind
        ? [
            kind.replace("/", "-"),
            generic.get(kind),
            `${kind.split("/")[0]}-x-generic`,
          ]
        : []),
      "text-x-generic",
      "unknown",
    ].filter(Boolean);
  };
  const find = async (type) => {
    for (const name of names(type))
      for (const { root, dirs } of themes)
        for (const dir of dirs)
          for (const ext of ["svg", "png"]) {
            const file = path.join(root, dir, `${name}.${ext}`);
            try {
              const data = await fs.readFile(file);
              if (data.length > MAX_ICON) continue;
              return ext === "png"
                ? valid(data.toString("base64"))
                : `data:image/svg+xml;base64,${data.toString("base64")}`;
            } catch {}
          }
    return null;
  };
  return Promise.all(types.map(find));
}
