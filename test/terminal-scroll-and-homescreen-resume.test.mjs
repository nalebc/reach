import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

function dispatchTouch(win, target, type, points) {
  const mkList = (arr) => {
    const list = arr.map((pt, i) => ({
      identifier: pt.id ?? i,
      clientX: pt.x,
      clientY: pt.y,
      pageX: pt.x,
      pageY: pt.y,
      target,
    }));
    list.item = (index) => list[index] ?? null;
    return list;
  };
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" || type === "touchcancel" ? mkList([]) : mkList(points),
  });
  Object.defineProperty(event, "changedTouches", { value: mkList(points) });
  target.dispatchEvent(event);
  return event;
}

test("terminalTouch stops xterm document-gesture conflict, supports diagonal drags, coasts, and sends line wheel events for mouse-reporting TUIs", async () => {
  const dom = await startDom({ mobile: true });
  try {
    const { terminalTouch, writeSnapshot } = await dom.load("/src/terminal-options.ts");
    const container = dom.document.createElement("div");
    container.className = "terminal-screen";
    Object.defineProperty(container, "clientHeight", { value: 360 });
    const xterm = dom.document.createElement("div");
    xterm.className = "xterm";
    const xtermScreen = dom.document.createElement("div");
    xtermScreen.className = "xterm-screen";
    xtermScreen.getBoundingClientRect = () => ({
      left: 10,
      top: 50,
      right: 380,
      bottom: 410,
      width: 370,
      height: 360,
      x: 10,
      y: 50,
      toJSON() {},
    });
    xterm.append(xtermScreen);
    container.append(xterm);
    dom.document.body.append(container);

    // Count any touch events that leak up to document (where xterm v6's Gesture listens).
    let leakedToDocument = 0;
    const onDocTouch = () => {
      leakedToDocument++;
    };
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
      dom.document.addEventListener(name, onDocTouch);

    const scrolledLines = [];
    const wheelEvents = [];
    xterm.addEventListener("wheel", (event) => {
      wheelEvents.push({
        deltaMode: event.deltaMode,
        deltaY: event.deltaY,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    });

    const term = {
      rows: 20, // 18px per row
      modes: { mouseTrackingMode: "none" },
      buffer: {
        active: {
          type: "normal",
          viewportY: 100,
          baseY: 100,
        },
      },
      scrollLines(lines) {
        scrolledLines.push(lines);
        this.buffer.active.viewportY = Math.max(
          0,
          Math.min(this.buffer.active.baseY, this.buffer.active.viewportY + lines),
        );
      },
      scrollToBottom() {
        this.buffer.active.viewportY = this.buffer.active.baseY;
      },
      scrollToLine(line) {
        this.buffer.active.viewportY = line;
      },
      reset() {
        this.buffer.active.viewportY = 0;
        this.buffer.active.baseY = 0;
      },
      writeCallbacks: [],
      write(_text, cb) {
        this.writeCallbacks.push(cb);
      },
    };

    const cleanup = terminalTouch(container, term);

    // 1. Slightly diagonal downward thumb swipe scrolls up into history and never leaks to document.
    dispatchTouch(dom.window, xtermScreen, "touchstart", [{ x: 120, y: 200 }]);
    dispatchTouch(dom.window, xtermScreen, "touchmove", [{ x: 126, y: 208 }]); // dx=6, dy=8 -> engages!
    dispatchTouch(dom.window, xtermScreen, "touchmove", [{ x: 130, y: 250 }]);
    dispatchTouch(dom.window, xtermScreen, "touchend", [{ x: 130, y: 250 }]);

    assert.equal(leakedToDocument, 0, "touch events must not leak to xterm v6's document Gesture listener");
    assert.ok(scrolledLines.some((n) => n < 0), `expected upward scrollback lines, got ${JSON.stringify(scrolledLines)}`);

    // Allow a couple animation frames for momentum coasting, then tap to catch/stop coasting.
    await settle(40);
    let focused = 0;
    container.addEventListener("click", () => focused++);
    // Click right after drag is suppressed so dragging never accidentally opens keyboard.
    xtermScreen.click();
    assert.equal(focused, 0, "click immediately after touch scroll is suppressed");

    // 2. Normal-buffer TUI with mouseTrackingMode (e.g. Claude Code / Codex TUI) receives DOM_DELTA_LINE wheel events
    //    clamped inside .xterm-screen even if the finger drifts outside the box.
    term.modes.mouseTrackingMode = "vt200";
    wheelEvents.length = 0;
    dispatchTouch(dom.window, xtermScreen, "touchstart", [{ x: 200, y: 300 }]);
    dispatchTouch(dom.window, xtermScreen, "touchmove", [{ x: 200, y: 290 }]);
    dispatchTouch(dom.window, xtermScreen, "touchmove", [{ x: 5, y: 240 }]); // x=5 is outside left=10!
    dispatchTouch(dom.window, xtermScreen, "touchend", [{ x: 5, y: 240 }]);

    assert.ok(wheelEvents.length >= 2, `expected line wheel events for mouse-reporting TUI, got ${wheelEvents.length}`);
    assert.ok(wheelEvents.every((e) => e.deltaMode === 1 && e.deltaY === 1), "wheel events use DOM_DELTA_LINE");
    assert.ok(wheelEvents.every((e) => e.clientX >= 11 && e.clientX <= 379), "wheel coords stay clamped inside .xterm-screen");

    // 3. Back-to-back writeSnapshot calls while reading scrollback keep the reader's line instead of snapping to bottom.
    term.buffer.active.baseY = 80;
    term.buffer.active.viewportY = 25; // reading history at line 25
    writeSnapshot(term, "first snapshot");
    // Before first term.write finishes, term.reset() set viewportY=0, baseY=0!
    // A second snapshot arriving now must NOT mistake 0 >= 0 for following=true.
    writeSnapshot(term, "second snapshot");
    for (const cb of term.writeCallbacks.splice(0)) {
      term.buffer.active.baseY = 90;
      cb?.();
    }
    assert.equal(term.buffer.active.viewportY, 25, "concurrent snapshots preserve scrollback reading position");

    cleanup();
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
      dom.document.removeEventListener(name, onDocTouch);
  } finally {
    await dom.close();
  }
});

test("Home Screen resume helpers recover when visibilitychange is omitted, history is pruned, IndexedDB hangs, or Funnel boots while Tailscale wakes", async () => {
  const dom = await startDom({ url: "https://studio.example.ts.net/", mobile: true });
  dom.window.fetch = globalThis.fetch;
  try {
    // 1. onAppResume fires on pageshow/focus even when iOS standalone omits visibilitychange.
    const { onAppResume } = await dom.load("/src/page-visible.ts");
    const wakes = [];
    const stopResume = onAppResume((suspended) => wakes.push(suspended));
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true }));
    assert.deepEqual(wakes, [true], "persisted pageshow wakes listeners as suspended");
    stopResume();

    // 2. backOne never traps full-screen views when a restored Home Screen web view pruned history entries.
    const nav = await dom.load("/src/nav-history.ts");
    dom.window.history.replaceState({ reach: { page: "terminal", i: 1 } }, "");
    let fallbackCalled = 0;
    if (dom.window.history.length <= 1) {
      assert.equal(nav.backOne(() => fallbackCalled++), false, "single-entry history returns false immediately");
      assert.equal(nav.stackDepth(), 0, "base state is re-seeded cleanly");
    } else {
      dom.window.history.pushState({ reach: { page: "terminal", i: 1 } }, "");
      const origBack = dom.window.history.back;
      dom.window.history.back = () => {}; // Simulate WebKit pruned entry where popstate never fires.
      try {
        assert.equal(nav.backOne(() => fallbackCalled++), true);
        await settle(420);
        assert.equal(fallbackCalled, 1, "stalled history.back invokes onStuck fallback");
        assert.equal(nav.stackDepth(), 0);
      } finally {
        dom.window.history.back = origBack;
      }
    }

    // 3. ensureDeviceKey falls back to in-memory P-256 key when WebKit's IndexedDB hangs after suspension.
    const savedIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open() {
          // Never fires onsuccess, onerror, or onblocked (classic post-suspend WebKit hang).
          return {};
        },
      },
    });
    try {
      const transport = await dom.load("/src/device-transport.ts");
      const started = Date.now();
      const material = await transport.ensureDeviceKey();
      const elapsed = Date.now() - started;
      assert.equal(material.jwk.kty, "EC");
      assert.equal(material.jwk.crv, "P-256");
      assert.ok(elapsed < 4000, `ensureDeviceKey recovered in ${elapsed}ms despite hung IndexedDB`);
    } finally {
      if (savedIdb) Object.defineProperty(globalThis, "indexedDB", savedIdb);
      else delete globalThis.indexedDB;
    }

    // 4. createPrivateRecovery switches from cold Funnel (device === null) to native once Tailscale VPN finishes waking up.
    const { createPrivateRecovery } = await dom.load("/src/app-watch.ts");
    const { installFunnelTransport } = await dom.load("/src/tailnet-transport.ts");
    installFunnelTransport(
      {
        fetch: async () => new Response("Unauthorized", { status: 401 }),
        Socket: dom.window.WebSocket,
      },
      "funnel",
    );
    dom.document.documentElement.dataset.connection = "funnel";
    const savedPeer = {
      id: "phone-1",
      computerId: "comp-1",
      name: "Studio",
      platform: "darwin",
      url: "https://studio.example.ts.net",
      token: "NATIVE-TOKEN",
    };
    let tailscaleAwake = false;
    const handoffs = [];
    const recovery = createPrivateRecovery(
      {
        product: "Reach",
        origin: "https://studio.example.ts.net",
        home: "https://studio.example.ts.net",
        name: "Studio",
        instance: "inst-1",
        tailnet: null,
      },
      {
        current: () => null, // Funnel returned 401 because device paired on private Tailscale earlier
        selected: () => savedPeer,
        mode: () => (dom.document.documentElement.dataset.connection === "funnel" ? "funnel" : "native"),
        peers: () => [savedPeer],
        nativeFetch: async (url) => {
          if (!tailscaleAwake) throw new TypeError("Tailscale tunnel still waking");
          if (String(url).endsWith("/api/device")) {
            return Response.json({
              id: "phone-1",
              computerId: "comp-1",
              name: "Studio",
              platform: "darwin",
              access: { kind: "device", scopes: ["admin"] },
            });
          }
          return Response.json({ product: "Reach", instance: "inst-1", transport: "private" });
        },
        handoff: (change) => handoffs.push(change),
      },
    );
    await recovery.check();
    assert.equal(handoffs.length, 0, "stays waiting while Tailscale tunnel is still waking");
    tailscaleAwake = true;
    await recovery.check();
    assert.equal(handoffs.length, 1, "switches immediately to native once Tailscale wakes");
    assert.equal(handoffs[0].mode, "native");
    assert.equal(dom.document.documentElement.dataset.connection, undefined);
    recovery.stop();

    // 5. usePageVisible pauses immediately on freeze/pagehide (even when document.hidden stays false)
    //    so Screen/HomeLive stop background H.264 decoding before iOS Jetsam terminates the web view.
    const { usePageVisible } = await dom.load("/src/page-visible.ts");
    let visibleState = null;
    function VisibilityProbe() {
      visibleState = usePageVisible();
      return dom.React.createElement("span", null, String(visibleState));
    }
    const visView = await dom.render(dom.React.createElement(VisibilityProbe));
    assert.equal(visibleState, true);
    dom.update(() => dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide", { persisted: true })));
    assert.equal(visibleState, false, "pagehide pauses visibility immediately even before hidden flips");
    dom.update(() => dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true })));
    assert.equal(visibleState, true, "pageshow restores visibility immediately");
    dom.update(() => dom.document.dispatchEvent(new dom.window.Event("freeze")));
    assert.equal(visibleState, false, "freeze pauses visibility immediately");
    dom.update(() => dom.document.dispatchEvent(new dom.window.Event("resume")));
    assert.equal(visibleState, true, "resume restores visibility immediately");
    await visView.unmount();
  } finally {
    await dom.close();
  }
});
