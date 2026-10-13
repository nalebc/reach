import { useId, useState } from "react";
import { Search } from "lucide-react";
import type { ContextAction, HostApp } from "./app-context";
import { commandIcon } from "./command-icons";
import { KeyTile, TileHead } from "./KeyTiles";
import "./app-commands.css";

type Run = (action: ContextAction) => void;

// "For <app>" in the screen's menu: a few picks as tiles, like Keys below
// it; every menu command one tap away, searched in place.
export function AppCommandList({
  app,
  picks,
  all,
  disabled,
  run,
}: {
  app: HostApp;
  picks: ContextAction[];
  all: ContextAction[];
  disabled: boolean;
  run: Run;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? all.filter((a) => `${a.group} ${a.label}`.toLowerCase().includes(needle))
    : all;
  return (
    <section className="key-section app-commands" aria-labelledby={`${id}-app`}>
      <TileHead
        id={`${id}-app`}
        title={`For ${app.name}`}
        open={open}
        controls={`${id}-all`}
        onToggle={all.length ? () => setOpen((value) => !value) : undefined}
      />
      {picks.length > 0 && (
        <div className="key-tiles">
          {picks.map((action) => (
            <KeyTile
              key={action.id}
              Icon={commandIcon(action.label)}
              label={action.label}
              name={action.keys ? `${action.label}, ${action.keys}` : action.label}
              shortcut={action.keys}
              disabled={disabled}
              onClick={() => run(action)}
            />
          ))}
        </div>
      )}
      {all.length > 0 && open && (
        <div id={`${id}-all`}>
          <label className="search app-commands-search">
            <Search size={16} />
            <input
              placeholder={`Search ${app.name} commands`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <ul className="app-commands-list">
            {matches.slice(0, 80).map((action) => (
              <li key={action.id}>
                <button disabled={disabled} onClick={() => run(action)}>
                  <span>
                    <small>{action.group}</small>
                    {action.label}
                  </span>
                  {action.keys && <kbd>{action.keys}</kbd>}
                </button>
              </li>
            ))}
            {!matches.length && <li className="muted">No matching commands.</li>}
          </ul>
        </div>
      )}
    </section>
  );
}
