// Laptop shortcuts offered on the Screen page. Shortcut text is derived from
// the keys actually sent, so a button can never show one shortcut and send
// another. Every key and modifier must be supported by the server protocol
// and each platform's native input helper (checked in test/screen-actions).
export type CatalogAction = {
  id: string;
  label: string;
  /** The tile's own word or two, when the label is longer. */
  short?: string;
  key: string;
  modifiers: string[];
};
export type CatalogGroup = { title: string; items: CatalogAction[] };

// The key composer's keys, in the order its grid shows them: named keys
// first (rows of four: arrows together), then function keys, letters and
// digits behind one small expand.
export const NAMED_KEYS = [
  "enter",
  "tab",
  "escape",
  "space",
  "backspace",
  "delete",
  "home",
  "end",
  "left",
  "up",
  "down",
  "right",
  "pageup",
  "pagedown",
];
export const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
export const CHARACTER_KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789"];
// Every key the composer can send (checked end to end in test/screen-actions).
export const EXTRA_KEYS = [...NAMED_KEYS, ...FUNCTION_KEYS, ...CHARACTER_KEYS];

// The everyday shortcuts shown up front; the rest are one tap away.
export const EVERYDAY = [
  "previous-tab",
  "next-tab",
  "new-tab",
  "close-tab",
  "switch-app",
  "find",
  "undo",
  "escape",
];

export function screenActionGroups(platform: string): CatalogGroup[] {
  const mac = platform === "darwin";
  const primary = mac ? "meta" : "control";
  // macOS: Mission Control is Ctrl ↑ and desktops are Ctrl ←/→.
  // Windows: Task View is Win Tab and desktops are Win Ctrl ←/→.
  const desktop = mac ? ["control"] : ["meta", "control"];
  return [
    {
      title: "Tabs",
      items: [
        { id: "previous-tab", label: "Previous tab", key: "tab", modifiers: ["control", "shift"] },
        { id: "next-tab", label: "Next tab", key: "tab", modifiers: ["control"] },
        { id: "new-tab", label: "New tab", key: "t", modifiers: [primary] },
        { id: "reopen-tab", label: "Reopen tab", key: "t", modifiers: [primary, "shift"] },
        { id: "close-tab", label: "Close tab / window", short: "Close tab", key: "w", modifiers: [primary] },
      ],
    },
    {
      title: "Apps & desktops",
      items: [
        { id: "switch-app", label: "Switch app", key: "tab", modifiers: [mac ? "meta" : "alt"] },
        {
          id: "all-windows",
          label: "All windows",
          key: mac ? "up" : "tab",
          modifiers: [mac ? "control" : "meta"],
        },
        { id: "previous-desktop", label: "Previous desktop", key: "left", modifiers: desktop },
        { id: "next-desktop", label: "Next desktop", key: "right", modifiers: desktop },
      ],
    },
    {
      title: "Quick keys",
      items: [
        { id: "find", label: "Find", key: "f", modifiers: [primary] },
        { id: "undo", label: "Undo", key: "z", modifiers: [primary] },
        { id: "escape", label: "Escape", key: "escape", modifiers: [] },
      ],
    },
  ];
}

const MODIFIER_ORDER: Record<string, string[]> = {
  // Apple's conventional order: ⌃ ⌥ ⇧ ⌘.
  darwin: ["fn", "control", "alt", "shift", "meta"],
  other: ["meta", "control", "alt", "shift", "fn"],
};
const MODIFIER_NAMES: Record<string, Record<string, string>> = {
  darwin: { meta: "⌘", control: "Ctrl", alt: "⌥", shift: "Shift", fn: "fn", caps: "Caps" },
  win32: { meta: "Win", control: "Ctrl", alt: "Alt", shift: "Shift", fn: "Fn", caps: "Caps" },
  linux: { meta: "Super", control: "Ctrl", alt: "Alt", shift: "Shift", fn: "Fn", caps: "Caps" },
};
const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Esc",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
};

export function keyName(platform: string, key: string) {
  if (platform === "darwin" && key === "backspace") return "⌫";
  if (platform === "darwin" && key === "delete") return "⌦";
  if (platform === "darwin" && key === "enter") return "Return";
  return KEY_NAMES[key] ?? key.toUpperCase();
}

// A key's word under its tile: what the keyboard itself prints there.
const KEY_WORDS: Record<string, string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Esc",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  left: "Left",
  up: "Up",
  down: "Down",
  right: "Right",
  pageup: "Page up",
  pagedown: "Page down",
};
export function keyWord(platform: string, key: string) {
  if (platform === "darwin" && key === "enter") return "Return";
  if (platform === "darwin" && key === "backspace") return "Delete";
  if (platform === "darwin" && key === "delete") return "Forward delete";
  return KEY_WORDS[key] ?? key.toUpperCase();
}

export function shortcutText(platform: string, modifiers: string[], key: string) {
  const names = MODIFIER_NAMES[platform] ?? MODIFIER_NAMES.linux;
  const order = MODIFIER_ORDER[platform === "darwin" ? "darwin" : "other"];
  const sorted = [...modifiers].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...sorted.map((m) => names[m] ?? m), keyName(platform, key)].join(" ");
}

// The composer's modifier chips, in the order each platform's keyboard
// prints them: ⌘ ⌥ ⌃ ⇧ on a Mac, Win Ctrl Alt Shift elsewhere. `symbol` is
// what the chip shows, `name` what it is called.
export function modifierChips(platform: string) {
  if (platform === "darwin")
    return [
      { id: "meta", symbol: "⌘", name: "Command" },
      { id: "alt", symbol: "⌥", name: "Option" },
      { id: "control", symbol: "⌃", name: "Control" },
      { id: "shift", symbol: "⇧", name: "Shift" },
    ];
  const names = MODIFIER_NAMES[platform] ?? MODIFIER_NAMES.linux;
  const spoken: Record<string, string> = {
    meta: platform === "win32" ? "Windows" : names.meta,
    control: "Control",
    alt: "Alt",
    shift: "Shift",
  };
  return ["meta", "control", "alt", "shift"].map((id) => ({
    id,
    symbol: names[id],
    name: spoken[id],
  }));
}

// What the held chips add up to, before a key is chosen: "⇧⌘ + …" on a Mac
// (symbols together, in the order its menus write them), "Ctrl + Shift + …"
// elsewhere.
export function comboPreview(platform: string, modifiers: string[]) {
  if (!modifiers.length) return "";
  const order = MODIFIER_ORDER[platform === "darwin" ? "darwin" : "other"];
  const chips = modifierChips(platform)
    .filter((chip) => modifiers.includes(chip.id))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return platform === "darwin"
    ? `${chips.map((chip) => chip.symbol).join("")} + …`
    : `${chips.map((chip) => chip.symbol).join(" + ")} + …`;
}
