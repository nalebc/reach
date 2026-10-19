import test from "node:test";
import assert from "node:assert/strict";
import { startComputer, phone, skip, word, needsDesktop, macInUse, desktopTurn, marker, lines, computerTerminal } from "../helpers/journey.mjs";

// Terminals: a terminal opened from the phone runs on the computer in its
// owner's own shell and answers what's typed; and the computer's own
// terminal windows (Terminal on a Mac; console windows and Windows
// Terminal tabs on a PC) are listed on the phone, read, typed into and
// closed from it. Found Oct 12: a terminal opened from the phone never
// appeared on a tester's laptop, which stand-ins had let pass.
const screenText = () => document.querySelector(".terminal-screen .xterm-rows")?.innerText || "";

// CDP carries the clipboard text and expected answer as data. Keep them out
// of generated JavaScript, including the predicates that inspect the paste.
async function terminalClipboard(page, answer) {
  const { result, exceptionDetails } = await page.tab.send("Runtime.evaluate", { expression: "globalThis" });
  assert.equal(exceptionDetails, undefined, "the phone's execution context is available");
  assert.ok(result.objectId, "the phone's global object is available");
  try {
    const written = await page.tab.send("Runtime.callFunctionOn", {
      objectId: result.objectId,
      functionDeclaration: `function(command, answer) {
        this.__reachTerminalClipboard = { command, answer };
        return this.navigator.clipboard.writeText(command);
      }`,
      arguments: [{ value: `echo ${answer}` }, { value: answer }],
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(written.exceptionDetails, undefined, "the phone's clipboard write succeeded");
  } finally {
    await page.tab.send("Runtime.releaseObject", { objectId: result.objectId });
  }
}

// Only this disposable page's clipboard read is controlled: no OS clipboard
// write or phone permission is involved. WebSockets and the computer's PTYs
// stay real. Observe only synthetic input, never the auth token.
async function heldClipboard(page, stale, fresh) {
  const { result } = await page.tab.send("Runtime.evaluate", { expression: "globalThis" });
  assert.ok(result.objectId);
  try {
    const installed = await page.tab.send("Runtime.callFunctionOn", {
      objectId: result.objectId,
      functionDeclaration: `function(stale, fresh) {
        const state = this.__reachPasteTarget = { reads: 0, held: null, sessions: [], inputs: [], stale, fresh };
        Object.defineProperty(this.navigator, "clipboard", { configurable: true, value: {
          readText: () => new Promise((resolve, reject) => {
            state.reads++;
            state.held = { resolve, reject };
          }),
        } });
        // Reach's routing constructor returns a native socket with its own
        // send method, so observing the constructor's prototype misses it.
        const OriginalSocket = this.WebSocket;
        this.WebSocket = new Proxy(OriginalSocket, { construct(Socket, args) {
          const socket = Reflect.construct(Socket, args), send = socket.send.bind(socket);
          let session;
          socket.send = function(data) {
            try {
              const message = JSON.parse(data);
              if (message.type === "auth" && typeof message.sessionId === "string") {
                session = message.sessionId;
                state.sessions.push(session);
              } else if (message.type === "input" && typeof message.data === "string" && state.inputs.length < 100) {
                state.inputs.push({ session, bytes: message.data.length,
                  stale: message.data.includes(stale), fresh: message.data.includes(fresh) });
              }
            } catch {}
            return send(data);
          };
          return socket;
        } });
      }`,
      arguments: [{ value: stale }, { value: fresh }],
      returnByValue: true,
    });
    assert.equal(installed.exceptionDetails, undefined);
  } finally {
    await page.tab.send("Runtime.releaseObject", { objectId: result.objectId });
  }
}

async function finishHeldClipboard(page, text, reject = false) {
  const { result } = await page.tab.send("Runtime.evaluate", { expression: "globalThis" });
  assert.ok(result.objectId);
  try {
    const finished = await page.tab.send("Runtime.callFunctionOn", {
      objectId: result.objectId,
      functionDeclaration: `function(text, reject) {
        const state = this.__reachPasteTarget, held = state.held;
        if (!held) throw Error("No clipboard read is pending");
        state.held = null;
        if (reject) held.reject(new DOMException("Denied", "NotAllowedError"));
        else held.resolve(text);
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }`,
      arguments: [{ value: text }, { value: reject }],
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(finished.exceptionDetails, undefined);
  } finally {
    await page.tab.send("Runtime.releaseObject", { objectId: result.objectId });
  }
}

test(`Terminals: a delayed clipboard read stays with its original target on this ${word}`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  const stale = marker("wrong-terminal"), fresh = marker("current-terminal"), fence = marker("paste-fence");
  await heldClipboard(page, stale, fresh);
  await page.tap(`nav.mobile-nav button[aria-label="Terminal"]`, "Terminal in the bottom bar");
  await page.see(() => document.querySelector('[aria-label="Start a terminal"]'), "the ways to start a terminal");
  await page.tap({ selector: '[aria-label="Start a terminal"] button', text: /^Terminal$/ }, "Terminal, to start one");
  const ready = () => document.querySelector(".terminal-switch .status-dot:not(.off)")
    && (document.querySelector(".terminal-screen .xterm-rows")?.innerText || "").trim().length > 0;
  await page.see(ready, "terminal A's connected shell", 90000);
  const first = await page.evaluate("globalThis.__reachPasteTarget.sessions.at(-1)");
  assert.equal(typeof first, "string");
  await page.tap(`.terminal-key-row button[aria-label="Paste"]`, "Paste on terminal A");
  await page.see(() => globalThis.__reachPasteTarget.reads === 1, "the held clipboard read on A");
  await page.tap(`button[aria-label="New terminal"]`, "New terminal");
  await page.tap({ selector: '[role="menuitem"]', text: /^New terminal$/ }, "start terminal B");
  await page.see(() => new Set(globalThis.__reachPasteTarget.sessions).size === 2, "two real terminal sessions authenticated", 60000);
  await page.see(ready, "terminal B's connected shell", 90000);
  const second = await page.evaluate("globalThis.__reachPasteTarget.sessions.at(-1)");
  assert.equal(typeof second, "string");
  assert.notEqual(first, second, "these are distinct real terminal sessions");
  await finishHeldClipboard(page, `echo ${stale}`);
  let inputs = await page.evaluate("globalThis.__reachPasteTarget.inputs");
  assert.equal(inputs.some(input => input.stale), false, "A's stale read cannot call the real terminal socket's send");
  // The shell answering this later input is a delivery fence, not a sleep
  // that could miss an old paste still on its way through the real socket.
  await page.tap(".terminal-screen", "terminal B");
  await page.type(`echo ${fence}`);
  await page.key("Enter");
  await page.see({ js: `(${screenText})().split("\\n").map(l => l.trim()).includes(${JSON.stringify(fence)})` }, "terminal B's answer after resolving A's read", 60000);
  inputs = await page.evaluate("globalThis.__reachPasteTarget.inputs");
  assert.equal(inputs.some(input => input.stale), false, "A's paste is never sent on any real terminal socket");
  assert.equal((await page.evaluate(`(${screenText})()`)).includes(stale), false);
  await page.shot("paste-target-changed");

  await page.tap(`.terminal-key-row button[aria-label="Paste"]`, "hold another read on B");
  await page.see(() => globalThis.__reachPasteTarget.reads === 2, "the held clipboard read on B");
  for (const name of ["Terminal 1", "Terminal 2"]) {
    await page.tap("button.terminal-switch", "switch terminal");
    await page.tap({ selector: 'section[aria-label="From your phone"] button.terminal-row-main', text: name }, name);
    await page.see({ js: `document.querySelector("button.terminal-switch")?.innerText.includes(${JSON.stringify(name)})` }, `${name} selected`);
    await page.see(ready, `${name}'s reconnected shell`, 90000);
  }
  await finishHeldClipboard(page, "", true);
  assert.equal(await page.evaluate('!!document.querySelector(".terminal-paste")'), false, "B → A → B cannot reopen the old fallback");
  assert.deepEqual(page.dialogs, [], "stale paste operations never ask to run a command");
  await page.tap(".terminal-screen", "focus the current shell before pasting and pressing Enter");
  await page.tap(`.terminal-key-row button[aria-label="Paste"]`, "fresh Paste on B");
  await page.see(() => globalThis.__reachPasteTarget.reads === 3, "the new read on the current terminal");
  await finishHeldClipboard(page, `echo ${fresh}`);
  await page.see({ js: `(${screenText})().replace(/\\n/g, "").includes(${JSON.stringify(fresh)})` }, "the fresh pasted command", 30000);
  await page.key("Enter");
  await page.see({ js: `(${screenText})().split("\\n").map(l => l.trim()).includes(${JSON.stringify(fresh)})` }, "the real shell's answer to the fresh paste", 60000);
  inputs = await page.evaluate("globalThis.__reachPasteTarget.inputs");
  assert.equal(inputs.filter(input => input.fresh).length, 1, "the fresh paste is sent once");
  assert.equal(inputs.find(input => input.fresh).session, second, "only the current terminal receives the fresh paste");
  assert.equal(inputs.some(input => input.stale), false);
  await page.shot("paste-current-target");
  t.diagnostic(JSON.stringify({ actual: "Chrome, Reach server, WebSockets and two native PTY shells",
    seam: "page-local delayed clipboard readText; no OS clipboard or phone permission used",
    targetChangeDiscarded: true, roundTripRejectionDiscarded: true, freshPasteSentOnce: true,
    shellDeliveryFenceAnswered: true, inputsObserved: inputs.length }));
});

test(`Terminals: a terminal opened from the phone runs on this ${word} and answers what's typed`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.tap(`nav.mobile-nav button[aria-label="Terminal"]`, "Terminal in the bottom bar");
  await page.see(() => document.querySelector('[aria-label="Start a terminal"]'), "the ways to start a terminal");
  await page.tap(/^Terminal$/, "Terminal, to start one");
  // Its shell's prompt: the computer's own shell answered.
  await page.see(() => (document.querySelector(".terminal-screen .xterm-rows")?.innerText || "").trim().length > 0, "the shell's first words", 90000);
  await page.shot("terminal-opened");
  const echo = marker("typed");
  await page.tap(".terminal-screen", "the terminal");
  await page.type(`echo ${echo}`);
  await page.key("Enter");
  // The answer on a line of its own, under the typed line.
  await page.see({ js: `(${screenText})().split("\\n").map((l) => l.trim()).includes(${JSON.stringify(echo)})` }, "the shell's answer", 60000);
  // The typed line, where it was typed (a narrow phone wraps it).
  const shown = await page.evaluate(`(${screenText})()`);
  assert.ok(shown.replace(/\n/g, "").includes(`echo ${echo}`), shown);
  await page.shot("terminal-answered");
  // Pasted from the phone: Paste in the key row reads the phone's clipboard
  // (once the person lets the browser) and the shell gets it as typed.
  const pasted = marker("pasted");
  await page.grant(["clipboardReadWrite", "clipboardSanitizedWrite"]);
  await terminalClipboard(page, pasted);
  await page.tap(`.terminal-key-row button[aria-label="Paste"]`, "Paste");
  await page.see({ js: `(${screenText})().replace(/\\n/g, "").includes(globalThis.__reachTerminalClipboard.command)` }, "the pasted line", 30000);
  await page.key("Enter");
  await page.see({ js: `(${screenText})().split("\\n").map((l) => l.trim()).includes(globalThis.__reachTerminalClipboard.answer)` }, "the shell's answer to the pasted line", 60000);
  await page.shot("terminal-pasted");
});

test(
  `Terminals: a terminal window opened on this ${word} itself is listed on the phone, read, typed into and closed from it`,
  { skip: skip || needsDesktop || macInUse(), timeout: 240000 },
  async (t) => {
    if (!(await desktopTurn(t))) return;
    const computer = await startComputer(t);
    const page = await phone(t, computer);
    await page.skipIntro();
    const title = marker("window");
    const window = await computerTerminal(t, title);
    await page.tap(`nav.mobile-nav button[aria-label="Terminal"]`, "Terminal in the bottom bar");
    // Listed under the computer's own, by the title it was given.
    const group = `On your ${word}`;
    const row = await page.see(
      { js: `(() => { const s = document.querySelector('section[aria-label="${group}"]'); const b = s && [...s.querySelectorAll("button.terminal-row-main")].find((b) => b.innerText.includes(${JSON.stringify(title)})); return b && b.innerText; })()` },
      `the window under "${group}"`,
      60000,
    );
    assert.ok(row.includes(title));
    await page.shot("listed");
    await page.tap({ selector: `section[aria-label="${group}"] button.terminal-row-main`, text: title }, "the window's row");
    await page.see(`Type, then Enter sends the line to this`, "the window opened on the phone", 30000);
    const echo = marker("typed");
    await page.tap(".terminal-screen", "the window's text");
    await page.type(`echo ${echo}`);
    await page.key("Enter");
    // Typed into the window on the computer, its answer read back.
    await page.see({ js: `(${screenText})().split("\\n").map((l) => l.trim()).includes(${JSON.stringify(echo)})` }, "the window's answer", 60000);
    await page.shot("typed-into");
    // Pasted from the phone onto the window's line, then sent with Enter.
    const pasted = marker("pasted");
    await page.grant(["clipboardReadWrite", "clipboardSanitizedWrite"]);
    await terminalClipboard(page, pasted);
    await page.tap(`.terminal-key-row button[aria-label="Paste"]`, "Paste");
    await page.see({ js: `(${screenText})().replace(/\\n/g, "").includes(globalThis.__reachTerminalClipboard.command)` }, "the pasted line", 30000);
    await page.key("Enter");
    await page.see({ js: `(${screenText})().split("\\n").map((l) => l.trim()).includes(globalThis.__reachTerminalClipboard.answer)` }, "the window's answer to the pasted line", 60000);
    assert.equal(await window.open(), true, "still open on the computer");
    // Closed from the phone: asked first, then gone from the list and from
    // the computer.
    await page.tap(`button[aria-label="Leave terminal"]`, "Leave");
    await page.tap(`nav.mobile-nav button[aria-label="Terminal"]`, "Terminal in the bottom bar, for the list");
    await page.tap({ selector: `section[aria-label="${group}"] button.terminal-row-action`, text: new RegExp(`^Close .*${title}.* on your ${word}$`) }, "the window's Close");
    await page.see(
      { js: `!([...document.querySelectorAll('section[aria-label="${group}"] button.terminal-row-main')].some((b) => b.innerText.includes(${JSON.stringify(title)})))` },
      "the window gone from the list",
      30000,
    );
    assert.equal(page.dialogs.length, 1, `asked before closing: ${JSON.stringify(page.dialogs)}`);
    for (let end = Date.now() + 15000; (await window.open()) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 300));
    assert.equal(await window.open(), false, "closed on the computer too");
    await page.shot("closed");
  },
);
