import path from "node:path";
import { execFile } from "node:child_process";
import { loadJson } from "../server/core.mjs";
import {
  createGuestKeys,
  guestPolicy,
  GUEST_TAG,
} from "../server/guest-keys.mjs";
import { tailscaleJson } from "./tailscale.mjs";
import { readPreferences } from "./configure.mjs";
import { terminalPrompts } from "./prompts.mjs";
import { stateDir } from "./home.mjs";

// `reach invites` (also a step of `reach setup`): one-time setup so
// invitations carry their own Tailscale key; people and agents just open the
// link. The easy way: paste one Tailscale access token and Reach adds its
// rules to your policy and makes its own limited key (the token is used once,
// never kept). Or do those two things by hand.

export { guestPolicy };
export const KEYS_PAGE = "https://login.tailscale.com/admin/settings/keys";

export async function setupInvites(root, deps = {}) {
  const print = deps.print || console.log;
  const dataDir = process.env.REACH_DATA || path.join(stateDir(root), "quick");
  const preferences = readPreferences(root);
  if (!preferences)
    throw Error("Run Reach once first (./reach), then set up invites.");
  const device = loadJson(path.join(dataDir, "device.json"), null);
  if (!device?.id)
    throw Error("Run Reach once first (./reach), then set up invites.");
  const status = await (
    deps.status || (() => tailscaleJson(["status", "--json"]))
  )();
  const links =
    loadJson(path.join(dataDir, "links.json"), { computers: [] }).computers ||
    [];
  const peers = Object.values(status.Peer || {});
  const addresses = [
    status.Self?.TailscaleIPs?.find((ip) => ip.includes(".")),
    ...links.map((l) =>
      peers
        .find((p) => p.ID === l.nodeId)
        ?.TailscaleIPs?.find((ip) => ip.includes(".")),
    ),
  ].filter(Boolean);
  const port = preferences.httpsPort || 8443;
  const ui = deps.select && deps.ask ? null : terminalPrompts();
  const select = deps.select || ui.select;
  const ask = deps.ask || ui.ask;
  const secret = deps.secret || ((m) => hiddenAsk(m));
  const keys = createGuestKeys({ dataDir, self: device.id, ...deps.guestKeys });
  print(
    "\nInvite links · one-time setup\nPeople and agents you invite then join with just the link: no Tailscale app or account.",
  );
  const how = await select({
    message: "How do you want to set this up?",
    choices: [
      {
        value: "token",
        label: "Paste one access token",
        description:
          "Reach adds its rules to your Tailscale policy and makes its own key.",
        recommended: true,
      },
      {
        value: "manual",
        label: "Do it by hand",
        description:
          "Edit the policy and create the key in Tailscale yourself.",
      },
    ],
  });
  if (how === "token") {
    print(
      `\n1. On the page that opens: Generate access token (1 day is enough), then copy it.\n   ${KEYS_PAGE}\n2. Paste it below. Reach uses it once and doesn't keep it.`,
    );
    await (deps.open || openPage)(KEYS_PAGE);
    const accessToken = (await secret("Access token (hidden):")).trim();
    print("Checking your Tailscale policy…");
    const result = await keys.setupFromAccessToken({
      accessToken,
      addresses,
      port,
      confirm: async (plan) => {
        print(
          `\nReach will add to your Tailscale policy (nothing else changes):\n${plan.added.map((l) => `  + ${l}`).join("\n")}`,
        );
        return (
          (await select({
            message: "Add these?",
            choices: [
              { value: "yes", label: "Add them", recommended: true },
              {
                value: "no",
                label: "Cancel",
                description: "Nothing is changed.",
              },
            ],
          })) === "yes"
        );
      },
    });
    if (!result.added.length) print("Your policy already had Reach's rules.");
    if (result.allowAll.length) print(allowAllWarning);
    print(
      "Invite links are ready. You can delete that access token in Tailscale now, or let it expire.",
    );
    return;
  }
  const policy = guestPolicy({ addresses, port });
  print(`
1. Tailscale admin → Access controls (https://login.tailscale.com/admin/acls).
   Add these to your policy file (merge with what's there):

${JSON.stringify(policy, null, 2).replace(/^/gm, "   ")}

   This lets guests reach Reach (port ${port}) on ${addresses.length > 1 ? "your linked computers" : "this computer"}.
${allowAllWarning.replace(/^/gm, "   ")}

2. Tailscale admin → Settings → Trust credentials
   (https://console.tailscale.com/admin/settings/trust-credentials):
   Credential → OAuth → choose Write for "Auth Keys" and for "Devices: Core"
   (auth_keys, devices:core) and Read for "Policy File" (policy_file:read),
   add the tag ${GUEST_TAG}, then Generate credential. Reach can then only
   make guest keys, remove guest devices, and check that guests reach only Reach.

3. Paste the client ID and secret below. They stay on this computer (owner-only
   file), and are never sent to a phone or browser.
`);
  const clientId = (await ask("OAuth client ID:")).trim();
  const clientSecret = (await secret("OAuth client secret (hidden):")).trim();
  print("Checking with Tailscale…");
  await keys.setup({ clientId, clientSecret });
  print(
    "Invite keys are ready. New invitations from your phone include a key; a running Reach uses it right away.",
  );
}

// Tailscale rules only ever allow: an "everyone reaches everything" rule
// covers guest devices too. Reach doesn't change your rules; it says so.
export const allowAllWarning = `Heads up: your policy has a rule letting every device reach everything ("src": ["*"]).
Invited people and agents fall under it too, so they could reach more than Reach.
To keep them to Reach, change that rule's "*" to "autogroup:member": your own
devices keep working; other tagged devices and people you shared devices with
would need their own rules.`;

const openPage = (url) =>
  new Promise((resolve) => {
    if (process.platform !== "darwin" || !process.stdout.isTTY)
      return resolve();
    execFile("open", [url], () => resolve());
  });

// Read a line without echoing it.
function hiddenAsk(message) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY)
      return reject(Error("Run ./reach invites in an interactive terminal."));
    stdout.write(`${message} `);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003")
          return done(Error("Cancelled. Nothing was saved."));
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
