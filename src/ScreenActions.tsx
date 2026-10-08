import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  X,
  RotateCcw,
  AppWindow,
  LayoutGrid,
  Search,
  Undo2,
  CornerUpLeft,
  type LucideIcon,
} from "lucide-react";
import type { DesktopAction } from "./desktop-input-queue";
import {
  EXTRA_KEYS,
  keyName,
  screenActionGroups,
  shortcutText,
} from "./screen-action-catalog";

export type ScreenAction = {
  label: string;
  keys: string;
  action: DesktopAction;
};
const COMMON = ["undo", "find", "escape", "switch-app", "new-tab", "close-tab"];
export default function ScreenActions({
  platform,
  disabled,
  run,
}: {
  platform: string;
  disabled: boolean;
  run: (action: ScreenAction) => void;
}) {
  const [modifiers, setModifiers] = useState<string[]>([]);
  const [extraKey, setExtraKey] = useState("enter");
  const mac = platform === "darwin";
  const icons: Record<string, LucideIcon> = {
    "previous-tab": ArrowLeft,
    "next-tab": ArrowRight,
    "new-tab": Plus,
    "reopen-tab": RotateCcw,
    "close-tab": X,
    "switch-app": AppWindow,
    "all-windows": LayoutGrid,
    "previous-desktop": ArrowLeft,
    "next-desktop": ArrowRight,
    find: Search,
    undo: Undo2,
    escape: CornerUpLeft,
  };
  // Shortcut text comes from the keys actually sent; see screen-action-catalog.
  const items = screenActionGroups(platform)
    .flatMap((group) => group.items)
    .map((item) => ({
      ...item,
      keys: shortcutText(platform, item.modifiers, item.key),
      Icon: icons[item.id],
    }));
  const [more, setMore] = useState(false);
  // A few everyday keys up front; the rest stay one tap away.
  const shown = more ? items : items.filter((item) => COMMON.includes(item.id));
  return (
    <section className="screen-action-groups">
      <h3>Keys</h3>
      <div className="screen-helper-grid">
        {shown.map(({ label, keys, key, modifiers, Icon }) => (
          <button
            key={label}
            className="screen-helper-action"
            disabled={disabled}
            onClick={() =>
              run({ label, keys, action: { type: "key", key, modifiers } })
            }
          >
            <Icon size={18} />
            <span>
              {label}
              <small>{keys}</small>
            </span>
          </button>
        ))}
      </div>
      {more && (
        <div className="extra-laptop-keys">
          <div
            className="action-modifiers"
            role="group"
            aria-label="Key modifiers"
          >
            {[
              ["meta", mac ? "⌘ Command" : "Windows"],
              ["control", "Ctrl"],
              ["alt", mac ? "⌥ Option" : "Alt"],
              ["shift", "⇧ Shift"],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={modifiers.includes(id)}
                disabled={disabled}
                onClick={() =>
                  setModifiers((current) =>
                    current.includes(id)
                      ? current.filter((m) => m !== id)
                      : [...current, id],
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="action-key-picker">
            <select
              aria-label="Laptop key"
              value={extraKey}
              onChange={(e) => setExtraKey(e.target.value)}
            >
              {EXTRA_KEYS.map((key) => (
                <option key={key} value={key}>
                  {keyName(platform, key)}
                </option>
              ))}
            </select>
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() =>
                run({
                  label: "Key sent",
                  keys: shortcutText(platform, modifiers, extraKey),
                  action: { type: "key", key: extraKey, modifiers },
                })
              }
            >
              Send key
            </button>
          </div>
        </div>
      )}
      <button
        className="button ghost small screen-more-toggle"
        aria-expanded={more}
        onClick={() => setMore((value) => !value)}
      >
        {more ? "Fewer keys" : "More keys"}
      </button>
    </section>
  );
}
