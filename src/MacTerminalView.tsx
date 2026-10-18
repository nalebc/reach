import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardPaste, CornerDownLeft } from "lucide-react";
import { Peer, post, request } from "./api";
import type { MacTerminal } from "./DesktopTerminals";
import { computerWord } from "./pause";
import "./key-row.css";
import { pastable, pasteQuestion } from "./terminal-keys";
import { usePhonePaste } from "./TerminalPaste";
import { useTerminalHistory } from "./useTerminalHistory";
import {
  altArrowWords,
  disposeLater,
  plainKeyboard,
  terminalOptions,
  terminalTouch,
  writeSnapshot,
} from "./terminal-options";

// What one of the computer's own terminals is called: a Mac tab, a Windows
// Terminal tab, a console window.
export function desktopTabWord(provider: string, platform?: string) {
  if (provider === "windows-terminal") return "Windows Terminal tab";
  if (provider === "console") return "console window";
  return `${computerWord(platform)} tab`;
}

// A tab already open in Terminal on the Mac (or Windows Terminal or a console
// window on a Windows PC), shown full page. Its text comes as soon as the tab
// prints (the computer answers a waiting request then), or about once a
// second from one that can't wait. Typing appears in place and Enter sends
// the line to the tab, which keeps working while the computer is locked and
// never brings the tab to the front.
export default function MacTerminalView({
  peer,
  tab,
  onGone,
}: {
  peer: Peer;
  tab: MacTerminal;
  onGone: () => void;
}) {
  const history = useTerminalHistory();
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
    writeSnapshot(term, snapshot.current.replace(/\r?\n/g, "\r\n") + pending.current);
  };
  const submit = useRef(async () => {});
  const pasteText = useRef((_text: string) => {});
  useEffect(() => {
    if (!mount.current) return;
    let stopped = false,
      reading = false,
      soon: ReturnType<typeof setTimeout> | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      // The text version this view shows; the Mac answers when it differs.
      version = 0;
    const waits = new Map<AbortController, ReturnType<typeof setTimeout>>();
    let resume: (() => void) | undefined;
    const term = new XTerm(terminalOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount.current);
    plainKeyboard(term);
    altArrowWords(term);
    const removeTouch = terminalTouch(mount.current, term);
    terminal.current = term;
    const stopHistory = history.observe(term);
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
          if (document.hidden && !stopped) return;
          document.removeEventListener("visibilitychange", shown);
          resume = undefined;
          resolve();
        };
        resume = shown;
        document.addEventListener("visibilitychange", shown);
      });
    // Ask for the next text; the Mac answers when the tab prints, or after
    // ~20 s with nothing new.
    const follow = async () => {
      while (!stopped) {
        await visible();
        if (stopped) return;
        const wait = new AbortController();
        const limit = setTimeout(() => wait.abort(), 30000);
        waits.set(wait, limit);
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
    // One line on its way at a time: a second Enter before the Mac answers
    // would run the same command again.
    let sending = false;
    submit.current = async () => {
      if (sending || stopped) return;
      sending = true;
      // Nothing typed: Return on its own, as on the Mac (to accept a
      // prompt or answer with the default).
      const typed = pending.current;
      const text = typed.trim() ? typed : "";
      try {
        await post(peer, `/api/terminals/desktop/${tab.id}/send`, { text });
        if (stopped) return;
        // What was typed while it went stays for the next line.
        if (pending.current.startsWith(typed)) pending.current = pending.current.slice(typed.length);
        draw();
        if (timer) refreshSoon();
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        sending = false;
      }
    };
    // A paste with line breaks runs as separate lines, in order.
    let lines = Promise.resolve();
    const pasteLines = (parts: string[]) => {
      lines = lines.then(async () => {
        for (let i = 0; i < parts.length && !stopped; i++) {
          pending.current += parts[i].replace(/[\x00-\x1f\x7f]/g, "");
          if (i === parts.length - 1) break;
          while (sending && !stopped) await new Promise((r) => setTimeout(r, 30));
          if (stopped) return;
          await submit.current();
        }
        draw();
      });
    };
    pasteText.current = (text) => {
      if (/[\r\n]/.test(text)) pasteLines(text.split(/\r\n|\r|\n/));
      else {
        pending.current += text.replace(/[\x00-\x1f\x7f]/g, "");
        draw();
      }
    };
    const input = term.onData((data) => {
      if (data.length > 1 && /[\r\n]/.test(data) && !/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(data))
        pasteLines(data.split(/\r\n|\r|\n/));
      else if (data === "\r") void submit.current();
      else if (data === "\x7f") {
        pending.current = Array.from(pending.current).slice(0, -1).join("");
        draw();
      } else if (/^[\x00-\x1f\x7f]/.test(data)) {
        setHint(`Esc, ctrl and arrows aren't available in ${desktopTabWord(tab.provider, peer.platform)}s yet.`);
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
      resume?.();
      for (const [wait, limit] of waits) {
        clearTimeout(limit);
        wait.abort();
      }
      waits.clear();
      clearInterval(timer);
      clearTimeout(soon);
      ro.disconnect();
      input.dispose();
      stopHistory();
      removeTouch();
      disposeLater(term);
      terminal.current = null;
    };
  }, [peer.url, peer.token, tab.id]);
  // Each line of a paste runs as its own command here, so one with a line
  // break asks first.
  const phonePaste = usePhonePaste((text) => {
    const clean = pastable(text);
    const question = pasteQuestion(clean);
    if (question && !confirm(question)) return;
    pasteText.current(clean);
  }, setHint);
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
      {history.reading && <button className="terminal-latest" onClick={history.latest}>↓ Latest output</button>}
      {phonePaste.box}
      <div className="key-row terminal-key-row mac-line" role="toolbar" aria-label="Terminal keys">
        <span className="terminal-line-hint">
          {hint || `Type, then Enter sends the line to this ${desktopTabWord(tab.provider, peer.platform)}.`}
        </span>
        <button
          aria-label="Paste"
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={phonePaste.paste}
        >
          <ClipboardPaste size={16} />
        </button>
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
