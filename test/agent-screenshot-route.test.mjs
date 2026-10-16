import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { browserToolRequest } from "../server/browser-tools.mjs";
import { createAgentClient, isScreenImageRoute } from "../scripts/agent-client.mjs";
import { tailnetApi } from "../scripts/agent-remote.mjs";
import { funnelApi } from "../scripts/agent-funnel.mjs";

const access = { preset: "full", screen: true, control: true, open: true, roots: [], terminals: [] };
const routes = [
  browserToolRequest("reach_screenshot", { displayId: 2 }, access).route,
  browserToolRequest("reach_screenshot", { maxWidth: 3840, displayId: 4294967295 }, access).route,
  "/api/browser/desktop/screen?displayId=2",
  "/api/browser/desktop/screen?displayId=2&maxWidth=640",
];
const jpeg = Buffer.from([255, 216, 255, 217]);
const image = { image: jpeg.toString("base64"), mimeType: "image/jpeg" };

test("advertised multi-display screenshot plans are binary image routes", () => {
  for (const route of routes) assert.equal(isScreenImageRoute(route), true, route);
});

test("screenshot decoding excludes lookalikes, duplicate fields and unsupported query values", () => {
  for (const route of [
    "/api/files/text?displayId=2", "/api/browser/desktop/screenful?displayId=2",
    "/api/browser/desktop/screen?displayId=2&other=1", "/api/browser/desktop/screen?displayId=2&displayId=3",
    "/api/browser/desktop/screen?maxWidth=2560&maxWidth=640", "/api/browser/desktop/screen?displayId=two",
    "/api/browser/desktop/screen?displayId=2#fragment", "/api/browser/desktop/screen?displayId=0",
    "/api/browser/desktop/screen?displayId=4294967296",
  ]) assert.equal(isScreenImageRoute(route), false, route);
});

test("direct HTTP decodes a selected display as an MCP image", async (t) => {
  // Real local HTTP transport, synthetic JPEG only; no screen is captured.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/jpeg" });
    response.end(jpeg);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = createAgentClient({ url: `http://127.0.0.1:${server.address().port}`, token: "fixture-with-no-authority" }, { allowLocal: true, proxy: "" });
  for (const route of routes) assert.deepEqual(await api(route), image);
  await assert.rejects(api("/api/files/text?displayId=2"), /JSON|Unexpected/);
});

test("tailnet and Funnel adapters decode selected-display images using the same route contract", async () => {
  // Both networks are stand-ins; the production adapters and planner run.
  const node = { fetch() {
    let sent = false;
    return { abort() {}, response: Promise.resolve({ status: 200, headers: ["Content-Type", "image/jpeg"],
      read: async () => sent ? null : (sent = true, jpeg), cancel() {},
    }) };
  } };
  const gateway = { request: async () => ({ status: 200, headers: { "content-type": "image/jpeg" }, bytes: jpeg, json: null }) };
  const adapters = [tailnetApi(node, "https://fixture.tailnet.ts.net", "fixture"),
    funnelApi({ conn: "fixture", credential: { origin: "https://fixture.tailnet.ts.net", token: "fixture" }, key: {}, gateway })];
  for (const api of adapters) for (const route of routes) assert.deepEqual(await api(route), image);
});
