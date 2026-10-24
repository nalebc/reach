import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Square,
  ChevronDown,
  ChevronLeft,
  FolderOpen,
  Pointer,
} from "lucide-react";
import {
  arrowKey,
  controlKey,
  inputPieces,
  pastable,
  pasteQuestion,
} from "./terminal-keys";
import { usePhonePaste } from "./TerminalPaste";
import { useViewportBox } from "./useViewportBox";
import { useTerminalHistory } from "./useTerminalHistory";
import {
  altArrowWords,
  disposeLater,
  fitKeepingLatest,
  plainKeyboard,
  terminalOptions,
  terminalTouch,
} from "./terminal-options";
import MacTerminalView from "./MacTerminalView";
import TerminalList from "./TerminalList";
import KeyRow from "./KeyRow";
import { describeMacTerminal } from "./terminal-titles";
import { computerWord } from "./pause";
import { macTerminalsFingerprint } from "./mac-terminal-live";
import { useFirstTime } from "./first-time";
import { AgentLogo, useAgentLogos } from "./agent-logos";
import { Peer, Session, request, post } from "./api";
import type { MacTerminal } from "./DesktopTerminals";
import "./terminals.css";
import { ReconnectTimer } from "./reconnect";
import {
  Terminal,
  Plus,
} from "./ui";
// The Mac's open terminal windows as last seen, per computer: the list shows
// them at once when the page opens, while a fresh look runs.
const knownMacTabs = new Map<string, MacTerminal[]>();
export function TerminalView({
  desktopTerminals,
  peer,
  sessions,
  selected,
  onSelect,
  onNew,
  onRefresh,
  toast,
  source,
  setSource,
  onExit,
  onOpenScreen,
  changes,
  owner = false,
}: {
  desktopTerminals: boolean;
  peer: Peer;
  sessions: Session[];
  selected: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  toast: (s: string) => void;
  source: string;
  setSource: (source: string) => void;
  onExit: () => void;
  onOpenScreen?: () => void;
  // The computer's live change fingerprints (App's presence connection).
  changes?: string;
  // The Mac's owner, on their own device: the AI apps' logos come from the
  // owner-only sessions routes (others get the line icons).
  owner?: boolean;
}) {
  const page = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    terminal = useRef<XTerm | null>(null),
    socket = useRef<WebSocket | null>(null),
    ctrlArmed = useRef(false);
  const history = useTerminalHistory();
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [menu, setMenu] = useState<"switch" | "new" | null>(null),
    [ctrl, setCtrl] = useState(false),
    [agents, setAgents] = useState<string[] | null>(null),
    [macTabs, setMacTabs] = useState<MacTerminal[]>(
      () => knownMacTabs.get(peer.id) ?? [],
    ),
    [macError, setMacError] = useState(""),
    // Consoles running as administrator, which a Windows PC can't show.
    [macHidden, setMacHidden] = useState(0),
    // Home opens a Mac tab directly with source "mac:<id>".
    [macSelected, setMacSelected] = useState(() =>
      source.startsWith("mac:") ? source.slice(4) : "",
    ),
    [macLoaded, setMacLoaded] = useState(() => knownMacTabs.has(peer.id)),
    // Looked at the Mac since this page opened (not just remembered).
    [macFresh, setMacFresh] = useState(false),
    [slide, setSlide] = useState<"next" | "previous" | "">(""),
    [starting, setStarting] = useState(false);
  // The computer's own terminal windows: a Mac's, or a Windows PC's.
  const showMacTabs =
    desktopTerminals && ["darwin", "win32"].includes(peer.platform);
  const word = computerWord(peer.platform);
  const macTab = macTabs.find((t) => t.id === macSelected);
  const current = macTab
    ? undefined
    : sessions.find((s) => s.id === selected);
  // Every terminal in swipe order: shells started here, then Mac tabs.
  const items = [
    ...sessions
      .filter((s) => s.status === "running" || s.id === selected)
      .map((s) => ({ key: `reach:${s.id}`, reach: s, mac: undefined })),
    ...macTabs.map((t) => ({ key: `mac:${t.id}`, reach: undefined, mac: t })),
  ];
  const currentKey = macTab
    ? `mac:${macTab.id}`
    : current
      ? `reach:${current.id}`
      : "";
  const position = items.findIndex((item) => item.key === currentKey);
  const choose = (item: (typeof items)[number], direction?: "next" | "previous") => {
    setSlide(direction ?? "");
    if (item.mac) setMacSelected(item.mac.id);
    else if (item.reach) {
      setMacSelected("");
      setSource("reach");
      onSelect(item.reach.id);
    }
  };
  // Tabs already open in Terminal on the Mac: fetched when the Mac says they
  // changed, or every few seconds from a Mac that can't say.
  const pushed = macTerminalsFingerprint(changes);
  const told = pushed !== undefined;
  useEffect(() => {
    if (!showMacTabs) return;
    let stopped = false;
    const list = async () => {
      if (document.hidden) return;
      try {
        const r = await request<{
          sessions: MacTerminal[];
          providers?: { administrator?: number }[];
        }>(peer, "/api/terminals/desktop");
        if (stopped) return;
        knownMacTabs.set(peer.id, r.sessions);
        setMacTabs(r.sessions);
        setMacHidden(
          (r.providers || []).reduce((n, p) => n + (p.administrator || 0), 0),
        );
        setMacLoaded(true);
        setMacFresh(true);
        setMacError("");
      } catch (e) {
        if (!stopped) setMacError((e as Error).message);
      }
    };
    void list();
    const timer = told ? undefined : setInterval(() => void list(), 5000);
    const shown = () => void list();
    document.addEventListener("visibilitychange", shown);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [showMacTabs, peer.url, peer.token, told, pushed]);
  // A shell chosen or started elsewhere (e.g. "In another folder…") comes to
  // the front. Only a real change counts: opening a Mac tab from Home, or the
  // newest shell being picked automatically, keeps the Mac tab.
  const lastSelected = useRef(selected);
  useEffect(() => {
    if (lastSelected.current === selected) return;
    lastSelected.current = selected;
    if (autoSelected.current) autoSelected.current = false;
    else setMacSelected("");
  }, [selected]);
  // A closed Mac tab drops back to the shells (once the Mac has been asked).
  useEffect(() => {
    if (macFresh && macSelected && !macTabs.some((t) => t.id === macSelected))
      setMacSelected("");
  }, [macTabs, macFresh]);
  // Swipe the header to move between terminals, leaving output scrollable. The first
  // time there's another terminal to go to, a hand shows how.
  const [swipeHint, swipeSeen] = useFirstTime("terminal-swipe");
  const swipeHintShown = useRef(false);
  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  const swipeHandlers = {
    onTouchStart: (event: React.TouchEvent) => {
      // Touching the header while the hand shows: understood.
      if (swipeHintShown.current) swipeSeen();
      const touch = event.touches[0];
      // Leave the screen edges to the browser's own back gesture.
      swipe.current =
        event.touches.length === 1 &&
        touch.clientX > 24 &&
        touch.clientX < window.innerWidth - 24
          ? { x: touch.clientX, y: touch.clientY, at: Date.now() }
          : null;
    },
    onTouchEnd: (event: React.TouchEvent) => {
      const start = swipe.current;
      swipe.current = null;
      const touch = event.changedTouches[0];
      if (!start || !touch || position < 0) return;
      const dx = touch.clientX - start.x,
        dy = touch.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (Date.now() - start.at > 700) return;
      const next = items[position + (dx < 0 ? 1 : -1)];
      if (next) choose(next, dx < 0 ? "next" : "previous");
    },
  };
  // Same breakpoint as the app's bottom navigation.
  const query = "(max-width: 1024px), (pointer: coarse)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  // On a phone the terminal takes the whole screen above the keyboard.
  useViewportBox(page, narrow);
  // With the keyboard closed, the key row stays clear of the iPhone's home
  // indicator, where Safari takes taps for its own toolbar; with it open,
  // the row sits right on the keyboard.
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () =>
      page.current?.classList.toggle(
        "kb-open",
        window.innerHeight - (viewport?.height || window.innerHeight) > 120,
      );
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  // Open the newest terminal when none is chosen. A just-started terminal
  // stays selected while the list catches up.
  const autoSelected = useRef(false);
  useEffect(() => {
    if (selected || !sessions.length) return;
    autoSelected.current = true;
    onSelect(sessions[0].id);
  }, [selected, sessions.length]);
  const armCtrl = (value: boolean) => {
    ctrlArmed.current = value;
    setCtrl(value);
  };
  const mounted = !!current;
  // No terminal open: the page is the list of every terminal.
  const listing = !current && !macTab;
  const showSwipeHint =
    swipeHint && !listing && !menu && items.length > 1 && position >= 0;
  swipeHintShown.current = showSwipeHint;
  // Seen once it has played a few times.
  useEffect(() => {
    if (!showSwipeHint) return;
    const timer = setTimeout(swipeSeen, 5200);
    return () => clearTimeout(timer);
  }, [showSwipeHint, swipeSeen]);
  const logos = useAgentLogos(owner ? peer : null);
  useEffect(() => {
    if ((menu === "new" || listing) && !agents)
      void request<{ agents: string[] }>(peer, "/api/terminals/agents")
        .then((r) => setAgents(r.agents))
        .catch(() => setAgents([]));
  }, [menu, listing]);
  useEffect(() => {
    if (!selected || !mounted || !mount.current) return;
    let stopped = false,
      ws: WebSocket;
    const retry = new ReconnectTimer();
    let lastSeen = Date.now(),
      retryable = true,
      heartbeatSupported = false;
    const term = new XTerm(terminalOptions());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount.current);
    plainKeyboard(term);
    altArrowWords(term);
    const removeTouch = terminalTouch(mount.current, term);
    terminal.current = term;
    const stopHistory = history.observe(term);
    const resize = () => {
      try {
        fitKeepingLatest(fit, term);
        if (ws?.readyState === WebSocket.OPEN && connectedRef)
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
      } catch {}
    };
    let connectedRef = false;
    const connect = () => {
      if (stopped) return;
      setError("");
      lastSeen = Date.now();
      heartbeatSupported = false;
      const url = new URL("/ws/terminal", peer.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
      socket.current = ws;
      const current = ws;
      ws.onopen = () => {
        if (stopped || ws !== current) {
          current.close();
          return;
        }
        current.send(
          JSON.stringify({
            type: "auth",
            token: peer.token,
            sessionId: selected,
          }),
        );
      };
      ws.onmessage = (e) => {
        if (stopped || ws !== current) return;
        lastSeen = Date.now();
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          current.close();
          return;
        }
        if (m.type === "snapshot") {
          heartbeatSupported = m.heartbeat === true;
          connectedRef = false;
          setConnected(false);
          term.reset();
          // History can contain terminal queries. xterm parses asynchronously:
          // their replies must not become fresh input in the current shell.
          // Live writes queued after this one still answer normally.
          term.write(m.data, () => {
            if (stopped || ws !== current || current.readyState !== WebSocket.OPEN) return;
            connectedRef = true;
            retry.reset();
            setConnected(true);
            resize();
          });
        }
        if (m.type === "data") term.write(m.data);
        if (m.type === "exit") {
          term.write(
            `\r\n\x1b[90mSession ended (exit ${m.exitCode}).\x1b[0m\r\n`,
          );
          onRefresh();
        }
        if (m.type === "error") setError(m.error);
      };
      ws.onclose = (e) => {
        if (stopped || ws !== current) return;
        connectedRef = false;
        setConnected(false);
        retryable = e.code !== 4001;
        if (retryable) retry.schedule(connect);
      };
      ws.onerror = () => {
        if (!stopped && ws === current)
          setError("Connection interrupted. Reconnecting…");
      };
    };
    connect();
    const wake = () => {
      if (stopped || document.hidden || !retryable) return;
      if (connectedRef && !heartbeatSupported) return;
      if (Date.now() - lastSeen > 12000 && ws.readyState < WebSocket.CLOSING) {
        connectedRef = false;
        setConnected(false);
        ws.close();
        retry.schedule(connect);
      } else retry.wake();
    };
    const heartbeat = setInterval(() => {
      if (stopped || !retryable) return;
      if (Date.now() - lastSeen > 12000) {
        wake();
        return;
      }
      if (
        connectedRef &&
        heartbeatSupported &&
        ws?.readyState === WebSocket.OPEN
      )
        ws.send(JSON.stringify({ type: "ping" }));
    }, 4000);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    const input = term.onData((typed) => {
      if (stopped || !connectedRef || ws?.readyState !== WebSocket.OPEN) return;
      let data = typed;
      // Sticky Ctrl from the key row applies to the next typed character.
      if (ctrlArmed.current && typed.length === 1) {
        data = controlKey(typed) ?? typed;
        ctrlArmed.current = false;
        setCtrl(false);
      }
      for (const piece of inputPieces(data))
        ws.send(JSON.stringify({ type: "input", data: piece }));
    });
    const ro = new ResizeObserver(resize);
    ro.observe(mount.current);
    setTimeout(resize, 100);
    return () => {
      stopped = true;
      retry.cancel();
      clearInterval(heartbeat);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      ro.disconnect();
      input.dispose();
      stopHistory();
      removeTouch();
      ws?.close();
      disposeLater(term);
      terminal.current = null;
      setConnected(false);
    };
  }, [selected, peer.id, peer.url, peer.token, mounted]);
  const send = (data: string) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ type: "input", data }));
  };
  // The phone's clipboard, pasted as the terminal pastes (bracketed when the
  // program asks for it), so it arrives as typing would. Sent once, now:
  // never held for a later connection.
  const phonePaste = usePhonePaste([
    peer.id, peer.computerId, peer.url, peer.token, peer.transport, peer.sessionId, currentKey,
  ], [
    peer.workspaceKey || JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId]),
    peer.id, currentKey,
  ], (text) => {
    const term = terminal.current;
    if (!term || !connected || socket.current?.readyState !== WebSocket.OPEN) {
      toast("This terminal isn't connected. Paste again once it is.");
      return false;
    }
    const clean = pastable(text);
    // A program that takes pastes whole (bracketed paste: shells, Codex,
    // Claude Code) runs nothing as it arrives.
    const question = term.modes.bracketedPasteMode ? null : pasteQuestion(clean);
    if (question && !confirm(question)) return false;
    // Sticky ctrl is for the next key typed, never a pasted letter (ctrl-D).
    ctrlArmed.current = false;
    setCtrl(false);
    term.paste(clean);
  }, toast);
  const arrow = (direction: "up" | "down" | "left" | "right") =>
    send(
      arrowKey(
        direction,
        !!terminal.current?.modes.applicationCursorKeysMode,
      ),
    );
  const start = async (run?: string) => {
    setMenu(null);
    setStarting(true);
    try {
      const created = await post<Session>(peer, "/api/terminals", {
        root: 0,
        ...(run ? { run } : {}),
      });
      setSource("reach");
      setMacSelected("");
      onSelect(created.id);
      onRefresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const openMacTab = async (tab: MacTerminal) => {
    setMenu(null);
    try {
      const shown = await post<{ front?: boolean }>(
        peer,
        `/api/terminals/desktop/${tab.id}/focus`,
      );
      // Windows often keeps a program in the background from coming forward.
      if (shown?.front === false)
        toast("Windows didn't bring it to the front: it's waiting on the taskbar.");
      if (onOpenScreen) onOpenScreen();
      else if (shown?.front !== false)
        toast(`Brought to the front on your ${word}. Turn on Screen to see it.`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const end = async (id: string) => {
    if (!confirm("End this terminal? Anything running in it will stop."))
      return;
    try {
      await request(peer, `/api/terminals/${id}`, { method: "DELETE" });
      onRefresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  // Close a tab already open on the Mac, as if closed there.
  const closeMacTab = async (tab: MacTerminal) => {
    const name = describeMacTerminal(tab.name, tab.provider).title;
    if (
      !confirm(
        `Close “${name}” on your ${word}? Anything running in it will stop. If this terminal runs Reach, you will disconnect.`,
      )
    )
      return;
    try {
      await post(peer, `/api/terminals/desktop/${tab.id}/close`, {
        confirm: true,
      });
      setMacTabs((tabs) => {
        const left = tabs.filter((t) => t.id !== tab.id);
        knownMacTabs.set(peer.id, left);
        return left;
      });
      if (macSelected === tab.id) setMacSelected("");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const folder = (cwd: string) =>
    cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  const openReach = (id: string) => {
    setMenu(null);
    setMacSelected("");
    setSource("reach");
    onSelect(id);
  };
  const openMac = (tab: MacTerminal) => {
    setMenu(null);
    setMacSelected(tab.id);
  };
  const heading = macTab
    ? describeMacTerminal(macTab.name, macTab.provider)
    : current
      ? { title: current.name, detail: folder(current.cwd) }
      : { title: "Terminals", detail: "" };
  const agentName: Record<string, string> = {
    codex: "Codex",
    claude: "Claude Code",
  };
  return (
    <div className="terminal-page" ref={page}>
      <header className="terminal-bar" {...swipeHandlers}>
        <button className="terminal-bar-icon" aria-label="Leave terminal" onClick={onExit}>
          <ChevronLeft size={20} />
        </button>
        {listing ? (
          <h1 className="terminal-switch">Terminals</h1>
        ) : (
          <button
            className="terminal-switch"
            aria-haspopup="true"
            aria-expanded={menu === "switch"}
            onClick={() => setMenu(menu === "switch" ? null : "switch")}
          >
            <i className={`status-dot ${macTab || (current && connected) ? "" : "off"}`} />
            <span>{heading.title}</span>
            <small>{heading.detail}</small>
            <ChevronDown size={16} />
          </button>
        )}
        {(macTab || current?.status === "running") && (
          <button
            className="terminal-bar-icon terminal-stop"
            aria-label={macTab ? `Close this tab on your ${word}` : "Stop this terminal"}
            title={macTab ? "Close tab" : "Stop terminal"}
            onClick={() =>
              macTab ? void closeMacTab(macTab) : current && void end(current.id)
            }
          >
            <Square size={15} />
          </button>
        )}
        <button
          className="terminal-bar-icon"
          aria-label="New terminal"
          aria-haspopup="menu"
          aria-expanded={menu === "new"}
          disabled={starting}
          onClick={() => setMenu(menu === "new" ? null : "new")}
        >
          <Plus size={20} />
        </button>
      </header>
      {items.length > 1 && position >= 0 && (
        <div className="terminal-segments" aria-hidden="true">
          {items.map((item, index) => (
            <span key={item.key} className={index === position ? "active" : ""} />
          ))}
        </div>
      )}
      {error && !macTab && <div className="terminal-error">{error}</div>}
      {menu === "switch" && (
        <div className="terminal-sheet">
          <TerminalList
            peer={peer}
            logos={logos}
            sessions={sessions}
            macTabs={macTabs}
            macLoaded={macLoaded}
            macError={macError}
            macHidden={macHidden}
            showMac={showMacTabs}
            currentKey={currentKey}
            onOpen={openReach}
            onOpenMac={openMac}
            onEnd={(id) => void end(id)}
            onShowOnScreen={onOpenScreen && ((tab) => void openMacTab(tab))}
            onCloseMac={(tab) => void closeMacTab(tab)}
          />
        </div>
      )}
      {menu === "new" && (
        <>
          <div className="terminal-menu-scrim" onClick={() => setMenu(null)} />
          <div className="terminal-menu" role="menu">
            {menu === "new" ? (
              <>
                <button role="menuitem" onClick={() => void start()}>
                  <Terminal size={17} /> New terminal
                </button>
                {(agents ?? []).map((agent) => (
                  <button key={agent} role="menuitem" onClick={() => void start(agent)}>
                    <AgentLogo agent={agent} logos={logos} size={22} />{" "}
                    {agentName[agent] ?? agent}
                  </button>
                ))}
                {!agents && <span className="terminal-menu-note">Looking for Codex and Claude Code…</span>}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    onNew();
                  }}
                >
                  <FolderOpen size={17} /> In another folder…
                </button>
              </>
            ) : null}
          </div>
        </>
      )}
      {showSwipeHint && (
        <div className="terminal-swipe-hint" role="note">
          <span className="terminal-swipe-track" aria-hidden="true">
            <span className="terminal-swipe-hand">
              <Pointer size={30} strokeWidth={1.8} />
            </span>
          </span>
          Swipe the header to switch terminals
        </div>
      )}
      <div
        key={currentKey}
        className={`terminal-stage ${slide ? `slide-${slide}` : ""}`}
      >
      {macTab ? (
        <MacTerminalView
          peer={peer}
          tab={macTab}
          onGone={() => setMacSelected("")}
        />
      ) : current ? (
        <>
          <div
            className="terminal-screen"
            ref={mount}
            onClick={() => terminal.current?.focus()}
          />
          {history.reading && <button className="terminal-latest" onClick={history.latest}>↓ Latest output</button>}
          {phonePaste.box}
          <KeyRow
            className="terminal-key-row"
            label="Terminal keys"
            modifier="ctrl"
            armed={ctrl}
            onArm={armCtrl}
            onPaste={phonePaste.paste}
            onKey={(key) =>
              key === "escape"
                ? send("\x1b")
                : key === "tab"
                  ? send("\t")
                  : key === "enter"
                    ? send("\r")
                    : arrow(key)
            }
          />
        </>
      ) : (
        <TerminalList
          peer={peer}
          logos={logos}
          sessions={sessions}
          macTabs={macTabs}
          macLoaded={macLoaded}
          macError={macError}
          macHidden={macHidden}
          showMac={showMacTabs}
          currentKey={currentKey}
          agents={agents}
          starting={starting}
          onStart={(agent) => void start(agent)}
          onFolder={onNew}
          onOpen={openReach}
          onOpenMac={openMac}
          onEnd={(id) => void end(id)}
          onShowOnScreen={onOpenScreen && ((tab) => void openMacTab(tab))}
          onCloseMac={(tab) => void closeMacTab(tab)}
        />
      )}
      </div>
    </div>
  );
}
