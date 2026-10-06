import { DesktopInput, desktopDisplays } from "./desktop-native.mjs";
import { streamOptions, inputAction } from "./desktop-protocol.mjs";
import { fail } from "./core.mjs";
export function desktopConnection(
  ws,
  {
    config,
    auth,
    control,
    create = DesktopInput.create,
    register = () => {},
    unregister = () => {},
  },
) {
  let token,
    helper,
    starting = false,
    busy = false,
    closed = false,
    lastId = 0,
    lastSeen = Date.now(),
    count = 0,
    windowAt = Date.now();
  const queue = [];
  const close = (message = "Desktop control ended.") => {
    if (closed) return;
    closed = true;
    for (const item of queue) item.reject?.(fail(403, message));
    queue.length = 0;
    helper?.stop();
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", error: message }));
      ws.close(4001, "Desktop control ended");
    }
  };
  ws.endControl = close;
  const authorize = () => {
    const client = auth.verify(token);
    if (
      !client ||
      !config.screen ||
      !(
        client.scopes.includes("admin") ||
        client.scopes.includes("screen:control")
      ) ||
      !client.scopes.includes("screen")
    )
      throw fail(403, "Desktop control expired or was revoked.");
    control.check(client);
    return client;
  };
  const drain = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      while (queue.length && !closed) {
        const item = queue.shift();
        let result;
        try {
          authorize();
          if (Date.now() - item.at > 1000) {
            // A move or scroll that waited too long is let go (the next one
            // stands for it); a click or key never runs late.
            if (["move", "scroll"].includes(item.action.type)) {
              item.resolve?.({ ok: true, skipped: true });
              if (item.id !== undefined && !closed && ws.readyState === 1)
                ws.send(JSON.stringify({ type: "ack", id: item.id, ok: true, skipped: true }));
              continue;
            }
            throw fail(408, "Desktop action became stale.");
          }
          result = await helper.send(item.action);
          authorize();
        } catch (e) {
          item.reject?.(e);
          throw e;
        }
        const client = authorize();
        control.acquire(client, true);
        item.resolve?.(result);
        if (item.id !== undefined && !closed && ws.readyState === 1)
          ws.send(JSON.stringify({ type: "ack", id: item.id, ...result }));
      }
    } catch (e) {
      close(e.message);
    } finally {
      busy = false;
    }
  };
  const deadline = setTimeout(() => close("Authenticate first."), 5000);
  const check = setInterval(() => {
    if (token) {
      try {
        authorize();
        if (!starting && !busy && Date.now() - lastSeen > 3000)
          close("Desktop control disconnected.");
      } catch (e) {
        close(e.message);
      }
    }
  }, 500);
  check.unref();
  ws.on("message", async (buffer, binary) => {
    try {
      if (closed) return;
      if (binary) throw fail(400, "Send desktop control messages.");
      const message = JSON.parse(buffer.toString());
      if (!token) {
        if (
          starting ||
          message.type !== "auth" ||
          typeof message.token !== "string"
        )
          throw fail(401, "Authenticate first.");
        starting = true;
        token = message.token;
        const client = authorize();
        register(client.id, ws);
        ws.clientId = client.id;
        clearTimeout(deadline);
        const options = streamOptions({ display: message.display });
        // Which display this control is on: an agent waits only for its own.
        ws.reachDisplay = options.display;
        if (create === DesktopInput.create) {
          const displays = await desktopDisplays(config);
          if (
            options.display !== "primary" &&
            !displays.some((d) => d.id === options.display)
          )
            throw fail(400, "Display unavailable.");
        }
        helper = await create(config, options.display);
        if (closed || ws.readyState !== 1) {
          helper.stop();
          return;
        }
        authorize();
        lastSeen = Date.now();
        // Probe authorization without generating any OS input.
        const initial = await helper.send({ type: "heartbeat" });
        authorize();
        starting = false;
        ws.send(
          JSON.stringify({
            type: "ready",
            cursor: initial.cursor,
            window: 8,
            typing: true,
            // Asks "is there a text field here?" on touch-down (probe).
            probe: true,
          }),
        );
        return;
      }
      authorize();
      lastSeen = Date.now();
      if (!helper || starting)
        throw fail(409, "Wait for desktop input to be ready.");
      if (Date.now() - windowAt >= 1000) {
        windowAt = Date.now();
        count = 0;
      }
      if (++count > 180) throw fail(429, "Desktop input rate exceeded.");
      if (
        message.type !== "input" ||
        !Number.isSafeInteger(message.id) ||
        message.id <= lastId ||
        queue.length >= 8
      )
        throw fail(400, "Invalid desktop input or full input window.");
      const action = inputAction(message.action);
      lastId = message.id;
      // Only replace consecutive queued moves. Button and key order is preserved.
      if (action.type === "move" && queue.at(-1)?.action.type === "move") {
        const previous = queue.pop();
        ws.send(
          JSON.stringify({
            type: "ack",
            id: previous.id,
            ok: true,
            skipped: true,
          }),
        );
      }
      queue.push({ action, id: message.id, at: Date.now() });
      void drain();
    } catch (e) {
      close(e.message);
    }
  });
  ws.on("close", () => {
    closed = true;
    for (const item of queue)
      item.reject?.(fail(403, "Desktop control ended."));
    queue.length = 0;
    clearTimeout(deadline);
    clearInterval(check);
    helper?.stop();
    if (ws.clientId) {
      if (unregister(ws.clientId, ws) !== false) control.revoke(ws.clientId);
    }
  });
  ws.on("error", () => close());
}
