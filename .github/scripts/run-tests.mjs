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
    "uploads-concurrency", "windows-commands", "windows-screen-helpers", "phone-link",
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
    const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...nativeEnv } });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    const code = await new Promise(resolve => child.on("close", (code, signal) => resolve(signal ? 1 : code ?? 1)));
    process.exitCode = code;
  } finally {
    if (nativeDir) fs.rmSync(nativeDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(process.argv[2]);
