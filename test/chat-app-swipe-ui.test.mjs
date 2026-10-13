import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = {
  id: "swipe-mac",
  name: "Mac",
  url: "https://reach.test",
  token: "t",
  platform: "darwin",
};
const claw = {
  key: "agent:main:reach-swipe",
  title: "OpenClaw plan",
  agentId: "main",
  channel: "webchat",
  writable: true,
  updatedAt: Date.now(),
  status: "idle",
};
const feed = {
  sessions: ["codex", "claude"].map((agent) => ({
    agent,
    id: agent,
    title: `${agent} plan`,
    cwd: "/work",
    updatedAt: Date.now(),
    status: "idle",
  })),
  health: ["codex", "claude", "openclaw", "gemini"].map((agent) => ({
    agent,
    // As the Mac names it (server/agent-sessions KNOWN_AGENTS).
    ...(agent === "openclaw" && { name: "OpenClaw" }),
    installed: true,
    signedIn: true,
    supported: true,
  })),
  errors: {},
  failure: "",
  macPrompts: [],
  reload() {},
  recheck() {},
};
let dom, EverythingChat, view;
before(async () => {
  dom = await startDom({
    routes: {
      "/api/sessions/logos": () => ({ version: "1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [] }),
      "/api/sessions/claude/claude": () => ({
        session: feed.sessions[1],
        items: [],
      }),
      "/api/sessions/claude/claude/live": async () => {
        await settle(60);
        return {
          version: 1,
          status: "idle",
          error: null,
          prompts: [],
          streaming: "",
          activity: null,
          items: 0,
        };
      },
      "/api/sessions/openclaw/overview": () => ({
        connected: true,
        sessions: [claw],
        approvals: [],
      }),
      "/api/sessions/openclaw/history": () => ({
        session: claw,
        items: [],
        approvals: [],
        streaming: "",
        error: "",
      }),
    },
  });
  dom.window.innerWidth = 393;
  dom.window.matchMedia = (media) => ({
    matches: !media.includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  });
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  assert.deepEqual(dom.errors, []);
});
const $ = (selector) => dom.document.querySelector(selector);
const selected = () => dom.window.localStorage.getItem("reach.chatAgent");
const idle = () => dom.waitFor(() => !$(".chat-app-pages")?.dataset.motion);
async function mount(app = "codex") {
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("reach.chatAgent", app);
  view = await dom.render(
    dom.React.createElement(EverythingChat, { peer, feed }),
  );
  await settle();
}
function touch(target, type, points, changed = points) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: points },
    changedTouches: { value: changed },
  });
  target.dispatchEvent(event);
  return event;
}
const point = (x, y = 300, identifier = 1) => ({
  clientX: x,
  clientY: y,
  identifier,
});
// The pager reads Date.now() for a release's speed (a short drag commits only
// as a flick: 64 px within 100 ms) and for the ghost click it swallows after.
// Run each event at a pinned time: the first touchmove renders the neighbor
// page synchronously, which on a loaded runner (macos-15-intel, Oct 12) took
// over 100 ms, so a quick swipe read as a slow drag and slid back.
function at(time, action) {
  const now = Date.now;
  Date.now = () => time;
  try {
    return action();
  } finally {
    Date.now = now;
  }
}
// A quick flick: lifted 50 ms after the finger landed.
function swipe(
  target = $(".chat-workspace"),
  dx = -130,
  dy = 0,
  x = 250,
  start = Date.now(),
) {
  const [, move, end] = timedDrag(
    target,
    [
      [0, x],
      [40, x + dx, 300 + dy],
      [50, x + dx, 300 + dy],
    ],
    start,
  );
  return { move, end };
}
// Give releases a realistic timeline without waiting on gesture duration.
function timedDrag(target, points, start = Date.now()) {
  return points.map(([ms, x, y = 300], index) => {
    const final = index === points.length - 1;
    return at(start + ms, () =>
      touch(
        target,
        index === 0 ? "touchstart" : final ? "touchend" : "touchmove",
        final ? [] : [point(x, y)],
        [point(x, y)],
      ),
    );
  });
}

for (const width of [320, 393, 768]) {
  test(`slow drags snap at half the ${width}px page in either direction`, async () => {
    const originalWidth = dom.window.innerWidth;
    dom.window.innerWidth = width;
    try {
      for (const direction of [-1, 1]) {
        for (const fraction of [0.49, 0.5]) {
          await mount("claude");
          const x = width * (direction < 0 ? 0.75 : 0.25);
          const end = x + direction * width * fraction;
          timedDrag($(".chat-workspace"), [
            [0, x],
            [600, end],
            [750, end],
          ]);
          await idle();
          assert.equal(
            selected(),
            fraction < 0.5 ? "claude" : direction < 0 ? "openclaw" : "codex",
          );
          await view.unmount();
          view = null;
        }
      }
    } finally {
      dom.window.innerWidth = originalWidth;
    }
  });
}

test("short flicks tolerate a stationary final frame, while pauses and reversals snap back", async () => {
  for (const [expected, points] of [
    [
      "claude",
      [
        [0, 250],
        [35, 210],
        [70, 175],
        [75, 175],
      ],
    ],
    [
      "codex",
      [
        [0, 250],
        [35, 210],
        [70, 175],
        [300, 175],
      ],
    ],
    [
      "codex",
      [
        [0, 250],
        [60, 120],
        [85, 175],
        [90, 180],
      ],
    ],
    [
      "codex",
      [
        [0, 250],
        [20, 215],
        [30, 215],
      ],
    ],
  ]) {
    await mount();
    timedDrag($(".chat-workspace"), points);
    await idle();
    assert.equal(selected(), expected);
    await view.unmount();
    view = null;
  }
});

test("vertical finger drift after the horizontal drag locks does not reject a half-page swipe", async () => {
  await mount();
  timedDrag($(".chat-workspace"), [
    [0, 290, 300],
    [50, 255, 315],
    [600, 80, 400],
    [750, 80, 400],
  ]);
  await idle();
  assert.equal(selected(), "claude");
});

test("the release position can cross halfway or reveal the app on the opposite side", async () => {
  await mount();
  timedDrag($(".chat-workspace"), [
    [0, 290],
    [600, 190],
    [1000, 80],
  ]);
  await idle();
  assert.equal(selected(), "claude");
  timedDrag($(".chat-workspace"), [
    [0, 190],
    [50, 110],
    [75, 310],
  ]);
  await idle();
  assert.equal(selected(), "codex");
});

test("page swipes follow the app menu in both directions, including OpenClaw, and stop at each end", async () => {
  await mount();
  // Every agent's chats together (All) come before the first app.
  swipe(undefined, 130, 0, 100);
  await idle();
  assert.equal(selected(), "all");
  swipe(undefined, 130, 0, 100);
  await idle();
  assert.equal(selected(), "all");
  swipe();
  await idle();
  assert.equal(selected(), "codex");
  for (const app of ["claude", "openclaw", "gemini"]) {
    const { move, end } = swipe();
    assert.equal(move.defaultPrevented, true);
    assert.equal(end.defaultPrevented, true);
    await idle();
    assert.equal(selected(), app);
  }
  swipe();
  await idle();
  assert.equal(selected(), "gemini");
  for (const app of ["openclaw", "claude", "codex", "all"]) {
    swipe(undefined, 130, 0, 100);
    await idle();
    assert.equal(selected(), app);
  }
});

test("vertical scrolling, short and diagonal drags, phone edges, and multitouch leave the provider selected", async () => {
  await mount();
  const page = $(".chat-workspace");
  assert.equal(swipe(page, -10, 130).move.defaultPrevented, false);
  swipe(page, -55);
  await idle();
  swipe(page, -130, 95);
  swipe(page, 130, 0, 8);
  swipe(page, -130, 0, 385);
  touch(page, "touchstart", [point(250), point(200, 330, 2)]);
  touch(page, "touchend", [], [point(100)]);
  touch(page, "touchstart", [point(250)]);
  touch(page, "touchmove", [point(210), point(200, 330, 2)]);
  touch(page, "touchend", [], [point(100)]);
  await idle();
  touch(page, "touchstart", [point(250)]);
  touch(page, "touchcancel", []);
  touch(page, "touchend", [], [point(100)]);
  // A vertical scroll cannot turn into provider navigation halfway through.
  touch(page, "touchstart", [point(250)]);
  touch(page, "touchmove", [point(248, 340)]);
  touch(page, "touchend", [], [point(100, 320)]);
  await settle();
  assert.equal(selected(), "codex");
});

test("swiping a chat row switches apps without also opening the row; a fresh tap still opens a chat", async () => {
  await mount();
  const card = $(".chat-card");
  const start = Date.now();
  swipe(card, -130, 0, 250, start);
  const ghost = new dom.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    detail: 1,
  });
  // The browser's synthesized click follows the release; on the same clock.
  at(start + 60, () => card.dispatchEvent(ghost));
  assert.equal(ghost.defaultPrevented, true);
  await idle();
  assert.equal(selected(), "claude");
  assert.ok(!$(".as-page"));
  const nextCard = $(".chat-card");
  touch(nextCard, "touchstart", [point(200)]);
  touch(nextCard, "touchend", [], [point(200)]);
  nextCard.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }),
  );
  await settle();
  assert.ok($(".as-page"));
});

test("app rails, fields, menus, and new-chat sheets keep their gestures", async () => {
  await mount();
  assert.equal(swipe($(".chat-app-token")).move.defaultPrevented, false);
  assert.equal(swipe($('input[type="search"]')).move.defaultPrevented, false);
  $(".chat-app-current").click();
  await settle();
  swipe();
  await settle();
  assert.equal(selected(), "codex");
  assert.ok($('[role="menu"]'));
  $(".chat-app-current").click();
  await settle();
  $('[aria-label="New chat"]').click();
  await settle();
  assert.ok($('[role="dialog"]'));
  swipe();
  await settle();
  assert.equal(selected(), "codex");
  assert.ok($('[role="dialog"]'));
});

test("an OpenClaw conversation keeps its swipes; provider swipes return after closing it", async () => {
  await mount("openclaw");
  await dom.waitFor(() => $(".claw-library .claw-chat"));
  $(".claw-library .claw-chat").click();
  await dom.waitFor(() => $(".claw-conversation"));
  swipe($(".claw-conversation"), 130, 0, 100);
  await settle();
  assert.equal(selected(), "openclaw");
  $('[aria-label="Back to OpenClaw sessions"]').click();
  await dom.waitFor(() => $(".chat-workspace"));
  swipe(undefined, 130, 0, 100);
  await idle();
  assert.equal(selected(), "claude");
});

test("the page follows the finger, reveals real adjacent chats, and promotes the same preview only after settling", async () => {
  await mount();
  const page = $(".chat-workspace");
  // A 130 px release commits only as a flick: keep the finger on the pinned
  // clock while the checks between move and release take real time.
  const start = Date.now();
  at(start, () => touch(page, "touchstart", [point(250)]));
  at(start + 40, () => touch(page, "touchmove", [point(170)]));
  await settle();
  const pager = $(".chat-app-pages");
  const next = $(".chat-page-pane.neighbor");
  assert.equal(pager.dataset.motion, "dragging");
  assert.equal(pager.style.getPropertyValue("--chat-page-x"), "-80px");
  assert.equal(next.dataset.app, "claude");
  assert.equal(next.getAttribute("aria-hidden"), "true");
  assert.ok(next.hasAttribute("inert"));
  assert.equal(
    next.querySelector(".chat-card strong").textContent,
    "claude plan",
  );
  assert.equal(selected(), "codex");
  at(start + 50, () => touch(page, "touchend", [], [point(120)]));
  assert.equal(pager.dataset.motion, "settling");
  assert.equal(pager.style.getPropertyValue("--chat-page-x"), "-393px");
  assert.equal(
    selected(),
    "codex",
    "release does not replace the visible page instantly",
  );
  await idle();
  assert.equal(selected(), "claude");
  assert.equal(
    $(".chat-page-pane.current"),
    next,
    "loaded preview is preserved when it becomes active",
  );
  assert.ok(!next.hasAttribute("inert"));
  assert.equal($(".chat-page-pane.neighbor"), null);
});

test("a partial drag and a cancellation slide back, with resistance at the first and last app", async () => {
  // The first page: every agent's chats together (All).
  await mount("all");
  const page = $(".chat-workspace");
  touch(page, "touchstart", [point(250)]);
  touch(page, "touchmove", [point(220)]);
  await settle();
  assert.ok($(".chat-page-pane.neighbor"));
  touch(page, "touchend", [], [point(220)]);
  assert.equal($(".chat-app-pages").dataset.motion, "settling");
  assert.equal(
    $(".chat-app-pages").style.getPropertyValue("--chat-page-x"),
    "0px",
  );
  await idle();
  assert.equal(selected(), "all");
  touch(page, "touchstart", [point(100)]);
  touch(page, "touchmove", [point(230)]);
  await settle();
  assert.ok(
    Number.parseFloat(
      $(".chat-app-pages").style.getPropertyValue("--chat-page-x"),
    ) < 32,
  );
  assert.equal($(".chat-page-pane.neighbor"), null);
  touch(page, "touchcancel", []);
  await idle();
  assert.equal(selected(), "all");
});

test("reversing a drag reveals the app on the new side; slow deliberate drags still complete", async () => {
  await mount("claude");
  const page = $(".chat-workspace");
  touch(page, "touchstart", [point(180)]);
  touch(page, "touchmove", [point(100)]);
  await settle();
  assert.equal($(".chat-page-pane.neighbor").dataset.app, "openclaw");
  touch(page, "touchmove", [point(380)]);
  await settle();
  assert.equal($(".chat-page-pane.neighbor").dataset.app, "codex");
  assert.equal($(".chat-page-pane.neighbor .claw-library"), null);
  await settle(850);
  touch(page, "touchend", [], [point(380)]);
  await idle();
  assert.equal(selected(), "codex");
});

test("an external app change or unmount cancels a pending slide rather than navigating later", async () => {
  await mount();
  swipe();
  $(".chat-app-current").click();
  await settle();
  $('.chat-mobile-app-menu [aria-label="OpenClaw"]').click();
  await settle(360);
  assert.equal(selected(), "openclaw");
  assert.equal($(".chat-page-pane.neighbor"), null);
  swipe(undefined, 130, 0, 100);
  await view.unmount();
  view = null;
  await settle(360);
  assert.equal(selected(), "openclaw");
});

test("reduced motion retains direct finger tracking and settles without an animated release", async () => {
  await mount();
  const media = dom.window.matchMedia;
  dom.window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  try {
    const page = $(".chat-workspace");
    // Past halfway, so it commits however long the release takes: a short
    // drag counts as a flick only when lifted within 100 ms, which a slow
    // runner missed.
    touch(page, "touchstart", [point(250)]);
    touch(page, "touchmove", [point(40)]);
    await settle();
    assert.equal(
      $(".chat-app-pages").style.getPropertyValue("--chat-page-x"),
      "-210px",
    );
    touch(page, "touchend", [], [point(40)]);
    assert.equal(selected(), "claude");
    assert.equal($(".chat-app-pages").dataset.motion, undefined);
  } finally {
    dom.window.matchMedia = media;
  }
});

test("a browser ending its touch pointer stream leaves the non-passive touch swipe in control", async () => {
  await mount();
  const page = $(".chat-workspace");
  touch(page, "touchstart", [point(250)]);
  // Cross halfway so this checks pointer cancellation, independently of
  // whether a loaded runner releases within the short-flick deadline.
  touch(page, "touchmove", [point(40)]);
  const canceledPointer = new dom.window.Event("pointercancel", {
    bubbles: true,
  });
  Object.defineProperty(canceledPointer, "pointerType", { value: "touch" });
  page.dispatchEvent(canceledPointer);
  await settle();
  assert.equal($(".chat-app-pages").dataset.motion, "dragging");
  touch(page, "touchend", [], [point(40)]);
  await idle();
  assert.equal(selected(), "claude");
});
