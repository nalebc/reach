import path from "node:path";
import { terminalPrompts } from "./prompts.mjs";
import { loadJson } from "../server/core.mjs";
import { computerWord } from "../server/computer-word.mjs";
import { approvalStore } from "../server/device-approval.mjs";
import { stateDir, command } from "./home.mjs";
import { accountApproval, flagMissing, FLAG_MISSING } from "./configure.mjs";
export const safeLabel = (value) =>
  String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
export function pendingApprovals(dataDir) {
  return approvalStore(dataDir)
    .list()
    .filter((r) => r.status === "pending");
}
// From this computer itself: tailscaled serves the computer's own
// connections too, so anyone signed in to it could have asked as you; said
// on a Mac as on Windows (docs/parity/D-public-door.md §0.8, D1).
export const thisComputerNote = (platform = process.platform) =>
  platform === "win32"
    ? "From this PC itself: anyone signed in to Windows here could have asked. Approve only if you just asked from this PC's browser."
    : `From this ${computerWord(platform)} itself: anyone signed in to it could have asked. Approve only if you just asked from a browser on it.`;
export function describeApproval(r, platform = process.platform) {
  return `${r.id.slice(0, 8)} · ${safeLabel(r.name)}\n  Tailscale: ${safeLabel(r.login)} · ${safeLabel(r.nodeName)}\n  Grants owner access (including terminals and files); screen control stays separately enabled.${r.thisComputer === true ? `\n  ${thisComputerNote(platform)}` : ""}`;
}
export function decideApproval(dataDir, value) {
  const deny = value.startsWith("deny ");
  const code = (deny ? value.slice(5) : value).trim();
  if (!/^[a-f0-9]{8}$/.test(code))
    throw Error(
      "Enter the eight-character request shown on your phone, or deny followed by that request.",
    );
  const matches = pendingApprovals(dataDir).filter((r) =>
    r.id.startsWith(code),
  );
  if (matches.length !== 1)
    throw Error(
      "No unique pending request matches. Open Connect on the phone and try again.",
    );
  approvalStore(dataDir).decide(matches[0].id, deny ? "deny" : "approve");
  return deny
    ? "Connection denied."
    : "Device approved. Your phone will connect automatically.";
}
export async function approveDevice(root, deps = {}) {
  const print = deps.print || console.log;
  const host = loadJson(path.join(stateDir(root), "host-status.json"), null);
  if (!host?.tailscaleApproval || !host.dataDir)
    throw Error(
      // Windows, started for browser sign-in, then back on pairing codes.
      typeof host?.signInOff === "string" && host.signInOff
        ? `Browser sign-in is off on this PC for now: ${host.signInOff} A phone joins with the pairing code Reach shows in its terminal. For a fresh one: ${command} pair`
        : accountApproval(deps.platform, deps.env)
        ? `Start Reach with ${command} configure completed, then request access on your phone.`
        : `On Windows, a phone joins with the pairing code Reach shows in its terminal. For a fresh one: ${command} pair${flagMissing(root, deps.platform, deps.env) ? ` ${FLAG_MISSING}` : ""}`,
    );
  const pending = pendingApprovals(host.dataDir);
  if (!pending.length) {
    print(
      "No pending devices. Open Reach's link on your phone (the QR in Reach's terminal).",
    );
    return;
  }
  if (!deps.select && !process.stdin.isTTY)
    throw Error(
      `Run ${command} approve in an interactive terminal on this computer.`,
    );
  const ui = terminalPrompts();
  const select = deps.select || ui.select,
    ask = deps.ask || ui.ask;
  const selected = await select({
    message: "Which device request do you want to review?",
    choices: [
      ...pending.map((r) => ({
        value: r.id,
        label: safeLabel(r.name),
        description: `${safeLabel(r.nodeName)} · ${r.id.slice(0, 8)}`,
      })),
      { value: "later", label: "Review later" },
    ],
    initial: "later",
  });
  if (selected === "later") return;
  const request = pending.find((r) => r.id === selected);
  if (!request) throw Error("This device request is no longer available.");
  print(describeApproval(request));
  const decision = await select({
    message: "What would you like to do?",
    initial: "later",
    choices: [
      {
        value: "approve",
        label: "Approve this device",
        description: "Requires matching the code shown on your phone.",
      },
      {
        value: "deny",
        label: "Deny this request",
        description: "This device will not be connected.",
      },
      {
        value: "later",
        label: "Review later",
        description: "Leave access pending.",
      },
    ],
  });
  if (decision === "later") return;
  if (decision === "deny") {
    print(decideApproval(host.dataDir, `deny ${request.id.slice(0, 8)}`));
    return;
  }
  if (decision !== "approve") throw Error("Invalid device approval choice.");
  const code = (
    await ask("Enter the eight-character code shown on your phone:")
  ).trim();
  if (code !== request.id.slice(0, 8))
    throw Error(
      "The code does not match this device request. Nothing was approved.",
    );
  print(decideApproval(host.dataDir, code));
}
