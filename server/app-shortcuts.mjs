import path from "node:path";
import fs from "node:fs/promises";
import { apps, launchApp, exec } from "./platform.mjs";
import { fail, id as newId, loadJson, atomicJson } from "./core.mjs";
import { createAppIconCache, readAppIcons } from "./app-icons.mjs";
import { bundledCodexPaths } from "./capabilities.mjs";
import { codexNative, findWindowsCli, spawnable } from "./agent-cli.mjs";

export function shortcutUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw fail(400, "Enter a complete http or https website address.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail(400, "Enter a complete website address, including https://.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw fail(400, "Use an http or https link without embedded credentials.");
  return url.href;
}
async function openUrl(url) {
  if (process.platform === "darwin")
    await exec("/usr/bin/open", [url], { timeout: 12000 });
  else if (process.platform === "win32")
    await exec("explorer.exe", [url], { timeout: 12000, windowsHide: true });
  else throw fail(501, "Desktop shortcuts support Mac and Windows.");
}
function definition(value) {
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.trim().length > 60 ||
    /[\u0000-\u001f\u007f]/.test(value.name)
  )
    throw fail(400, "Give this shortcut a name of up to 60 characters.");
  const name = value.name.trim();
  if (value.type === "website")
    return { name, type: "website", url: shortcutUrl(value.url) };
  if (value.type === "terminal") {
    // A command run in a new terminal window, inside a shared folder.
    const root = value.root ?? 0,
      folder = value.path ?? "",
      command = value.command;
    if (
      !Number.isInteger(root) ||
      root < 0 ||
      root > 64 ||
      typeof folder !== "string" ||
      folder.length > 1024 ||
      folder.includes("\0")
    )
      throw fail(400, "Choose a folder inside one of your shared folders.");
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 2000 ||
      /[\u0000-\u001f\u007f]/.test(command)
    )
      throw fail(400, "Enter a one-line command of up to 2,000 characters.");
    return { name, type: "terminal", root, path: folder, command: command.trim() };
  }
  if (
    value.type !== "app" ||
    typeof value.actionId !== "string" ||
    value.actionId.length > 4096 ||
    !(
      value.actionId === "codex-new" ||
      value.actionId.startsWith("app:") ||
      value.actionId.startsWith("recipe:")
    )
  )
    throw fail(400, "Choose an installed app or a website.");
  return { name, type: "app", actionId: value.actionId };
}
// The Codex desktop app (now ChatGPT.app) registers codex:// under this id.
const CODEX_BUNDLE = "com.openai.codex";
// A Mac app's bundle id, from its Info.plist (binary or XML), or null.
async function readBundleId(app) {
  if (process.platform !== "darwin" || !/\.app$/.test(app)) return null;
  try {
    const plist = path.join(app, "Contents", "Info.plist");
    const { stdout } = await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { timeout: 4000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
// Windows: the CLI as cmd starts it, its full path(s) quoted (agent-cli.mjs
// finds it as Node would, native installs off PATH too). Never the bare name:
// PowerShell would run npm's claude.ps1, which Windows' default policy
// refuses ("running scripts is disabled"), and a native install off PATH
// wasn't found at all.
export async function windowsCliCommand(name, { find = findWindowsCli, node = process.execPath } = {}) {
  const found = await find(name, name === "codex" ? { native: (script) => codexNative(script) } : {});
  if (!found) return null;
  const { file, args } = spawnable(found, { platform: "win32", node });
  return [file, ...args].map((part) => `"${part}"`).join(" ");
}
// That command as PowerShell runs it: a call (&) with each part in single
// quotes ($ and backticks stay as written).
export const powershellCall = (command) =>
  /^"/.test(command)
    ? `& ${command.replace(/"([^"]*)"/g, (_, part) => `'${part.replace(/'/g, "''")}'`)}`
    : command;
// Where an agent CLI can be started from a terminal, or null when missing.
// bundled: a list of paths, or a function giving one.
async function findCli(name, bundled = []) {
  if (process.platform === "win32") return windowsCliCommand(name);
  try {
    const { stdout } = await exec(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${name}`], {
      timeout: 4000,
    });
    if (stdout.trim()) return name;
  } catch {}
  for (const file of typeof bundled === "function" ? await bundled() : bundled) {
    try {
      await fs.access(file, fs.constants.X_OK);
      return shellQuote(file);
    } catch {}
  }
  return null;
}
// Opens a new terminal window in `cwd` running `command`. Mac terminals are
// provided by the host (desktop terminal integration); Windows uses PowerShell.
async function openWindowsTerminal({ cwd, command }) {
  if (process.platform !== "win32")
    throw fail(501, "Terminal shortcuts are not available on this computer.");
  const encoded = Buffer.from(powershellCall(command), "utf16le").toString("base64");
  await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process powershell -WorkingDirectory '${cwd.replace(/'/g, "''")}' -ArgumentList '-NoExit','-EncodedCommand','${encoded}'`,
    ],
    { timeout: 12000, windowsHide: true },
  );
}
const RECIPES = [
  {
    id: "recipe:codex-terminal",
    name: "Codex in Terminal",
    detail: "New terminal in your shared folder, running Codex",
    cli: "codex",
    bundled: bundledCodexPaths,
  },
  {
    id: "recipe:claude-terminal",
    name: "Claude Code in Terminal",
    detail: "New terminal in your shared folder, running Claude Code",
    cli: "claude",
    bundled: [],
  },
];
// Agents a Reach terminal can start, by request name.
export const AGENTS = { codex: "Codex", claude: "Claude Code" };
// The command that starts an agent CLI, or null when it isn't installed.
export function agentCommand(name) {
  const recipe = RECIPES.find((r) => r.cli === name);
  return recipe ? findCli(recipe.cli, recipe.bundled) : Promise.resolve(null);
}
export function createAppShortcuts({
  dataDir,
  listApps = apps,
  launch = launchApp,
  openCodex = () => openUrl("codex://threads/new"),
  openWebsite = openUrl,
  // Reads icons for a list of app ids; loadIcon substitutes a one-at-a-time reader.
  loadIcons = readAppIcons,
  loadIcon = null,
  // (command, authorize) => opens a Mac terminal window running command.
  macTerminal = null,
  // (root, path) => absolute folder inside the shared folders.
  resolveFolder = () => {
    throw fail(501, "Terminal shortcuts are not available here.");
  },
  locateCli = findCli,
  bundleId = readBundleId,
} = {}) {
  const terminalAvailable =
    process.platform === "win32" || (process.platform === "darwin" && !!macTerminal);
  const openTerminal = async ({ cwd, command }, authorize) =>
    process.platform === "darwin"
      ? macTerminal(`cd ${shellQuote(cwd)} && ${command}`, authorize)
      : openWindowsTerminal({ cwd, command });
  const openIn = async (root, folder, command, authorize) => {
    const cwd = resolveFolder(root, folder);
    authorize();
    await openTerminal({ cwd, command }, authorize);
  };
  // Bundle ids by app path; an app at a path keeps its id.
  const bundles = new Map();
  const bundleOf = (app) => {
    if (typeof app.bundleId === "string") return app.bundleId;
    if (!bundles.has(app.id))
      bundles.set(app.id, Promise.resolve(app.id).then(bundleId).catch(() => null));
    return bundles.get(app.id);
  };
  let cliCache = { at: 0, commands: new Map() };
  const recipeCommands = async () => {
    if (!terminalAvailable) return new Map();
    if (Date.now() - cliCache.at > 300000) {
      const commands = new Map();
      for (const recipe of RECIPES) {
        const command = await locateCli(recipe.cli, recipe.bundled);
        if (command) commands.set(recipe.id, command);
      }
      cliCache = { at: Date.now(), commands };
    }
    return cliCache.commands;
  };
  const icon = createAppIconCache(
    loadIcon
      ? async (ids) => {
          const found = [];
          for (const id of ids)
            found.push(await Promise.resolve(id).then(loadIcon).catch(() => null));
          return found;
        }
      : loadIcons,
  );
  const installedIds = async (ids) => {
    const installed = new Set((await listApps()).map((a) => a.id));
    return ids.filter((id) => installed.has(id));
  };
  const file = dataDir ? path.join(dataDir, "shortcuts.json") : null;
  const stored = file ? loadJson(file, []) : [];
  let custom = (Array.isArray(stored) ? stored : [])
    .slice(0, 50)
    .flatMap((value) => {
      try {
        if (!/^custom:[a-f0-9-]{36}$/.test(value.id)) return [];
        return [{ id: value.id, ...definition(value) }];
      } catch {
        return [];
      }
    });
  const persist = (next) => {
    if (file) atomicJson(file, next);
    custom = next;
  };
  const catalog = async () => {
    const installed = await listApps();
    // The app registering codex://, by bundle id; the name only when ids are
    // unknown. ChatGPT's name alone does not establish that Codex is installed.
    const ids = await Promise.all(installed.map(bundleOf));
    const codex =
      installed.find((a, i) => ids[i] === CODEX_BUNDLE) ||
      installed.find((a, i) => !ids[i] && /^codex$/i.test(a.name));
    const commands = await recipeCommands();
    return [
      // Multi-step shortcuts: open a terminal in the shared folder and start an agent.
      ...RECIPES.filter((r) => commands.has(r.id)).map((r) => ({
        id: r.id,
        name: r.name,
        detail: r.detail,
        kind: "terminal",
        suggested: true,
      })),
      ...(codex
        ? [
            {
              id: "codex-new",
              name: "New Codex session",
              detail: "Start fresh in the desktop app",
              kind: "codex",
              suggested: true,
              appId: codex.id,
            },
          ]
        : []),
      ...installed.map((a) => {
        const known =
          a === codex
            ? [/^codex$/i.test(a.name) ? "Codex" : a.name, "codex"]
            : /^Google Chrome$/i.test(a.name)
              ? ["Chrome", "browser"]
              : /^Safari$/i.test(a.name)
                ? ["Safari", "browser"]
                : /^(?:Firefox|Microsoft Edge)$/i.test(a.name)
                  ? [a.name, "browser"]
                  : /^(?:Terminal|iTerm|iTerm2|Windows Terminal|PowerShell)$/i.test(
                        a.name,
                      )
                    ? [a.name, "terminal"]
                    : null;
        return {
          id: "app:" + a.id,
          name: known ? `Open ${known[0]}` : a.name,
          detail: "Open on your computer",
          kind: known?.[1] || "app",
          suggested: !!known,
          appId: a.id,
        };
      }),
    ];
  };
  const list = async () => {
    const builtins = await catalog();
    return [
      ...custom.flatMap((c) => {
        if (c.type === "terminal")
          return terminalAvailable
            ? [
                {
                  id: c.id,
                  name: c.name,
                  detail: c.command,
                  kind: "terminal",
                  custom: true,
                },
              ]
            : [];
        const target = builtins.find((a) => a.id === c.actionId);
        if (c.type === "app" && !target) return [];
        return [
          {
            id: c.id,
            name: c.name,
            detail:
              c.type === "website" ? new URL(c.url).hostname : target.name,
            kind: c.type === "website" ? "browser" : target.kind,
            custom: true,
            ...(target && c.type === "app" ? { appId: target.appId } : {}),
          },
        ];
      }),
      ...builtins,
    ];
  };
  return {
    list,
    async icon(appId) {
      if (
        typeof appId !== "string" ||
        appId.length > 4096 ||
        !(await listApps()).some((a) => a.id === appId)
      )
        throw fail(404, "Choose an installed app.");
      return { icon: await icon(appId) };
    },
    // Icons for a screenful of apps in one request. Ids that aren't installed
    // are left out and never reach the native reader.
    async icons(ids) {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 64 ||
        ids.some((id) => typeof id !== "string" || id.length > 4096)
      )
        throw fail(400, "Choose up to 64 installed apps.");
      const found = await installedIds([...new Set(ids)]);
      const result = await Promise.all(found.map(icon));
      return { icons: Object.fromEntries(found.map((id, i) => [id, result[i]])) };
    },
    async customList() {
      const builtins = await catalog();
      return custom.map((c) => ({
        ...c,
        available:
          c.type === "website" ||
          (c.type === "terminal" && terminalAvailable) ||
          builtins.some((a) => a.id === c.actionId),
      }));
    },
    async save(value, authorize = () => {}) {
      const entry = definition(value);
      if (
        entry.type === "app" &&
        !(await catalog()).some((a) => a.id === entry.actionId)
      )
        throw fail(404, "That app is not installed on this computer.");
      if (entry.type === "terminal") {
        if (!terminalAvailable)
          throw fail(501, "Terminal shortcuts are not available on this computer.");
        resolveFolder(entry.root, entry.path);
      }
      authorize();
      if (
        value.id !== undefined &&
        (typeof value.id !== "string" || !custom.some((c) => c.id === value.id))
      )
        throw fail(404, "Shortcut not found.");
      if (!value.id && custom.length >= 50)
        throw fail(400, "You can save up to 50 custom shortcuts.");
      const saved = { id: value.id || `custom:${newId()}`, ...entry };
      persist(
        value.id
          ? custom.map((c) => (c.id === value.id ? saved : c))
          : [...custom, saved],
      );
      return saved;
    },
    remove(id, authorize = () => {}) {
      authorize();
      if (!custom.some((c) => c.id === id))
        throw fail(404, "Shortcut not found.");
      persist(custom.filter((c) => c.id !== id));
      return { ok: true };
    },
    async run(id, authorize = () => {}) {
      if (typeof id !== "string" || id.length > 4096)
        throw fail(400, "Choose a shortcut.");
      const builtins = await catalog();
      const saved = custom.find((c) => c.id === id);
      if (saved?.type === "terminal") {
        if (!terminalAvailable)
          throw fail(501, "Terminal shortcuts are not available on this computer.");
        authorize();
        await openIn(saved.root, saved.path, saved.command, authorize);
        return { name: saved.name };
      }
      const action = builtins.find((a) => a.id === (saved?.actionId || id));
      if (!action && saved?.type !== "website")
        throw fail(404, "This shortcut is no longer available.");
      authorize();
      if (saved?.type === "website") await openWebsite(shortcutUrl(saved.url));
      else if (action.id === "codex-new") await openCodex();
      else if (action.id.startsWith("recipe:"))
        await openIn(0, "", (await recipeCommands()).get(action.id), authorize);
      else await launch(action.id.slice(4));
      return { name: saved?.name || action.name };
    },
  };
}
