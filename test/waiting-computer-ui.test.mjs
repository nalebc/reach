import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Another of your Reach computers, seen on your Tailscale account but not
// linked (found during M7, Oct 10: an Ubuntu Reach next to the owner's Mac).
// Tapping it in the top bar was a passing note about two terminal commands,
// and the More sheet's list of computers left it out. Now both open a sheet:
// open it at its own address, or link the two.
const peer = {
  id: "mac",
  name: "Studio",
  url: "https://studio.tail.ts.net",
  token: "t",
  platform: "darwin",
};
const ubuntu = {
  origin: "https://ubuntu-box.tail.ts.net",
  name: "ubuntu-box",
  short: "ubuntu-box",
  linked: false,
};
let dom, React, WaitingComputerSheet, ComputerMenu;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "1", logos: {} }),
      "/api/apps/icons": () => ({ icons: {} }),
    },
  });
  React = dom.React;
  ({ default: WaitingComputerSheet } = await dom.load("/src/WaitingComputer.tsx"));
  ({ default: ComputerMenu } = await dom.load("/src/ComputerMenu.tsx"));
  dom.window.HTMLDialogElement.prototype.showModal ??= function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close ??= function () {
    this.open = false;
  };
});
after(async () => dom?.close());

test("an unlinked computer opens at its own address, and says how to link the two", async () => {
  let closed = 0;
  const view = await dom.render(
    React.createElement(WaitingComputerSheet, {
      computer: ubuntu,
      here: peer,
      onClose: () => closed++,
    }),
  );
  await settle();
  const doc = dom.window.document;
  const sheet = doc.querySelector(".waiting-computer");
  assert.ok(sheet, "a sheet, not a passing note");
  assert.match(sheet.textContent, /Not linked to Studio yet/);
  const open = sheet.querySelector("a.waiting-computer-open");
  assert.equal(open.textContent.trim(), "Open ubuntu-box");
  assert.equal(open.getAttribute("href"), "https://ubuntu-box.tail.ts.net");
  assert.equal(open.getAttribute("rel"), "noopener noreferrer");
  // Each computer's own command, under its name.
  const rows = [...sheet.querySelectorAll(".waiting-computer-link dt")].map((dt) => [
    dt.textContent,
    dt.nextElementSibling.textContent,
  ]);
  assert.deepEqual(rows, [
    ["Studio", "link ubuntu-box"],
    ["ubuntu-box", "link studio"],
  ]);
  sheet.querySelector(".chat-sheet-close").click();
  await settle();
  assert.equal(closed, 1);
  await view.unmount();
});

test("a linked computer still joining: open it, no link steps", async () => {
  const view = await dom.render(
    React.createElement(WaitingComputerSheet, {
      computer: { ...ubuntu, linked: true },
      here: peer,
      onClose: () => {},
    }),
  );
  await settle();
  const sheet = dom.window.document.querySelector(".waiting-computer");
  assert.match(sheet.textContent, /Linked\. Joins Studio's list when it answers/);
  assert.ok(sheet.querySelector("a.waiting-computer-open"));
  assert.equal(sheet.querySelector(".waiting-computer-link"), null);
  await view.unmount();
});

test("The computer picker lists an unlinked computer among yours, and tapping it opens its sheet", async () => {
  const calls = [];
  const view = await dom.render(
    React.createElement(ComputerMenu, {
      peers: [peer],
      active: "mac",
      connections: { mac: { state: "connected" } },
      waiting: [ubuntu],
      onWaiting: (c) => calls.push(["waiting", c.name]),
      onChoose: (id) => calls.push(["choose", id]),
      onAdd: () => calls.push(["add"]),
      onClose: () => {},
    }),
  );
  const root = view.container;
  await settle();
  const labels = [...root.querySelectorAll(".computer-menu-list .computer-menu-row strong")].map((e) => e.textContent);
  assert.deepEqual(labels, ["Studio", "ubuntu-box"]);
  const row = root.querySelector(".computer-menu-waiting");
  assert.equal(row.querySelector("small").textContent, "Not linked");
  row.click();
  await settle();
  assert.deepEqual(calls, [["waiting", "ubuntu-box"]]);
  await view.unmount();
});
