import { useState } from "react";
import { Search } from "lucide-react";
import type { ContextAction, HostApp } from "./app-context";
import "./app-commands.css";

type Run = (action: ContextAction) => void;

// A slim row of commands for the app in front, shown above the dock.
export function ContextBar({
  app,
  picks,
  disabled,
  run,
  more,
}: {
  app: HostApp;
  picks: ContextAction[];
  disabled: boolean;
  run: Run;
  more: () => void;
}) {
  return (
    <div className="app-context-bar" role="toolbar" aria-label={`${app.name} commands`}>
      <span className="app-context-name">{app.name}</span>
      <div className="app-context-chips">
        {picks.map((action) => (
          <button
            key={action.id}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => run(action)}
          >
            {action.label}
          </button>
        ))}
        <button
          className="app-context-more"
          onPointerDown={(event) => event.preventDefault()}
          onClick={more}
        >
          More…
        </button>
      </div>
    </div>
  );
}

// "For <app>" section of the Actions panel: top picks plus every menu command.
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
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? all.filter((a) => `${a.group} ${a.label}`.toLowerCase().includes(needle))
    : all;
  return (
    <section className="app-commands">
      <h3>For {app.name}</h3>
      {picks.length > 0 && (
        <div className="screen-helper-grid">
          {picks.map((action) => (
            <button
              key={action.id}
              className="screen-helper-action"
              disabled={disabled}
              onClick={() => run(action)}
            >
              <span>
                {action.label}
                {action.keys && <small>{action.keys}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      {all.length > 0 && (
        <>
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
        </>
      )}
    </section>
  );
}
