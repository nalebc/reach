import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createFunnelAgentGateway } from "../server/funnel-agent.mjs";
import {
  agentShortcutRoutes,
  createAgentShortcuts,
} from "../server/agent-shortcuts.mjs";
import { browserToolRequest } from "../server/browser-tools.mjs";

// Real local HTTP and P-256 signatures; synthetic credentials and app callbacks.
// No invitation is created and no host application or native input is accessed.
test(
  "signed saved-tool plans record, discard and save through the real gateway and routes",
  { timeout: 15000 },
  async (t) => {
    const origin = "https://shortcut-fixture.example.ts.net";
    const key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = key.publicKey.export({ format: "jwk" });
    const thumbprint = crypto
      .createHash("sha256")
      .update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }))
      .digest("base64url");
    const token = crypto.randomBytes(32).toString("base64url");
    const appChoice = {
      id: "/System/Applications/Calculator.app",
      name: "Calculator",
      bundleId: "com.apple.calculator",
    };
    const access = {
      preset: "apps",
      screen: true,
      control: true,
      open: true,
      apps: [appChoice],
      roots: [],
      terminals: [],
    };
    const client = {
      id: "synthetic-agent",
      name: "Fixture",
      kind: "agent",
      status: "accepted",
      expiresAt: Date.now() + 60000,
      policy: {
        invite: true,
        browser: true,
        preset: "apps",
        apps: [appChoice],
        roots: [],
      },
      scopes: [
        "browser:read",
        "browser:screen",
        "browser:control",
        "browser:open",
      ],
      browserTransport: "funnel",
      browserBinding: thumbprint,
      browserIdleExpiresAt: Date.now() + 60000,
    };
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "reach-shortcut-gateway-"),
    );
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let opens = 0;
    const shortcuts = createAgentShortcuts({
      dataDir,
      desktop: {
        front: async (_, authorize) => {
          authorize();
          return {
            bundle: appChoice.bundleId,
            app: appChoice.name,
            path: appChoice.id,
            title: "Synthetic",
            layout: "",
            secure: false,
            blocked: "",
          };
        },
        open: async (_, app, authorize) => {
          authorize();
          assert.equal(app, appChoice.id);
          opens++;
          return { ok: true, app: appChoice.name, bundle: appChoice.bundleId };
        },
        act: async () =>
          assert.fail("No native input is allowed in this fixture"),
      },
    });
    const app = express();
    agentShortcutRoutes(app, { shortcuts });
    app.post("/api/browser/desktop/open", async (req, res) =>
      res.json(
        await shortcuts.open(req.reauthorize(), req.body.app, req.reauthorize),
      ),
    );
    app.use((error, _req, res, _next) =>
      res.status(error.status || 500).json({ error: error.message }),
    );
    const gateway = createFunnelAgentGateway({
      origin,
      auth: {
        verifyFunnel: (supplied, binding) =>
          supplied === token && binding === thumbprint ? client : null,
      },
      dispatch(req, res, context) {
        req.method = context.method;
        req.url = context.path;
        req.body = context.body === null ? undefined : context.body;
        req.reauthorize = () => client;
        app(req, res);
      },
    });
    const server = http.createServer((req, res) => {
      if (!gateway(req, res)) res.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const send = (plan) => {
      const payload = JSON.stringify({
        v: 1,
        audience: origin,
        issuedAt: Date.now(),
        nonce: crypto.randomBytes(24).toString("base64url"),
        operation: "request",
        token,
        method: plan.method || "GET",
        path: plan.route,
        body: plan.body ?? null,
      });
      const envelope = JSON.stringify({
        payload,
        publicKey: jwk,
        signature: crypto
          .sign("sha256", Buffer.from(payload), {
            key: key.privateKey,
            dsaEncoding: "ieee-p1363",
          })
          .toString("base64url"),
      });
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/agent-gateway",
            method: "POST",
            headers: {
              host: new URL(origin).host,
              origin,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(envelope),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks)),
              }),
            );
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(envelope);
      });
    };
    const tool = (name, args = {}) =>
      send(browserToolRequest(name, args, access));
    const list = () => send({ route: "/api/browser/shortcuts", method: "GET" });
    assert.equal(
      (
        await tool("reach_record_shortcut", {
          name: "Discard synthetic recording",
        })
      ).status,
      201,
    );
    assert.equal(
      (await tool("reach_open_app", { app: appChoice.id })).status,
      200,
    );
    assert.equal((await list()).body.recording.stepCount, 1);
    const discarded = await tool("reach_discard_shortcut");
    assert.equal(
      discarded.status,
      200,
      "the shared planner must produce a gateway-compatible DELETE",
    );
    assert.equal((await list()).body.recording, null);
    assert.equal(opens, 1, "discard does not undo or replay an app action");

    assert.equal(
      (
        await tool("reach_record_shortcut", {
          name: "Save synthetic recording",
        })
      ).status,
      201,
    );
    await tool("reach_open_app", { app: appChoice.id });
    const invalidDelete = await send({
      route: "/api/browser/shortcuts/record",
      method: "DELETE",
      body: {},
    });
    assert.equal(
      invalidDelete.status,
      400,
      "the strict signed DELETE schema remains enforced",
    );
    assert.equal(
      (await list()).body.recording.stepCount,
      1,
      "invalid requests preserve the recording",
    );
    const saved = await tool("reach_save_shortcut");
    assert.equal(
      saved.status,
      201,
      "Save keeps its permitted POST object body",
    );
    assert.equal(saved.body.name, "Save synthetic recording");
    const state = (await list()).body;
    assert.equal(state.recording, null);
    assert.equal(state.shortcuts.length, 1);
    assert.equal(opens, 2, "save makes no additional app action");
    assert.equal(
      (
        await send({
          route: "/api/agents/shortcuts/cancel",
          method: "POST",
          body: { runId: crypto.randomUUID() },
        })
      ).status,
      403,
      "owner Stop is not exposed through the agent gateway",
    );
  },
);
