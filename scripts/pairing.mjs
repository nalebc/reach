import crypto from "node:crypto";
import path from "node:path";
import { atomicJson, loadJson, openPairingWindow, PAIRING_WINDOW_MS } from "../server/core.mjs";
import { stateDir, command } from "./home.mjs";
import { checkBrowserLink } from "./browser-link.mjs";

export async function pairRunningHost(
  root,
  { env = process.env, fetchHost = fetch, print = console.log, qr, browserCheck = checkBrowserLink } = {},
) {
  const service = loadJson(path.join(stateDir(root), "service.json"), null);
  const host = loadJson(path.join(stateDir(root), "host-status.json"), null);
  if (!host?.localUrl || !host.dataDir || !host.instance)
    throw Error(
      `Reach is not ready. Start ${command} or check ${command} status and its logs.`,
    );
  const local = new URL(host.localUrl);
  if (
    local.protocol !== "http:" ||
    local.hostname !== "127.0.0.1" ||
    local.pathname !== "/" ||
    local.username ||
    local.password ||
    local.search ||
    local.hash
  )
    throw Error("Invalid local Reach address.");
  const response = await fetchHost(`${local.origin}/api/health`, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  const health = response.ok && (await response.json());
  if (
    !health ||
    health.product !== "Reach" ||
    health.instance !== host.instance
  )
    throw Error(
      `Reach is stopped or still connecting. Check ${command} status and retry shortly.`,
    );
  const dataDir = path.resolve(host.dataDir);
  if (service?.installed && dataDir !== path.resolve(service.dataDir))
    throw Error("The running host does not match this installed service.");
  if (env.REACH_DATA && dataDir !== path.resolve(env.REACH_DATA))
    throw Error("REACH_DATA does not match the running host.");
  const origin = new URL(host.origin);
  if (origin.protocol !== "https:" && origin.origin !== local.origin)
    throw Error("Invalid Reach pairing link.");
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("Invalid Reach pairing link.");
  const pairing = {
    code: crypto.randomInt(10000000, 100000000).toString(),
    expiresAt: Date.now() + 600000,
  };
  atomicJson(path.join(dataDir, "pairing.json"), pairing);
  // The one address, when Reach holds it (noted in host-status.json): a phone
  // without the Tailscale app signs in from its browser there, so the start
  // page answers for the next minutes (a pairing window, server/core.mjs).
  let one = "";
  try {
    const link = new URL(host.link || "");
    if (link.protocol === "https:" && !link.port && link.pathname === "/" && !link.search && !link.hash && !link.username)
      // `link` may be the fleet home's address. The code and window are on
      // this host, whose one address is its private origin without the port.
      one = origin.protocol === "https:" ? `https://${origin.hostname}` : link.origin;
  } catch {
    /* no one address: the private one */
  }
  const browserApproval = process.platform === "win32" && host.tailscaleApproval;
  if (one || browserApproval) openPairingWindow(dataDir);
  if (browserApproval) {
    const browser = one ? await browserCheck(one, host.instance) : { ready: false, reason: host.browserLink?.reason || "Reach is still preparing the public browser link." };
    if (!browser.ready) throw Error(`${browser.reason} Keep Reach's terminal open; its phone QR appears when the browser connection is ready.`);
  }
  const url = `${one || origin.origin}/#${new URLSearchParams({ pair: pairing.code, name: host.name || "My computer" })}`;
  print(
    `Reach: ${one || origin.origin}\nPairing code: ${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}\nOne use. Expires in 10 minutes. Previous unused code replaced.` +
      (one
        ? `\nNo Tailscale app on the phone? It can sign in to Tailscale in its browser for the next ${PAIRING_WINDOW_MS / 60000} minutes.`
        : "\nThe phone needs the Tailscale app, on and signed in to this account."),
  );
  if (!qr) qr = (await import("qrcode-terminal")).default;
  qr.generate(url, { small: true }, print);
  return pairing;
}
