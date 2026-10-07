// Isolated interaction fixture: no real companion, credentials or shell.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import RemoteTyping from "../../src/RemoteTyping";
import type { DesktopAction, TextTarget } from "../../src/desktop-input-queue";
import AgentSession from "../../src/AgentSession";
import { TerminalView } from "../../src/Sessions";
import DesktopSurface from "../../src/DesktopSurface";
import { useScreenPresentation } from "../../src/useScreenPresentation";
import "../../src/styles.css";
import "../../src/atmosphere.css";
import "../../src/workspace.css";
import "../../src/screen-immersive.css";
const peer = { id: "sample", name: "Home Mac", platform: "darwin", url: location.origin, token: "sample-only" };
const session = { agent: "codex", id: "sample", title: "A calmer mobile workspace", cwd: "/Projects/Reach", status: "idle", updatedAt: Date.now(), createdAt: Date.now(), origin: "app", inApp: true, archived: false, model: "sample", effort: "medium", mode: "read-only", held: null };
const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user", kind: "text", at: Date.now(), text: i % 2 ? `Step ${i}: the header stays put, the conversation scrolls, and the keyboard has its own space.\n\nYou can read earlier messages without being pulled back down.\n\n\`\`\`sh\nnpm run build\n\`\`\`` : `Let's review mobile interaction ${i + 1}.` }));
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!u.pathname.startsWith("/api/")) return nativeFetch(input, init);
  let data: unknown = {};
  if (u.pathname.endsWith("/live")) {
    await new Promise(r => setTimeout(r, 1500));
    data = { version: 1, status: "idle", prompts: [], streaming: "", items: 0 };
  } else if (u.pathname === "/api/sessions/codex/sample") data = { session, items, before: null };
  else if (u.pathname.endsWith("/messages")) {
    items.push({ id: String(items.length), role: "user", kind: "text", at: Date.now(), text: JSON.parse(String(init.body)).text });
    data = { turnId: "sample" };
  } else if (u.pathname.endsWith("/models")) data = { models: [], modes: [] };
  else if (u.pathname.endsWith("/agents")) data = { agents: [] };
  else if (u.pathname.endsWith("/logos")) data = { logos: {} };
  return Response.json(data);
};
class SampleSocket {
  static OPEN = 1; static CLOSING = 2; readyState = 1;
  onopen: any; onmessage: any; onclose: any;
  constructor() { setTimeout(() => this.onopen?.(), 20); }
  send(raw: string) {
    const msg = JSON.parse(raw);
    const data = msg.type === "auth" ? { type: "snapshot", data: Array.from({ length: 240 }, (_, i) => `\x1b[32m${String(i + 1).padStart(3)}\x1b[0m  workspace check ${i + 1} · passed\r\n`).join("") + "\r\n$ " } : msg.type === "input" ? { type: "data", data: msg.data === "\r" ? "\r\n$ " : msg.data } : null;
    if (data) setTimeout(() => this.onmessage?.({ data: JSON.stringify(data) }), 0);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
window.WebSocket = SampleSocket as any;
function PreviewScreen({ back }: { back: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), viewer = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [target, setTarget] = useState<TextTarget | null>(null);
  const [text, setText] = useState("This text was already on the computer.");
  const { expanded, toggleFullscreen } = useScreenPresentation(viewer, !!target);
  const inField = (p: { x: number; y: number }) => p.x >= .11 && p.x <= .89 && p.y >= .67 && p.y <= .82;
  const send = async (action: DesktopAction) => {
    if (action.type === "type-edit") setText(value => [...value].slice(0, action.delete ? -Number(action.delete) : undefined).join("") + String(action.text));
    if (action.type === "key" && action.key === "backspace") setText(value => [...value].slice(0, -1).join(""));
    if (action.type === "text") setText(value => value + String(action.text));
    return {};
  };
  useEffect(() => {
    const c = canvas.current!;
    const draw = () => {
      c.width = 1440; c.height = 900;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#24483e"; ctx.fillRect(0, 0, 1440, 900);
      ctx.fillStyle = "#121c18"; ctx.fillRect(110, 90, 1220, 710);
      ctx.fillStyle = "#d2e6db"; ctx.font = "32px system-ui";
      ctx.fillText("Reach · Keyboard interaction preview", 160, 165);
      ctx.font = "26px system-ui";
      ctx.fillText("Tap the field below. Type directly. Hold Delete to erase.", 160, 285);
      ctx.fillText("Sample only — no commands or input reach your Mac.", 160, 340);
      ctx.fillStyle = target ? "#345d4c" : "#283b32";
      ctx.fillRect(160, 605, 1120, 132);
      ctx.fillStyle = "#e3f5e9"; ctx.font = "30px system-ui";
      ctx.fillText(text.slice(-65) + (target ? "│" : ""), 180, 680);
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(c);
    return () => observer.disconnect();
  }, [text, target]);
  return <div ref={viewer} className={`panel screen-viewer remote-viewer simple-screen ${expanded ? "screen-expanded" : ""} ${target ? "screen-typing" : ""}`}>
    <div className="screen-toolbar simple-screen-toolbar"><button onClick={back}>Back</button><span>Home Mac · Sample</span><button onClick={toggleFullscreen}>Fullscreen</button></div>
    <DesktopSurface canvas={canvas} width={1440} height={900} ready connecting={false} canControl mode="direct" drag={false} clickMode="left" send={send} onDragEnd={() => {}} onFeedback={() => {}} onInteraction={() => setTarget(null)}
      probe={async point => ({ field: inField(point), secure: false })}
      onField={() => { flushSync(() => setTarget({ editable: true, pending: true })); editor.current?.focus({ preventScroll: true }); }}
      onTextTarget={point => setTimeout(() => setTarget(inField(point) ? { editable: true, focus: "sample-field", pending: false } : null), 80)}
      resetKey="sample" initialCursor={null} compact typing={!!target} />
    {target && <RemoteTyping target={target} editorRef={editor} send={send} keyRow onClose={() => setTarget(null)} onError={() => setTarget(null)} />}
    <p className="simple-screen-caption" aria-live="polite">Sample text: {text || "(empty)"}</p>
  </div>;
}
function Preview() {
  const [view, setView] = useState(new URLSearchParams(location.search).get("view") || "menu");
  const back = () => setView("menu");
  if (view === "chat") return <AgentSession peer={peer} session={session as any} siblings={[session as any]} health={[{ agent: "codex", installed: true, signedIn: true } as any]} onSelect={() => {}} onBack={back} />;
  if (view === "terminal") return <TerminalView peer={peer} sessions={[{ id: "sample", name: "Workspace", cwd: "/Projects/Reach", status: "running" } as any]} selected="sample" desktopTerminals={false} source="reach" setSource={() => {}} onSelect={() => {}} onNew={() => {}} onRefresh={() => {}} toast={() => {}} onExit={back} />;
  if (view === "screen") return <PreviewScreen back={back} />;
  return <main style={{ padding: 28 }}><h1>Mobile interaction preview</h1><p>Sample data only. No connection to your Mac.</p>{["chat", "terminal", "screen"].map(id => <button style={{ margin: 8, padding: 16 }} key={id} onClick={() => setView(id)}>{id}</button>)}</main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
