import path from "node:path";
import { terminalPrompts } from "./prompts.mjs";
import { loadJson } from "../server/core.mjs";
import { approvalStore } from "../server/device-approval.mjs";
import { stateDir } from "./home.mjs";
export const safeLabel = (value) =>
  String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
export function pendingApprovals(dataDir) {
  return approvalStore(dataDir)
    .list()
    .filter((r) => r.status === "pending");
}
export function describeApproval(r) {
  return `${r.id.slice(0, 8)} · ${safeLabel(r.name)}\n  Tailscale: ${safeLabel(r.login)} · ${safeLabel(r.nodeName)}\n  Grants owner access (including terminals and files); screen control stays separately enabled.`;
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
      "Start Reach with ./reach configure completed, then request access on your phone.",
    );
  const pending = pendingApprovals(host.dataDir);
  if (!pending.length) {
    print(
      "No pending devices. Open the private link on your phone and tap Connect.",
    );
    return;
  }
  if (!deps.select && !process.stdin.isTTY)
    throw Error(
      "Run ./reach approve in an interactive terminal on this computer.",
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
