import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, loadJson, openPairingWindow } from "../server/core.mjs";
import { stateDir, command, packaged } from "./home.mjs";
import { protectedFolder } from "./background-service.mjs";
import { readPreferences, configure, preferencesFile, accountApproval } from "./configure.mjs";

// First-run setup for `./reach`: one guided flow that gets this computer ready,
// then starts Reach. Every step saves as it finishes, so stopping (Ctrl+C) and
// running `./reach` again picks up where it left off. Nothing here needs npm
// packages, so it still works while Reach is installing them on first run.
//
// Steps: 1) Tailscale + your account + what to share, 2) invite links so
// people and agents can join without the Tailscale app (optional), 3) keep
// Reach running in the background (optional). `./reach setup` re-runs it;
// `./reach setup invites` (or account) jumps straight to one step.

export const SETUP_SECTIONS = ["account", "link", "invites", "background"];
const DNS_PAGE = "https://login.tailscale.com/admin/dns";

// What still blocks the phone's HTTPS link: MagicDNS (names like
// mac.tail1.ts.net) and HTTPS certificates, both switches on one Tailscale
// page. Funnel (the start page for phones without the app) is allowed with
// one click when Reach first starts, so it doesn't hold setup up.
export function linkProblem(status) {
  if (status?.CurrentTailnet?.MagicDNSEnabled === false) return "magicdns";
  if (!status?.CertDomains?.length) return "https";
  return null;
}
const openPage = (url) =>
  new Promise((resolve) => {
    const platform = process.platform;
    if (!["darwin", "win32"].includes(platform) || !process.stdout.isTTY)
      return resolve();
    Promise.all([
      import("node:child_process"),
      import("./tailscale-connect.mjs"),
    ]).then(([{ execFile }, { pageOpener }]) =>
      execFile(...pageOpener(platform, url), () => resolve()),
    );
  });
const onboardingFile = (root) => path.join(stateDir(root), "onboarding.json");

export function readProgress(root) {
  const value = loadJson(onboardingFile(root), null);
  return value && value.version === 1 ? value : null;
}
function writeProgress(root, progress) {
  atomicJson(onboardingFile(root), { version: 1, ...progress });
}

// Whether bare `./reach` should walk through setup. A finished setup, or a
// computer configured before this flow existed, never sees it again.
export function needsOnboarding(root, deps = {}) {
  const progress = (deps.readProgress || readProgress)(root);
  if (progress?.done) return false;
  let configured = false;
  try {
    configured = !!(deps.readPreferences || readPreferences)(root);
  } catch {
    // A broken preferences file: setup can repair it.
    configured = false;
  }
  if (configured && !progress) {
    // Already set up before onboarding existed: record it done, don't prompt.
    writeProgress(root, { steps: { account: "done" }, done: true });
    return false;
  }
  return !progress?.done;
}

const mark = (state) =>
  state && state !== "pending" ? "✔" : state === "pending" ? "·" : "○";
const line = (n, title, note) => `  ${n}. ${title}${note ? `  ${note}` : ""}`;

// The step list, with a check on what's done. Shown at the start and after
// each step so progress is always visible (OpenClaw-style, but plain text).
function board(print, steps, progress, activeId) {
  print(`\n  Reach setup · ${command}\n`);
  for (const [i, step] of steps.entries()) {
    const state = progress.steps?.[step.id];
    const m =
      step.id === activeId ? "▸" : mark(state === undefined ? null : state);
    const note =
      state && state !== "pending"
        ? progress.notes?.[step.id] || labelFor(step.id, state)
        : step.optional
          ? "optional"
          : "";
    print(`  ${m} ${i + 1}. ${step.title}${note ? `  —  ${note}` : ""}`);
  }
  print("");
}
function labelFor(id, state) {
  if (id === "invites") return state === "skipped" ? "set up later" : "ready";
  if (id === "background")
    return state === "background" ? "runs in the background" : state === "login" ? "opens in Terminal at sign-in" : "this terminal";
  return "done";
}

// A computer needs a device identity before it can make invite keys; the
// server writes it on first start, so create it here (same shape, same id) if
// setup offers invites before Reach has ever run.
function ensureDeviceId(dataDir) {
  const file = path.join(dataDir, "device.json");
  const existing = loadJson(file, null);
  if (existing?.id) return existing.id;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  atomicJson(file, { id });
  return id;
}

function makeSteps(root, deps) {
  const platform = deps.platform || process.platform;
  const dataDir =
    deps.dataDir ||
    process.env.REACH_DATA ||
    path.join(stateDir(root), "quick");
  // Windows approves phones by pairing code (configure.mjs accountApproval):
  // no account or folders to save, and no start page for invites.
  const byAccount = accountApproval(platform);
  return [
    {
      id: "account",
      title: byAccount ? "Tailscale account & sharing" : "Tailscale on this computer",
      async run({ print, select, ask, explicit }) {
        const ensureTailscale =
          deps.ensureTailscale ||
          (await import("./tailscale-connect.mjs")).ensureTailscale;
        const status = await ensureTailscale(deps.tailscale || { select, print });
        if (!byAccount)
          return {
            note: status?.User?.[status?.Self?.UserID]?.LoginName || "connected",
          };
        const prefs = await (deps.configure || configure)(root, {
          select,
          ask,
          print,
          quiet: true,
          ...deps.configureDeps,
        });
        if (explicit)
          print(
            "  A Reach that's already running keeps its old settings until it restarts.",
          );
        return { note: prefs?.owner?.login || "connected" };
      },
    },
    {
      id: "link",
      title: "HTTPS link for your phone",
      async run({ print, select }) {
        const status =
          deps.status ||
          (async () =>
            (await import("./tailscale.mjs")).tailscaleJson([
              "status",
              "--json",
            ]));
        const sleep =
          deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const deadline = Date.now() + (deps.waitMs ?? 15 * 60_000);
        let shown = "";
        // The private socket Tailscale reaches Reach through must fit macOS's
        // path limit: a long account name is said now, not after setup.
        if (byAccount)
          (deps.socketPath || (await import("../server/tailscale-auth.mjs")).serveSocketPath)(root);
        for (;;) {
          let connection;
          try { connection = await status(); } catch {}
          // The account step may have finished on an earlier run. Signing
          // out, quitting or uninstalling Tailscale while setup is paused
          // must go through connection recovery before checking DNS/HTTPS.
          if (connection?.BackendState !== "Running") {
            const ensureTailscale = deps.ensureTailscale ||
              (await import("./tailscale-connect.mjs")).ensureTailscale;
            connection = await ensureTailscale(deps.tailscale || { select, print });
          }
          const problem = linkProblem(connection);
          if (!problem) return { note: "ready" };
          if (problem !== shown) {
            shown = problem;
            print(
              problem === "magicdns"
                ? `  Turn on MagicDNS for your tailnet: one switch on this page (opening it):\n  ${DNS_PAGE}`
                : `  Turn on HTTPS certificates for your tailnet: one click on this page (opening it):\n  ${DNS_PAGE}`,
            );
            print(`  Waiting… (Ctrl+C to stop; ${command} picks up here)`);
            await (deps.open || openPage)(DNS_PAGE);
          }
          if (Date.now() > deadline)
            throw Error(
              `${problem === "magicdns" ? "MagicDNS" : "HTTPS certificates"} is still off. Turn it on at ${DNS_PAGE}, then run ${command} again.`,
            );
          await sleep(1500);
        }
      },
    },
    {
      id: "invites",
      title: "Invite people & agents without the Tailscale app",
      optional: true,
      skip: !byAccount,
      async run({ print, select, ask, explicit }) {
        const choice = explicit
          ? "now"
          : await select({
              message: "Set up invite links now?",
              choices: [
                {
                  value: "later",
                  label: "Later",
                  description: `Do it from your phone, or run ${command} setup invites.`,
                  recommended: true,
                },
                {
                  value: "now",
                  label: "Set it up now",
                  description: "A one-time Tailscale step, about 3 minutes.",
                },
              ],
            });
        if (choice !== "now") return { state: "skipped" };
        ensureDeviceId(dataDir);
        const setupInvites =
          deps.setupInvites || (await import("./invites.mjs")).setupInvites;
        const invites = await setupInvites(root, { select, ask, print, ...deps.invitesDeps });
        // Declined at the policy change: set up later, setup goes on.
        if (invites?.ready === false) return { state: "skipped" };
        return { state: "done", note: "ready" };
      },
    },
    {
      id: "background",
      title: "Keep Reach running in the background",
      optional: true,
      skip: platform !== "darwin",
      async run({ select }) {
        // In Documents (and the like) a background service never starts:
        // Reach opens in Terminal at sign-in instead.
        const folder = (deps.protectedFolder || protectedFolder)(root, { platform });
        const choice = await select({
          message: "Keep Reach running after you close this terminal?",
          choices: [
            {
              value: "foreground",
              label: "No, only while this terminal is open",
              recommended: true,
            },
            folder
              ? {
                  value: "login",
                  label: "Yes, open it in Terminal each time I sign in",
                  description: `macOS keeps background services out of your ${folder} folder, where Reach is. Terminal can use it, and keeps Reach's live screen and control.`,
                }
              : {
                  value: "background",
                  label: "Yes, start it at login and keep it running",
                  description: "Installs a background service (you can remove it). Without a Terminal window it has no live screen or control, and can't approve new phones.",
                },
          ],
        });
        return { state: choice, note: labelFor("background", choice) };
      },
    },
  ].filter((s) => !s.skip);
}

// Run the guided setup. `only` runs a single section. On a finished setup
// with no section, it lists the current settings and asks what to change.
// Returns how to start Reach ({ launch: "background" | "foreground" }) and
// which steps ran now ({ ran }), so the caller can install or start it; lock
// ordering and the install path stay in one place.
export async function runSetup(root, { only, deps = {} } = {}) {
  const print = deps.print || console.log;
  const ui = deps.ui || (await import("./prompts.mjs")).terminalPrompts();
  const select = deps.select || ui.select;
  const ask = deps.ask || ui.ask;
  const all = makeSteps(root, deps);
  if (only && !all.some((s) => s.id === only))
    throw Error(
      `Unknown setup section "${only}". Try: ${all.map((s) => s.id).join(", ")}.`,
    );
  let progress = (deps.readProgress || readProgress)(root) || { steps: {} };
  progress.steps ||= {};
  progress.notes ||= {};
  // Already set up: show where things stand, change one thing (or start over).
  if (!only && progress.done) {
    board(print, all, progress);
    const pick = await select({
      message: "What do you want to change?",
      choices: [
        { value: "", label: "Nothing", recommended: true },
        ...all.map((s) => ({ value: s.id, label: s.title })),
        {
          value: "over",
          label: "Start setup over",
          description: "Paired phones and access stay as they are.",
        },
      ],
    });
    if (!pick) return { launch: launchOf(progress), progress, ran: [] };
    if (pick === "over") progress = { steps: {}, notes: {} };
    else only = pick;
  }
  const resuming = !only && Object.keys(progress.steps).length > 0;
  if (!only)
    print(
      resuming
        ? `\n  Picking up your Reach setup where you left off.`
        : `\n  Welcome to Reach. A short setup: stop any time with Ctrl+C, and ${command} picks it up again.`,
    );
  const ran = [];
  for (const step of all.filter((s) => !only || s.id === only)) {
    // A full run skips finished steps; a chosen section is redone.
    if (
      !only &&
      progress.steps[step.id] &&
      progress.steps[step.id] !== "pending"
    )
      continue;
    board(print, all, progress, step.id);
    let result;
    try {
      result = (await step.run({ print, select, ask, explicit: !!only })) || {};
    } catch (error) {
      if (/cancell?ed|Paused/i.test(error.message)) {
        print(`\n  Paused. Run ${command} to continue your setup.`);
        throw Object.assign(Error("Setup paused."), { paused: true });
      }
      throw error;
    }
    progress.steps[step.id] = result.state || "done";
    if (result.note) progress.notes[step.id] = result.note;
    else delete progress.notes[step.id];
    ran.push(step.id);
    // Re-running one section never un-finishes a completed setup.
    if (!only)
      progress.done = all.every(
        (s) => progress.steps[s.id] && progress.steps[s.id] !== "pending",
      );
    writeProgress(root, progress);
  }
  board(print, all, progress);
  print(
    only
      ? `  Saved.\n`
      : `  Setup complete. Change anything later with ${command} setup.\n`,
  );
  return { launch: launchOf(progress), progress, ran };
}
const launchOf = (progress) =>
  ["background", "login"].includes(progress.steps.background) ? progress.steps.background : "foreground";

// After a first run moves Reach to the background: wait for it to start, show
// the link (and QR), then approve the phone right here, by the code it shows,
// exactly as a Reach in the foreground does.
export async function connectPhone(root, { since = 0, deps = {} } = {}) {
  const print = deps.print || console.log;
  const sleep =
    deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const hostFile = path.join(stateDir(root), "host-status.json");
  // Only the background Reach's own, fresh status counts.
  const readHost =
    deps.readHost ||
    (() => {
      try {
        if (fs.statSync(hostFile).mtimeMs < since) return null;
      } catch {
        return null;
      }
      const host = loadJson(hostFile, null);
      return host?.service ? host : null;
    });
  // What the service said when it failed to start (its error log, written
  // since it was installed): shown, rather than waiting minutes in silence.
  const errorLog = path.join(stateDir(root), "logs", "companion-error.log");
  const readFailure =
    deps.readFailure ||
    (() => {
      try {
        if (fs.statSync(errorLog).mtimeMs < since) return "";
        return fs.readFileSync(errorLog, "utf8").trim().split("\n").filter(Boolean).pop() || "";
      } catch {
        return "";
      }
    });
  print("\n  Starting Reach in the background…");
  let host = null;
  const started = Date.now();
  for (
    const until = Date.now() + (deps.startMs ?? 5 * 60_000);
    Date.now() < until;
  ) {
    host = readHost();
    if (host?.origin?.startsWith("https://") && host.dataDir) break;
    host = null;
    // Still not up a while later, and it said why: it isn't going to be.
    const failure = Date.now() - started > (deps.failAfterMs ?? 20_000) ? readFailure() : "";
    if (failure) {
      print(
        `  Reach couldn't start in the background: ${failure.replace(/^Reach:\s*/, "")}\n  Its log: ${errorLog}\n  Run ${command} uninstall, fix that, then ${command} setup background again. Or run ${command} here meanwhile.`,
      );
      return false;
    }
    await sleep(1000);
  }
  if (!host) {
    print(
      `  Reach is still starting. When it's ready: ${command} status, then open its link on your phone and run ${command} approve.`,
    );
    return false;
  }
  // The one address works for every phone, with or without the Tailscale
  // app: shown once this Reach answers there (from here, as your devices do).
  const start = `https://${new URL(host.origin).hostname}`;
  const reachable =
    deps.reachable ||
    ((url) =>
      fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" })
        .then(async (r) => {
          const health = r.ok && (await r.json());
          return (
            health?.product === "Reach" && health.instance === host.instance
          );
        })
        .catch(() => false));
  const link =
    host.link ||
    ((await reachable(`${start}/api/health`)) ? start : host.origin);
  // At the one address, a phone without the Tailscale app signs in from its
  // browser: the start page answers while you're here to approve it.
  const oneAddress = link !== host.origin;
  if (oneAddress) (deps.openWindow || openPairingWindow)(host.dataDir);
  print(`\n  Open on your phone: ${link}\n`);
  try {
    const qr = deps.qr || (await import("qrcode-terminal")).default;
    qr.generate(link, { small: true });
  } catch {}
  print(
    oneAddress
      ? `  With the Tailscale app, it opens straight away; without it, sign in to Tailscale in the phone's browser in the next 15 minutes.\n  Then tap Connect. Waiting for your phone… (Ctrl+C to do it later with ${command} pair)`
      : `  Your phone needs the Tailscale app, on and signed in. Then tap Connect. Waiting for your phone… (Ctrl+C to do it later with ${command} approve)`,
  );
  const approvals = await import("./approve-device.mjs");
  const pending =
    deps.pending || (() => approvals.pendingApprovals(host.dataDir));
  const decide =
    deps.decide || ((code) => approvals.decideApproval(host.dataDir, code));
  const ask = deps.ask || (await import("./prompts.mjs")).terminalPrompts().ask;
  const seen = new Set();
  for (
    const until = Date.now() + (deps.waitMs ?? 15 * 60_000);
    Date.now() < until;
  ) {
    const request = pending().find((r) => !seen.has(r.id));
    if (!request) {
      await sleep(1000);
      continue;
    }
    seen.add(request.id);
    print(`\n  New device:\n${approvals.describeApproval(request)}`);
    for (;;) {
      const answer = (
        await ask(
          "  Type the code shown on your phone to approve it (or deny <code>):",
        )
      ).trim();
      try {
        print(`  ${decide(answer)}`);
        if (!answer.startsWith("deny ")) {
          print(
            "  Your phone is connected. Reach keeps running in the background.\n",
          );
          return true;
        }
        break; // denied: keep waiting for the right phone
      } catch (error) {
        print(`  ${error.message}`);
      }
    }
  }
  print(
    `  No phone yet. Later: open ${link} on it, then run ${command} approve.`,
  );
  return false;
}
