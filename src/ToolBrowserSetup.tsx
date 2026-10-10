import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Wrench } from "lucide-react";
import { request, type Peer } from "./api";
import ScreenPopup from "./ScreenPopup";
import "./tool-setup.css";

// Agents' saved tools (Gmail, Walmart…) run on the Mac, in your own Chrome
// or Safari, with no round trips: macOS has to let Reach control that
// browser, and the browser has to allow JavaScript from Apple Events. One
// row once an agent's tool needed a browser that isn't set up, nothing
// otherwise. Allow flips the browser's switch for you and asks macOS; its
// prompt comes to Needs you, where you answer it.
type Automation = "allowed" | "ask" | "off" | "closed" | "asking" | "unknown";
type Browser = {
  id: string;
  automation: Automation;
  javascript: "on" | "off" | "unknown";
  ready: boolean;
  // An agent's tool asked for this browser lately.
  needed: boolean;
  where: string;
};
type Setup = { available: boolean; browsers: Browser[]; problem?: string };
const AUTOMATION: Record<Automation, string> = {
  allowed: "On",
  ask: "Not asked yet",
  closed: "Not asked yet",
  asking: "Answer the prompt on the Mac",
  off: "Off in System Settings",
  unknown: "Couldn't check",
};
const POLL_MS = 3000;

export default function ToolBrowserSetup({
  peer,
  toast,
}: {
  peer: Peer;
  toast?: (message: string) => void;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // macOS was just asked: its prompt is on the Mac, and in Needs you here.
  const [asking, setAsking] = useState("");
  const wasNeeded = useRef(false);
  const load = useCallback(async () => {
    try {
      const next = await request<Setup>(peer, "/api/agents/tool-setup");
      setSetup(next);
      setError("");
      const needed = next.available && next.browsers.some((browser) => browser.needed && !browser.ready);
      if (wasNeeded.current && !needed) {
        setOpen(false);
        toast?.("Browser tools are ready.");
      }
      wasNeeded.current = needed;
    } catch (e) {
      setSetup(null);
      setError((e as Error).message);
    }
  }, [peer, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  // While the sheet is open, the Mac is looked at again every few seconds:
  // a switch turned on there shows here without a tap.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);
  const act = async (browser: string, action: "enable" | "settings") => {
    setBusy(browser);
    try {
      const result = await request<{ automation: Automation }>(peer, "/api/agents/tool-setup", {
        method: "POST",
        body: JSON.stringify({ browser, action }),
      });
      setAsking(result.automation === "asking" ? browser : "");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const browsers = setup?.available ? setup.browsers : [];
  const needed = browsers.filter((browser) => browser.needed && !browser.ready);
  if (!needed.length) return null;
  const summary = `An agent's tool needs ${needed.map((browser) => browser.id).join(" and ")}`;
  return (
    <>
      <button
        type="button"
        className="ag-agent-head ts-row"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="ts-icon" aria-hidden="true">
          <Wrench size={20} />
        </span>
        <span className="ag-agent-title">
          <strong>Browser tools</strong>
          <small>{summary}</small>
        </span>
        <span className="ts-cta">
          Set up <ChevronRight size={16} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <ScreenPopup title="Browser tools" onClose={() => setOpen(false)}>
          <p className="ag-quiet">
            Agents' ready-made tasks run in your own browser on the Mac. Allow
            flips the browser's switch for you; macOS then asks you once.
          </p>
          {(error || setup?.problem) && (
            <p role="alert" className="error">
              {error || setup?.problem}
            </p>
          )}
          {browsers.map((browser) => (
            <section key={browser.id} className="ts-browser" aria-label={browser.id}>
              <h4>
                {browser.id}
                {browser.ready ? (
                  <span className="ts-ready">Ready</span>
                ) : (
                  <button
                    type="button"
                    className="ag-primary ag-small ts-allow"
                    disabled={!!busy}
                    onClick={() => void act(browser.id, "enable")}
                  >
                    {busy === browser.id ? "Allowing…" : "Allow"}
                  </button>
                )}
              </h4>
              {asking === browser.id && browser.automation !== "allowed" && (
                <p className="ts-asking" role="status">
                  macOS is asking on your Mac. Answer it there, or in Needs you here.
                </p>
              )}
              <div className="ts-step">
                <span className={`ts-mark${browser.automation === "allowed" ? " is-on" : ""}`} aria-hidden="true">
                  {browser.automation === "allowed" ? <Check size={14} /> : "1"}
                </span>
                <span className="ts-words">
                  <strong>macOS lets Reach control {browser.id}</strong>
                  <small>{AUTOMATION[browser.automation]}</small>
                </span>
                {browser.automation === "off" && (
                  <button
                    type="button"
                    className="ag-secondary ag-small"
                    disabled={!!busy}
                    onClick={() => void act(browser.id, "settings")}
                  >
                    Open settings on the Mac
                  </button>
                )}
              </div>
              <div className="ts-step">
                <span className={`ts-mark${browser.javascript === "on" ? " is-on" : ""}`} aria-hidden="true">
                  {browser.javascript === "on" ? <Check size={14} /> : "2"}
                </span>
                <span className="ts-words">
                  <strong>Allow JavaScript from Apple Events</strong>
                  <small>{browser.javascript === "on" ? "On" : browser.where}</small>
                </span>
                {browser.javascript !== "on" && (
                  <button
                    type="button"
                    className="ag-secondary ag-small"
                    disabled={!!busy}
                    onClick={() => void load()}
                  >
                    Check
                  </button>
                )}
              </div>
            </section>
          ))}
          <p className="ag-quiet">
            Once on, any app macOS lets control a browser can run scripts in
            its tabs, signed-in ones included.
          </p>
        </ScreenPopup>
      )}
    </>
  );
}
