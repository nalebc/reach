import path from "node:path";
import { loadJson } from "../server/core.mjs";
import { createGuestKeys, GUEST_TAG } from "../server/guest-keys.mjs";
import { tailscaleJson } from "./tailscale.mjs";
import { readPreferences } from "./configure.mjs";
import { terminalPrompts } from "./prompts.mjs";
import { stateDir } from "./home.mjs";

// `reach invites`: one-time setup so invitations carry their own Tailscale
// key (guests just open the link). Prints the exact policy lines for this
// tailnet, then checks and saves the OAuth client.

export function guestPolicy({ addresses, port }) {
  return {
    tagOwners: { [GUEST_TAG]: ["autogroup:admin"] },
    grants: [{ src: [GUEST_TAG], dst: addresses, ip: [`tcp:${port}`] }],
  };
}

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
  const policy = guestPolicy({ addresses, port });
  print(`
Invite keys · one-time setup (about 3 minutes)
Guests then just open your link: no Tailscale account or app.

1. Tailscale admin → Access controls (https://login.tailscale.com/admin/acls).
   Add these to your policy file (merge with what's there):

${JSON.stringify(policy, null, 2).replace(/^/gm, "   ")}

   This lets guests reach Reach (port ${port}) on ${addresses.length > 1 ? "your linked computers" : "this computer"} and nothing else.
   Important: Tailscale rules only ever allow. If your policy has a rule with
   "src": ["*"], guests could reach every device and port it allows. Change
   that "*" to "autogroup:member" (your own devices keep working).

2. Tailscale admin → Settings → Trust credentials
   (https://console.tailscale.com/admin/settings/trust-credentials):
   Credential → OAuth → choose Write for "Auth Keys" and for "Devices: Core"
   (auth_keys, devices:core), add the tag ${GUEST_TAG}, then Generate credential.
   Reach can then only make guest keys and remove guest devices.

3. Paste the client ID and secret below. They stay on this computer (owner-only
   file), and are never sent to a phone or browser.
`);
  const ui = terminalPrompts();
  const ask = deps.ask || ui.ask;
  const secret = deps.secret || ((m) => hiddenAsk(m));
  const clientId = (await ask("OAuth client ID:")).trim();
  const clientSecret = (await secret("OAuth client secret (hidden):")).trim();
  const keys = createGuestKeys({ dataDir, self: device.id, ...deps.guestKeys });
  print("Checking with Tailscale…");
  await keys.setup({ clientId, clientSecret });
  print(
    "Invite keys are ready. New invitations from your phone include a key; a running Reach uses it right away.",
  );
}

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
