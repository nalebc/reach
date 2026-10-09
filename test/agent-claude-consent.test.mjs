import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeConsent, pressClaudeConsent } from "../server/agent-sessions/claude-consent.mjs";

const A = "1fa82f5d-07e5-459c-a5fd-61368b3423c5";
const B = "8f3a3707-0000-4000-8000-000000000001";
const shownAs = (...ids) => () => ids.map((id, i) => ({ id, session: `local_${id}`, at: 100 - i }));

// A Claude app session waiting on its consent card until the press lands.
const app = (id = "consent:toolu_1") => {
  const state = { asked: { id, apps: ["Calculator"] }, presses: [], expected: [], opened: [] };
  state.press = async (choice, expect) => {
    state.presses.push(choice);
    state.expected.push(expect);
    state.asked = null;
  };
  state.pending = async () => state.asked;
  state.open = async (url) => state.opened.push(url);
  return state;
};

test("a phone's answer presses the same button on the Claude app's card, showing that session first when it isn't on screen", async () => {
  const mac = app();
  const consent = createClaudeConsent({ press: mac.press, open: mac.open, pending: mac.pending, shown: () => (mac.opened.length ? shownAs(A, B)() : shownAs(B, A)()), wait: async () => {} });
  assert.equal(consent.owns("consent:toolu_1"), true);
  assert.equal(consent.owns("7"), false);
  assert.deepEqual(await consent.answer(A, "consent:toolu_1", { decision: "allow" }), { answered: true });
  assert.deepEqual(mac.opened, [`claude://code/continue?session=local_${A}`]);
  assert.deepEqual(mac.presses, ["Allow for this session"]);
  // Only a card that says this request: its question and its apps.
  assert.deepEqual(mac.expected, [["Allow Claude to use", "Calculator"]]);
  // Answered and confirmed: a second tap says so, not "couldn't confirm".
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "allow" }), /^Error: This request was already answered\.$/);

  // Already on screen: pressed in place.
  const shownHere = app();
  const here = createClaudeConsent({ press: shownHere.press, open: shownHere.open, pending: shownHere.pending, shown: shownAs(A), wait: async () => {} });
  await here.answer(A, "consent:toolu_1", { decision: "deny" });
  assert.deepEqual(shownHere.opened, []);
  assert.deepEqual(shownHere.presses, ["Deny"]);
});

test("nothing is pressed for an unknown choice, a card already answered, or a session the app doesn't list; a press that doesn't land says so", async () => {
  const mac = app();
  const consent = createClaudeConsent({ press: mac.press, open: mac.open, pending: mac.pending, shown: shownAs(B), wait: async () => {} });
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "always" }), (e) => e.status === 400);
  await assert.rejects(consent.answer(A, "consent:toolu_other", { decision: "deny" }), /already answered/);
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "deny" }), /doesn't list this session/);
  assert.deepEqual(mac.presses, []);
  assert.deepEqual(mac.opened, []);

  // Pressed, but the transcript never gets the answer.
  const stuck = createClaudeConsent({
    // On a Mac: these say "your Mac" (other computers: computer-word.test.mjs).
    platform: "darwin",
    press: async () => {},
    open: async () => {},
    pending: async () => ({ id: "consent:toolu_1" }),
    shown: shownAs(A),
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    confirmMs: 30,
  });
  await assert.rejects(stuck.answer(A, "consent:toolu_1", { decision: "deny" }), (e) => e.status === 409 && /Answer it on your Mac/.test(e.message));
});

test("the press goes through Reach's helper with only the chosen button, and its refusals are passed on", async () => {
  const runs = [];
  const helper = (stdout) => ({ binary: async () => "/data/reach-claude-consent", run: async (...args) => (runs.push(args), { stdout }) });
  assert.deepEqual(
    await pressClaudeConsent("Deny", { ...helper('{"pressed":"Deny","ms":40}\n'), expect: ["Allow Claude to use", "Calculator"] }),
    { pressed: "Deny", ms: 40 },
  );
  assert.deepEqual(runs[0].slice(0, 2), [
    "/data/reach-claude-consent",
    ["--press", "Deny", "--expect", "Allow Claude to use", "--expect", "Calculator"],
  ]);
  await assert.rejects(
    pressClaudeConsent("Deny", helper('{"error":"The Claude app isn\'t showing that request."}\n')),
    /isn't showing that request\. Answer it on your Mac\./,
  );
  await assert.rejects(pressClaudeConsent("Deny", helper("garbage")), (e) => e.status === 502);
});

test("a tap the helper never pressed can be tried again; a press it can't confirm is never repeated", async () => {
  let reply = '{"error":"The Claude app isn\'t showing that request.","untouched":true}\n';
  const presses = [];
  const consent = createClaudeConsent({
    press: (choice) => (presses.push(choice), pressClaudeConsent(choice, { binary: async () => "/h", run: async () => ({ stdout: reply }) })),
    open: async () => {},
    pending: async () => ({ id: "consent:toolu_1" }),
    shown: shownAs(A),
    wait: async () => {},
    confirmMs: 0,
    platform: "darwin",
  });
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "allow" }), /isn't showing that request/);
  // Nothing was pressed: the second tap reaches the helper again.
  reply = '{"error":"The Claude app did not confirm the answer. Check it on your Mac."}\n';
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "allow" }), /did not confirm/);
  assert.equal(presses.length, 2);
  // Maybe pressed: never pressed twice, and the phone is told why.
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "allow" }), /couldn't confirm it\. Check the card on your Mac/);
  assert.equal(presses.length, 2);
});

test("Claude native consent rejects concurrent taps and rechecks the request after switching chats", async () => {
  let release;
  const switched = new Promise(resolve => { release = resolve; });
  const mac = app();
  const consent = createClaudeConsent({ press: mac.press, open: mac.open, pending: mac.pending, shown: shownAs(B, A), wait: () => switched });
  const answer = consent.answer(A, "consent:toolu_1", { decision: "allow" });
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "deny" }), /already being sent/);
  mac.asked = null;
  release();
  await assert.rejects(answer, /already answered/);
  assert.equal(mac.presses.length, 0);
});

// Allow presses the card that shows "Allow Claude to use" and its apps: with
// no app named (the field renamed in a newer Claude), any apps card would
// match, so Allow is never pressed. Deny still is (fail-open audit, Oct 8).
test("an apps card that names no app is never allowed from the phone", async () => {
  const mac = app();
  mac.asked = { id: "consent:toolu_1", kind: "apps", apps: [] };
  const consent = createClaudeConsent({ press: mac.press, open: mac.open, pending: mac.pending, shown: shownAs(A), wait: async () => {} });
  await assert.rejects(consent.answer(A, "consent:toolu_1", { decision: "allow" }), (e) => e.status === 409 && /which apps/.test(e.message));
  assert.deepEqual(mac.presses, []);
  await consent.answer(A, "consent:toolu_1", { decision: "deny" });
  assert.deepEqual(mac.presses, ["Deny"]);
});
