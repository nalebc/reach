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
    "agent-extended-expiry", "agent-screenshot-route", "agent-image-envelope", "agent-image-envelope-integration", "service-failure-guidance",
    "browser-file-boundary", "browser-platform-capabilities", "capabilities", "ci-policy",
    "integration", "mcp-entrypoints", "mcp-preset-tools", "native-sharing", "node-runtime-files", "notice-versions",
    "release-assets", "release-privacy", "terminal-keys", "terminal-lifecycle", "terminal-liveness", "terminal-windows-exit",
    "uploads-concurrency", "windows-agent-cli", "windows-commands", "tailscale-port", "browser-link", "public-dns", "public-start", "tailnet-transport", "setup", "windows-screen-helpers", "phone-link", "jobs", "windows-recycle",
    // Decode the emitted QR and follow it through a separate phone network.
    "qr-onboarding-e2e",
    // Shared phone gestures must also run against Windows' input contract.
    "touch-scroll", "screen-scroll-momentum-ui", "screen-scroll-ui", "screen-touch-accuracy-ui",
    "screen-pointer", "desktop-performance", "desktop-control-safety", "desktop-input-lifecycle",
    "windows-desktop-input-native",
    "screen-owner-first-ui", "screen-presentation", "screen-bar-placement", "screen-bar-ui",
    "screen-typing-integration", "screen-tap-to-type-ui", "field-probe-ui", "field-map",
    "remote-typing", "remote-keyboard",
    "tap-clicks", "screen-double-click-ui",
    // Bug bash recovery: shared chat/file UI and native input refusals.
    "agent-markdown-ui", "back-stack-ui",
    "chat-send-recovery-ui", "file-send-recovery-ui", "app-context-recovery-ui",
    "abort-polyfill", "upload-restart-ui", "background-transfer-ui", "transfer-cancel-ui",
    "file-download-race", "file-download-cleanup", "hidden-root-downloads", "transfers-server", "confined-file",
    "uploads-recovery", "upload-folder-race", "outbox-mutation-recovery", "native-helper-unicode", "supervise",
    "agent-compatibility", "reach-version", "agent-watch",
    "coding-task-tools", "coding-tasks", "coding-tasks-api", "coding-task-sessions",
    // Simulator orchestration and subprocess guards; real iOS runs in macOS CI.
    "ios-launch", "bounded-command",
    // Keeping what Reach drives in sync: Codex's service update (Oct 13).
    "keep-in-sync",
    // The user journeys, workstream J: the built phone interface in headless
    // Chrome against a real first install of Reach, page by page, ending in
    // the same visible result as on a Mac. What needs the PC's desktop (its
    // screen, input, windows) runs with REACH_TEST_WINDOWS_DESKTOP only.
    // On Windows CI all eight run once in the serial native step, including
    // their real browser startup; the concurrent contract lane defers them.
    "journeys/home", "journeys/terminals", "journeys/files", "journeys/chat", "journeys/screen", "journeys/apps",
    "journeys/access", "journeys/pause", "headless-chrome-lifecycle",
    // Mascots for invited agents and people: the shared deck and faces (Oct 13).
    "mascot-deck", "mascots-ui",
    // Shared cross-agent archives and bounded context on macOS and Windows.
    "portable-history", "transfer-context", "agent-move", "agent-move-sessions", "move-provider-authorization",
    // Agent parity, workstream A (docs/WINDOWS_AGENT_PARITY.md).
    "app-identity", "agent-desktop-windows", "agent-guard-windows", "windows-native-build",
    "agent-preset-invite-ui", "browser-platform-invite-ui", "windows-sandbox-grants",
    // Workstream D, the public door (docs/parity/D-public-door.md §7.1).
    "windows-keyed-ingress", "tailscaled-peer", "foreground-funnel", "windows-sign-in", "windows-sign-in-launch",
    "windows-route-audit", "windows-private-folder", "windows-oracle",
    // On by detection, as on a Mac (owner, Oct 13): Face ID join and linked
    // computers over the keyed route.
    "face-join", "fleet",
    // Workstreams K and L: the PC's process list (one Reach per computer),
    // status, stop, restart and Reach's own window, sleep prevention and the
    // background task, on a real PC.
    "windows-processes", "windows-lifecycle", "windows-stay-awake", "windows-background",
    // The first run's install alongside its setup, numbered menus included,
    // on Windows' own Node (audit #31; the real console is workstream U's).
    "first-start", "prompts",
    // Setup, status and stop on Windows' own Node: first run there Oct 14.
    "setup", "instances", "stop",
    // Workstream B, the agent desktop helper (docs/parity/B-desktop-helper.md):
    // its build, start and launch checks; its policy against the shared corpus;
    // on a real screen only with REACH_TEST_WINDOWS_DESKTOP (ci.yml's step).
    "windows-helper-launch", "agent-desktop-windows-policy", "windows-agent-desktop-native",
    // Coding agents, workstream M.
    "windows-codex-transport", "windows-pipe-owner", "windows-codex-holder", "windows-team-bridge",
    // Proof below the phone, workstream U (audit #18-#20, #22, #24): the
    // stand-in Tailscale's own tailscale.exe and the Tailscale-mode launches
    // on it; the first run, Ctrl+C and crash relaunch in a real console;
    // Files' ways out, icons and drives; reach-agent's join, MCP, pipe, keep
    // and restore, with the PowerShell commands agents are given.
    "windows-tailscale-stand-in", "windows-sign-in-launch", "windows-console", "windows-files", "file-icons", "archives",
    "agent-remote", "agent-runtime-pin", "agent-link-steps", "agent-credential-rotation", "agent-runtime-update", "agent-cli",
    // Shared credential renewal, browser tabs and recovery after lost replies.
    "agent-funnel-reconnect", "funnel-agent-ui", "agent-guide", "agent-services", "service-connectors", "service-tools-ui",
    // Background mode out of sight: no window from its task's programs.
    "windows-quiet-background",
    // Windows' live screen as H.264 with nothing installed (audit #26): the
    // choice and its reasons, the phone's Video row, and the real helper
    // (Desktop Duplication into Media Foundation) streaming this runner's
    // screen, decoded by Chrome's WebCodecs, when REACH_TEST_WINDOWS_DESKTOP is set.
    "windows-video", "screen-video-kind-ui", "remote-screen-client", "remote-screen-hub",
    "windows-screen-video-native",
    // Guests' live screen, workstream P (audit #12, #13): private windows
    // painted black in a guest's picture, guests let in once this PC's check
    // passes, and the invite sheet offering screen roles then (the real
    // pictures in windows-screen-video-native, the concealed clipboard in
    // windows-desktop-input-native, with REACH_TEST_WINDOWS_DESKTOP).
    "app-display-access", "invite-ui",
    // The Claude desktop app on Windows, workstream N: its data in either
    // install's folder, the PC's idle and lock readings.
    "claude-app-paths", "claude-locate", "windows-presence",
    // Its consent card answered from the phone: refused plainly on a PC
    // (no helper presses it there yet), never the Mac's Swift build.
    "agent-claude-consent",
    // Claude Code's permission prompts and mode switches answered from the
    // phone on Windows, workstream H: the named pipe, the exec-form hook, the
    // Node mode hook and the strict pipe-owner check (the mocked parts run
    // here; the real pipe-owner check and the end-to-end run with Claude Code
    // itself are gated on REACH_TEST_WINDOWS_DESKTOP, so they skip in this
    // lane and run in windows-validation).
    "windows-claude-hooks", "windows-claude-hooks-e2e",
    // Windows conveniences, workstream W: the owner's own shell in Reach's
    // terminals, drives attached later, the launcher's name on the phone.
    "windows-shell", "file-roots", "connect-states-ui",
    // Reach's icon in the notification area, workstream P (audit #16).
    "windows-tray",
    // Apps' icons and the agents' logos drawn by Windows (audit #28).
    "windows-app-icons",
    // Word, RTF and OpenDocument previews read in JS off a Mac (audit #37).
    "document-text", "file-kinds",
    // Voice memos as words through Windows' own recognizer (audit #35).
    "voice-messages",
    // OpenClaw natively (audit #15, Oct 13): npm's OpenClaw started through
    // Node with whole arguments, a key only in its variable or on stdin,
    // Telegram's token file closed to others, a timeout ending the whole
    // tree, and the install terminal's verdict. Beside OpenClaw's own
    // Windows app, its Gateway in WSL (the WSL scripts run by bash only on
    // Mac and Linux: WSL can't run on the runner).
    "windows-openclaw", "windows-openclaw-hub",
    // The PC's own terminals, workstream T: Windows Terminal's tabs and
    // console windows listed, read, typed into, closed and opened from the
    // phone, the real helper driven on this runner; the shared list and its
    // checks with them.
    "windows-terminals", "windows-terminals-native", "windows-terminals-ui",
    "desktop-terminals", "terminal-titles", "terminal-list-ui",
    // Hearing the computer beside its screen (Oct 13): the shared part.
    "screen-sound", "screen-sound-route", "screen-sound-ui", "sound-worklet", "tone-stability",
    // OpenClaw's guided setup: its words whole, its progress, one page (Oct 13).
    "openclaw-wizard",
    // Workstream C, the Windows sandbox (docs/parity/C-sandbox.md). The unit
    // tests run here on any host; the escape e2e are gated on a real runner
    // (REACH_TEST_WINDOWS_DESKTOP=1, CI=true) and skip in this lane, running in
    // ci.yml's real-Windows step and windows-validation.yml. A skip is not a pass.
    "windows-sandbox", "windows-path-validation", "windows-sandbox-e2e", "windows-file-boundary-e2e", "windows-agent-e2e",
    // Auto-continue: here when usage is back, or the first provider free (Oct 14).
    "auto-continue", "across-agents-ui", "claude-usage-ui",
    // Usage back on time when Claude's sign-in lapsed while unused (Oct 14).
    "usage-watch", "account-usage",
    // Workstream G, saved browser tools through Reach's Chrome/Edge extension
    // (docs/parity/G-browser-tools.md): the bridge, the extension, the shared
    // tool runner and its safety. Real Chrome and Edge run in ci.yml's
    // real-Windows step (windows-browser-tools-native).
    "browser-extension", "browser-extension-bridge", "tool-receipt-pdf", "tool-setup", "permission-requests", "tool-browser-safety",
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
    // Clocked audio must run without competing browser suites: its strict
    // speaker/underrun assertions also run in Windows' serial desktop step.
    "screen-sound-native", "screen-sound-chrome-e2e",
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
      Object.assign(nativeEnv, { REACH_TEST_APP_NATIVE: "1", REACH_TEST_FILE_BOUNDARY: "1", REACH_TEST_SCRIPT_SANDBOX: "1", REACH_TEST_SOUND_CHROME: "1" });
    }
    // One folder of native helper builds for the whole suite (named by source
    // hash, built whole or not at all), not one per test's data folder. A run
    // inside a suite (ci-policy's own) uses the suite's folder, already
    // built, and leaves it for the suite: a new one compiled the helper again,
    // past that test's 20 s on a loaded Intel runner (run 38451431163), where
    // this compile alone takes 17 to 44 s.
    const suiteBuilds = process.platform === "darwin" && process.env.REACH_TEST_NATIVE_DIR;
    const shared = suiteBuilds && fs.existsSync(suiteBuilds) ? suiteBuilds : null;
    builds = process.platform === "darwin" && !shared ? fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-builds-")) : null;
    const nativeBuilds = shared || builds;
    if (nativeBuilds) {
      nativeEnv.REACH_TEST_NATIVE_DIR = nativeBuilds;
      // Compiled before any test, as Reach compiles it at start: an agent's
      // file request has 30 seconds, and a cold Intel runner took longer to
      // compile it inside the first one (Oct 12, PR 21).
      process.env.REACH_TEST_NATIVE_DIR = nativeBuilds;
      const { desktopBinary } = await import("../../server/desktop-native.mjs");
      await desktopBinary({ dataDir: nativeBuilds }, "browser-files");
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
