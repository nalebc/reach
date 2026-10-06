import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { AGENT_SCOPES, ALL_SCOPES } from "../server/core.mjs";

// The "/" commands (rename, fork, compact, review, a chat's skills and
// status) are the owner's alone, like every AI chat: never a guest's, not
// even with full access, and never an agent's, whatever it was given.
const ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

test("only the owner's own devices list or run a chat's slash commands", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-slash-access-"));
  const files = path.join(dir, "files");
  fs.mkdirSync(files);
  const reach = await createReach({ roots: [files], dataDir: path.join(dir, "private") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const call = (route, token, { method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.status);
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const created = await fetch(`${url}/api/guests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Sam", ttlSeconds: 900, full: true }),
  }).then((r) => r.json());
  const guest = await fetch(`${url}/api/guest/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitation: created.invitation }),
  }).then((r) => r.json());
  // An agent can't be given admin at all; the most it can hold.
  const agent = reach.auth.issue("Agent", AGENT_SCOPES, "agent");
  const routes = [
    ["/api/sessions/commands?agent=codex", "GET"],
    [`/api/sessions/commands?agent=codex&id=${ID}`, "GET"],
    [`/api/sessions/codex/${ID}/commands`, "POST", { name: "rename", args: "x" }],
    [`/api/sessions/codex/${ID}/commands`, "POST", { name: "fork" }],
    [`/api/sessions/codex/${ID}/messages`, "POST", { text: "x", skill: "documents:documents" }],
  ];
  for (const [who, token] of [["a full-access guest", guest.token], ["an agent with every scope it can have", agent.token]])
    for (const [route, method, body] of routes) assert.equal(await call(route, token, { method, body }), 403, `${who}: ${method} ${route}`);
  // The owner's device is let in (no Codex in tests: nothing listed).
  assert.equal(await call("/api/sessions/commands?agent=codex", owner.token), 200);
});
