// All test execution goes through npm's guarded test:file entrypoint. This
// wrapper makes Windows selection explicit and keeps machine-readable reports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const suites = {
  windows: [
    "agent-install", "agent-sign-in", "browser-mutations", "private-ingress-platform",
    "agent-admission-auth", "agent-request-limit", "agent-transport", "auth-cache",
    "browser-file-boundary", "browser-platform-capabilities", "capabilities", "ci-policy",
    "integration", "mcp-entrypoints", "native-sharing", "node-runtime-files", "notice-versions",
    "release-assets", "release-privacy", "terminal-keys", "terminal-lifecycle", "terminal-liveness", "terminal-windows-exit",
    "uploads-concurrency", "windows-agent-cli", "windows-commands", "windows-screen-helpers", "phone-link", "jobs", "windows-recycle",
    // Shared phone gestures must also run against Windows' input contract.
    "touch-scroll", "screen-scroll-momentum-ui", "screen-scroll-ui", "screen-touch-accuracy-ui",
    "screen-pointer", "desktop-performance", "desktop-control-safety", "desktop-input-lifecycle",
    "windows-desktop-input-native",
    "screen-owner-first-ui", "screen-presentation", "screen-bar-placement", "screen-bar-ui",
    "screen-typing-integration", "screen-tap-to-type-ui", "field-probe-ui", "field-map",
    "remote-typing", "remote-keyboard",
    "tap-clicks", "screen-double-click-ui",
    // Bug bash recovery: shared chat/file UI and native input refusals.
    "chat-send-recovery-ui", "file-send-recovery-ui", "app-context-recovery-ui",
    // Keeping what Reach drives in sync: Codex's service update (Oct 13).
    "keep-in-sync",
    // Mascots for invited agents and people: the shared deck and faces (Oct 13).
    "mascot-deck", "mascots-ui",
    // Shared cross-agent archives and bounded context on macOS and Windows.
    "portable-history", "transfer-context", "agent-move", "agent-move-sessions", "move-provider-authorization",
    // Agent parity, workstream A (docs/WINDOWS_AGENT_PARITY.md).
    "app-identity", "agent-desktop-windows", "agent-guard-windows", "windows-native-build",
    // Workstream D, the public door (docs/parity/D-public-door.md §7.1).
    "windows-keyed-ingress", "tailscaled-peer", "foreground-funnel", "windows-account-flag",
    "windows-route-audit", "windows-private-folder", "windows-oracle",
    // Coding agents, workstream M.
    "windows-codex-transport", "windows-pipe-owner", "windows-codex-holder", "windows-team-bridge",
    // Hearing the computer beside its screen (Oct 13): the shared part.
    "screen-sound", "screen-sound-route", "screen-sound-ui", "sound-worklet", "tone-stability",
    // OpenClaw's guided setup: its words whole, its progress, one page (Oct 13).
    "openclaw-wizard",
    // Auto-continue: here when usage is back, or the first provider free (Oct 14).
    "auto-continue", "across-agents-ui", "claude-usage-ui",
  ],
  native: [
    "agent-input", "browser-terminal-routes", "money-sites",
    "agent-claude-model-native", "agent-desktop-focus-native",
    "agent-desktop-pointer-native", "agent-desktop-policy-native",
    "agent-desktop-release-native", "agent-desktop-text-native",
    "agent-navigation-native", "browser-app-native", "browser-control-policy-native",
    "browser-file-boundary", "browser-script-guarded-files", "browser-scripts",
    "node-runtime-files", "security-resilience-cursor-native",
    "remote-desktop", "remote-screen-hub", "tool-page-runtime",
    "ios-background-transfer-native",
    // The Mac's sound helper, built and self-tested (Oct 13).
    "screen-sound-native",
  ],
};

export function testFiles(suite, root = process.cwd()) {
  const names = suite === "all"
    ? fs.readdirSync(path.join(root, "test")).filter(name => name.endsWith(".test.mjs")).sort()
    : suites[suite]?.map(name => `${name}.test.mjs`);
  if (!names?.length) throw Error(`Unknown or empty CI test suite: ${suite}`);
  return names.map(name => {
    const file = path.join("test", name);
    if (!fs.statSync(path.join(root, file)).isFile()) throw Error(`Missing required test: ${file}`);
    return file;
  });
}

export async function run(suite) {
  if (!process.env.npm_execpath) throw Error("Run through npm run test:ci, test:ci:windows, or test:ci:native.");
  if (suite === "native" && process.platform !== "darwin") throw Error("The native security suite requires macOS; a skipped suite is not a pass.");
  const files = testFiles(suite);
  fs.mkdirSync("reports", { recursive: true });
  const args = [process.env.npm_execpath, "run", "test:file", "--",
    "--test-timeout=180000", `--test-concurrency=${suite === "native" ? 1 : 2}`,
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=junit", `--test-reporter-destination=reports/${suite}.xml`,
    "--test-reporter=tap", `--test-reporter-destination=reports/${suite}.tap`, ...files];
  let builds = null;
  const nativeDir = suite === "native" ? fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-native-")) : null;
  try {
    const nativeEnv = {};
    if (nativeDir) {
      // Compile the production helpers in a disposable directory. The enabled
      // video cases use generated pixels or reject malformed rules before
      // capture; PDF rendering consumes only synthetic plain text.
      for (const [name, variable] of [
        ["screen-stream", "REACH_TEST_VIDEO_HELPER"],
        ["tool-receipt", "REACH_TEST_TOOL_PDF_BINARY"],
      ]) {
        const output = path.join(nativeDir, name);
        await exec("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-O", `scripts/native/${name}.swift`, "-o", output], { timeout: 180000, maxBuffer: 4 << 20 });
        nativeEnv[variable] = output;
      }
      Object.assign(nativeEnv, { REACH_TEST_APP_NATIVE: "1", REACH_TEST_FILE_BOUNDARY: "1", REACH_TEST_SCRIPT_SANDBOX: "1" });
    }
    // One folder of native helper builds for the whole suite (named by source
    // hash, built whole or not at all), not one per test's data folder.
    builds = process.platform === "darwin" ? fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-builds-")) : null;
    if (builds) {
      nativeEnv.REACH_TEST_NATIVE_DIR = builds;
      // Compiled before any test, as Reach compiles it at start: an agent's
      // file request has 30 seconds, and a cold Intel runner took longer to
      // compile it inside the first one (Oct 12, PR 21).
      process.env.REACH_TEST_NATIVE_DIR = builds;
      const { desktopBinary } = await import("../../server/desktop-native.mjs");
      await desktopBinary({ dataDir: builds }, "browser-files");
    }
    const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...nativeEnv } });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    const code = await new Promise(resolve => child.on("close", (code, signal) => resolve(signal ? 1 : code ?? 1)));
    process.exitCode = code;
  } finally {
    if (nativeDir) fs.rmSync(nativeDir, { recursive: true, force: true });
    if (builds) fs.rmSync(builds, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv[2]);
