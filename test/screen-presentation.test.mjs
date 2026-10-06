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
