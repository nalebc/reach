import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { terminalPrompts } from "../scripts/prompts.mjs";
const choices = [
  {
    value: "default",
    label: "Documents",
    recommended: true,
    description: "Share this folder",
  },
  { value: "custom", label: "Choose another folder" },
  { value: "cancel", label: "Cancel setup" },
];
const tick = () => new Promise((resolve) => setImmediate(resolve));
function streams() {
  const input = new PassThrough(),
    output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = (value) => {
    input.isRaw = value;
  };
  output.columns = 90;
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  return { input, output, text: () => text };
}
async function rendered(s) {
  for (let i = 0; i < 50 && !s.text().includes("Recommended"); i++)
    await tick();
  assert.match(s.text(), /Recommended/);
}

test("arrow menu shows recommended choice and waits for Enter before selecting", async () => {
  const s = streams(),
    ui = terminalPrompts({ ...s, env: { TERM: "xterm" } });
  const answer = ui.select({ message: "Choose folder", choices });
  await rendered(s);
  assert.equal(s.input.isRaw, true);
  s.input.write("\u001b[B");
  s.input.write("\r");
  assert.equal(await answer, "custom");
  assert.equal(s.input.isRaw, false);
  assert.equal(s.input.listenerCount("keypress"), 0);
});

test("Ctrl+C and EOF cancel menus without accepting the highlighted choice", async () => {
  for (const end of [false, true]) {
    const s = streams(),
      ui = terminalPrompts({ ...s, env: { TERM: "xterm" } });
    const answer = ui.select({ message: "Choose folder", choices });
    const rejection = assert.rejects(answer, /Cancelled/);
    await rendered(s);
    end ? s.input.end() : s.input.write("\u0003");
    await rejection;
    assert.equal(s.input.isRaw, false);
    assert.equal(s.input.listenerCount("keypress"), 0);
  }
});

test("plain terminals and first-run without dependencies use numbered menus and reject invalid choices", async () => {
  for (const env of [{ TERM: "dumb" }, { TERM: "xterm" }]) {
    const s = streams();
    const ui = terminalPrompts({
      ...s,
      env,
      load: async () => {
        throw Object.assign(Error("not installed"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    const answer = ui.select({ message: "Choose folder", choices });
    await rendered(s);
    assert.match(s.text(), /1\. Documents \(Recommended\)/);
    assert.doesNotMatch(s.text(), /\u001b/);
    s.input.write("99\n");
    await tick();
    assert.match(s.text(), /listed numbers/);
    s.input.write("2\n");
    assert.equal(await answer, "custom");
  }
});

test("piped input never auto-selects a recommended permission", async () => {
  const s = streams();
  s.input.isTTY = false;
  const ui = terminalPrompts(s);
  await assert.rejects(
    ui.select({ message: "Account", choices }),
    /interactive terminal/,
  );
  assert.equal(s.text(), "");
});

test("the menu library installed during setup is used from the next menu on", async () => {
  const s = streams();
  let installed = false;
  let loads = 0;
  const ui = terminalPrompts({
    ...s,
    env: { TERM: "xterm" },
    load: async () => {
      loads++;
      if (!installed)
        throw Object.assign(Error("not installed"), { code: "ERR_MODULE_NOT_FOUND" });
      return import("prompts");
    },
  });
  const first = ui.select({ message: "Choose folder", choices });
  await rendered(s);
  assert.match(s.text(), /1\. Documents \(Recommended\)/, "numbered while installing");
  s.input.write("1\n");
  assert.equal(await first, "default");
  installed = true;
  const second = ui.select({ message: "Choose folder", choices });
  for (let i = 0; i < 50 && !s.input.isRaw; i++) await tick();
  assert.equal(s.input.isRaw, true, "the arrow menu, once installed");
  s.input.write("\r");
  assert.equal(await second, "default");
  assert.equal(loads, 2);
});
