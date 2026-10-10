import { useCallback, useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { request, type Peer } from "./api";

// Agents' saved tools run on the Mac, in your own Chrome or Safari, with no
// round trips: macOS has to let Reach control that browser, and the browser
// has to allow JavaScript from Apple Events. Reach shows where each stands,
// asks macOS for you, and opens the right settings; you click on the Mac.
type Automation = "allowed" | "ask" | "off" | "closed" | "asking" | "unknown";
type Setup = {
  available: boolean;
  browsers: { id: string; automation: Automation; javascript: string }[];
};
const WORDS: Record<Automation, string> = {
  allowed: "Reach may control it",
  ask: "Not asked yet",
  off: "Turned off for Reach",
  closed: "Open it on the Mac, then check",
  asking: "Answer on the Mac",
  unknown: "Couldn't check",
};

export default function ToolBrowserSetup({ peer }: { peer: Peer }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setSetup(await request<Setup>(peer, "/api/agents/tool-setup"));
      setError("");
    } catch (e) {
      setSetup(null);
      setError((e as Error).message);
    }
  }, [peer]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (browser: string, action: "ask" | "settings") => {
    setBusy(browser);
    try {
      await request(peer, "/api/agents/tool-setup", {
        method: "POST",
        body: JSON.stringify({ browser, action }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!setup?.available || !setup.browsers.length) return null;
  return (
    <section className="service-access" aria-label="Saved tools on this Mac">
      <h3>
        <Wrench size={17} /> Saved tools on this Mac
      </h3>
      <p>
        Agents' saved tools run right on the Mac, in your own browser. Each
        browser needs two switches, turned on once by you.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {setup.browsers.map((browser) => (
        <article key={browser.id} className="service-card">
          <strong>
            {browser.id} · {WORDS[browser.automation]}
          </strong>
          <p>{browser.javascript}</p>
          <div className="service-actions">
            {browser.automation === "ask" && (
              <button
                className="ag-secondary ag-small"
                disabled={!!busy}
                onClick={() => void act(browser.id, "ask")}
              >
                Ask on the Mac
              </button>
            )}
            {(browser.automation === "off" || browser.automation === "unknown") && (
              <button
                className="ag-secondary ag-small"
                disabled={!!busy}
                onClick={() => void act(browser.id, "settings")}
              >
                Open settings on the Mac
              </button>
            )}
            {browser.automation !== "allowed" && (
              <button
                className="ag-secondary ag-small"
                disabled={!!busy}
                onClick={() => void load()}
              >
                Check again
              </button>
            )}
          </div>
        </article>
      ))}
      <p className="service-muted">
        Allowing JavaScript from Apple Events lets any app you allow to control
        that browser run scripts in its tabs, including signed-in ones.
      </p>
    </section>
  );
}
