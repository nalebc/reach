import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { assertDisposableWindows, desktopRequiredForSelection, desktopSourcePayload, lastDesktopCheckpoint } from "../.github/scripts/prepare-windows-desktop.mjs";
import * as desktopDiagnostics from "../.github/scripts/prepare-windows-desktop.mjs";

const hosted = { SystemRoot: "C:\\Windows", GITHUB_ACTIONS: "true", CI: "true", RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY: "nalebc/reach", REACH_CI_DESKTOP_PREFLIGHT: "1" };

test("CI desktop preparation refuses any missing disposable-hosted boundary before executing Windows code", () => {
  assert.doesNotThrow(() => assertDisposableWindows({ platform: "win32", env: hosted }));
  for (const platform of ["darwin", "linux"]) assert.throws(() => assertDisposableWindows({ platform, env: hosted }));
  for (const key of Object.keys(hosted)) for (const value of [undefined, "", "false", "self-hosted", "other/repository"])
    assert.throws(() => assertDisposableWindows({ platform: "win32", env: { ...hosted, [key]: value } }), key);
  for (const root of ["Windows", "C:\\Windows\\..\\other", "\\\\host\\Windows", "C:\\Users\\me\\Windows"])
    assert.throws(() => assertDisposableWindows({ platform: "win32", env: { ...hosted, SystemRoot: root } }));
});

test("the actual CI desktop entry point refuses outside the explicit runner gate", () => {
  const script = fileURLToPath(new URL("../.github/scripts/prepare-windows-desktop.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, REACH_CI_DESKTOP_PREFLIGHT: "0" }, encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit disposable public GitHub-hosted Windows gate/);
});

test("manual peer and ACL selections do not acquire a desktop dependency", () => {
  for (const names of ["windows-tailscaled-peer", "windows-codex-socket-native", "windows-owner-rights windows-state-normalization", "windows-native-build windows-claude-hooks"])
    assert.equal(desktopRequiredForSelection(names), false, names);
  for (const names of ["journeys/home", "windows-console", "windows-terminals-native", "windows-desktop-e2e", "windows-owner-rights journeys/files", "new-native-file", ""])
    assert.equal(desktopRequiredForSelection(names), true, names);
});

test("CI desktop progress retains only the last exact allowlisted marker", () => {
  const marker = "REACH_CI_DESKTOP_STAGE:";
  assert.equal(lastDesktopCheckpoint(`${marker}compiled\r\nprivate stderr\n${marker}probe-show\n`), "probe-show");
  for (const line of ["secret-token", `${marker}unknown`, `${marker}probe-show secret-token`,
    ` ${marker}probe-show`, `${marker}probe-show\rsecret-token`, `${marker}probe-show/secret-token`,
    `${marker}probe-show\u0000`, `${marker}probe-show `]) assert.equal(lastDesktopCheckpoint(line), null);
  assert.equal(lastDesktopCheckpoint(undefined), null);
  assert.equal(lastDesktopCheckpoint(`${marker}compiled\n${marker}secret-token`), "compiled");
});

test("desktop diagnostic timing tuples retain only bounded known stages and one monotonic own process", () => {
  assert.equal(typeof desktopDiagnostics.desktopTimingEvidence, "function");
  const parse = desktopDiagnostics.desktopTimingEvidence;
  const prefix = "REACH_CI_DESKTOP_TIME:";
  const result = parse(`${prefix}compile-start:4:4321\r\n${prefix}compiled:1200:4321\n${prefix}probe-pixel-copied:1410:4321\n`);
  assert.deepEqual(result, { samples: [
    { stage: "compile-start", elapsedMs: 4, pid: 4321 },
    { stage: "compiled", elapsedMs: 1200, pid: 4321 },
    { stage: "probe-pixel-copied", elapsedMs: 1410, pid: 4321 },
  ], rejected: 0, truncated: false });
  for (const tuple of ["secret-token:1:4321", "compiled secret-token:1:4321", "compiled:-1:4321",
    "compiled:1.5:4321", "compiled:1e3:4321", "compiled:120001:4321", "compiled:9999999:4321",
    "compiled:1:-1", "compiled:1:0", "compiled:1:1", "compiled:1:2147483648", "compiled:1:999999999999",
    "compiled:1:4321:secret-token", "compiled:1:4321\0", "compiled:1:4321 secret-token"])
    assert.deepEqual(parse(prefix + tuple), { samples: [], rejected: 1, truncated: false }, tuple);
  assert.deepEqual(parse(`${prefix}compiled:10:4321\n${prefix}probe-pixel:9:4321\n${prefix}probe-pixel:11:4322\n`),
    { samples: [{ stage: "compiled", elapsedMs: 10, pid: 4321 }], rejected: 2, truncated: false });
  assert.deepEqual(parse(` ${prefix}compiled:1:4321\nprivate stderr`), { samples: [], rejected: 0, truncated: false });
  assert.deepEqual(parse(`${prefix}compiled:1:4321\n` + "x".repeat(128 * 1024)), { samples: [], rejected: 0, truncated: false });
  const many = parse(Array.from({ length: 49 }, (_, i) => `${prefix}compiled:${i}:4321`).join("\n"));
  assert.equal(many.samples.length, 48);
  assert.equal(many.truncated, true);
  assert.equal(many.rejected, 0);
  assert.equal(JSON.stringify(parse(`${prefix}secret-token:1:4321`)).includes("secret-token"), false);
});

test("desktop failure diagnostics expose only bounded exit facts and native completion booleans", () => {
  assert.equal(typeof desktopDiagnostics.desktopFailureEvidence, "function");
  const parse = desktopDiagnostics.desktopFailureEvidence;
  const stdout = JSON.stringify({ schema: 1, ready: true, secret: "secret-token", actions: ["private command"] });
  assert.deepEqual(parse({ code: "ETIMEDOUT", status: null, signal: "SIGTERM", stdout: Buffer.from(stdout),
    message: "secret-token", args: ["private command"], env: { secret: "secret-token" } }),
    { code: "ETIMEDOUT", status: null, signal: "SIGTERM", stdoutBytes: Buffer.byteLength(stdout), nativeReportComplete: true, nativeReady: true });
  assert.equal(JSON.stringify(parse({ code: "secret-token", signal: "private command", status: Infinity, stdout })).includes("secret-token"), false);
  for (const status of [-2147483648, 0, 1, 4294967295]) assert.equal(parse({ status }).status, status);
  for (const status of [-2147483649, 4294967296, 1.5, Infinity, "1"]) assert.equal(parse({ status }).status, null);
  for (const body of ["secret-token", "{}", "[]", '{"schema":1,"ready":"secret-token"}', "x".repeat(128 * 1024 + 1)]) {
    const result = parse({ stdout: body });
    assert.equal(result.nativeReportComplete, false);
    assert.equal(result.nativeReady, null);
    assert.ok(result.stdoutBytes <= 128 * 1024 + 1);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
  }
  assert.equal(parse({ stdout: '{"schema":1,"ready":false}' }).nativeReady, false);
});

test("the actual checked-in C# has one bounded payload across LF and CRLF filesystem checkouts", () => {
  const source = fs.readFileSync(new URL("../.github/scripts/windows-desktop-preflight.cs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reach-desktop-source-"));
  try {
    for (const [name, contents] of [["lf.cs", source], ["crlf.cs", source.replace(/\n/g, "\r\n")]]) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, contents, { mode: 0o600 });
      const payload = desktopSourcePayload(fs.readFileSync(file, "utf8"));
      assert.equal(payload, source, `${name} keeps the same C# compiler input`);
      assert.ok(payload.length <= 24000, `${name} retains the environment protocol cap`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("CI desktop source keeps the exact 24000-character payload limit", () => {
  assert.equal(desktopSourcePayload("x".repeat(23999) + "\r\n").length, 24000);
  for (const source of ["x".repeat(24001), "x".repeat(24000) + "\r\n"])
    assert.throws(() => desktopSourcePayload(source), /bounded environment protocol/);
});

test("native Windows CI phases require desktop preflight success and preserve budgets and failure gates", () => {
  const workflow = (name) => parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  for (const [name, job] of [["ci", "verify"], ["windows-validation", "windows"], ["real-windows-acceptance", "real-windows"]]) {
    const config = workflow(name).jobs[job];
    const step = config.steps.find((s) => s.id === "desktop_preflight");
    assert.equal(step.run, `node .github/scripts/prepare-windows-desktop.mjs${name === "windows-validation" ? " --if-needed" : ""}`);
    assert.equal(step.env.REACH_CI_DESKTOP_PREFLIGHT, "1");
    assert.equal(step["continue-on-error"], undefined, "an unusable desktop must fail the job");
    const vendors = config.steps.find((s) => /install-windows-vendors/.test(s.run || ""));
    if (vendors) assert.ok(config.steps.indexOf(vendors) < config.steps.indexOf(step), "desktop refusal cannot prevent non-UI vendor prerequisites");
    const native = config.steps.filter((s) => /test\/acceptance\/real-windows|test\/windows-console|windows-validation\.mjs/.test(s.run || ""));
    assert.ok(native.length);
    for (const actual of native) {
      assert.ok(config.steps.indexOf(step) < config.steps.indexOf(actual));
      assert.match(actual.if, /steps\.desktop_preflight\.outcome == 'success'/);
      assert.equal(actual["continue-on-error"], undefined);
    }
    const independent = config.steps.filter((s) => /test\/windows-codex-socket-native|test:ci:windows|test\/windows-tailscaled-peer/.test(s.run || ""));
    assert.ok(independent.length);
    for (const actual of independent) {
      assert.doesNotMatch(actual.if, /desktop_preflight/);
      assert.match(actual.if, /!cancelled\(\)/);
      assert.equal(actual["continue-on-error"], undefined);
    }
    assert.equal(config["timeout-minutes"], name === "ci" ? 60 : name === "windows-validation" ? 40 : 30);
  }
  const ci = workflow("ci").jobs.verify;
  assert.equal(ci.steps.find((s) => /package-candidate/.test(s.run || ""))?.if, "${{ success() }}");
  const wrapper = fs.readFileSync(new URL("../.github/scripts/prepare-windows-desktop.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /timeout: 60000/);
  assert.doesNotMatch(wrapper, /ExecutionPolicy|Bypass/);
  assert.ok(desktopSourcePayload(fs.readFileSync(new URL("../.github/scripts/windows-desktop-preflight.cs", import.meta.url), "utf8")).length <= 24000);
});
