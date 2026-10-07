import test from "node:test";
import assert from "node:assert/strict";
import { waitForAgentAdmission } from "../scripts/agent-remote.mjs";

const receipt = () => ({ status: "pending", kind: "agent", requestId: "claim-1", requestSecret: "r".repeat(43), verificationCode: "123456", expiresAt: 5000 });
test("CLI waiting uses only its receipt, prints comparison code, and returns a token only after approval", async () => {
  const calls = [], announcements = [];
  let at = 0;
  const approved = { status: "approved", kind: "agent", token: "access-token", clientId: "agent-1", scopes: ["device"], expiresAt: 10000 };
  const joined = await waitForAgentAdmission(receipt(), async (...args) => {
    calls.push(args);
    return calls.length === 1 ? { status: "pending" } : approved;
  }, { now: () => at, delay: async (ms) => { at += ms; }, announce: (code) => announcements.push(code) });
  assert.equal(joined, approved);
  assert.deepEqual(announcements, ["123456"]);
  assert.deepEqual(calls, Array(2).fill(["/api/invitations/claims/claim-1/status", "POST", { secret: "r".repeat(43) }]));
  assert.equal(at, 2000);
});
test("CLI waiting fails closed for denial, expiry, malformed approval and deadline", async () => {
  for (const result of [{ status: "denied" }, { status: "expired" }, { status: "approved", kind: "guest", token: "wrong", scopes: [] }, { status: "approved", kind: "agent", scopes: [] }]) {
    await assert.rejects(waitForAgentAdmission(receipt(), async () => result, { now: () => 0, announce() {} }));
  }
  let at = 0, polls = 0;
  await assert.rejects(waitForAgentAdmission(receipt(), async () => { polls++; return { status: "pending" }; }, {
    now: () => at, delay: async (ms) => { at += ms; }, announce() {},
  }), /timed out/);
  assert.equal(at, 5000);
  assert.equal(polls, 3);
  await assert.rejects(waitForAgentAdmission({ ...receipt(), requestSecret: undefined }, async () => assert.fail("Must not poll"), { now: () => 0, announce() {} }), /invalid.*receipt/);
});
