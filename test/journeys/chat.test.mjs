import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startComputer, phone, skip, word, windows, desktop } from "../helpers/journey.mjs";

// Chat: the phone says which agents this computer has, and offers to install
// one with its maker's own installer, said in full before it runs. Found
// Oct 12: "installed but not found" passed with stand-in detection, so the
// install itself runs for real here, from the phone: on a Windows PC
// (GitHub's runner, disposable), Claude Code's own installer in a Reach
// terminal, then found and asked to sign in. Sign-in can't finish without an
// account; the phone says what's next plainly. On a Mac the journey stops
// before installing: Claude Code there could find its owner's sign-in.
const commands = {
  win32: "irm https://claude.ai/install.ps1 | iex",
  darwin: "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash",
};
const command = commands[process.platform];

async function claudeOffered(t) {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.tap(`nav.mobile-nav button[aria-label="Chat"]`, "Chat in the bottom bar");
  // Health, as the computer has it: nothing yet (Add an agent), or the
  // apps it has, one chosen; then Claude Code, chosen in the app menu.
  const first = await page.see(
    () =>
      (document.querySelector('section[aria-label="Add an agent"]') && "add") ||
      document.querySelector("button.chat-app-current")?.getAttribute("aria-label"),
    "which agents this computer has",
    60000,
  );
  await page.shot("agents");
  if (first !== "add" && !/Claude Code selected$/.test(first)) {
    await page.tap("button.chat-app-current", "the app menu");
    await page.tap(`[role="menu"][aria-label="Choose an app"] [role="menuitemradio"][aria-label="Claude Code"]`, "Claude Code, in the app menu");
  }
  const setup = await page.see(
    () =>
      document.querySelector('section[aria-label="Add an agent"]')?.innerText ||
      document.querySelector('section[aria-label="Set up Claude Code"]')?.innerText,
    "Claude Code to add",
    60000,
  );
  if (/^Add an agent/.test(setup)) {
    assert.match(setup, new RegExp(`Install one on this ${word} to chat with it here\\.`));
    await page.tap({ selector: 'section[aria-label="Add an agent"] li', text: /^Claude Code/ }, "Claude Code's row");
    await page.tap({ selector: 'section[aria-label="Add an agent"] li button', text: "Install" }, "Install");
  } else {
    assert.match(setup, new RegExp(`Claude Code isn't installed on this ${word}\\.`));
    await page.tap({ selector: 'section[aria-label="Set up Claude Code"] button', text: `Install on ${word}` }, `Install on ${word}`);
  }
  // Its maker's installer, said in full before anything runs.
  await page.see(`Reach runs Claude Code's own installer on your ${word}:`, "what Reach will run");
  const shown = await page.see(() => document.querySelector("pre.chat-setup-command")?.innerText, "the installer's command");
  assert.equal(shown.trim(), command);
  await page.shot("installer");
  return { computer, page };
}

test(`Chat: the phone says which agents this ${word} has, and shows Claude Code's own installer before it runs`, { skip, timeout: 240000 }, async (t) => {
  const { page } = await claudeOffered(t);
  await page.tap({ selector: "div.chat-setup-actions button", text: "Cancel" }, "Cancel");
  await page.see(() => !document.querySelector("pre.chat-setup-command"), "nothing run");
});

test(
  `Chat: Claude Code installed from the phone is found on this ${word}, and the phone says it needs signing in`,
  { skip: skip || (!windows ? "on a Mac, Claude Code could find its owner's own sign-in" : !desktop && "installs from the internet on the PC (REACH_TEST_WINDOWS_DESKTOP=1)"), timeout: 600000 },
  async (t) => {
    const { page } = await claudeOffered(t);
    await page.tap({ selector: "div.chat-setup-actions button", text: "Install" }, "Install");
    await page.see(`Installing Claude Code on your ${word}`, "the install running", 30000);
    await page.shot("installing");
    // Its own installer, in a Reach terminal, until it says it's done.
    const outcome = await page.see(
      () =>
        document.querySelector(".chat-setup-problem")?.innerText ||
        (document.querySelector('section[aria-label^="Sign-ins on your"]') && "found"),
      "the install's end",
      480000,
    );
    await page.shot("installed");
    const where = [path.join(os.homedir(), ".local", "bin", "claude.exe"), path.join(os.homedir(), ".local", "bin", "claude")].filter((f) => fs.existsSync(f));
    assert.equal(outcome, "found", `Claude Code found once installed (the phone said: ${outcome}; claude is at: ${JSON.stringify(where)})`);
    // Found, not signed in: what's next, said plainly.
    const access = await page.see(() => document.querySelector('section[aria-label^="Sign-ins on your"]')?.innerText, "the sign-ins");
    assert.match(access, /Claude Code CLI\s*Not signed in/);
    await page.tap({ selector: 'section[aria-label^="Sign-ins on your"] button.sign-in-start', text: "Sign in" }, "Sign in");
    await page.see(/Open the sign-in page|Starting sign-in on your/, "sign-in started on the computer", 60000);
    const link = await page.see(() => document.querySelector("a.sign-in-open")?.href, "the sign-in page to open", 120000);
    assert.match(new URL(link).hostname, /(^|\.)(claude\.ai|anthropic\.com|claude\.com)$/, link);
    await page.see(() => document.querySelector('input[aria-label="Sign-in code"]'), "where its code goes");
    await page.shot("sign-in");
    await page.tap({ selector: "button.sign-in-cancel", text: "Cancel" }, "Cancel sign-in");
  },
);
