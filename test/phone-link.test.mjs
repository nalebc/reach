import test from "node:test";
import assert from "node:assert/strict";
import { phoneAppFirst, phoneLinkText } from "../scripts/phone-link.mjs";
import { command } from "../scripts/home.mjs";
// The launcher as this computer types it: ./reach, or .\\reach.cmd on Windows.
const cmd = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// First-run matrix W1, W5, W6: what the terminal says under the QR.
test("with the one address and someone at the terminal: both ways in, and how to reopen browser sign-in", () => {
  const text = phoneLinkText({ oneAddress: true, attended: true });
  assert.match(text, /With the Tailscale app on your phone, it opens straight away/);
  assert.match(text, new RegExp(`No Tailscale app\\? Sign in to Tailscale in the phone's browser in the next 15 minutes \\(later: ${cmd} pair\\)`));
  assert.match(text, /Approve new devices here/);
});

test("the background service opens no window by itself: it says ./reach pair does", () => {
  assert.match(phoneLinkText({ oneAddress: true, attended: false }), new RegExp(`Run ${cmd} pair: browser sign-in then opens for 15 minutes`));
});

test("without the one address, the phone needs the Tailscale app, and the reason is given", () => {
  const text = phoneLinkText({ oneAddress: false, publicProblem: "Port 443 is used by another service." });
  assert.match(text, /Your phone needs the Tailscale app/);
  assert.match(text, /isn't available: Port 443 is used by another service\./);
  assert.doesNotMatch(text, /browser in the next/);
});

test("linked computers: the shared link for the app, this computer's own for browser sign-in", () => {
  const text = phoneLinkText({ oneAddress: true, attended: true, ownLink: "https://studio.example.ts.net" });
  assert.match(text, /No Tailscale app\? Open https:\/\/studio\.example\.ts\.net and sign in to Tailscale in the phone's browser in the next 15 minutes/);
});

test("the pairing-code way in says, before the QR, that the phone needs the Tailscale app and which account", () => {
  assert.equal(
    phoneAppFirst({ account: "sam@example.com", platform: "win32" }),
    "  First, on your phone: install the Tailscale app, sign in as sam@example.com and turn it on.\n  On Windows, phones can't sign in from the browser yet.",
  );
  // Tailscale didn't say whose it is: the account is still named by what it is.
  assert.equal(
    phoneAppFirst({ platform: "darwin" }),
    "  First, on your phone: install the Tailscale app, sign in with this computer's Tailscale account and turn it on.",
  );
});
