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
  ArrowDown,
  CornerDownLeft,
  ChevronDown,
  Copy,
  ArrowLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { Peer, Session, Chat, Approval, request, post } from "./api";
import { parseChatResponse } from "./chat-response";
import DesktopTerminals, { type MacTerminal } from "./DesktopTerminals";
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
}) {
  const mount = useRef<HTMLDivElement>(null),
    terminal = useRef<XTerm | null>(null),
    socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false),
    [error, setError] = useState("");
  const current = sessions.find((s) => s.id === selected);
  // One list for every terminal on the computer: shells started from this
  // device and tabs already open in Terminal or iTerm2.
  const showOpenApps = desktopTerminals && peer.platform === "darwin";
  const [appTerminals, setAppTerminals] = useState<MacTerminal[]>([]),
    [appSelected, setAppSelected] = useState("");
  const terminals = [
    ...sessions.map((s) => ({
      key: `shell:${s.id}`,
      name: s.name,
      detail: s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd,
      live: s.status === "running",
      active: !appSelected && s.id === selected,
      open: () => {
        setAppSelected("");
        onSelect(s.id);
      },
    })),
    ...appTerminals.map((t) => ({
      key: `app:${t.id}`,
      name: t.name || "Untitled terminal",
      detail: t.provider === "terminal" ? "Terminal" : "iTerm2",
      live: true,
      active: appSelected === t.id,
      open: () => setAppSelected(t.id),
    })),
  ];
  // The terminal mount only exists once the session list includes the selection.
  const mounted = !!current && !appSelected;
  useEffect(() => {
    if (!selected || !mounted || !mount.current) return;
    let stopped = false,
      ws: WebSocket;
    const retry = new ReconnectTimer();
    let lastSeen = Date.now(),
      retryable = true,
      heartbeatSupported = false;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#0c110f",
        foreground: "#dce5dd",
        cursor: "#b9f568",
        selectionBackground: "#354831",
        black: "#182019",
        red: "#f18d8d",
        green: "#b9f568",
        yellow: "#e3c67a",
        blue: "#8fb9f4",
        magenta: "#c7a8e9",
        cyan: "#86d0bd",
        white: "#e5ece6",
      },
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount.current);
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
    const input = term.onData((data) => {
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
      term.dispose();
      terminal.current = null;
      setConnected(false);
    };
  }, [selected, peer.id, peer.url, peer.token, mounted]);
  const key = (data: string) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ type: "input", data }));
    terminal.current?.focus();
  };
  return (
    <>
      <PageTitle
        eyebrow={peer.name}
        title="Terminals"
        description={`Every terminal on ${peer.name}, in one place.`}
      >
        <button className="button primary" onClick={onNew}>
          <Plus size={17} />
          New terminal
        </button>
      </PageTitle>
      {terminals.length > 0 && (
        <div className="session-tabs terminal-picker" aria-label="Terminals">
          {terminals.map((t) => (
            <button
              key={t.key}
              className={t.active ? "active" : ""}
              aria-pressed={t.active}
              onClick={t.open}
            >
              <Terminal size={15} />
              <span className="terminal-picker-label">
                {t.name}
                <small>{t.detail}</small>
              </span>
              <span className={`status-dot ${t.live ? "" : "off"}`} />
            </button>
          ))}
        </div>
      )}
      {showOpenApps && (
        <DesktopTerminals
          key={`${peer.id}:${peer.url}:${peer.token}`}
          peer={peer}
          embedded
          selectedId={appSelected}
          onInventory={(list) => {
            setAppTerminals(list);
            setAppSelected((id) =>
              id && !list.some((t) => t.id === id) ? "" : id,
            );
            // With no shell open here, show an existing terminal by default.
            if (!sessions.length && list.length)
              setAppSelected((id) => id || list[0].id);
          }}
        />
      )}
      {appSelected ? null : !sessions.length ? (
        <section className="panel">
          <Empty
            icon={Terminal}
            title="A command line, wherever you are"
            action={
              <button className="button primary" onClick={onNew}>
                <Plus size={17} />
                Open a terminal
              </button>
            }
          >
            Start a shell on {peer.name}. It stays running when you close this
            page.
          </Empty>
        </section>
      ) : (
        <section className="terminal-panel">
          <div className="terminal-info">
            <span>{current?.cwd}</span>
            <span className="connection-label">
              <i className={`status-dot ${connected ? "" : "off"}`} />
              {connected ? "Connected" : "Reconnecting"}
            </span>
            {current?.status === "running" && (
              <button
                className="icon-button"
                title="End terminal session"
                onClick={async () => {
                  if (
                    !confirm(
                      "End this terminal? Any commands running in it will stop.",
                    )
                  )
                    return;
                  try {
                    await request(peer, `/api/terminals/${selected}`, {
                      method: "DELETE",
                    });
                    onRefresh();
                  } catch (e) {
                    toast((e as Error).message);
                  }
                }}
              >
                <Square size={14} />
              </button>
            )}
          </div>
          <ErrorLine error={error} />
          <div className="terminal-mount" ref={mount} />
          <div className="terminal-keys">
            {[
              ["Esc", "\x1b"],
              ["Tab", "\t"],
              ["Ctrl C", "\x03"],
              ["Ctrl D", "\x04"],
              ["↑", "\x1b[A"],
              ["↓", "\x1b[B"],
              ["←", "\x1b[D"],
              ["→", "\x1b[C"],
              ["Enter", "\r"],
            ].map(([label, data]) => (
              <button key={label} onClick={() => key(data)}>
                {label}
              </button>
            ))}
          </div>
          <div className="terminal-footnote">
            Session stays on your computer · reconnect anytime while Reach is
            running
          </div>
        </section>
      )}
    </>
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
