import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom,
  useScreenPresentation,
  view,
  viewer,
  state,
  native,
  entered,
  exited,
  keys,
  media,
  queries;
before(async () => {
  dom = await startDom({ mobile: false });
  ({ useScreenPresentation } = await dom.load("/src/useScreenPresentation.ts"));
  Object.defineProperty(dom.document, "fullscreenElement", {
    configurable: true,
    get: () => native,
  });
  dom.document.exitFullscreen = async () => {
    exited++;
    native = null;
    dom.document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  assert.deepEqual(dom.errors, []);
});
after(() => dom.close());
async function mount({
  coarse = false,
  narrow = false,
  reject = false,
  typing = false,
} = {}) {
  native = null;
  entered = 0;
  exited = 0;
  keys = 0;
  queries = [];
  dom.errors.length = 0;
  const listeners = new Set();
  media = {
    matches: coarse || narrow,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  };
  globalThis.matchMedia = dom.window.matchMedia = (q) => {
    queries.push(q);
    return media;
  };
  dom.window.HTMLElement.prototype.requestFullscreen = async function () {
    entered++;
    if (reject) throw Error("Embedded browser");
    native = this;
    dom.document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
  function Host() {
    const ref = dom.React.useRef(null);
    state = useScreenPresentation(ref, typing);
    return dom.React.createElement(
      "section",
      {
        ref,
        "data-mobile": state.mobile,
        "data-fullscreen": state.fullscreen,
        "data-expanded": state.expanded,
      },
      dom.React.createElement(
        "button",
        { onClick: state.toggleFullscreen },
        "Fullscreen",
      ),
      dom.React.createElement(
        "div",
        {
          tabIndex: 0,
          onKeyDown: (e) => {
            keys++;
            e.preventDefault();
          },
        },
        "Remote screen",
      ),
    );
  }
  view = await dom.render(dom.React.createElement(Host));
  viewer = view.container.querySelector("section");
  return {
    change: async (matches) => {
      media.matches = matches;
      listeners.forEach((fn) => fn());
      await settle();
    },
  };
}
const toggle = () => viewer.querySelector("button").click();

test("desktop fullscreen uses the browser API and toggles back to the workspace", async () => {
  await mount();
  assert.equal(state.mobile, false);
  toggle();
  await dom.waitFor(() => state.fullscreen);
  assert.equal(entered, 1);
  assert.equal(native, viewer);
  assert.equal(state.expanded, true);
  toggle();
  await dom.waitFor(() => !state.fullscreen);
  assert.equal(exited, 1);
  assert.equal(native, null);
  assert.equal(state.expanded, false);
});
test("Escape exits fullscreen before a remote surface can consume the key", async () => {
  await mount();
  toggle();
  await dom.waitFor(() => state.fullscreen);
  viewer
    .querySelector("div")
    .dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  await dom.waitFor(() => !state.fullscreen);
  assert.equal(exited, 1);
  assert.equal(keys, 0);
  assert.equal(native, null);
});
test("a denied browser fullscreen request still fills the viewport and Escape restores it", async () => {
  await mount({ reject: true });
  toggle();
  await dom.waitFor(() => state.fullscreen);
  assert.equal(state.expanded, true);
  assert.equal(native, null);
  assert.equal(
    viewer.style.getPropertyValue("--screen-height"),
    `${dom.window.innerHeight}px`,
  );
  viewer
    .querySelector("div")
    .dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  await dom.waitFor(() => !state.expanded);
  assert.equal(viewer.style.getPropertyValue("--screen-height"), "");
});
test("phone typing fits the visible keyboard viewport without native fullscreen", async () => {
  const viewport = new dom.window.EventTarget();
  Object.assign(viewport, {
    height: 310,
    width: 390,
    offsetTop: 0,
    offsetLeft: 0,
  });
  Object.defineProperty(dom.window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  await mount({ coarse: true, typing: true });
  assert.equal(state.mobile, true);
  assert.equal(state.expanded, true);
  assert.equal(entered, 0);
  assert.equal(viewer.style.getPropertyValue("--screen-height"), "310px");
  assert.equal(viewer.dataset.compactViewport, "true");
  viewport.height = 540;
  viewport.dispatchEvent(new dom.window.Event("resize"));
  await dom.waitFor(
    () => viewer.style.getPropertyValue("--screen-height") === "540px",
  );
  assert.equal(viewer.dataset.compactViewport, "false");
});
test("responsive layout follows primary input and viewport changes, not an optional touchscreen", async () => {
  const { change } = await mount();
  assert.equal(state.mobile, false);
  assert.ok(queries.every((q) => !q.includes("any-pointer")));
  await change(true);
  assert.equal(state.mobile, true);
  await change(false);
  assert.equal(state.mobile, false);
});

// A phone turned on its side opens the screen fullscreen; turning it back
// closes only what the turn opened.
function orientation(type) {
  const target = new dom.window.EventTarget();
  target.type = type;
  Object.defineProperty(dom.window.screen, "orientation", {
    configurable: true,
    value: target,
  });
  Object.defineProperty(dom.window.screen, "width", { configurable: true, value: 390 });
  Object.defineProperty(dom.window.screen, "height", { configurable: true, value: 844 });
  return async (next) => {
    target.type = next;
    target.dispatchEvent(new dom.window.Event("change"));
    await settle();
  };
}
test("turning a phone sideways opens fullscreen and turning it back closes it", async () => {
  const turn = orientation("portrait-primary");
  try {
    await mount({ coarse: true });
    assert.equal(state.fullscreen, false);
    await turn("landscape-primary");
    await dom.waitFor(() => state.fullscreen);
    assert.equal(state.landscape, true);
    // In-page fullscreen: no tap means the browser's own would be refused.
    assert.equal(entered, 0);
    await turn("portrait-primary");
    await dom.waitFor(() => !state.fullscreen);
  } finally {
    delete dom.window.screen.orientation;
  }
});
test("fullscreen closed by hand while sideways stays closed until the next turn", async () => {
  const turn = orientation("landscape-primary");
  try {
    await mount({ coarse: true });
    // Already sideways when the screen opens.
    await dom.waitFor(() => state.fullscreen);
    toggle();
    await dom.waitFor(() => !state.fullscreen);
    await turn("landscape-secondary");
    assert.equal(state.fullscreen, false);
    await turn("portrait-primary");
    await turn("landscape-primary");
    await dom.waitFor(() => state.fullscreen);
  } finally {
    delete dom.window.screen.orientation;
  }
});
test("fullscreen opened by hand survives turning the phone back upright", async () => {
  const turn = orientation("portrait-primary");
  try {
    await mount({ coarse: true });
    toggle();
    await dom.waitFor(() => state.fullscreen);
    await turn("landscape-primary");
    await turn("portrait-primary");
    assert.equal(state.fullscreen, true);
  } finally {
    delete dom.window.screen.orientation;
  }
});
test("tablets and desktops keep their layout when turned", async () => {
  const turn = orientation("portrait-primary");
  Object.defineProperty(dom.window.screen, "width", { configurable: true, value: 820 });
  Object.defineProperty(dom.window.screen, "height", { configurable: true, value: 1180 });
  try {
    await mount({ coarse: true });
    await turn("landscape-primary");
    assert.equal(state.landscape, false);
    assert.equal(state.fullscreen, false);
  } finally {
    delete dom.window.screen.orientation;
  }
});

// Fullscreen as a video plays it: Android's browser can hide its own bars,
// from a tap; iPhone and iPad keep the in-page one (their keyboards).
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
async function asPhone(userAgent, run) {
  const nav = dom.window.navigator;
  const saved = Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { configurable: true, get: () => userAgent });
  Object.defineProperty(dom.document, "fullscreenEnabled", { configurable: true, get: () => true });
  try {
    await run();
  } finally {
    if (saved) Object.defineProperty(nav, "userAgent", saved);
    else delete nav.userAgent;
    delete dom.document.fullscreenEnabled;
  }
}
test("Android: the fullscreen button hides the browser's bars too; tapped again, both go", async () => {
  await asPhone(ANDROID, async () => {
    await mount({ coarse: true });
    toggle();
    await dom.waitFor(() => state.fullscreen && native === viewer);
    assert.equal(entered, 1, "the browser's own fullscreen, from the tap");
    toggle();
    await dom.waitFor(() => !state.fullscreen);
    assert.equal(exited, 1);
  });
});
test("Android turned sideways: in-page at once, and one tap on the button hides the browser's bars", async () => {
  const turn = orientation("portrait-primary");
  try {
    await asPhone(ANDROID, async () => {
      await mount({ coarse: true });
      await turn("landscape-primary");
      await dom.waitFor(() => state.fullscreen);
      assert.equal(entered, 0, "turning is no tap: nothing asked of the browser");
      assert.equal(state.nativeOffer, true, "the button stays to hide the bars");
      toggle();
      await dom.waitFor(() => native === viewer);
      assert.equal(state.fullscreen, true);
      assert.equal(state.nativeOffer, false);
    });
  } finally {
    delete dom.window.screen.orientation;
  }
});
test("Android refusing its fullscreen: the button stops offering it and still closes", async () => {
  const turn = orientation("landscape-primary");
  try {
    await asPhone(ANDROID, async () => {
      await mount({ coarse: true, reject: true });
      await dom.waitFor(() => state.fullscreen);
      toggle();
      await dom.waitFor(() => !state.nativeOffer);
      assert.equal(state.fullscreen, true, "the in-page fullscreen stays");
      toggle();
      await dom.waitFor(() => !state.fullscreen);
    });
  } finally {
    delete dom.window.screen.orientation;
  }
});
test("iPhone: fullscreen stays in-page, so the keyboard keeps working with it", async () => {
  await asPhone(IPHONE, async () => {
    await mount({ coarse: true });
    toggle();
    await dom.waitFor(() => state.fullscreen);
    assert.equal(entered, 0);
    assert.equal(state.nativeOffer, false);
  });
});
