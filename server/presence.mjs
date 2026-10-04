import { hash } from "./core.mjs";

// Presence comes from authenticated, live sockets, never saved pairing records.
export class DevicePresence {
  sessions = new Map();
  add(socket, client, kind = "computer") {
    this.sessions.set(socket, {
      client,
      kind: ["phone", "tablet", "computer"].includes(kind) ? kind : "computer",
    });
  }
  remove(socket) {
    this.sessions.delete(socket);
  }
  removeClient(id) {
    for (const [socket, { client }] of this.sessions)
      if (client.id === id) this.sessions.delete(socket);
  }
  snapshot(viewer, activity = () => "connected") {
    const devices = new Map();
    const key = (client) =>
      client.tailscale
        ? `node:${hash(`${client.tailscale.userId}:${client.tailscale.nodeId}`)}`
        : `client:${client.id}`;
    const self = key(viewer);
    for (const { client, kind } of this.sessions.values()) {
      if (client.expiresAt <= Date.now()) continue;
      const id = key(client);
      if (!viewer.scopes.includes("admin") && id !== self) continue;
      const status = activity(client.id);
      const old = devices.get(id);
      const access = [...(old?.access || [])];
      const grant = {
        kind:
          client.kind === "guest"
            ? "invited"
            : client.kind === "agent"
              ? "agent"
              : "paired",
        expiresAt: client.expiresAt,
      };
      if (
        !access.some(
          (a) => a.kind === grant.kind && a.expiresAt === grant.expiresAt,
        )
      )
        access.push(grant);
      const rank = { connected: 0, terminal: 1, viewing: 2, controlling: 3 };
      devices.set(id, {
        id,
        name: old?.name || client.name,
        kind: old?.kind || kind,
        self: id === self,
        access,
        activity:
          old && rank[old.activity] > rank[status] ? old.activity : status,
      });
    }
    return { devices: [...devices.values()] };
  }
}

export function presenceConnection(ws, { verify, presence, activity }) {
  let lastSnapshot = "";
  let token,
    client,
    alive = true;
  const end = () => {
    presence.remove(ws);
    ws.close(4001, "Presence access ended");
  };
  const deadline = setTimeout(() => ws.terminate(), 5000);
  const send = () => {
    if (!token || ws.readyState !== 1) return;
    client = verify(token);
    if (!client) return end();
    presence.add(ws, client, ws.deviceKind);
    if (ws.bufferedAmount > 256 * 1024) return ws.terminate();
    const snapshot = JSON.stringify({
      type: "presence",
      ...presence.snapshot(client, activity),
    });
    if (snapshot !== lastSnapshot) {
      ws.send(snapshot);
      lastSnapshot = snapshot;
    }
  };
  const update = setInterval(send, 2000);
  const heartbeat = setInterval(() => {
    if (!alive) {
      presence.remove(ws);
      return ws.terminate();
    }
    alive = false;
    ws.ping();
  }, 10000);
  update.unref();
  heartbeat.unref();
  deadline.unref();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("message", (buffer, binary) => {
    try {
      if (binary || token || buffer.length > 1024) return end();
      const message = JSON.parse(buffer.toString());
      if (message.type !== "auth" || typeof message.token !== "string")
        return end();
      client = verify(message.token);
      if (!client) return end();
      token = message.token;
      ws.clientId = client.id;
      ws.deviceKind = message.kind;
      presence.add(ws, client, message.kind);
      clearTimeout(deadline);
      send();
    } catch {
      end();
    }
  });
  ws.once("close", () => {
    clearTimeout(deadline);
    clearInterval(update);
    clearInterval(heartbeat);
    presence.remove(ws);
  });
  ws.on("error", () => {});
}
