import { DesktopInput, desktopDisplays } from "./desktop-native.mjs";
import { streamOptions, inputAction } from "./desktop-protocol.mjs";
import { fail } from "./core.mjs";
import { actsAsOwner } from "./screen.mjs";
import { privateViewRefused, PRIVATE_VIEW_UNAVAILABLE } from "./remote-screen.mjs";
export function desktopConnection(
  ws,
  {
    config,
    auth,
    control,
    create = DesktopInput.create,
    // A second helper that only looks where the text fields are, so a scan
    // never waits behind (or delays) a click. Accessibility on a Mac, UI
    // Automation on Windows; neither sends input or reads field values.
    scanner = create === DesktopInput.create && ["darwin", "win32"].includes(process.platform)
      ? DesktopInput.create
      : null,
    register = () => {},
    unregister = () => {},
    // Told of each input that reached the computer (a tap, a key, a scroll,
    // a pointer move; never a look such as a probe or a focus check), with
    // the display it went to: agents step aside while a person uses it.
    used = () => {},
    // May this client control this display? (Reach's hidden app displays
    // are only for those the app is shared with: server/index.mjs.)
    allowDisplay = () => true,
    // How long a dropped connection's control lease waits for it to come
    // back (a blip on the phone's link, Tailscale answering late).
    grace = 15000,
    // How long a stopped control keeps its connection and helper parked, so
    // Control again resumes at once instead of starting a new helper.
    parkFor = 60000,
    platform = process.platform,
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
    windowAt = Date.now(),
    // Control stopped, connection kept: no lease, no input, until resumed.
    parked = false,
    parkTimer,
    // The button let go on parking, finished before anything else is sent.
    letGo = Promise.resolve(),
    // Bumped when control stops: an action already with the helper isn't
    // acknowledged (or renewed) for a control that has ended.
    epoch = 0;
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
    if (!fields || closed || parked) return;
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
  // A person's hands on the computer: everything that changes it, and the
  // pointer moving (a trackpad, a mouse). Reads and let-gos don't count.
  const inputs = new Set([...changes, "move"]);
  // Actions that let go of something held. (A key press lets go of its own
  // modifiers in the same helper call, so there's no separate key-up.)
  const releases = new Set(["up", "release"]);
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
    clearTimeout(parkTimer);
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
  // Control off: the lease is gone (server/screen.mjs), and so is anything
  // queued; the connection and its helper wait a minute for Control again.
  ws.parkControl = () => {
    if (parked) return;
    if (closed || !helper || starting) return close();
    parked = ws.parked = true;
    epoch++;
    clearTimeout(scanTimer);
    for (const item of queue) item.reject?.(fail(403, "Desktop control ended."));
    queue.length = 0;
    // Nothing stays held down on the Mac while parked.
    letGo = (async () => {
      while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
      if (!closed) await helper.send({ type: "release" }).catch(() => {});
    })();
    // Control taken back as the minute ran out: the lease is the phone's
    // again, so the end is retryable and the lease waits for its reconnect.
    parkTimer = setTimeout(
      () => close("Desktop control ended.", control.holder()?.clientId === ws.clientId),
      parkFor,
    );
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "parked" }));
  };
  // Ready again on this connection: the same helper, a new input window.
  const ready = async (initial) => {
    if (initial === undefined) {
      while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
      await letGo;
      await readyForInput();
      if (closed || ws.readyState !== 1) return;
      initial = await helper.send({ type: "heartbeat" });
      if (closed || ws.readyState !== 1) return;
      authorize();
    }
    lastId = 0;
    doneId = 0;
    lastSeen = Date.now();
    ws.send(
      JSON.stringify({
        type: "ready",
        cursor: initial.cursor,
        window: 8,
        typing: true,
        // One physical click per rapid tap, with an explicit second click.
        doubleClick: true,
        // Asks "is there a text field here?" on touch-down (probe).
        probe: true,
        // Pushes where the text fields are, ahead of the tap.
        fields: !!scanner,
      }),
    );
  };
  // Parked, the connection still answers to its device and to pause; only
  // the lease is not asked for.
  const authorize = (lease = true) => {
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
    // Windows can't yet hide password managers from guests' pictures, or a
    // concealed copy from their clipboard reads (parity audit #12, #13):
    // there only the owner and full-access people control, as they watch.
    if (privateViewRefused(!actsAsOwner(client), platform)) throw fail(403, PRIVATE_VIEW_UNAVAILABLE);
    // A phone app's hidden display is for whoever that app is shared with.
    if (ws.reachDisplay && !allowDisplay(client, ws.reachDisplay))
      throw fail(403, "That app isn't shared with you.");
    if (lease) control.check(client);
    else if (control.paused) throw fail(423, "Desktop control ended.");
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
      while (queue.length && !closed && !parked) {
        const item = queue.shift();
        const current = epoch;
        let result;
        try {
          const client = await readyForInput();
          // A touch-down's "is there a field here?" never holds up the tap
          // queued behind it: the phone falls back to its field map.
          if (
            item.action.type === "probe" &&
            queue.some((next) => ["click", "down", "up"].includes(next.action.type))
          ) {
            item.resolve?.({ ok: true, skipped: true });
            if (item.id !== undefined && !closed && ws.readyState === 1)
              ws.send(JSON.stringify({ type: "ack", id: item.id, ok: true, skipped: true }));
            continue;
          }
          // Letting go (a button up, release) always runs, however late:
          // dropped, it would leave the Mac's mouse button held down.
          if (Date.now() - item.at > 1000 && !releases.has(item.action.type)) {
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
          // A password manager's copied secret stays on the Mac for guests:
          // the helper turns it down unless the owner asked. (On Windows,
          // guests don't control at all yet: authorize.)
          result = await helper.send(
            item.action.type === "clipboard-read"
              ? { ...item.action, owner: client.scopes.includes("admin") }
              : item.action,
          );
          if (closed || ws.readyState !== 1) throw fail(403, "Desktop control ended.");
          if (current !== epoch) continue;
          authorize();
        } catch (e) {
          if (current !== epoch && !closed) continue;
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
        // A skipped probe or a dropped late move never came here.
        if (inputs.has(item.action.type)) {
          try { used(client, ws.reachDisplay); } catch { /* never costs the input */ }
        }
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
        authorize(!parked);
        if (parked) return;
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
        authorize();
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
        await ready(initial);
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
      // Control again on a parked connection (the phone asked for the lease
      // first): resumed at once, no new helper.
      if (message.type === "resume") {
        if (!helper || starting) throw fail(409, "Wait for desktop input to be ready.");
        authorize();
        clearTimeout(parkTimer);
        parked = ws.parked = false;
        starting = true;
        try {
          await ready();
        } finally {
          starting = false;
        }
        if (fields) void scan();
        return;
      }
      if (parked) {
        // Sent before the phone heard control stopped: dropped, told.
        if (message.type === "input" && Number.isSafeInteger(message.id))
          ws.send(JSON.stringify({ type: "ack", id: message.id, ok: false, error: "Desktop control is off." }));
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
      lastId = message.id;
      let action;
      try {
        action = inputAction(message.action);
      } catch (e) {
        // A bad action (text too long, an unknown key) fails alone; control stays.
        ws.send(JSON.stringify({ type: "ack", id: message.id, ok: false, error: e.message }));
        return;
      }
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
    clearTimeout(parkTimer);
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
