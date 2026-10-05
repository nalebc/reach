import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Square,
  Send,
  Check,
  X,
  ArrowUp,
  ChevronDown,
  Copy,
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  FolderOpen,
  Search,
  Pointer,
} from "lucide-react";
import { arrowKey, controlKey } from "./terminal-keys";
import { useViewportBox } from "./useViewportBox";
import {
  disposeLater,
  plainKeyboard,
  terminalOptions,
} from "./terminal-options";
import MacTerminalView from "./MacTerminalView";
import TerminalList from "./TerminalList";
import KeyRow from "./KeyRow";
import { describeMacTerminal } from "./terminal-titles";
import { macTerminalsFingerprint } from "./mac-terminal-live";
import { useFirstTime } from "./first-time";
import { AgentLogo, useAgentLogos } from "./agent-logos";
import { Peer, Session, Chat, Approval, request, post } from "./api";
import { parseChatResponse } from "./chat-response";
import type { MacTerminal } from "./DesktopTerminals";
import "./terminals.css";
import ThinkingOrb from "./ThinkingOrb";
import { ReconnectTimer } from "./reconnect";
import {
  PageTitle,
  Terminal,
  MessageSquare,
  Plus,
  Empty,
  Spinner,
  ErrorLine,
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
}) {
  const page = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null),
    terminal = useRef<XTerm | null>(null),
    socket = useRef<WebSocket | null>(null),
    ctrlArmed = useRef(false);
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [menu, setMenu] = useState<"switch" | "new" | null>(null),
    [ctrl, setCtrl] = useState(false),
    [agents, setAgents] = useState<string[] | null>(null),
    [macTabs, setMacTabs] = useState<MacTerminal[]>(
      () => knownMacTabs.get(peer.id) ?? [],
    ),
    [macError, setMacError] = useState(""),
    // Home opens a Mac tab directly with source "mac:<id>".
    [macSelected, setMacSelected] = useState(() =>
      source.startsWith("mac:") ? source.slice(4) : "",
    ),
    [macLoaded, setMacLoaded] = useState(() => knownMacTabs.has(peer.id)),
    // Looked at the Mac since this page opened (not just remembered).
    [macFresh, setMacFresh] = useState(false),
    [slide, setSlide] = useState<"next" | "previous" | "">(""),
    [starting, setStarting] = useState(false);
  const showMacTabs = desktopTerminals && peer.platform === "darwin";
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
        const r = await request<{ sessions: MacTerminal[] }>(
          peer,
          "/api/terminals/desktop",
        );
        if (stopped) return;
        knownMacTabs.set(peer.id, r.sessions);
        setMacTabs(r.sessions);
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
  // Swipe left or right to move between terminals, like stories. The first
  // time there's another terminal to go to, a hand shows how.
  const [swipeHint, swipeSeen] = useFirstTime("terminal-swipe");
  const swipeHintShown = useRef(false);
  const swipe = useRef<{ x: number; y: number; at: number } | null>(null);
  const swipeHandlers = {
    onTouchStart: (event: React.TouchEvent) => {
      // Touching the terminal while the hand shows: understood.
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
  const logos = useAgentLogos(peer);
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
    terminal.current = term;
    const resize = () => {
      try {
        fit.fit();
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
          term.reset();
          term.write(m.data);
          connectedRef = true;
          retry.reset();
          setConnected(true);
          resize();
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
      let data = typed;
      // Sticky Ctrl from the key row applies to the next typed character.
      if (ctrlArmed.current) {
        data = controlKey(typed) ?? typed;
        ctrlArmed.current = false;
        setCtrl(false);
      }
      if (ws?.readyState === WebSocket.OPEN && connectedRef)
        ws.send(JSON.stringify({ type: "input", data }));
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
      await post(peer, `/api/terminals/desktop/${tab.id}/focus`);
      if (onOpenScreen) onOpenScreen();
      else toast("Brought to the front on your Mac. Turn on Screen to see it.");
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
      <header className="terminal-bar">
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
            showMac={showMacTabs}
            currentKey={currentKey}
            onOpen={openReach}
            onOpenMac={openMac}
            onEnd={(id) => void end(id)}
            onShowOnScreen={onOpenScreen && ((tab) => void openMacTab(tab))}
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
          Swipe to switch terminals
        </div>
      )}
      <div
        key={currentKey}
        className={`terminal-stage ${slide ? `slide-${slide}` : ""}`}
        {...swipeHandlers}
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
          <KeyRow
            className="terminal-key-row"
            label="Terminal keys"
            modifier="ctrl"
            armed={ctrl}
            onArm={armCtrl}
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
        />
      )}
      </div>
    </div>
  );
}
export function ChatView({
  peer,
  chats,
  selected,
  focused = false,
  onFocus,
  onSelect,
  onNew,
  onRefresh,
  toast,
}: {
  peer: Peer;
  chats: Session[];
  selected: string;
  focused?: boolean;
  onFocus: (focused: boolean) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  toast: (s: string) => void;
}) {
  const [search, setSearch] = useState("");
  const workspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height || window.innerHeight;
      workspace.current?.style.setProperty("--chat-height", `${height}px`);
      workspace.current?.style.setProperty(
        "--chat-offset",
        `${viewport?.offsetTop || 0}px`,
      );
      workspace.current?.classList.toggle(
        "keyboard-open",
        window.innerHeight - height > 120,
      );
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const [revision, setRevision] = useState(0);
  const [chat, setChat] = useState<Chat | null>(null),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draftKey = `${peer.id}:${selected}`;
  const message = drafts[draftKey] || "";
  const setMessage = (text: string) =>
    setDrafts((previous) => ({ ...previous, [draftKey]: text }));
  const end = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true);
  useEffect(() => {
    setChat(null);
    setError("");
    if (!selected) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const c = parseChatResponse(
          await request<unknown>(peer, `/api/chats/${selected}`),
          selected,
        );
        if (active) {
          setChat(c);
          setError("");
        }
      } catch (e) {
        if (active) {
          setChat(null);
          setError((e as Error).message);
        }
      }
      if (active) timer = setTimeout(poll, 1200);
    };
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected, peer.id, peer.url, peer.token, revision]);
  useEffect(() => {
    if (nearBottom.current) end.current?.scrollIntoView({ block: "nearest" });
  }, [chat?.items, chat?.approvals]);
  const send = async () => {
    if (
      !message.trim() ||
      !chat ||
      busy ||
      ["running", "waiting", "starting"].includes(chat.status)
    )
      return;
    setBusy(true);
    setError("");
    try {
      await post(peer, `/api/chats/${selected}/messages`, { text: message });
      setMessage("");
      nearBottom.current = true;
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const running =
    chat && ["running", "waiting", "starting"].includes(chat.status);
  return (
    <div
      ref={workspace}
      className={`codex-workspace ${focused && chats.length ? "is-thread" : "is-inbox"}`}
    >
      <PageTitle
        eyebrow={peer.name}
        title="Codex"
        description="Pick up an idea. Keep it moving."
      >
        <button className="button primary" onClick={onNew}>
          <Plus size={17} />
          New chat
        </button>
      </PageTitle>
      {!chats.length ? (
        <section className="panel">
          <Empty
            icon={MessageSquare}
            title="Your next idea starts here"
            action={
              <button className="button primary" onClick={onNew}>
                <Plus size={17} />
                Start with Codex
              </button>
            }
          >
            Choose a folder and give Codex a task. Review its work and approve
            actions from any device.
          </Empty>
          <div className="info-strip">
            Uses Codex installed and signed in on your computer.
          </div>
        </section>
      ) : (
        <section className="chat-layout">
          <aside className="chat-list" aria-label="Conversations">
            <label className="conversation-search">
              <Search size={17} />
              <input
                aria-label="Search conversations"
                placeholder="Find a conversation"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="inbox-caption">
              <span>YOUR CONVERSATIONS</span>
              <span>{chats.length}</span>
            </div>
            {chats
              .filter((c) =>
                c.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.id}
                  className={c.id === selected ? "active" : ""}
                  onClick={() => {
                    onSelect(c.id);
                    onFocus(true);
                  }}
                >
                  <span className={`conversation-icon ${c.status}`}>
                    <MessageSquare size={20} />
                  </span>
                  <span className="conversation-summary">
                    <strong>{c.name}</strong>
                    <small>
                      {c.cwd?.split(/[\\/]/).pop() || "On your computer"}
                    </small>
                    <em>
                      {c.status === "waiting"
                        ? "Needs your approval"
                        : c.status === "running" || c.status === "starting"
                          ? "Working…"
                          : c.status === "error"
                            ? "Needs attention"
                            : "Ready to continue"}
                    </em>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            {search &&
              !chats.some((c) =>
                c.name.toLowerCase().includes(search.toLowerCase()),
              ) && (
                <p className="inbox-empty">
                  No conversations match “{search}”.
                </p>
              )}
            <p className="inbox-footnote">Runs with Codex on {peer.name}.</p>
          </aside>
          <div className="chat-panel">
            <div className="chat-top">
              <button
                className="icon-button thread-back"
                aria-label="Back to conversations"
                onClick={() => onFocus(false)}
              >
                <ArrowLeft size={21} />
              </button>
              <div className="thread-heading">
                <strong>
                  {chat?.name ||
                    chats.find((c) => c.id === selected)?.name ||
                    "Conversation"}
                </strong>
                <small>
                  {peer.name} · {chat?.cwd?.split(/[\\/]/).pop() || "Codex"}
                </small>
              </div>
              <button
                className="icon-button"
                aria-label="New conversation"
                onClick={onNew}
              >
                <Plus size={20} />
              </button>
            </div>
            <ErrorLine error={error} />
            <div
              className="chat-messages"
              ref={scroll}
              onScroll={() => {
                const el = scroll.current;
                if (el)
                  nearBottom.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 120;
              }}
            >
              {!chat ? (
                error ? (
                  <Empty
                    icon={MessageSquare}
                    title="Conversation unavailable"
                    action={
                      <button
                        className="button secondary"
                        onClick={() => setRevision((n) => n + 1)}
                      >
                        Try again
                      </button>
                    }
                  >
                    Choose another conversation or return to Home while Reach
                    retries.
                  </Empty>
                ) : !selected ? (
                  <Empty icon={MessageSquare} title="Choose a conversation">
                    Select a conversation to continue.
                  </Empty>
                ) : (
                  <Spinner />
                )
              ) : !chat.items.length ? (
                <div className="chat-welcome">
                  <span className="chat-welcome-symbol">
                    <MessageSquare size={32} strokeWidth={1.4} />
                  </span>
                  <h2>What are we working on?</h2>
                  <p>
                    Ask a question, build something, or explore this folder.
                  </p>
                  <button
                    className="suggestion"
                    onClick={() =>
                      setMessage(
                        "Explore this folder and explain what is here. Do not change any files.",
                      )
                    }
                  >
                    Help me understand this folder
                  </button>
                </div>
              ) : (
                chat.items.map((item) =>
                  item.type === "userMessage" ? (
                    <div className="message user" key={item.id}>
                      {item.content?.map((i) => i.text).join("\n")}
                    </div>
                  ) : item.type === "agentMessage" ? (
                    <div className="message assistant" key={item.id}>
                      <div className="message-author">✳ Codex</div>
                      <div className="message-text">{item.text}</div>
                    </div>
                  ) : item.type === "commandExecution" ? (
                    <details className="tool-card" key={item.id}>
                      <summary>
                        <Terminal size={15} />
                        <code>{item.command}</code>
                        <span>{item.status}</span>
                      </summary>
                      <pre>{item.aggregatedOutput || "Running…"}</pre>
                    </details>
                  ) : item.type === "fileChange" ? (
                    <details className="tool-card" key={item.id}>
                      <summary>
                        Files changed <span>{item.changes?.length}</span>
                      </summary>
                      {item.changes?.map((c, i) => (
                        <div key={i}>
                          <strong>{c.path}</strong>
                          <pre>{c.diff}</pre>
                        </div>
                      ))}
                    </details>
                  ) : item.type === "mcpToolCall" ? (
                    <div className="tool-card compact" key={item.id}>
                      {item.tool} · {item.status}
                    </div>
                  ) : item.type === "plan" ? (
                    <div className="message assistant" key={item.id}>
                      {item.text}
                    </div>
                  ) : null,
                )
              )}
              {chat?.approvals.map((a) => (
                <ApprovalCard
                  key={a.id}
                  approval={a}
                  peer={peer}
                  chatId={selected}
                  toast={toast}
                />
              ))}
              {chat?.error && <ErrorLine error={chat.error} />}{" "}
              {running && (
                <div className="thinking">
                  <ThinkingOrb
                    size={32}
                    state={chat.status === "waiting" ? "waiting" : "working"}
                  />
                  {chat.status === "waiting"
                    ? "Waiting for your response"
                    : "Working on your computer…"}
                </div>
              )}
              <div ref={end} />
            </div>
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <textarea
                placeholder="Ask Codex to do something…"
                aria-label="Message Codex"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    !running
                  ) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div>
                <span>Workspace access · approvals enabled</span>
                {running ? (
                  <button
                    type="button"
                    className="icon-button stop-button"
                    title="Stop working"
                    onClick={async () => {
                      try {
                        await post(peer, `/api/chats/${selected}/stop`);
                      } catch (e) {
                        toast((e as Error).message);
                      }
                    }}
                  >
                    <Square size={17} />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    aria-label="Send message"
                    disabled={!chat || busy || !message.trim()}
                  >
                    <ArrowUp size={20} />
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      )}
    </div>
  );
}
function ApprovalCard({
  approval: a,
  peer,
  chatId,
  toast,
}: {
  approval: Approval;
  peer: Peer;
  chatId: string;
  toast: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const respond = async (data: unknown) => {
    setBusy(true);
    try {
      await post(peer, `/api/chats/${chatId}/approvals/${a.id}`, data);
      setDone(true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (done) return <div className="tool-card compact">Response sent</div>;
  return (
    <div className="approval-card">
      <strong>
        {a.method === "item/tool/requestUserInput"
          ? "Codex has a question"
          : "Your approval is needed"}
      </strong>
      <p>{a.params.reason}</p>
      {a.params.command && <pre>{a.params.command}</pre>}
      {a.params.questions?.map((q) => (
        <label key={q.id}>
          {q.question}
          {q.options ? (
            <select
              value={answers[q.id] || ""}
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
            >
              <option value="">Choose an answer</option>
              {q.options.map((o) => (
                <option key={o.label}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              value={answers[q.id] || ""}
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
            />
          )}
        </label>
      ))}
      <div className="button-row">
        {a.method === "item/tool/requestUserInput" ? (
          <button
            disabled={busy}
            className="button primary"
            onClick={() => respond({ answers })}
          >
            Send answer
          </button>
        ) : (
          <>
            <button
              disabled={busy}
              className="button primary"
              onClick={() => respond({ decision: "accept" })}
            >
              <Check size={16} />
              Allow once
            </button>
            <button
              disabled={busy}
              className="button secondary"
              onClick={() => respond({ decision: "decline" })}
            >
              <X size={16} />
              Deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}
