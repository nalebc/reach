import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

// A long press on a chat row, a tab or a title selected text across the list
// on the iPhone (Oct 6). In a native app the chrome isn't text; what's there
// to read or copy (messages, code, commands, fields) still is.
const css = fs
  .readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
  .replace(/@import[^;]*;/g, "");

const page = () => {
  const dom = new JSDOM(
    `<style>${css}</style><body>
      <nav><button class="tab">Chat</button></nav>
      <div class="chat-row"><strong>Fix chat list</strong><span>Working</span></div>
      <div class="md"><p>A reply to <a href="https://example.com">copy</a></p></div>
      <div class="as-user">A message from the phone</div>
      <pre class="as-prompt-command">npm test</pre>
      <p>Run <code>npm test</code></p>
      <textarea aria-label="Reply"></textarea>
      <input type="text">
      <div contenteditable="true"></div>
    </body>`,
  );
  const { document } = dom.window;
  const select = (q) => dom.window.getComputedStyle(document.querySelector(q)).getPropertyValue("user-select");
  return { select, close: () => dom.window.close() };
};

test("a long press on the app's chrome selects nothing, as in a native app", () => {
  const { select, close } = page();
  assert.equal(select("body"), "none");
  // No "Copy / Look Up" bubble on a long press either (jsdom doesn't know
  // -webkit-touch-callout, so it's read from the rule itself).
  assert.match(css, /\nbody \{[^}]*-webkit-touch-callout: none;/);
  // Rows, tabs and titles have no rule of their own: they take the page's.
  for (const q of [".tab", ".chat-row", ".chat-row strong"]) assert.notEqual(select(q), "text", q);
  close();
});

test("what's there to read or copy stays selectable: messages, code, commands and fields", () => {
  const { select, close } = page();
  for (const q of [".md", ".as-user", "pre", "code", "textarea", "input", "[contenteditable]"])
    assert.equal(select(q), "text", q);
  // A link in a reply still opens its menu on a long press.
  assert.match(css, /\.md,[^{]*\{[^}]*-webkit-touch-callout: default;/);
  close();
});
