import test from "node:test";
import assert from "node:assert/strict";
import { startComputer, phone, skip, word } from "../helpers/journey.mjs";

// Agents & people and invites: inviting an agent or a person offers what
// this computer can do, and says why for what it can't (the owner, Oct 13:
// detect, never a switch, and say why). Nothing is ever sent: no invite is
// made, so no link or code ends up in a screenshot.
const reasons = () => [...document.querySelectorAll(".ag-quiet, .ivt-quiet, .ivt-warn, .ag-error, .ivt-note, [role=note]")].map((p) => p.innerText.trim()).filter(Boolean);
const choices = (label) => `[...document.querySelectorAll('[role="radiogroup"][aria-label="${label}"] [role="radio"]')].map((b) => ({ name: b.getAttribute("aria-label"), off: b.disabled }))`;

test(`Agents & people: inviting an agent or a person offers what this ${word} can do, and says why for what it can't`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.tap(`button[aria-label="Invite an agent or someone"]`, "Invite, on Home");
  await page.see("Claude, Codex, ChatGPT or any AI", "who to invite: an agent or a person");
  await page.shot("who");
  // An agent: how it connects, and what it may do.
  await page.tap({ selector: "button.inv-who-row", text: /^An agent/ }, "An agent");
  const presets = await page.see({ js: `(() => { const c = ${choices("Access preset")}; return c.length === 4 && c; })()` }, "what an agent may do", 30000);
  assert.deepEqual(presets.map((p) => p.name), ["Full control", "Apps", "Files", "Read only"]);
  const ways = await page.see({ js: `(() => { const c = ${choices("How the agent connects")}; return c.length && c; })()` }, "how an agent connects");
  assert.ok(ways.length >= 2, JSON.stringify(ways));
  const off = presets.filter((p) => p.off).map((p) => p.name);
  const said = await page.evaluate(`(${reasons})()`);
  await page.shot("agent");
  if (off.length) assert.ok(said.length > 0, `${off.join(", ")} not offered here, and the sheet says why: ${JSON.stringify(said)}`);
  t.diagnostic(`agent presets not offered on this ${word}: ${JSON.stringify(off)}; said: ${JSON.stringify(said)}`);
  // A person: what they may do; screen roles only where invited people may
  // see the screen, and said when they can't.
  await page.tap(`button[aria-label="Back"]`, "Back");
  await page.tap({ selector: "button.inv-who-row", text: /^A person/ }, "A person");
  const roles = await page.see({ js: `(() => { const c = ${choices("Access")}; return c.length && c.map((r) => r.name); })()` }, "what a person may do", 30000);
  const screenRoles = ["Can watch", "Can control"].filter((r) => roles.includes(r));
  const told = await page.evaluate(`(${reasons})()`);
  await page.shot("person");
  t.diagnostic(`person roles on this ${word}: ${JSON.stringify(roles)}; said: ${JSON.stringify(told)}`);
  assert.ok(roles.includes("Can use files") && roles.includes("Full access"), JSON.stringify(roles));
  if (screenRoles.length < 2)
    assert.ok(told.some((line) => /screen/i.test(line)), `watching and controlling aren't offered, and the sheet says why: ${JSON.stringify(told)}`);
});
