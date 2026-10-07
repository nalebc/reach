import assert from "node:assert/strict";

// Existing access tests begin after the separate owner admission gate. These
// helpers explicitly perform that gate; admission tests exercise it unaided.
export function admitAgent(auth, invitation, identity) {
  const claim = auth.redeemGuest(invitation, identity);
  assert.equal(claim.status, "pending");
  assert.equal(claim.token, undefined);
  auth.decideAgentAdmission(claim.requestId, "approve");
  const joined = auth.pollAgentAdmission(
    claim.requestId,
    claim.requestSecret,
    identity,
  );
  assert.equal(joined.status, "approved");
  return joined;
}

export async function approveAgentClaim(call, claimed) {
  if (claimed.status !== 202) return claimed;
  assert.equal(claimed.body.status, "pending");
  assert.equal(claimed.body.token, undefined);
  const decided = await call(
    `/api/agents/admissions/${claimed.body.requestId}`,
    {
      method: "POST",
      body: { decision: "approve" },
    },
  );
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const joined = await call(
    `/api/invitations/claims/${claimed.body.requestId}/status`,
    {
      token: "",
      method: "POST",
      body: { secret: claimed.body.requestSecret },
    },
  );
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.status, "approved");
  return joined;
}
