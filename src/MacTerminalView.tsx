import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CornerDownLeft } from "lucide-react";
import { Peer, post, request } from "./api";
import type { MacTerminal } from "./DesktopTerminals";
import {
  disposeLater,
  plainKeyboard,
  terminalOptions,
} from "./terminal-options";

// A tab already open in Terminal on the Mac, shown full page. Its text
// refreshes about once a second. Typing appears in place and Enter sends the
// line to the tab, which keeps working while the Mac is locked and never
// brings the tab to the front.
export default function MacTerminalView({
  peer,
  tab,
  onGone,
}: {
  peer: Peer;
  tab: MacTerminal;
  onGone: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null),
    terminal = useRef<XTerm | null>(null),
    snapshot = useRef(""),
    pending = useRef(""),
    gone = useRef(onGone);
  gone.current = onGone;
  const [error, setError] = useState(""),
    [hint, setHint] = useState("");
  const draw = () => {
    const term = terminal.current;
    if (!term) return;
    term.reset();
    term.write(snapshot.current.replace(/\r?\n/g, "\r\n") + pending.current);
  };
  const submit = useRef(async () => {});
  useEffect(() => {
    if (!mount.current) return;
    let stopped = false,
      reading = false,
      soon: ReturnType<typeof setTimeout> | undefined;
    const term = new XTerm(terminalOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount.current);
    plainKeyboard(term);
    terminal.current = term;
    const read = async () => {
      if (stopped || reading || document.hidden) return;
      reading = true;
      try {
        const { text } = await request<{ text: string }>(
          peer,
          `/api/terminals/desktop/${tab.id}`,
        );
        if (stopped) return;
        // Drop the empty rows below the prompt so typing lands after it.
        const next = String(text).replace(/(\r?\n[ \t]*)+$/, "");
        if (next !== snapshot.current) {
          snapshot.current = next;
          draw();
        }
        setError("");
      } catch (e) {
        if (stopped) return;
        if ((e as { status?: number }).status === 404) gone.current();
        else setError((e as Error).message);
      } finally {
        reading = false;
      }
    };
    const refreshSoon = () => {
      clearTimeout(soon);
      soon = setTimeout(() => void read(), 350);
    };
    submit.current = async () => {
      const text = pending.current;
      if (!text.trim()) return;
      try {
        await post(peer, `/api/terminals/desktop/${tab.id}/send`, { text });
        pending.current = "";
        draw();
        refreshSoon();
      } catch (e) {
        setError((e as Error).message);
      }
    };
    const input = term.onData((data) => {
      if (data === "\r") void submit.current();
      else if (data === "\x7f") {
        pending.current = Array.from(pending.current).slice(0, -1).join("");
        draw();
      } else if (/^[\x00-\x1f\x7f]/.test(data)) {
        setHint("Esc, ctrl and arrows aren't available in Mac tabs yet.");
      } else {
        // Typed or pasted text, without control characters.
        pending.current += data.replace(/[\x00-\x1f\x7f]/g, "");
        draw();
      }
    });
    const resize = () => {
      try {
        fit.fit();
      } catch {}
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount.current);
    resize();
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(soon);
      ro.disconnect();
      input.dispose();
      disposeLater(term);
      terminal.current = null;
    };
  }, [peer.url, peer.token, tab.id]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(""), 3500);
    return () => clearTimeout(timer);
  }, [hint]);
  return (
    <>
      {error && <div className="terminal-error">{error}</div>}
      <div
        className="terminal-screen"
        ref={mount}
        onClick={() => terminal.current?.focus()}
      />
      <div className="terminal-key-row mac-line" role="toolbar" aria-label="Terminal keys">
        <span className="terminal-line-hint">
          {hint || "Type, then Enter sends the line to this Mac tab."}
        </span>
        <button
          aria-label="Enter"
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void submit.current()}
        >
          <CornerDownLeft size={16} />
        </button>
      </div>
    </>
  );
}
