import test from "node:test";
import assert from "node:assert/strict";
import { phoneLinkText } from "../scripts/phone-link.mjs";

// First-run matrix W1, W5, W6: what the terminal says under the QR.
test("with the one address and someone at the terminal: both ways in, and how to reopen browser sign-in", () => {
  const text = phoneLinkText({ oneAddress: true, attended: true });
  assert.match(text, /With the Tailscale app on your phone, it opens straight away/);
  assert.match(text, /No Tailscale app\? Sign in to Tailscale in the phone's browser in the next 15 minutes \(later: \.\/reach pair\)/);
  assert.match(text, /Approve new devices here/);
});

test("the background service opens no window by itself: it says ./reach pair does", () => {
  assert.match(phoneLinkText({ oneAddress: true, attended: false }), /Run \.\/reach pair: browser sign-in then opens for 15 minutes/);
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
