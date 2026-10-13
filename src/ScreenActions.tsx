import { useId, useState } from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleArrowOutUpLeft,
  CornerDownLeft,
  Delete,
  LayoutGrid,
  RotateCcwSquare,
  Search,
  Space,
  SquareArrowLeft,
  SquareArrowRight,
  SquarePlus,
  SquareX,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { DesktopAction } from "./desktop-input-queue";
import { KeyTile, TileHead } from "./KeyTiles";
import {
  CHARACTER_KEYS,
  EVERYDAY,
  FUNCTION_KEYS,
  NAMED_KEYS,
  comboPreview,
  keyWord,
  modifierChips,
  screenActionGroups,
  shortcutText,
} from "./screen-action-catalog";

export type ScreenAction = {
  label: string;
  keys: string;
  action: DesktopAction;
};

// One icon per meaning: tab moves are squares, desktops the bar's own
// chevrons and grid, keys what their keycaps show.
const ACTION_ICONS: Record<string, LucideIcon> = {
  "previous-tab": SquareArrowLeft,
  "next-tab": SquareArrowRight,
  "new-tab": SquarePlus,
  "reopen-tab": RotateCcwSquare,
  "close-tab": SquareX,
  "switch-app": AppWindow,
  "all-windows": LayoutGrid,
  "previous-desktop": ChevronLeft,
  "next-desktop": ChevronRight,
  find: Search,
  undo: Undo2,
  escape: CircleArrowOutUpLeft,
};
const KEY_ICONS: Record<string, LucideIcon> = {
  enter: CornerDownLeft,
  tab: ArrowRightToLine,
  escape: CircleArrowOutUpLeft,
  space: Space,
  backspace: Delete,
  delete: Delete,
  home: ChevronFirst,
  end: ChevronLast,
  left: ArrowLeft,
  up: ArrowUp,
  down: ArrowDown,
  right: ArrowRight,
  pageup: ChevronsUp,
  pagedown: ChevronsDown,
};

const keyAction = (key: string, modifiers: string[]): DesktopAction =>
  modifiers.length ? { type: "key", key, modifiers } : { type: "key", key };

export default function ScreenActions({
  platform,
  disabled,
  run,
  composer = true,
  shownAbove = [],
}: {
  platform: string;
  disabled: boolean;
  run: (action: ScreenAction) => void;
  /** The "any key" composer (modifier chips, then a key); off where the page has its own. */
  composer?: boolean;
  /**
   * Commands the app in front already offers above (by name): its own
   * version is the right one for it (Windows Terminal's New tab is
   * Ctrl Shift T), so Keys doesn't show a second tile for them.
   */
  shownAbove?: string[];
}) {
  const id = useId();
  const [more, setMore] = useState(false);
  const [pad, setPad] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const above = new Set(shownAbove.map((label) => label.toLowerCase()));
  const items = screenActionGroups(platform)
    .flatMap((group) => group.items)
    .filter(
      (item) =>
        !above.has(item.label.toLowerCase()) && !above.has((item.short ?? "").toLowerCase()),
    );
  // A few everyday keys up front; the rest stay one tap away, in place.
  const everyday = EVERYDAY.flatMap((wanted) => items.filter((item) => item.id === wanted));
  const rest = items.filter((item) => !EVERYDAY.includes(item.id));
  const chips = modifierChips(platform);
  // Chips in the keyboard's order, so the same combination always sends the same way.
  const modifiers = chips.filter((chip) => held.includes(chip.id)).map((chip) => chip.id);
  const preview = comboPreview(platform, modifiers);

  const action = (item: (typeof items)[number]) => {
    const keys = shortcutText(platform, item.modifiers, item.key);
    return (
      <KeyTile
        key={item.id}
        Icon={ACTION_ICONS[item.id]}
        label={item.short ?? item.label}
        name={`${item.label}, ${keys}`}
        shortcut={keys}
        disabled={disabled}
        onClick={() =>
          run({ label: item.label, keys, action: keyAction(item.key, item.modifiers) })
        }
      />
    );
  };
  // A key from the composer goes at once with the chips held, then they let go.
  const press = (key: string) => {
    const keys = shortcutText(platform, modifiers, key);
    setHeld([]);
    run({ label: keys, keys, action: keyAction(key, modifiers) });
  };
  const keyTile = (key: string, compact: boolean) => {
    const keys = shortcutText(platform, modifiers, key);
    return (
      <KeyTile
        key={key}
        Icon={compact ? undefined : KEY_ICONS[key]}
        glyph={compact ? key.toUpperCase() : undefined}
        label={compact ? undefined : keyWord(platform, key)}
        name={`Press ${keys}`}
        shortcut={keys}
        flip={key === "delete"}
        disabled={disabled}
        onClick={() => press(key)}
      />
    );
  };

  return (
    <section className="key-section screen-keys" aria-labelledby={`${id}-keys`}>
      <TileHead
        id={`${id}-keys`}
        title="Keys"
        open={more}
        controls={`${id}-more`}
        onToggle={() => setMore((value) => !value)}
      />
      <div className="key-tiles">{everyday.map(action)}</div>
      {more && (
        <div id={`${id}-more`} className="key-more-body">
          <div className="key-tiles">{rest.map(action)}</div>
          {composer && (
            <div className="key-composer" role="group" aria-labelledby={`${id}-any`}>
              <div className="key-head">
                <h4 id={`${id}-any`}>Any key</h4>
                <span className="key-preview" aria-live="polite">
                  {preview}
                </span>
              </div>
              <div className="key-chips" role="group" aria-label="Hold with the next key">
                {chips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    className="key-chip"
                    aria-label={chip.name}
                    aria-pressed={held.includes(chip.id)}
                    title={chip.name}
                    disabled={disabled}
                    onClick={() =>
                      setHeld((current) =>
                        current.includes(chip.id)
                          ? current.filter((m) => m !== chip.id)
                          : [...current, chip.id],
                      )
                    }
                  >
                    <span className="key-chip-symbol" aria-hidden="true">
                      {chip.symbol}
                    </span>
                    {/* A Mac's symbols get their names where there's room. */}
                    {platform === "darwin" && (
                      <span className="key-chip-name" aria-hidden="true">
                        {chip.name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="key-tiles">{NAMED_KEYS.map((key) => keyTile(key, false))}</div>
              <button
                type="button"
                className="key-expand"
                aria-expanded={pad}
                aria-controls={pad ? `${id}-pad` : undefined}
                onClick={() => setPad((value) => !value)}
              >
                F1–F12, A–Z, 0–9
                <ChevronDown aria-hidden="true" />
              </button>
              {pad && (
                <div id={`${id}-pad`} className="key-tiles key-pad">
                  {[...FUNCTION_KEYS, ...CHARACTER_KEYS].map((key) => keyTile(key, true))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
