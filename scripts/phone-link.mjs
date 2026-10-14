import { command } from "./home.mjs";

// What the terminal says under the phone's QR (scripts/launch.mjs), for each
// way a phone comes in (docs/FIRST_RUN_MATRIX.md, W1, W5, W6):
// - the one address, with someone at this terminal: the Tailscale app opens
//   it straight away; without the app, the phone signs in to Tailscale in its
//   browser while the pairing window is open;
// - the one address, nobody watching (the background service): the window
//   opens on ./reach pair;
// - only the private address (port 443 isn't Reach's, Funnel isn't allowed):
//   the phone needs the Tailscale app.
export function phoneLinkText({ oneAddress = false, attended = false, minutes = 15, ownLink = "", publicProblem = "" } = {}) {
  const lines = [];
  if (oneAddress) {
    lines.push("  With the Tailscale app on your phone, it opens straight away.");
    // Linked computers share the first one's link; browser sign-in opens
    // here, at this computer's own.
    const signIn = ownLink ? `Open ${ownLink} and sign in` : "Sign in";
    lines.push(
      attended
        ? `  No Tailscale app? ${signIn} to Tailscale in the phone's browser in the next ${minutes} minutes (later: ${command} pair).`
        : `  No Tailscale app on the phone? Run ${command} pair: browser sign-in then opens for ${minutes} minutes${ownLink ? ` at ${ownLink}` : ""}.`,
    );
  } else {
    lines.push("  Your phone needs the Tailscale app, on and signed in to this account. The QR holds only this private address.");
    if (publicProblem) lines.push(`  Signing in from the phone's browser isn't available: ${publicProblem}`);
  }
  if (ownLink) lines.push(`  This computer's own link works too: ${ownLink}`);
  lines.push(`  Approve new devices here, or run ${command} approve in another terminal.`);
  return lines.join("\n");
}

// The pairing-code way in (a PC whose browser sign-in can't open yet, or a
// computer set up before account approval): the private address opens only
// in the Tailscale app, and there is no browser sign-in. Said above the QR,
// where a first-time user looks (Oct 11: a Windows user scanned it without
// the app and got "can't connect"), with why when there's a reason.
export function phoneAppFirst({ account = "", why = "" } = {}) {
  const lines = [
    `  First, on your phone: install the Tailscale app, sign in ${account ? `as ${account}` : "with this computer's Tailscale account"} and turn it on.`,
  ];
  if (why) lines.push(`  Signing in from the phone's browser is off here for now: ${why}`);
  return lines.join("\n");
}

// Said once Tailscale's public record for the one address is checked: until
// it's published, the internet can't find the link (server/public-dns.mjs).
export const UNPUBLISHED =
  "  Tailscale hasn't published this address on the internet yet. Phones with the Tailscale app are fine; browser sign-in works once it has (it can take several minutes).";
