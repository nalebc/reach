import test from "node:test";
import assert from "node:assert/strict";
import { createServiceConnectors } from "../server/service-connectors.mjs";

const authorize = () => ({ policy: { preset: "full" }, scopes: ["browser:screen", "browser:control", "browser:open"] });
const options = { authorize, requestId: "11111111-2222-4333-8444-555555555555", signal: new AbortController().signal };

for (const nativeError of [false, true]) {
  test(`Gmail ${nativeError ? "transport" : "tool-result"} loading failures explain how to recover without exposing browser text`, async () => {
    const sensitive = "private browser address and page content";
    const tools = { async run() {
      if (nativeError) throw Object.assign(Error(sensitive), { code: "loading" });
      return { status: "stopped", code: "loading", error: sensitive };
    } };
    const gmail = createServiceConnectors(tools).find(connector => connector.id === "gmail");
    await assert.rejects(gmail.run("find", { browser: "Chrome", account: "0", query: "invoice" }, options), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /requested page|page.*load/i);
      assert.match(error.message, /account/i);
      assert.match(error.message, /retry/i);
      assert.ok(!error.message.includes(sensitive));
      return true;
    });
  });
}

test("unknown browser errors still return fixed guidance rather than native exception text", async () => {
  const sensitive = "private browser address and page content";
  const tools = { async run() { throw Object.assign(Error(sensitive), { code: "unknown_from_browser" }); } };
  const gmail = createServiceConnectors(tools).find(connector => connector.id === "gmail");
  await assert.rejects(gmail.run("find", { browser: "Chrome", account: "0", query: "invoice" }, options), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /Check Agent Access/);
    assert.ok(!error.message.includes(sensitive));
    return true;
  });
});
