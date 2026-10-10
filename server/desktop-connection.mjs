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
    // A second helper that only looks where the text fields are, so a scan
    // never waits behind (or delays) a click. macOS only.
    scanner = create === DesktopInput.create && process.platform === "darwin"
      ? DesktopInput.create
      : null,
    register = () => {},
    unregister = () => {},
    // How long a dropped connection's control lease waits for it to come
    // back (a blip on the phone's link, Tailscale answering late).
    grace = 15000,
  },
) {
  let token,
    helper,
    starting = false,
    busy = false,
    closed = false,
    // How this connection ended: "retry" (the phone reconnects and resumes
    // control) or "end" (control is over: revoked, expired, a bad message).
    ended = "",
    lastId = 0,
    // The last input the Mac has done: a field map reflects the screen after it.
    doneId = 0,
    lastSeen = Date.now(),
    count = 0,
    windowAt = Date.now();
  const queue = [];
  // Text fields on screen, pushed to the phone after anything that can move
  // them (a click, a key, a scroll), and when windows change on the Mac.
  let fields = null,
    scanning = false,
    // A look asked for while one runs: "full" wins over "cheap".
    again = "",
    scanTimer,
    scannedAt = 0,
    sent = "";
  const scan = async (cheap = false) => {
    if (!fields || closed) return;
    if (scanning) {
      again = again === "full" || !cheap ? "full" : "cheap";
      return;
    }
    scanning = true;
    const after = doneId;
    try {
      const result = await fields.send({ type: "fields", cheap });
      scannedAt = Date.now();
      if (closed || ws.readyState !== 1 || result.same || !Array.isArray(result.fields)) return;
      authorize();
      const message = JSON.stringify({ type: "fields", after, fields: result.fields });
      if (message === sent) return;
      sent = message;
      ws.send(message);
    } catch {
      // A scan that fails costs only the shortcut: the tap's own probe stays.
    } finally {
      scanning = false;
      if (again && !closed) {
        const cheapAgain = again === "cheap";
        again = "";
        void scan(cheapAgain);
      }
    }
  };
  // Let the app react first (a page opening, a sheet sliding in).
  const rescan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scan(), 200);
  };
  const changes = new Set(["click", "down", "up", "key", "text", "type-edit", "scroll", "menu"]);
  const stopInput = (input) => {
    if (!input) return;
    // Retirement is independent of the grant: even a revoked/expired phone
    // keeps native ownership until cleanup can no longer post input.
    if (input.terminated) control.retireInput?.(input.terminated);
    input.stop();
  };
  // A retryable end (the connection, not the grant, is the trouble) closes
  // with 1012 and keeps the lease a moment; the phone reconnects quietly
  // (src/useDesktopInput.ts). Anything else is 4001: control is over.
  const close = (message = "Desktop control ended.", retryable = false) => {
    if (closed) return;
    closed = true;
    ended = retryable ? "retry" : "end";
    clearTimeout(scanTimer);
    fields?.stop();
    for (const item of queue) item.reject?.(fail(403, message));
    queue.length = 0;
    stopInput(helper);
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({ type: "error", error: message, ...(retryable && { retryable: true }) }),
      );
      if (retryable) ws.close(1012, "Desktop control reconnecting");
      else ws.close(4001, "Desktop control ended");
    }
  };
  ws.endControl = close;
  const authorize = () => {
    const client = auth.verify(token);
    if (!client) {
      // Not refused, just not confirmed yet (Tailscale's word on the phone
      // or on this Mac is late): the phone reconnects and is checked afresh.
      const interruption = auth.interruption?.(token);
      if (interruption) throw Object.assign(fail(503, interruption), { retryable: true });
    }
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
  const readyForInput = async () => {
    await control.waitForInputStop?.();
    if (closed || ws.readyState !== 1) throw fail(403, "Desktop control ended.");
    // A grant, pause or identity can change while the old native helper exits.
    return authorize();
  };
  const drain = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      while (queue.length && !closed) {
        const item = queue.shift();
        let result;
        try {
          await readyForInput();
          if (Date.now() - item.at > 1000) {
            // A move or scroll that waited too long is let go (the next one
            // stands for it); a click or key never runs late.
            if (["move", "scroll"].includes(item.action.type)) {
              item.resolve?.({ ok: true, skipped: true });
              if (item.id !== undefined && !closed && ws.readyState === 1)
                ws.send(JSON.stringify({ type: "ack", id: item.id, ok: true, skipped: true }));
              continue;
            }
            // Only that action is dropped, and the phone is told; control stays.
            const late = fail(408, "That action waited too long and was dropped. Try again.");
            item.reject?.(late);
            if (item.id !== undefined && !closed && ws.readyState === 1)
              ws.send(JSON.stringify({ type: "ack", id: item.id, ok: false, error: late.message }));
            continue;
          }
          result = await helper.send(item.action);
          if (closed || ws.readyState !== 1) throw fail(403, "Desktop control ended.");
          authorize();
        } catch (e) {
          item.reject?.(e);
          // The helper turned down this one action: it fails, control stays.
          if (e?.refused && !closed) {
            if (item.id !== undefined && ws.readyState === 1)
              ws.send(JSON.stringify({ type: "ack", id: item.id, ok: false, error: e.message }));
            continue;
          }
          throw e;
        }
        const client = authorize();
        control.acquire(client, true);
        item.resolve?.(result);
        if (item.id !== undefined) doneId = item.id;
        if (changes.has(item.action.type)) rescan();
        if (item.id !== undefined && !closed && ws.readyState === 1)
          ws.send(JSON.stringify({ type: "ack", id: item.id, ...result }));
      }
    } catch (e) {
      close(e.message, e?.retryable === true);
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
          close("Desktop control disconnected. Reconnecting…", true);
        // Changes on the Mac itself (a window opening, an app switch): a
        // cheap look, a full one only when windows moved.
        else if (fields && !scanning && Date.now() - scannedAt > 1000)
          void scan(true);
      } catch (e) {
        close(e.message, e?.retryable === true);
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
        // Back within the grace: the lease is this connection's again.
        control.keep?.(client.id);
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
        await readyForInput();
        helper = await create(config, options.display);
        if (closed || ws.readyState !== 1) {
          stopInput(helper);
          return;
        }
        await readyForInput();
        lastSeen = Date.now();
        // Probe authorization without generating any OS input.
        const initial = await helper.send({ type: "heartbeat" });
        if (closed || ws.readyState !== 1) { stopInput(helper); return; }
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
            // Pushes where the text fields are, ahead of the tap.
            fields: !!scanner,
          }),
        );
        if (scanner)
          void scanner(config, options.display).then(
            (helper) => {
              if (closed) return helper.stop();
              fields = helper;
              void scan();
            },
            () => {},
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
      close(e.message, e?.retryable === true);
    }
  });
  ws.on("close", (code) => {
    closed = true;
    for (const item of queue)
      item.reject?.(fail(403, "Desktop control ended."));
    queue.length = 0;
    clearTimeout(deadline);
    clearTimeout(scanTimer);
    clearInterval(check);
    stopInput(helper);
    fields?.stop();
    if (ws.clientId && unregister(ws.clientId, ws) !== false) {
      // Over for good (revoked, expired, or the phone let go: a clean close,
      // 1000 or one without a code): control ends now. Dropped (the link,
      // 1006; a retryable end here; the phone closing to reconnect, 4002):
      // the lease waits for it, up to the grace.
      if (ended === "end" || code === 1000 || code === 1005 || !control.revokeLater)
        control.revoke(ws.clientId);
      else control.revokeLater(ws.clientId, grace);
    }
  });
  // The socket itself failed: the link, not the grant.
  ws.on("error", () => close("Desktop control disconnected. Reconnecting…", true));
}
