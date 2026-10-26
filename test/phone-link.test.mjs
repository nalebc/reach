import test from "node:test";
import assert from "node:assert/strict";
import { phoneAppFirst, phoneLinkText } from "../scripts/phone-link.mjs";
import { command } from "../scripts/home.mjs";
// The launcher as this computer types it: ./reach, or .\\reach.cmd on Windows.
const cmd = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// First-run matrix W1, W5, W6: what the terminal says under the QR.
test("the owner link supports both paths after setup without a pairing-window deadline", () => {
  const text = phoneLinkText({ oneAddress: true, attended: true });
  assert.match(text, /With the Tailscale app on your phone, it opens straight away/);
  assert.match(text, /No Tailscale app\? Sign in to Tailscale in the phone's browser to finish owner setup/);
  assert.match(text, /same link reconnects automatically with the phone app on or off/);
  assert.match(text, /Approve new devices here/);
});

test("owner bootstrap remains available when no pairing window was opened", () => {
  assert.match(phoneLinkText({ oneAddress: true, attended: false }), /same link reconnects automatically/);
  assert.doesNotMatch(phoneLinkText({ oneAddress: true, attended: false }), /15 minutes|Run .* pair/);
});

test("without the one address, the phone needs the Tailscale app, and the reason is given", () => {
  const text = phoneLinkText({ oneAddress: false, publicProblem: "Port 443 is used by another service." });
  assert.match(text, /Your phone needs the Tailscale app/);
  assert.match(text, /isn't available: Port 443 is used by another service\./);
  assert.doesNotMatch(text, /browser in the next/);
});

test("linked computers: the shared link for the app, this computer's own for browser sign-in", () => {
  const text = phoneLinkText({ oneAddress: true, attended: true, ownLink: "https://studio.example.ts.net" });
  assert.match(text, /No Tailscale app\? Open https:\/\/studio\.example\.ts\.net and sign in to Tailscale in the phone's browser to finish owner setup/);
});

test("the pairing-code way in says, before the QR, that the phone needs the Tailscale app, which account, and why browser sign-in is off", () => {
  assert.equal(
    phoneAppFirst({ account: "sam@example.com", why: "Tailscale 1.90.0 is older than 1.104; update Tailscale." }),
    "  First, on your phone: install the Tailscale app, sign in as sam@example.com and turn it on.\n  Signing in from the phone's browser is off here for now: Tailscale 1.90.0 is older than 1.104; update Tailscale.",
  );
  // Tailscale didn't say whose it is: the account is still named by what it is.
  assert.equal(
    phoneAppFirst({}),
    "  First, on your phone: install the Tailscale app, sign in with this computer's Tailscale account and turn it on.",
  );
});
