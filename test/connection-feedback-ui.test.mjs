import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Real connection feedback with simulated connectivity.
// No Reach process, network route, credentials, or live screen is involved.
let dom, React, ConnectionStatus, OwnerConnection, MotionContext, deviceResponse;
let online = true;
before(async () => {
  dom = await startDom({
    url: "https://mac.t.ts.net/",
    fakes: { "src/owner-connection.ts": "test/dom/fakes/owner-enrollment.mjs" },
    routes: { "/api/device": () => deviceResponse?.() || {} },
  });
  React = dom.React;
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, get: () => online });
  ({ default: ConnectionStatus } = await dom.load("/src/ConnectionStatus.tsx"));
  ({ default: OwnerConnection } = await dom.load("/src/OwnerConnection.tsx"));
  ({ MotionContext } = await dom.load("/src/motion.ts"));
});
after(async () => dom?.close());
afterEach(() => {
  online = true;
  delete globalThis.__ownerSetup;
  assert.deepEqual(dom.errors, [], "feedback renders without React or DOM errors");
});

const motion = { enabled: true, reduced: true, hidden: false, toggle() {} };
const renderStatus = (props = {}, preferences = {}) => dom.render(
  React.createElement(MotionContext.Provider, { value: { ...motion, ...preferences } },
    React.createElement(ConnectionStatus, { onRetry() {}, onConnect() {}, ...props })),
);

// Only the user-facing delay uses a test clock. Module loading, animation
// frames, and harness cleanup keep their ordinary timers.
function feedbackClock() {
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 8000) return realTimeout(callback, delay, ...args);
    const handle = {};
    timers.set(handle, { at: now + delay, callback: () => callback(...args) });
    return handle;
  };
  globalThis.clearTimeout = handle => {
    if (!timers.delete(handle)) realClear(handle);
  };
  return {
    advance(ms) {
      now += ms;
      for (const [handle, timer] of timers) if (timer.at <= now) {
        timers.delete(handle);
        timer.callback();
      }
    },
    restore() {
      timers.clear();
      globalThis.setTimeout = realTimeout;
      globalThis.clearTimeout = realClear;
    },
  };
}

test("opening explains the current work and keeps the mascot decorative", async () => {
  const view = await renderStatus();
  try {
    const status = view.container.querySelector('[role="status"]');
    assert.match(status.textContent, /Connecting to your computer/);
    assert.match(status.textContent, /Your workspace will open here/);
    assert.match(status.textContent, /Connecting securely/);
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(status.getAttribute("aria-atomic"), "true");
    assert.equal(view.container.querySelector(".connection-loading-mark").getAttribute("aria-hidden"), "true");
    assert.equal(view.container.querySelector("button"), null, "ordinary loading needs no user action");
  } finally { await view.unmount(); }
});

test("a sustained wait gives useful feedback and an explicit retry after eight seconds", async () => {
  const clock = feedbackClock();
  let retries = 0, view;
  try {
    view = await renderStatus({ onRetry: () => retries++ });
    dom.update(() => clock.advance(7999));
    assert.doesNotMatch(view.container.textContent, /Still connecting/);
    assert.equal(view.container.querySelector("button"), null);
    dom.update(() => clock.advance(1));
    assert.match(view.container.querySelector('[role="status"]').textContent, /Still connecting/);
    assert.match(view.container.textContent, /computer is awake and Reach is running/);
    assert.match(view.container.textContent, /Taking longer than usual/);
    assert.doesNotMatch(view.container.textContent, /\d+%|Step \d/);
    const retry = view.container.querySelector("button");
    assert.equal(retry.textContent, "Try again");
    dom.update(() => retry.click());
    await settle();
    assert.equal(retries, 1);
    assert.match(view.container.textContent, /Connecting to your computer/);
    assert.equal(view.container.querySelector("button"), null, "a retry starts a fresh wait");
  } finally {
    await view?.unmount();
    clock.restore();
  }
});

test("going offline explains the wait, and coming online starts a fresh connection wait", async () => {
  const clock = feedbackClock();
  let view;
  try {
    view = await renderStatus();
    dom.update(() => clock.advance(7000));
    dom.update(() => {
      online = false;
      dom.window.dispatchEvent(new dom.window.Event("offline"));
    });
    assert.match(view.container.textContent, /You’re offline/);
    assert.match(view.container.textContent, /Connect this device to the internet/);
    assert.match(view.container.textContent, /Waiting for internet/);
    dom.update(() => clock.advance(8000));
    assert.equal(view.container.querySelector("button"), null, "retry cannot restore an offline device");
    dom.update(() => {
      online = true;
      dom.window.dispatchEvent(new dom.window.Event("online"));
    });
    assert.match(view.container.textContent, /Connecting to your computer/);
    assert.doesNotMatch(view.container.textContent, /Still connecting|You’re offline/);
    dom.update(() => clock.advance(8000));
    assert.match(view.container.textContent, /Still connecting/);
  } finally {
    await view?.unmount();
    clock.restore();
  }
});

test("access that needs approval offers Connect again without promising automatic retries", async () => {
  let retries = 0, connections = 0;
  const view = await renderStatus({
    error: "This browser’s saved access was revoked.", needsApproval: true,
    onRetry: () => retries++, onConnect: () => connections++,
  });
  try {
    const status = view.container.querySelector('[role="status"]');
    assert.match(status.textContent, /Approval needed/);
    assert.match(status.textContent, /approved again on your computer/);
    assert.doesNotMatch(status.textContent, /keep trying|Trying again automatically|Try again/);
    const action = view.container.querySelector("button");
    assert.equal(action.textContent, "Connect again");
    dom.update(() => action.click());
    assert.equal(connections, 1);
    assert.equal(retries, 0);
  } finally { await view.unmount(); }
});

test("network errors keep practical recovery visible and technical details collapsed", async () => {
  let retries = 0;
  const view = await renderStatus({ error: "Fixture network request timed out.", onRetry: () => retries++ });
  try {
    const status = view.container.querySelector('[role="status"]');
    assert.match(status.textContent, /Your computer is out of reach/);
    assert.match(status.textContent, /Trying again automatically/);
    assert.doesNotMatch(status.textContent, /Fixture network/);
    const details = view.container.querySelector("details");
    assert.equal(details.open, false);
    assert.equal(details.querySelector("summary").textContent, "Connection details");
    assert.match(details.textContent, /Fixture network request timed out/);
    dom.update(() => view.container.querySelector("button").click());
    assert.equal(retries, 1);
  } finally { await view.unmount(); }
});

test("one loading indicator respects reduced motion, disabled animation, and hidden pages", async () => {
  for (const [preferences, playing] of [
    [{ reduced: false }, true], [{ reduced: true }, false],
    [{ enabled: false }, false], [{ reduced: false, hidden: true }, false],
  ]) {
    const view = await renderStatus({}, preferences);
    try {
      assert.equal(view.container.querySelector(".connection-state").dataset.paused === "false", playing);
      assert.match(view.container.querySelector('[role="status"]').textContent, /Connecting securely/);
    } finally { await view.unmount(); }
  }
});


test("attention states stop progress while waiting for internet, sign-in, or approval", async () => {
  for (const props of [
    { needsApproval: true, error: "Saved access needs approval." },
    { setup: { state: "signin", url: "https://login.tailscale.com/a/fixture" } },
    {},
  ]) {
    online = Object.keys(props).length > 0;
    const view = await renderStatus(props, { reduced: false });
    try {
      assert.equal(view.container.querySelector(".connection-loading-dot"), null);
    } finally { await view.unmount(); online = true; }
  }
});

const peer = { id: "mac", name: "Studio-Mac", url: "https://mac.t.ts.net/", token: "fixture" };
const device = { ...peer, ownerConnection: 1, access: { kind: "device", scopes: ["admin"] } };
function ownerFixture(state) {
  return globalThis.__ownerSetup = {
    starts: 0, stops: 0, state,
    update(next) { this.state = next; this.report?.(next); },
  };
}
const renderOwner = (props = {}) => dom.render(React.createElement(OwnerConnection, { peer, device, visible: true, ...props }));

test("standby preparation stays silent while a connected owner keeps working", async () => {
  const clock = feedbackClock();
  const fixture = ownerFixture({ state: "preparing" });
  let view;
  try {
    view = await renderOwner({ visible: false });
    assert.equal(view.container.textContent, "");
    assert.equal(fixture.starts, 1, "quiet preparation still starts enrollment");
    dom.update(() => clock.advance(8000));
    dom.update(() => fixture.update({ state: "signin", url: "" }));
    assert.equal(view.container.textContent, "", "a pending sign-in URL adds no second loading state");
    dom.update(() => fixture.update({ state: "preparing" }));
    assert.equal(view.container.querySelector(".spin, .connection-loading-dot, .connection-state"), null);
    dom.update(() => fixture.update({ state: "ready" }));
    assert.equal(view.container.textContent, "");
    assert.equal(fixture.starts, 1, "quiet updates do not restart the work");
    assert.equal(fixture.stops, 0);
  } finally { await view?.unmount(); clock.restore(); }
  assert.equal(fixture.stops, 1);
});

test("Settings retains an explicit retry for a long standby wait without another loader", async () => {
  const clock = feedbackClock();
  const fixture = ownerFixture({ state: "preparing" });
  let view;
  try {
    view = await renderOwner();
    assert.equal(view.container.textContent, "", "ordinary standby setup stays quiet");
    dom.update(() => clock.advance(8000));
    assert.match(view.container.textContent, /Browser access.*Needs attention/);
    assert.match(view.container.textContent, /Reach is connected/);
    assert.equal(view.container.querySelector(".spin,.connection-loading-dot,.connection-state"), null);
    dom.update(() => fixture.update({ state: "signin", url: "" }));
    assert.ok(view.container.querySelector("button"), "polling does not reset the long-wait recovery action");
    dom.update(() => view.container.querySelector("button").click());
    await settle();
    assert.equal(fixture.starts, 2);
    assert.equal(fixture.stops, 1);
    assert.equal(view.container.textContent, "", "an explicit retry starts a fresh quiet wait");
  } finally { await view?.unmount(); clock.restore(); }
});

test("owner setup distinguishes sign-in, errors, and completion", async () => {
  const fixture = ownerFixture({ state: "signin", url: "https://login.tailscale.com/a/fixture" });
  const view = await renderOwner();
  try {
    const summary = () => view.container.querySelector("summary")?.textContent;
    assert.match(summary(), /Browser access.*Sign-in required/);
    const signIn = view.container.querySelector("a");
    assert.equal(signIn.href, "https://login.tailscale.com/a/fixture");
    assert.equal(signIn.target, "_blank");
    assert.match(signIn.rel, /noopener/);
    dom.update(() => fixture.update({ state: "error", message: "Browser storage is unavailable." }));
    assert.match(summary(), /Browser access.*Needs attention/);
    assert.match(view.container.textContent, /Browser storage is unavailable/);
    assert.equal(view.container.querySelector("a"), null, "an obsolete sign-in action disappears on failure");
    dom.update(() => fixture.update({ state: "ready" }));
    assert.equal(view.container.querySelector("details"), null, "completed setup clears its reminder");
    assert.equal(fixture.starts, 1, "status changes do not restart enrollment");
  } finally { await view.unmount(); }
});

test("owner reconnect explains browser preparation, offers sign-in when ready, and retries its existing approval", async () => {
  const fixture = ownerFixture({ state: "preparing" });
  const active = [];
  const beginBrowser = () => {};
  const view = await renderOwner({
    device: null, reconnect: true, onActive: value => active.push(value), beginBrowser,
  });
  try {
    assert.ok(view.container.querySelector('.connection-state[aria-label="Computer connection"]'));
    assert.equal(view.container.querySelector("details.owner-connection-setup"), null, "reconnecting uses the same primary feedback as loading");
    assert.equal(view.container.querySelector("a"), null, "preparation does not advertise a sign-in URL it lacks");
    assert.equal(fixture.options.resumeOnly, true, "reconnection can only resume this owner's existing setup");
    assert.equal(typeof fixture.options.beginBrowser, "function", "the verified browser handoff remains available");
    assert.equal(active.at(-1), true);

    dom.update(() => fixture.update({ state: "signin", url: "https://login.tailscale.com/a/fixture" }));
    const signIn = view.container.querySelector('a[href="https://login.tailscale.com/a/fixture"]');
    assert.ok(signIn, "a ready sign-in becomes the primary next step");
    assert.match(signIn.textContent, /Sign in/);
    assert.equal(signIn.target, "_blank");
    assert.match(signIn.rel, /noopener/);

    dom.update(() => fixture.update({ state: "error", message: "The secure browser connection did not answer." }));
    assert.match(view.container.querySelector('[role="status"]').textContent, /Your computer is out of reach/);
    assert.equal(view.container.querySelector("a"), null, "a failed attempt never retains the previous sign-in link");
    const retry = [...view.container.querySelectorAll("button")].find(button => /Try (?:setup )?again/.test(button.textContent));
    assert.ok(retry, "a failed browser setup provides an actionable retry");
    dom.update(() => retry.click());
    await settle();
    assert.equal(fixture.starts, 2);
    assert.equal(fixture.stops, 1);
    assert.equal(fixture.options.resumeOnly, true, "retry does not turn recovery into a new enrollment");
    dom.update(() => fixture.update({ state: "ready" }));
    assert.equal(view.container.querySelector(".connection-state"), null);
    assert.equal(active.at(-1), false, "completion hands the workspace back to App");
  } finally { await view.unmount(); }
  assert.equal(active.at(-1), false, "unmount clears the active reconnect indicator");
});

test("App keeps one meaningful connection view through loading and browser sign-in, with reports behind details", async () => {
  let releaseDevice;
  const deviceReady = new Promise(resolve => { releaseDevice = resolve; });
  const appDom = dom;
  deviceResponse = async () => {
    await deviceReady;
    return Response.json({ error: "The computer did not answer." }, { status: 503 });
  };
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class { close() {} send() {} };
  const fixture = ownerFixture({ state: "preparing" });
  // Starting the subscription does not mean its state reached the DOM yet.
  fixture.deferInitial = true;
  let view;
  try {
    localStorage.setItem("reach.devices", JSON.stringify([{ ...peer, url: "https://mac.t.ts.net", platform: "darwin" }]));
    localStorage.setItem("reach.active", peer.id);
    localStorage.setItem("reach.ways", "1");
    sessionStorage.setItem("reach.arrival.v1", "seen");
    const { default: App } = await appDom.load("/src/App.tsx");
    view = await appDom.render(appDom.React.createElement(App));
    assert.deepEqual(appDom.errors, []);
    const count = () => view.container.querySelectorAll(".connection-state").length;
    const connectionPage = view.container.querySelector(".connection-state");
    assert.equal(count(), 1, view.container.textContent.slice(0, 800));
    assert.match(view.container.querySelector(".connection-state").textContent, /Connecting to your computer/);
    assert.equal(view.container.querySelector('[aria-label="Copy connection report"]'), null, "ordinary startup keeps reports out of the loading view");

    releaseDevice();
    await appDom.waitFor(() => fixture.starts === 1);
    assert.equal(view.container.querySelector(".connection-state"), connectionPage, "waiting for the first setup report keeps the same page mounted");
    fixture.initialReport();
    await appDom.waitFor(() => view.container.querySelector(".connection-state h1")?.textContent === "Connecting to your computer");
    assert.equal(view.container.querySelector(".connection-state h1").textContent, "Connecting to your computer");
    assert.equal(count(), 1, "background setup uses the existing connection page");
    assert.equal(view.container.querySelectorAll(".connection-loading-dot").length, 1);
    assert.doesNotMatch(view.container.textContent, /Preparing (?:browser|secure)|Checking your saved/);
    assert.equal(view.container.querySelector(".owner-connection-setup"), null, "reconnection does not add another setup card");
    appDom.update(() => fixture.update({ state: "signin", url: "https://login.tailscale.com/a/fixture" }));
    assert.equal(count(), 1);
    assert.equal(view.container.querySelector(".connection-state h1").textContent, "One quick sign-in");
    assert.equal(view.container.querySelector(".connection-state-actions a").href, "https://login.tailscale.com/a/fixture");

    appDom.update(() => fixture.update({ state: "error", message: "Browser setup could not finish." }));
    assert.equal(count(), 1);
    const report = view.container.querySelector('[aria-label="Copy connection report"]');
    assert.ok(report, "the retained report remains available for recovery");
    const details = report.closest("details");
    assert.ok(details);
    assert.equal(details.open, false, "reports stay out of the primary feedback until requested");
    appDom.update(() => details.querySelector("summary").click());
    assert.equal(details.open, true, "connection details can reveal the report");
    assert.equal(fixture.starts, 1, "the loading-to-setup handoff starts only one enrollment watcher");
    assert.equal(view.container.querySelector(".connection-state"), connectionPage, "every stage keeps one connection page mounted");
    assert.deepEqual(appDom.errors, []);
  } finally {
    releaseDevice();
    await view?.unmount();
    globalThis.WebSocket = socket;
    deviceResponse = undefined;
  }
});


test("changing computer or losing owner access retires stale setup reports", async () => {
  const fixture = ownerFixture({ state: "preparing" });
  let change;
  function Switch() {
    const [target, setTarget] = React.useState({ peer, device });
    change = setTarget;
    return React.createElement(OwnerConnection, { ...target, visible: true });
  }
  const view = await dom.render(React.createElement(Switch));
  try {
    const oldReport = fixture.report;
    const other = { ...peer, id: "pc", token: "other-fixture" };
    const otherDevice = { ...device, ...other };
    dom.update(() => change({ peer: other, device: otherDevice }));
    assert.equal(fixture.starts, 2);
    assert.equal(fixture.stops, 1);
    dom.update(() => oldReport({ state: "signin", url: "https://login.tailscale.com/a/obsolete" }));
    assert.equal(view.container.querySelector("a"), null, "the previous computer cannot advertise its sign-in");
    dom.update(() => fixture.update({ state: "signin", url: "https://login.tailscale.com/a/current" }));
    assert.equal(view.container.querySelector("a").href, "https://login.tailscale.com/a/current");
    const report = fixture.report;
    dom.update(() => change({ peer: other, device: { ...otherDevice, access: { kind: "guest", scopes: [] } } }));
    assert.equal(fixture.stops, 2, "losing owner access stops enrollment");
    dom.update(() => report({ state: "error", message: "Late old setup" }));
    assert.equal(view.container.textContent, "");
    assert.equal(fixture.starts, 2, "guest access never starts an owner enrollment");
  } finally { await view.unmount(); }
});
