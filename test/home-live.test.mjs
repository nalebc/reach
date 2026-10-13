import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
import { terminalPreview } from "../server/terminal.mjs";
import { streamOptions } from "../server/desktop-protocol.mjs";

const source = await fs.readFile(
  new URL("../src/terminal-preview.ts", import.meta.url),
  "utf8",
);
const outputText = transpile(source);
const client = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const samples = {
  shell:
    "Last login\r\n\x1b[1m\x1b[7m%\x1b[27m\x1b[0m        \r \r\x1b]2;me@mac:~\x07" +
    "\x1b[32mme@mac\x1b[0m app % npm test\r\n\x1b[32m✓\x1b[0m 41 passed\r\n" +
    "progress 10%\rprogress 100%\r\nme@mac app % ",
  fullScreen: "ls\r\n\x1b[?1049h\x1b[2J› Working (12s)",
  afterFullScreen: "x\x1b[?1049hdrawn ui\x1b[?1049lback in the shell\r\nme@mac app % ",
  empty: "",
};

test("Home previews show the shell's last lines as plain text", () => {
  assert.deepEqual(terminalPreview(samples.shell), [
    "progress 100%",
    "me@mac app %",
  ]);
  // Full-screen programs redraw with cursor moves: no garbled preview.
  assert.equal(terminalPreview(samples.fullScreen), null);
  assert.deepEqual(terminalPreview(samples.afterFullScreen), [
    "back in the shell",
    "me@mac app %",
  ]);
  assert.deepEqual(terminalPreview(samples.empty), []);
});

test("the app and the server compute the same preview", () => {
  for (const [name, text] of Object.entries(samples))
    assert.deepEqual(client.terminalPreview(text), terminalPreview(text), name);
});

test("Home's live screen asks for the preview stream, which the server accepts", async () => {
  assert.equal(streamOptions({ quality: "preview", format: "h264" }).width, 960);
  const home = await fs.readFile(new URL("../src/HomeLive.tsx", import.meta.url), "utf8");
  assert.match(home, /"preview",/);
});
