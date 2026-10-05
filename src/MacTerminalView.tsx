import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CornerDownLeft } from "lucide-react";
import { Peer, post, request } from "./api";
import type { MacTerminal } from "./DesktopTerminals";
import "./key-row.css";
import {
  disposeLater,
  plainKeyboard,
  terminalOptions,
} from "./terminal-options";

// A tab already open in Terminal on the Mac, shown full page. Its text comes
// as soon as the tab prints (the Mac answers a waiting request then), or about
// once a second from a Mac that can't wait. Typing appears in place and Enter sends the
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
      soon: ReturnType<typeof setTimeout> | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      // The text version this view shows; the Mac answers when it differs.
      version = 0;
    const waits = new Set<AbortController>();
    const term = new XTerm(terminalOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount.current);
    plainKeyboard(term);
    terminal.current = term;
    const show = (text: string) => {
      // Drop the empty rows below the prompt so typing lands after it.
      const next = String(text).replace(/(\r?\n[ \t]*)+$/, "");
      if (next !== snapshot.current) {
        snapshot.current = next;
        draw();
      }
    };
    const failed = (e: unknown) => {
      if (stopped) return;
      if ((e as { status?: number }).status === 404) gone.current();
      else setError((e as Error).message);
    };
    // A Mac that can't wait for output: ask about once a second.
    const read = async () => {
      if (stopped || reading || document.hidden) return;
      reading = true;
      try {
        const { text } = await request<{ text: string }>(
          peer,
          `/api/terminals/desktop/${tab.id}`,
        );
        if (stopped) return;
        show(text);
        setError("");
      } catch (e) {
        failed(e);
      } finally {
        reading = false;
      }
    };
    const visible = () =>
      new Promise<void>((resolve) => {
        if (!document.hidden) return resolve();
        const shown = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", shown);
          resolve();
        };
        document.addEventListener("visibilitychange", shown);
      });
    // Ask for the next text; the Mac answers when the tab prints, or after
    // ~20 s with nothing new.
    const follow = async () => {
      while (!stopped) {
        await visible();
        if (stopped) return;
        const wait = new AbortController();
        waits.add(wait);
        const limit = setTimeout(() => wait.abort(), 30000);
        try {
          const r = await request<{
            text?: string;
            version?: number;
            unchanged?: boolean;
          }>(peer, `/api/terminals/desktop/${tab.id}?after=${version}`, {
            signal: wait.signal,
          });
          if (stopped) return;
          if (typeof r.version !== "number") {
            if (typeof r.text === "string") show(r.text);
            timer = setInterval(() => void read(), 1000);
            return;
          }
          // An answer with nothing new must not turn into a tight loop.
          const same = r.version === version;
          version = r.version;
          if (!r.unchanged && typeof r.text === "string") show(r.text);
          setError("");
          if (same && !r.unchanged)
            await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          if (stopped) return;
          // A wait cut short (a stalled network): just ask again.
          if ((e as Error).name === "AbortError") continue;
          failed(e);
          if ((e as { status?: number }).status === 404) return;
          await new Promise((r) => setTimeout(r, 1000));
        } finally {
          clearTimeout(limit);
          waits.delete(wait);
        }
      }
    };
    const refreshSoon = () => {
      clearTimeout(soon);
      soon = setTimeout(() => void read(), 350);
    };
    submit.current = async () => {
      // Nothing typed: Return on its own, as on the Mac (to accept a
      // prompt or answer with the default).
      const text = pending.current.trim() ? pending.current : "";
      try {
        await post(peer, `/api/terminals/desktop/${tab.id}/send`, { text });
        pending.current = "";
        draw();
        if (timer) refreshSoon();
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
    void follow();
    return () => {
      stopped = true;
      for (const wait of waits) wait.abort();
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
      <div className="key-row terminal-key-row mac-line" role="toolbar" aria-label="Terminal keys">
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
