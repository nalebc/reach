import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom } from "./dom/harness.mjs";

// Chat's sheets (New conversation, Needs you) on a phone: they sit in the part
// of the screen the keyboard leaves visible. New chat opened its composer
// under the iPhone keyboard, the sheet pinned to the bottom of the screen.
let dom, React, ChatSheet;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: ChatSheet } = await dom.load("/src/ChatSheet.tsx"));
});
after(() => dom?.close());

test("New chat's sheet follows the keyboard, and the page underneath is left as it was", async () => {
  const { window } = dom;
  // iOS's visual viewport: the keyboard takes the bottom of the screen.
  const viewport = new window.EventTarget();
  Object.assign(viewport, { offsetTop: 0, height: 812, width: 375, offsetLeft: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => 0 });
  window.scrollTo = () => {};
  const view = await dom.render(
    React.createElement(
      ChatSheet,
      { title: "New conversation", onClose: () => {} },
      React.createElement("textarea", { "aria-label": "New chat" }),
    ),
  );
  const overlay = dom.document.querySelector(".reach-chat-overlay");
  const height = () => overlay.style.getPropertyValue("--sheet-height");
  assert.equal(height(), "812px");
  assert.equal(dom.document.activeElement, dom.document.querySelector("textarea"), "ready to type");
  // The keyboard opens: the sheet fits in what's left above it.
  viewport.height = 430;
  viewport.dispatchEvent(new window.Event("resize"));
  await dom.waitFor(() => height() === "430px");
  assert.equal(dom.document.body.style.position, "fixed", "the page underneath stays put");
  await view.unmount();
  assert.equal(dom.document.body.style.position, "");
  assert.equal(dom.document.body.style.overflow, "", "the page scrolls again after");
  assert.deepEqual(dom.errors, []);
});

// Every text field on a phone: focus shows on the field itself or the rounded
// field around it. A ring around the bare input drew a mint square inside
// Chat's round search field (and Apps and Files each switched it off alone).
test("text fields never wear the square focus ring; buttons and links keep it", () => {
  const css = fs.readFileSync(new URL("../src/identity.css", import.meta.url), "utf8");
  const ring = css.match(/([^{}]+)\{\s*outline: 2px solid var\(--lime\);\s*outline-offset: 4px;\s*\}/);
  assert.ok(ring, "the focus ring rule");
  const selectors = ring[1].split(",").map((s) => s.trim());
  assert.ok(selectors.includes("button:focus-visible") && selectors.includes("a:focus-visible"));
  assert.ok(!selectors.includes("input:focus-visible"), "not on every input");
  const fields = css.match(/input:focus,\s*input:focus-visible,\s*textarea:focus,\s*textarea:focus-visible,\s*select:focus\s*\{([^}]*)\}/);
  assert.ok(fields, "text fields' own focus rule");
  assert.match(fields[1], /outline: none/);
  assert.match(fields[1], /box-shadow: none/, "no shadow box either");
});
