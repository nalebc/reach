// Laptop shortcuts offered on the Screen page. Shortcut text is derived from
// the keys actually sent, so a button can never show one shortcut and send
// another. Every key and modifier must be supported by the server protocol
// and each platform's native input helper (checked in test/screen-actions).
export type CatalogAction = {
  id: string;
  label: string;
  key: string;
  modifiers: string[];
};
export type CatalogGroup = { title: string; items: CatalogAction[] };

export const EXTRA_KEYS = [
  "enter",
  "tab",
  "escape",
  "left",
  "up",
  "down",
  "right",
  "backspace",
  "delete",
  "space",
  "home",
  "end",
  "pageup",
  "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
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
        { id: "close-tab", label: "Close tab / window", key: "w", modifiers: [primary] },
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

export function shortcutText(platform: string, modifiers: string[], key: string) {
  const names = MODIFIER_NAMES[platform] ?? MODIFIER_NAMES.linux;
  const order = MODIFIER_ORDER[platform === "darwin" ? "darwin" : "other"];
  const sorted = [...modifiers].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...sorted.map((m) => names[m] ?? m), keyName(platform, key)].join(" ");
}
