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
