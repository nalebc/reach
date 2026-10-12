import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

const exec = promisify(execFile);
const enabled =
  process.platform === "darwin" && process.env.REACH_TEST_AGENT_LIVE === "1";

// Real Accessibility and real input, restricted by the production Apps preset
// to a disposable fixture app. Each event also names its exact expected bundle
// and window title. Never use Full control, screenshots, arbitrary coordinates,
// a browser, a shell, or user documents in this test. Permission denial fails
// explicitly; this harness never prompts for or changes TCC permissions.
test(
  "a native agent observes and fills only its toy app; owner pause, phone control and revocation stop subsequent input",
  {
    skip:
      !enabled &&
      "set REACH_TEST_AGENT_LIVE=1 on macOS with Accessibility and Screen Recording already granted",
    timeout: 240000,
  },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-native-live-"));
    const appPath = path.join(dir, "Agent Fixture.app"),
      contents = path.join(appPath, "Contents"),
      executable = path.join(contents, "MacOS", "agent-fields");
    const bundle = "test.fixture.agentform",
      title = "Synthetic Agent Form";
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>agent-fields</string><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleName</key><string>Agent Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/></dict></plist>`,
    );
    await exec(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-O",
        new URL("./fixtures/agent-fields.swift", import.meta.url).pathname,
        "-o",
        executable,
      ],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    );
    const fixture = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 240000,
      killSignal: "SIGKILL",
    });
    let fixtureError = "";
    fixture.stderr.on("data", (chunk) => {
      fixtureError = (fixtureError + chunk).slice(-4000);
    });
    const lines = createInterface({ input: fixture.stdout });
    const closed = new Promise((resolve) => fixture.once("close", resolve));
    let desktop;
    t.after(async () => {
      desktop?.close();
      lines.close();
      fixture.stdin.end();
      const kill = setTimeout(() => fixture.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(kill);
      await fs.rm(dir, { recursive: true, force: true });
    });
    const next = async () => {
      const [line] = await once(lines, "line", {
        signal: AbortSignal.timeout(10000),
      });
      return JSON.parse(line);
    };
    const state = async () => {
      const answer = next();
      fixture.stdin.write("state\n");
      return answer;
    };
    const expectValue = async (value) => {
      // Quartz delivery and AppKit's field editor settle asynchronously; read
      // the fixture, never replay input while waiting for its acknowledgement.
      let seen;
      for (let attempt = 0; attempt < 20; attempt++) {
        seen = await state();
        if (seen.value === value) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      t.diagnostic(JSON.stringify({ inputFailure: seen }));
      assert.equal(
        seen.value,
        value,
        "The fixture independently confirms the actual key events",
      );
    };
    const initial = await next();
    assert.equal(initial.bundle, bundle, fixtureError);
    assert.equal(initial.value, "");
    const policy = {
      invite: true,
      browser: true,
      preset: "apps",
      roots: [],
      apps: [{ id: appPath, bundleId: bundle, name: "Agent Fixture" }],
    };
    const client = {
      id: "native-fixture-agent",
      kind: "agent",
      name: "Native fixture",
      expiresAt: Date.now() + 180000,
      policy,
      scopes: presetScopes(policy),
    };
    let current = client,
      phone = false;
    const authorize = () => {
      if (!current)
        throw Object.assign(Error("Fixture access revoked"), { status: 401 });
      return current;
    };
    desktop = createAgentDesktop(
      { dataDir: dir, screen: true },
      { verifyClient: () => current, phoneControls: () => phone, pauses: createAgentPauses() },
    );
    const expected = { bundle, title },
      timings = {};
    const started = performance.now();
    const observed = await desktop.elements(client, authorize);
    timings.firstObservationIncludingHelperBuildMs = Math.round(
      performance.now() - started,
    );
    assert.equal(observed.title, title);
    const field = observed.items.find(
      (item) =>
        item.name === "Fixture note" && /TextField|TextArea/.test(item.role),
    );
    assert.ok(
      field,
      "The synthetic text field is discoverable by its accessible name",
    );
    assert.ok(field.ref, "The field has a stable native reference");
    t.diagnostic(JSON.stringify({ beforeInput: await state() }));
    let at = performance.now();
    await desktop.act(client, { type: "element", ref: field.ref }, authorize, {
      expected,
    });
    const value = "Synthetic note 123";
    await desktop.act(
      client,
      {
        type: "fill",
        fields: [{ label: "Fixture note", text: value }],
        replace: true,
      },
      authorize,
      { expected },
    );
    timings.referenceClickAndFillMs = Math.round(performance.now() - at);
    await expectValue(value);
    at = performance.now();
    const changed = await desktop.elements(client, authorize);
    timings.followupObservationMs = Math.round(performance.now() - at);
    assert.ok(
      changed.items.some(
        (item) => item.name === "Fixture note" && item.value === value,
      ),
      "The agent can observe its completed change",
    );
    desktop.setPaused(client.id, true);
    await assert.rejects(
      desktop.act(client, { type: "type", text: "BLOCKED_PAUSE" }, authorize, {
        expected,
      }),
      (error) => error.status === 409 && error.kind === "paused",
    );
    assert.equal((await state()).value, value);
    desktop.setPaused(client.id, false);
    await desktop.elements(client, authorize);
    phone = true;
    await assert.rejects(
      desktop.act(client, { type: "type", text: "BLOCKED_PHONE" }, authorize, {
        expected,
      }),
      (error) => error.status === 409 && error.kind === "paused",
    );
    assert.equal((await state()).value, value);
    phone = false;
    await desktop.elements(client, authorize);
    await desktop.act(
      client,
      {
        type: "fill",
        fields: [{ label: "Fixture note", text: "Resumed fixture" }],
        replace: true,
      },
      authorize,
      { expected },
    );
    await expectValue("Resumed fixture");
    current = null;
    desktop.cancelClient(client.id);
    await assert.rejects(
      desktop.act(client, { type: "type", text: "BLOCKED_REVOKE" }, authorize, {
        expected,
      }),
      { status: 401 },
    );
    assert.equal((await state()).value, "Resumed fixture");
    t.diagnostic(
      JSON.stringify({
        ...timings,
        fixtureOnly: true,
        physicalPhone: false,
        modelInLoop: false,
      }),
    );
  },
);
