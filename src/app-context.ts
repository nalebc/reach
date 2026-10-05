import type { DesktopAction } from "./desktop-input-queue";
import { shortcutText } from "./screen-action-catalog";

// Context shortcuts: commands for whichever app is in front on the computer.
// On Mac, apps describe their own commands through their menu bar; Reach
// presses the real menu item. Known apps get hand-picked top commands with
// keyboard fallbacks. On Windows, curated keyboard shortcuts per app.
export type HostApp = { name: string; bundle: string };
export type MenuItem = {
  path: string[];
  shortcut?: { key: string; modifiers: string[] };
};
export type ContextAction = {
  id: string;
  label: string;
  keys?: string;
  group?: string;
  action: DesktopAction;
};
type Pick = {
  label: string;
  titles?: string[];
  key: string;
  modifiers: { darwin: string[]; win32: string[] };
};

const pick = (
  label: string,
  key: string,
  mac: string[],
  win: string[],
  titles?: string[],
): Pick => ({ label, key, titles, modifiers: { darwin: mac, win32: win } });

const BROWSER: Pick[] = [
  pick("New tab", "t", ["meta"], ["control"], ["New Tab"]),
  pick("Close tab", "w", ["meta"], ["control"], ["Close Tab"]),
  pick("Reopen tab", "t", ["meta", "shift"], ["control", "shift"], [
    "Reopen Closed Tab",
    "Reopen Last Closed Tab",
  ]),
  pick("Reload", "r", ["meta"], ["control"], [
    "Reload This Page",
    "Reload Page",
    "Reload",
  ]),
  pick("Back", "left", ["meta"], ["alt"], ["Back"]),
  pick("Forward", "right", ["meta"], ["alt"], ["Forward"]),
  pick("Address bar", "l", ["meta"], ["control"], [
    "Open Location…",
    "Open Location...",
  ]),
  pick("Find", "f", ["meta"], ["control"], ["Find…", "Find..."]),
];
const TERMINAL: Pick[] = [
  pick("New tab", "t", ["meta"], ["control", "shift"]),
  pick("Interrupt (Ctrl C)", "c", ["control"], ["control"]),
  pick("Clear", "k", ["meta"], ["control", "shift"]),
  pick("Previous command", "up", [], []),
  pick("Close tab", "w", ["meta"], ["control", "shift"]),
  pick("Find", "f", ["meta"], ["control", "shift"]),
];
const FILES: Pick[] = [
  pick("New window", "n", ["meta"], ["control"], ["New Finder Window"]),
  pick("New folder", "n", ["meta", "shift"], ["control", "shift"], [
    "New Folder",
  ]),
  pick("Up a folder", "up", ["meta"], ["alt"], ["Enclosing Folder"]),
  pick("Search", "f", ["meta"], ["control"], ["Find"]),
];
const CODE_EDITOR: Pick[] = [
  pick("Quick open", "p", ["meta"], ["control"], ["Go to File...", "Go to File…"]),
  pick("Command palette", "p", ["meta", "shift"], ["control", "shift"], [
    "Command Palette...",
    "Command Palette…",
  ]),
  pick("Save", "s", ["meta"], ["control"], ["Save"]),
  pick("Find", "f", ["meta"], ["control"], ["Find"]),
];

const KNOWN: { match: RegExp; picks: Pick[] }[] = [
  {
    match:
      /^(com\.google\.chrome|com\.apple\.safari|company\.thebrowser\.browser|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.brave\.browser|chrome|msedge|firefox|brave)$/i,
    picks: BROWSER,
  },
  {
    match: /^(com\.apple\.terminal|com\.googlecode\.iterm2|windowsterminal|wt)$/i,
    picks: TERMINAL,
  },
  { match: /^(com\.apple\.finder|explorer)$/i, picks: FILES },
  {
    match: /^(com\.microsoft\.vscode|com\.todesktop\..*|code|cursor)$/i,
    picks: CODE_EDITOR,
  },
];

// For any other app (Codex, Claude, Slack…), rank its own menu commands.
const RANKED = [
  /^new (chat|thread|conversation|session|message)/i,
  /^new tab/i,
  /^new window/i,
  /^new\b/i,
  /^(open|go to)\b/i,
  /^(find|search)\b/i,
  /^(reload|refresh)\b/i,
  /^save$/i,
  /^close tab/i,
];
const leaf = (item: MenuItem) => item.path[item.path.length - 1];
const clean = (title: string) => title.replace(/(\.\.\.|…)$/, "");

function menuKeys(platform: string, item: MenuItem) {
  if (!item.shortcut) return undefined;
  const { key, modifiers } = item.shortcut;
  // Menu keys arrive as display characters (e.g. "T", "←"), not key ids.
  return shortcutText(platform, modifiers, "x").replace(/X$/, key);
}

function menuAction(platform: string, item: MenuItem, label?: string): ContextAction {
  return {
    id: `menu:${item.path.join("\u0000")}`,
    label: label ?? clean(leaf(item)),
    keys: menuKeys(platform, item),
    group: item.path[0],
    action: { type: "menu", path: item.path },
  };
}

export function contextPicks(
  platform: string,
  app: HostApp | null,
  items: MenuItem[],
): ContextAction[] {
  if (!app) return [];
  const os = platform === "darwin" ? "darwin" : "win32";
  const known = KNOWN.find((k) => k.match.test(app.bundle))?.picks;
  if (known)
    return known.map((p) => {
      // Prefer the app's own menu command when it has one; keys otherwise.
      const menu =
        platform === "darwin" &&
        p.titles &&
        items.find((i) => p.titles!.includes(leaf(i)));
      if (menu) return menuAction(platform, menu, p.label);
      const modifiers = p.modifiers[os];
      return {
        id: `key:${p.label}`,
        label: p.label,
        keys: shortcutText(platform, modifiers, p.key),
        action: { type: "key", key: p.key, modifiers },
      };
    });
  const seen = new Set<string>();
  const ranked: ContextAction[] = [];
  for (const pattern of RANKED)
    for (const item of items)
      if (item.shortcut && pattern.test(leaf(item)) && !seen.has(leaf(item))) {
        seen.add(leaf(item));
        ranked.push(menuAction(platform, item));
      }
  return ranked.slice(0, 6);
}

export function allCommands(platform: string, items: MenuItem[]): ContextAction[] {
  return items.map((item) => ({
    ...menuAction(platform, item),
    label: item.path.slice(1).map(clean).join(" › "),
  }));
}
