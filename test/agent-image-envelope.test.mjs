import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAgentClient } from "../scripts/agent-client.mjs";
import { tailnetApi } from "../scripts/agent-remote.mjs";
import {
  AGENT_JSON_RESPONSE_BYTES, AGENT_SCREEN_RESPONSE_BYTES, AGENT_MCP_IMAGE_RESPONSE_BYTES,
  agentJsonResponseLimit, validateAgentJsonResponse,
} from "../server/agent-transport.mjs";

const route = "/api/browser/mcp/call";
const request = { name: "reach_screenshot", arguments: { maxWidth: 2560 } };
const envelope = (bytes) => ({ result: { image: Buffer.alloc(bytes).toString("base64"), mimeType: "image/jpeg" }, list: "fixture" });

async function adapters(t) {
  let bytes = Buffer.from("{}"), status = 200;
  // Real loopback HTTP; native screen capture and the tailnet are stand-ins.
  const server = http.createServer((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(bytes); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const direct = createAgentClient({ url: `http://127.0.0.1:${server.address().port}`, token: "fixture-no-authority" }, { allowLocal: true, proxy: "" });
  const tailnet = tailnetApi({ fetch() {
    let sent = false;
    return { abort() {}, response: Promise.resolve({ status, headers: ["content-type", "application/json"],
      cancel() {}, read: async () => sent ? null : (sent = true, bytes),
    }) };
  } }, "https://fixture.tailnet.ts.net", "fixture");
  return { clients: [direct, tailnet], answer(value, code = 200) { bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); status = code; } };
}

test("only exact successful MCP image calls get the bounded base64 envelope budget", () => {
  for (const path of [route, `${route}?runtime=${"a".repeat(64)}`]) {
    for (const name of ["reach_screenshot", "reach_app_screen"]) {
      assert.equal(agentJsonResponseLimit(path, "POST", { name }), AGENT_MCP_IMAGE_RESPONSE_BYTES);
      assert.equal(agentJsonResponseLimit(path, "POST", { name: "reach_execute", arguments: { name } }), AGENT_MCP_IMAGE_RESPONSE_BYTES);
    }
  }
  for (const [path, method, body, status] of [
    [route, "GET", request], [route, "POST", request, 403], [route, "POST", { name: "reach_read_file" }],
    [route, "POST", { name: "reach_service_gmail_find" }], [route, "POST", { name: "reach_execute", arguments: { name: "reach_read_file" } }],
    [`${route}?other=1`, "POST", request], [`${route}?runtime=wrong`, "POST", request], [`${route}back`, "POST", request],
  ]) assert.equal(agentJsonResponseLimit(path, method, body, status), AGENT_JSON_RESPONSE_BYTES);
});

test("direct and tailnet MCP dispatch accept a 2 MiB screenshot through full and compact tool calls", async t => {
  const fixture = await adapters(t), value = envelope(2 * 1024 * 1024);
  fixture.answer(value);
  for (const api of fixture.clients) for (const body of [request, { name: "reach_execute", arguments: request }]) {
    const result = await api(`${route}?runtime=${"b".repeat(64)}`, "POST", body);
    assert.equal(result.result.image.length, value.result.image.length);
    assert.equal(result.result.mimeType, "image/jpeg");
  }
});

test("base64 envelopes retain the binary 8 MiB image bound and validate their content", () => {
  const value = envelope(AGENT_SCREEN_RESPONSE_BYTES);
  assert.equal(validateAgentJsonResponse(route, "POST", request, value), value);
  // The next byte has the same base64 length; enforce decoded bytes too.
  const tooLarge = envelope(AGENT_SCREEN_RESPONSE_BYTES + 1);
  assert.equal(tooLarge.result.image.length, value.result.image.length);
  assert.throws(() => validateAgentJsonResponse(route, "POST", request, tooLarge), /exceeds 8 MiB/);
  for (const image of ["not base64", "", "A===", "abc"]) {
    assert.throws(() => validateAgentJsonResponse(route, "POST", request, { result: { image, mimeType: "image/jpeg" } }), /unsupported screenshot/);
  }
  assert.throws(() => validateAgentJsonResponse(route, "POST", request, { result: { image: "YQ==", mimeType: "text/html" } }), /unsupported screenshot/);
});

test("both transports accept a full 8 MiB image inside the bounded MCP envelope", async t => {
  const fixture = await adapters(t), value = envelope(AGENT_SCREEN_RESPONSE_BYTES);
  fixture.answer(value);
  for (const api of fixture.clients) {
    const result = await api(route, "POST", request);
    assert.equal(result.result.image.length, value.result.image.length);
    assert.equal(result.result.mimeType, "image/jpeg");
  }
});

test("both transports keep ordinary JSON at 2 MiB and bound image envelope overhead", async t => {
  const fixture = await adapters(t);
  fixture.answer({ result: { text: "x".repeat(AGENT_JSON_RESPONSE_BYTES) } });
  for (const api of fixture.clients) {
    await assert.rejects(api(route, "POST", { name: "reach_read_file" }), /exceeds 2 MiB/);
    await assert.rejects(api(route + "?other=1", "POST", request), /exceeds 2 MiB/);
  }
  fixture.answer(Buffer.alloc(AGENT_MCP_IMAGE_RESPONSE_BYTES + 1));
  for (const api of fixture.clients) await assert.rejects(api(route, "POST", request), /base64 envelope limit/);
  fixture.answer(envelope(AGENT_SCREEN_RESPONSE_BYTES + 1));
  for (const api of fixture.clients) await assert.rejects(api(route, "POST", request), /exceeds 8 MiB/);
});
