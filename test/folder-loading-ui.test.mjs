import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const device = { name: "Mac", roots: [{ id: 0, name: "Home", path: "/Users/me" }] };
let dom, FolderPicker, FolderBrowser, finish, view, deviceReply;
before(async () => {
  dom = await startDom({ routes: {
    "/api/device": () => deviceReply ? deviceReply() : device,
    "/api/files": (_init, url) => url.searchParams.get("path")
      ? new Promise((resolve) => { finish = resolve; })
      : { items: [{ name: "Projects", path: "Projects", type: "directory" }] },
  } });
  ({ FolderPicker, FolderBrowser } = await dom.load("/src/FolderBrowser.tsx"));
});
after(() => dom?.close());
afterEach(async () => { finish?.({ items: [] }); await view?.unmount(); finish = undefined; deviceReply = undefined; });
const open = (name) => dom.document.querySelector(`[aria-label="Open ${name}"]`);

for (const picker of [true, false]) {
  test(`${picker ? "chat folder picker" : "sharing folder browser"} hides the old directory's actions while loading`, async () => {
    view = await dom.render(dom.React.createElement(picker ? FolderPicker : FolderBrowser,
      picker ? { peer, onPick() {} } : { peer, device, picked: [], onChange() {} }));
    // The sharing browser opens in Home, not the computer's root.
    if (!picker) assert.equal(dom.document.querySelector('.fb-crumbs [aria-current="location"]')?.textContent, "Home");
    await dom.waitFor(() => open("Projects"));
    open("Projects").click();
    await dom.waitFor(() => finish);
    assert.ok(!open("Projects"), "old entries must not remain actionable under the new breadcrumb");
    if (picker) assert.equal(dom.document.querySelector(".folder-pick-use").disabled, true);
    finish(new Response(JSON.stringify({ error: "Folder unavailable" }), { status: 403 }));
    await settle();
    if (picker) assert.equal(dom.document.querySelector(".folder-pick-use").disabled, true, "a failed folder cannot be confirmed");
  });
}

test("switching computers clears the folder picker until the new computer's roots arrive", async () => {
  let changePeer, finishDevice;
  const picked = [];
  function Probe() {
    const [current, setCurrent] = dom.React.useState(peer);
    changePeer = () => dom.update(() => setCurrent({ ...peer, id: "other", url: "https://other.test" }));
    return dom.React.createElement(FolderPicker, { peer: current, onPick: (path) => picked.push(path) });
  }
  view = await dom.render(dom.React.createElement(Probe));
  await dom.waitFor(() => open("Projects"));
  deviceReply = () => new Promise((resolve) => { finishDevice = resolve; });
  changePeer();
  await settle();
  const use = () => dom.document.querySelector(".folder-pick-use");
  const disabledWhileLoading = use().disabled;
  finishDevice({ roots: [{ id: 0, name: "Home", path: "/Users/other" }] });
  await dom.waitFor(() => !use().disabled);
  use().click();
  assert.equal(disabledWhileLoading, true, "the previous computer's path cannot be selected");
  assert.deepEqual(picked, ["/Users/other"]);
});
