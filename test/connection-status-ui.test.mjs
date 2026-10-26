import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// How the phone reaches the computer, as Settings and More say it: a dot and
// a word. Green on the Tailscale app, amber on a fallback (Tailscale in the
// browser, the public link), grey when it isn't connected. Reach picks the
// route; this only shows which one, and follows a handoff as it happens.
const app = { url: "https://mac.tail1.ts.net" };
// Funnel's names end in .ts.net too: never shown as the private route.
const publicLink = { url: "https://mac.tail1.ts.net", transport: "funnel" };
const local = { url: "http://127.0.0.1:8443" };
let dom, React, connection;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  connection = await dom.load("/src/connection.ts");
});
after(() => dom?.close());

test("each route in a word, with the dot's tone, and the fleet state first", () => {
  const { connectionStatus } = connection;
  assert.deepEqual(connectionStatus(app, "connected"), { tone: "best", label: "Tailscale app" });
  assert.deepEqual(connectionStatus(publicLink, "connected"), { tone: "fallback", label: "Public link" });
  assert.deepEqual(connectionStatus(local), { tone: "best", label: "Direct" });
  assert.deepEqual(connectionStatus(app, "disconnected"), { tone: "off", label: "Offline" });
  assert.deepEqual(connectionStatus(app, "denied"), { tone: "off", label: "No access" });
  assert.deepEqual(connectionStatus(app, "connecting"), { tone: "waiting", label: "Connecting…" });
  assert.equal(connection.connectionName(publicLink), "Public link");
  assert.equal(connection.connectionName(app.url), "Tailscale app", "a bare address still works");
});

test("private → browser fallback → private: the dot follows the page's own route without a new peer", async () => {
  const Route = () => {
    const { tone, label } = connection.useConnectionStatus(app, "connected");
    return React.createElement("span", { className: `conn-status ${tone}` }, label);
  };
  const view = await dom.render(React.createElement(Route));
  const shown = () => dom.document.querySelector(".conn-status");
  assert.equal(shown().textContent, "Tailscale app");
  assert.match(shown().className, /\bbest\b/);
  dom.document.documentElement.dataset.connection = "browser";
  await settle();
  assert.equal(shown().textContent, "Tailscale in browser");
  assert.match(shown().className, /\bfallback\b/);
  delete dom.document.documentElement.dataset.connection;
  await settle();
  assert.equal(shown().textContent, "Tailscale app");
  assert.match(shown().className, /\bbest\b/);
  await view.unmount();
});
