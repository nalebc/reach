// Isolated interaction fixture: no real companion, credentials or shell.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
  const [typing, setTyping] = useState(false);
  const { expanded, toggleFullscreen } = useScreenPresentation(viewer, typing);
  useEffect(() => {
    const c = canvas.current!;
    const draw = () => { c.width = 1440; c.height = 900;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#24483e"; ctx.fillRect(0, 0, 1440, 900);
    ctx.fillStyle = "#121c18"; ctx.fillRect(110, 90, 1220, 710);
    ctx.fillStyle = "#d2e6db"; ctx.font = "28px system-ui"; ctx.fillText("Reach · Sample desktop", 150, 150);
    for (let i = 0; i < 11; i++) { ctx.fillStyle = i % 2 ? "#8bada0" : "#cedcd5"; ctx.font = "22px monospace"; ctx.fillText(`${String(i + 1).padStart(2)}    The whole screen stays in view. Pinch to zoom.`, 160, 225 + i * 44); }
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(c);
    return () => observer.disconnect();
  }, []);
  return <div ref={viewer} className={`panel screen-viewer remote-viewer simple-screen ${expanded ? "screen-expanded" : ""}`}>
    <div className="screen-toolbar simple-screen-toolbar"><button onClick={back}>Back</button><span>Home Mac · Sample</span><button onClick={toggleFullscreen}>Fullscreen</button></div>
    <DesktopSurface canvas={canvas} width={1440} height={900} ready connecting={false} canControl={false} mode="direct" drag={false} clickMode="left" send={async () => ({})} onDragEnd={() => {}} onFeedback={() => {}} onInteraction={() => {}} onTextTarget={() => {}} resetKey="sample" initialCursor={null} compact typing={typing} focusPoint={typing ? { x: .7, y: .7 } : undefined} />
    <div className="simple-screen-dock"><input style={{ fontSize: 16 }} placeholder="Test keyboard layout" onFocus={() => setTyping(true)} onBlur={() => setTyping(false)} /></div>
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
