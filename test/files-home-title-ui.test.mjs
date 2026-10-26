import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Oct 25: Files opened on a big "Home ▾" while the tab bar below had its own
// Home tab: two "Home"s on one screen. The computer still names the root
// "Home" (the new-chat folder picker finds it by that name); the phone shows
// it as Finder and File Explorer do, by the account folder's own name beside
// a house. One rule on a Mac and on a PC.
let dom, Files, rootLabel;
before(async () => {
  dom = await startDom({
    routes: {
      "/api/files": () => ({
        items: [
          {
            name: "Projects",
            path: "Projects",
            type: "directory",
            size: 0,
            modified: "2026-10-07T00:00:00Z",
          },
        ],
      }),
      "/api/files/icons": () => ({ icons: {} }),
    },
  });
  ({ default: Files } = await dom.load("/src/Files.tsx"));
  ({ rootLabel } = await dom.load("/src/file-root-label.ts"));
});
after(() => dom?.close());

let sequence = 0;
async function show(platform, roots, initialLocation) {
  const peer = {
    id: "files",
    name: "Studio",
    url: "https://files.test",
    token: `home-title-${++sequence}`,
  };
  const view = await dom.render(
    dom.React.createElement(Files, {
      peer,
      peers: [peer],
      device: { name: peer.name, platform, roots, capabilities: { files: true } },
      initialLocation,
      onSession() {},
      toast() {},
    }),
  );
  await dom.waitFor(() => view.container.querySelector(".file-main"));
  return view;
}

const hosts = [
  {
    platform: "darwin",
    roots: [
      { id: 0, name: "Home", path: "/Users/sam" },
      { id: 1, name: "Computer", path: "/" },
    ],
  },
  {
    platform: "win32",
    roots: [
      { id: 0, name: "Home", path: "C:\\Users\\sam" },
      { id: 1, name: "Drive C:\\", path: "C:\\" },
    ],
  },
];

for (const { platform, roots } of hosts)
  test(`Files names the home folder by its own name with a house, never "Home" (${platform})`, async () => {
    const view = await show(platform, roots);
    const title = view.container.querySelector(".files-title h1");
    assert.equal(title.textContent.trim(), "sam");
    assert.ok(title.querySelector("svg.files-title-icon"), "a house beside the name");
    assert.doesNotMatch(
      view.container.querySelector(".files-header").textContent,
      /\bHome\b/,
      "no second Home beside the tab bar's",
    );
    // The locations switch: the same name and the house; the drive as before.
    dom.update(() => view.container.querySelector("button.files-title.is-switch").click());
    const chips = [...view.container.querySelectorAll('[aria-label="Locations"] button')];
    assert.deepEqual(
      chips.map((b) => b.textContent.trim()),
      ["sam", roots[1].name],
    );
    assert.ok(chips[0].querySelector("svg.lucide-house"), "the home chip's house");
    assert.ok(!chips[1].querySelector("svg.lucide-house"), "the drive keeps its folder");
    await view.unmount();
  });

for (const { platform, roots } of hosts)
  test(`inside a folder, the path back reads the home folder's name, and only the root has the house (${platform})`, async () => {
    const view = await show(platform, roots, { root: 0, dir: "Projects" });
    const title = view.container.querySelector("h1.files-title");
    assert.equal(title.textContent.trim(), "Projects");
    assert.ok(!title.querySelector("svg.files-title-icon"), "no house on a subfolder");
    const crumbs = [...view.container.querySelectorAll(".files-crumbs button")];
    assert.deepEqual(crumbs.map((b) => b.textContent.trim()), ["sam"]);
    assert.ok(view.container.querySelector('[aria-label="Back to sam"]'));
    await view.unmount();
  });

test("the home folder's name: either separator, a trailing one, and the fallbacks", () => {
  const home = (path) => rootLabel({ name: "Home", path });
  assert.equal(home("/Users/sam"), "sam");
  assert.equal(home("/Users/sam/"), "sam");
  assert.equal(home("C:\\Users\\sam"), "sam");
  assert.equal(home("C:\\Users\\sam\\"), "sam");
  assert.equal(home("D:/Profiles/Jean Dupont"), "Jean Dupont");
  // Nothing to read, or a folder really called "Home": still not the tab's word alone.
  assert.equal(home(""), "Home folder");
  assert.equal(rootLabel({ name: "Home" }), "Home folder");
  assert.equal(home("/Volumes/Backup/Home"), "Home folder");
  // Every other root keeps the computer's name for it.
  assert.equal(rootLabel({ name: "Computer", path: "/" }), "Computer");
  assert.equal(rootLabel({ name: "Drive C:\\", path: "C:\\" }), "Drive C:\\");
  assert.equal(rootLabel({ name: "", path: "/x" }), "Shared folder");
  assert.equal(rootLabel(undefined), "Shared folder");
});
