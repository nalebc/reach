import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Reach's own update on the phone (Settings → Reach updates): the owner sees
// "Update to 0.2.0", one tap more says what happens, Update installs it.
// Someone else (or an older computer) sees the interface row as before.
const peer = { id: "mac", name: "Mac", url: "https://mac.tail1.ts.net:8443", token: "t", platform: "darwin" };
const sent = [];
let mac = { version: "0.1.0", state: "available", to: "0.2.0", command: "npm install --global --prefix '/opt/homebrew' @nalebc/reach@0.2.0" };
let dom, React, InterfaceUpdates, runtimeUpdateCommand;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/reach/update": (init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body || "{}");
          sent.push(body);
          if (body.action === "install") mac = { version: "0.1.0", state: "installing", to: body.version };
          return mac;
        }
        return mac;
      },
    },
  });
  React = dom.React;
  ({ default: InterfaceUpdates } = await dom.load("/src/InterfaceUpdates.tsx"));
  ({ runtimeUpdateCommand } = await dom.load("/src/PeopleHub.tsx"));
});
after(() => dom?.close());
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const button = (text) => $$("button").find((b) => b.textContent.trim() === text);
const value = () => dom.document.querySelector(".interface-updates .gs-value")?.textContent;
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};

test("the owner: Update to 0.2.0, what happens, then Update installs exactly it", async () => {
  const view = await dom.render(React.createElement(InterfaceUpdates, { peer, owner: true }));
  await settle();
  assert.equal(value(), "Update to 0.2.0");
  await click(dom.document.querySelector(".interface-updates"));
  assert.match(dom.document.body.textContent, /Installs 0\.2\.0 and starts Reach again\. Its terminals and live screens end; agents pick it up by themselves\./);
  await click(button("Update"));
  assert.deepEqual(sent.at(-1), { action: "install", version: "0.2.0" });
  assert.equal(value(), "Installing 0.2.0…");
  assert.equal(dom.document.querySelector(".interface-updates").disabled, true, "nothing more to tap while it installs");
  await view.unmount();
});

test("what Reach can't install into its own folder: the command to run, nothing run", async () => {
  mac = { version: "0.1.0", state: "manual", to: "0.2.0", reason: "permission", command: "npm install --global --prefix '/usr/local' @nalebc/reach@0.2.0" };
  sent.length = 0;
  const view = await dom.render(React.createElement(InterfaceUpdates, { peer, owner: true }));
  await settle();
  assert.equal(value(), "0.2.0 available");
  await click(dom.document.querySelector(".interface-updates"));
  assert.equal(dom.document.querySelector(".update-command")?.textContent, mac.command);
  assert.equal(button("Update"), undefined);
  assert.deepEqual(sent, []);
  await view.unmount();
});

test("not the owner, a checkout, or up to date: the interface row as it was", async () => {
  mac = { version: "0.1.0", state: "source" };
  let view = await dom.render(React.createElement(InterfaceUpdates, { peer, owner: true }));
  await settle();
  assert.doesNotMatch(value(), /Update to|available/);
  await view.unmount();
  mac = { version: "0.1.0", state: "available", to: "0.2.0" };
  view = await dom.render(React.createElement(InterfaceUpdates, { peer, owner: false }));
  await settle();
  assert.doesNotMatch(value(), /Update to/, "a guest never sees it");
  await view.unmount();
});

test("an agent on an older runtime: one command for its machine, with its key over the public link, that installs only the runtime named", () => {
  const sha = "cd".repeat(32);
  const check = `node -e 'const [f,h]=process.argv.slice(1);if(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex")!==h)throw Error("This is not the runtime the computer named.")' ~/.reach-agent/agent.mjs.new ${sha} && mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs`;
  assert.equal(runtimeUpdateCommand({ kind: "agent", runtime: "one-time", runtimeSha256: sha }, peer),
    `curl -fsSL -o ~/.reach-agent/agent.mjs.new https://mac.tail1.ts.net/agent-runtimes/${sha}.mjs && ${check}`);
  assert.equal(runtimeUpdateCommand({ kind: "agent", runtime: "one-time", runtimeSha256: sha, browserTransport: "funnel", browserBinding: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ab" }, peer),
    `curl -fsSL -H 'Reach-Key: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ab' -o ~/.reach-agent/agent.mjs.new https://mac.tail1.ts.net/agent-runtimes/${sha}.mjs && ${check}`);
  assert.doesNotMatch(runtimeUpdateCommand({ kind: "agent", runtimeSha256: sha, browserTransport: "funnel", browserBinding: "x'; rm -rf ~" }, peer), /rm -rf/, "only a real key goes in");
  // No hash from the computer: no command, never an unchecked download
  // (connections audit, Oct 10).
  for (const runtimeSha256 of [undefined, "", "not-a-hash", "x'; rm -rf ~"])
    assert.equal(runtimeUpdateCommand({ kind: "agent", runtime: "one-time", runtimeSha256 }, peer), "");
});
