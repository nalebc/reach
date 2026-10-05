import { useState } from "react";
import { Search } from "lucide-react";
import type { ContextAction, HostApp } from "./app-context";
import "./app-commands.css";

type Run = (action: ContextAction) => void;

// "For <app>" section of the Shortcuts panel: a few picks, every menu command on request.
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
  const [open, setOpen] = useState(false);
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
      {all.length > 0 && !open && (
        <button
          className="button ghost small screen-more-toggle"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          All {app.name} commands
        </button>
      )}
      {all.length > 0 && open && (
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
