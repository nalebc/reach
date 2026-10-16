import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { hostedConnector } from "../server/core.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { agentKey, funnelApi, funnelGateway } from "../scripts/agent-funnel.mjs";
import { AGENT_SCREEN_RESPONSE_BYTES } from "../server/agent-transport.mjs";

const ORIGIN = "https://image.fixture.ts.net";
const CALL = "/api/browser/mcp/call";
const screenshot = { name: "reach_screenshot", arguments: { maxWidth: 2560 } };
const compactScreenshot = { name: "reach_execute", arguments: screenshot };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-image-envelope-")));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  // Synthetic bytes and desktop observations only. No native screen capture,
  // input, provider calls or real Tailscale process are used by this fixture.
  const state = { bytes: AGENT_SCREEN_RESPONSE_BYTES, ordinary: false, calls: [] };
  const image = () => Buffer.alloc(state.bytes, 0x7f);
  const reach = await createReach({
    name: "Image fixture", roots: [shared], dataDir: path.join(dir, "state"),
    agentPolicyFile: path.join(dir, "none.json"), screen: false,
    publicOrigin: `${ORIGIN}:8443`, allowedOrigins: [ORIGIN],
    tailscaleOwner: { userId: "42", login: "fixture@example.test" },
    tailscaleIdentity: { lookup: async () => null },
    browserFilesSupported: true, browserAppSupported: false,
    desktopTerminals: { platform: "linux", run: async () => assert.fail("No native terminals") },
    browserCapture: async () => assert.fail("No host screen capture"),
    browserInput: async () => assert.fail("No host input"),
    agentDesktop: {
      available: () => true,
      screenshot: async (client, authorize) => {
        authorize(); state.calls.push(client.id);
        return { jpeg: image(), width: 2560, height: 1440, hidden: 0 };
      },
      front: async (_client, authorize) => {
        authorize();
        return { app: "Fixture", title: state.ordinary ? "x".repeat(AGENT_SCREEN_RESPONSE_BYTES + 1) : "Synthetic observation" };
      },
      cancelClient() {},
    },
  });
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await new Promise((resolve, reject) => {
    reach.server.once("error", reject);
    reach.server.listen(0, "127.0.0.1", resolve);
  });
  // Exercise Windows' portable keyed ingress on every host. Only the
  // Tailscale peer-identity check is mocked; its routing and gateway run.
  const ingress = newIngressKey();
  const port = await reach.listenKeyed({
    key: ingress, peerCheck: { check: async () => true },
    publicApp: (req, res) => reach.publicAgent(req, res) || (res.statusCode = 404, res.end(), true),
  });
  reach.setFunnelController(async () => {});
  const optionsFor = (route, options = {}) => ({
    host: "127.0.0.1", port, path: `/r-${ingress}${route}`,
    ...options,
    headers: {
      ...options.headers, Host: new URL(ORIGIN).host,
      "X-Forwarded-Host": new URL(ORIGIN).host,
      "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.7",
    },
  });
  // Substitute TLS plumbing with real loopback HTTP. The gateway still signs;
  // httpsSend still streams, counts bytes and applies the request budget.
  t.mock.method(https, "request", (url, options, callback) => {
    assert.equal(String(url), `${ORIGIN}/agent-gateway`, "no external HTTPS requests");
    return http.request(optionsFor("/agent-gateway", {
      method: options.method, headers: options.headers, timeout: options.timeout,
    }), callback);
  });
  const post = (route, body, token) => new Promise((resolve, reject) => {
    const req = http.request(optionsFor(route, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    }), res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.once("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  const invitation = extra => reach.auth.inviteBrowser({
    name: "Synthetic image reader", transport: "funnel", preset: "readonly",
    folders: [{ root: 0, path: "" }], ttlSeconds: 600, ...extra,
  });
  // Use real admission and token binding. OAuth itself is covered separately;
  // these tests target hosted-mcp's apiFor and index's hostedDispatch.
  const hosted = invitation({ hosted: true });
  const connector = hostedConnector(hosted.invitation);
  const binding = crypto.randomBytes(32).toString("base64url");
  const admission = reach.auth.claimHostedInvitation(binding, { name: "Fixture", clientId: "fixture", connector });
  reach.auth.decideAgentAdmission(admission.requestId, "approve");
  const accepted = reach.auth.pollFunnelAdmission(admission.requestId, admission.requestSecret, binding);
  assert.equal(accepted.status, "approved");
  const hostedCall = body => post(`/mcp/${connector}`, {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: body,
  }, `${binding}.${accepted.accessToken}`);
  const conn = path.join(dir, "agent");
  fs.mkdirSync(conn);
  const key = agentKey(conn);
  const gateway = funnelGateway(ORIGIN, key);
  const claimed = await gateway.claim(invitation().invitation);
  assert.equal(claimed.status, 202);
  reach.auth.decideAgentAdmission(claimed.json.requestId, "approve");
  const approved = await gateway.status(claimed.json.requestId, claimed.json.requestSecret);
  assert.equal(approved.json.status, "approved");
  const api = funnelApi({ conn, credential: { origin: ORIGIN, token: approved.json.token }, key, gateway });
  return { state, api, hostedCall, image };
}

test("large MCP screenshots keep their image budget through hosted and signed Funnel dispatch", async t => {
  const f = await fixture(t);
  await t.test("hosted apiFor and real inner dispatch accept an 8 MiB image for full and compact calls", async () => {
    for (const body of [screenshot, compactScreenshot]) {
      const response = await f.hostedCall(body);
      assert.equal(response.status, 200);
      assert.ok(!response.body.result?.isError, JSON.stringify(response.body.result?.content?.filter(item => item.type === "text")));
      const image = response.body.result.content.find(item => item.type === "image");
      assert.equal(image?.mimeType, "image/jpeg");
      const decoded = Buffer.from(image.data, "base64");
      assert.equal(decoded.length, AGENT_SCREEN_RESPONSE_BYTES);
      assert.equal(digest(decoded), digest(f.image()));
    }
  });
  await t.test("Funnel CLI's real httpsSend and signature gateway accept the same full and compact calls", async () => {
    for (const body of [screenshot, compactScreenshot]) {
      const result = await f.api(`${CALL}?runtime=${"a".repeat(64)}`, "POST", body);
      assert.equal(result.result.mimeType, "image/jpeg");
      const decoded = Buffer.from(result.result.image, "base64");
      assert.equal(decoded.length, AGENT_SCREEN_RESPONSE_BYTES);
      assert.equal(digest(decoded), digest(f.image()));
    }
  });
  await t.test("both paths reject decoded images over 8 MiB even when base64 length is unchanged", async () => {
    f.state.bytes = AGENT_SCREEN_RESPONSE_BYTES + 1;
    const response = await f.hostedCall(screenshot);
    assert.equal(response.status, 200);
    assert.equal(response.body.result?.isError, true);
    assert.match(response.body.result.content[0].text, /exceeds 8 MiB/);
    await assert.rejects(f.api(CALL, "POST", screenshot), /exceeds 8 MiB/);
  });
  await t.test("Funnel's binary screenshot response retains its 8 MiB transport cap", async () => {
    await assert.rejects(f.api("/api/browser/desktop/screen?maxWidth=2560"), /transport limit|exceeds 8 MiB/);
  });
  await t.test("ordinary tool JSON keeps the existing 8 MiB bound on both paths", async () => {
    f.state.ordinary = true;
    const body = { name: "reach_front", arguments: {} };
    const response = await f.hostedCall(body);
    assert.equal(response.status, 200);
    assert.equal(response.body.result?.isError, true);
    assert.match(response.body.result.content[0].text, /transport limit|too large|exceeds 8 MiB/);
    await assert.rejects(f.api(CALL, "POST", body), /transport limit|exceeds 8 MiB/);
  });
  assert.ok(f.state.calls.length >= 7, "the real tools reached only the synthetic screenshot implementation");
});
