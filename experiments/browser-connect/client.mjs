export function privateOrigin(value) {
  const u = new URL(value.trim());
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(u.hostname) ||
    !["", "/"].includes(u.pathname)
  )
    throw Error("Enter the computer’s private HTTPS Tailscale address.");
  return u.origin;
}

// This is deliberately NOT a replacement for global fetch/WebSocket. Every
// Reach operation goes through the explicit embedded IPN adapter, or fails.
export function createReachClient(ipn, target, onRevoked = () => {}) {
  const origin = privateOrigin(target);
  let token = "",
    generation = 0,
    stopped = false;
  const sockets = new Set();
  const stop = (revoked = false) => {
    if (stopped) return;
    stopped = true;
    token = "";
    generation++;
    for (const socket of [...sockets]) socket.close();
    if (revoked) onRevoked();
  };
  const api = {
    origin,
    authenticate(value) {
      if (stopped || typeof value !== "string" || !value || value.length > 512)
        throw Error("Invalid Reach session");
      token = value;
    },
    async request(route, { method = "GET", body, bytes = false } = {}) {
      if (stopped) throw Error("Access ended. Request approval again.");
      const epoch = generation;
      const result = await ipn.reachRequest(
        origin,
        route,
        method,
        token,
        body === undefined ? "" : JSON.stringify(body),
      );
      if (epoch !== generation) throw Error("Access ended.");
      const data = Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(data);
      if (result.status === 401 && token) stop(true);
      if (result.status < 200 || result.status >= 300) {
        let message = `Reach returned ${result.status}`;
        try {
          message = JSON.parse(text).error || message;
        } catch {}
        throw Error(message);
      }
      return bytes ? data : JSON.parse(text);
    },
    async terminal(sessionId, onMessage, onClose = () => {}) {
      if (stopped || !token) throw Error("Approve this browser first.");
      const epoch = generation;
      let id,
        closed = false,
        heartbeat;
      const socket = {
        async send(data) {
          if (closed || stopped || id === undefined)
            throw Error("Terminal disconnected.");
          return ipn.reachSocketSend(id, JSON.stringify(data));
        },
        close() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          sockets.delete(socket);
          if (id !== undefined) ipn.reachSocketClose(id);
        },
      };
      sockets.add(socket);
      try {
        id = await ipn.reachSocketOpen(origin, (event) => {
          if (closed || epoch !== generation) return;
          if (event.type === "close") {
            socket.close();
            if (event.code === 4001 || event.code === 4003) stop(true);
            onClose(event.code);
          } else if (event.type === "message") {
            try {
              onMessage(JSON.parse(event.data));
            } catch {
              socket.close();
              onClose(1002);
            }
          }
        });
        if (closed || epoch !== generation) {
          ipn.reachSocketClose(id);
          throw Error("Access ended.");
        }
        await socket.send({ type: "auth", token, sessionId });
        heartbeat = setInterval(
          () =>
            socket.send({ type: "ping" }).catch(() => {
              if (!closed) {
                socket.close();
                onClose(1006);
              }
            }),
          10000,
        );
        return socket;
      } catch (error) {
        socket.close();
        throw error;
      }
    },
    stop,
  };
  return api;
}
