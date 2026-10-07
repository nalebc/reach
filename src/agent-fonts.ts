import { useEffect } from "react";
import { request, type Peer } from "./api";

// The Claude app's typefaces (Anthropic Sans and Serif), which the computer
// reads from its Claude app (server/agent-sessions/fonts.mjs). Loaded once per
// computer, the first time a Claude screen shows; agent-session.css names them
// first, so Claude's chats change over as soon as they arrive. Without them the
// phone's own serif and sans stand in.
const loading = new Map<string, Promise<void>>();

export function loadClaudeFonts(peer: Peer, fonts: FontFaceSet | undefined = document.fonts) {
  if (typeof FontFace === "undefined" || !fonts) return Promise.resolve();
  let pending = loading.get(peer.url);
  if (!pending) {
    pending = (async () => {
      const { version, fonts: families } = await request<{ version: string; fonts: string[] }>(
        peer,
        "/api/sessions/fonts",
      );
      await Promise.all(
        families.map(async (family) => {
          const response = await fetch(`${peer.url}/api/sessions/fonts/${encodeURIComponent(family)}?v=${version}`, {
            headers: { Authorization: `Bearer ${peer.token}` },
            redirect: "error",
          });
          if (!response.ok) return;
          const face = new FontFace(family, await response.arrayBuffer(), { weight: "300 800", display: "swap" });
          fonts.add(await face.load());
        }),
      );
    })().catch(() => {
      // Try again next time a Claude screen opens.
      loading.delete(peer.url);
    });
    loading.set(peer.url, pending);
  }
  return pending;
}

export function useClaudeFonts(peer: Peer | null | undefined, on: boolean) {
  useEffect(() => {
    if (peer && on) void loadClaudeFonts(peer);
  }, [peer?.url, peer?.token, on]);
}
