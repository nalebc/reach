import fs from "node:fs";
import { atomicJson, loadJson } from "../server/core.mjs";
import { serveConfigs, tailscaleJson } from "./tailscale.mjs";
import { runTailscale } from "./persistent-serve.mjs";

// The one address: https://<computer>.<tailnet>.ts.net (port 443) via
// Tailscale Funnel, pointing at Reach's own private listener. That listener
// gives the internet only the start page (server/public-start.mjs) and your
// devices Reach, request by request, by Tailscale's Funnel mark
// (server/tailscale-auth.mjs). Reach's own port (8443) stays private Serve.
export const PUBLIC_PORT = 443;
export const startOrigin = (privateOrigin) =>
  `https://${new URL(privateOrigin).hostname}`;

// "ours": exactly our Funnel route. "free": nothing on 443. "taken": anything
// else on 443, which is never replaced.
export function funnelRoute(config, origin, target) {
  const host = `${new URL(origin).hostname}:${PUBLIC_PORT}`;
  let ours = false,
    taken = false;
  for (const c of serveConfigs(config)) {
    const hosts = Object.keys(c?.Web || {}).filter((h) =>
      h.endsWith(`:${PUBLIC_PORT}`),
    );
    if (!c?.TCP?.[PUBLIC_PORT] && !hosts.length) continue;
    const handlers = c.Web?.[host]?.Handlers || {};
    if (
      c.TCP?.[PUBLIC_PORT]?.HTTPS === true &&
      hosts.length === 1 &&
      hosts[0] === host &&
      Object.keys(handlers).length === 1 &&
      handlers["/"]?.Proxy === target &&
      c.AllowFunnel?.[host] === true
    )
      ours = true;
    else taken = true;
  }
  return taken ? "taken" : ours ? "ours" : "free";
}

// Exactly Reach's own background Funnel route, and nothing else on port 443:
// what Reach may switch off, and what it may keep using after a restart.
export function exactBackgroundFunnel(config, origin, target) {
  const entries = serveConfigs(config).filter((entry) =>
    entry?.TCP?.[PUBLIC_PORT] || Object.keys(entry?.Web || {}).some((host) => host.endsWith(`:${PUBLIC_PORT}`)),
  );
  if (entries.length !== 1 || entries[0] !== config || funnelRoute(config, origin, target) !== "ours") return false;
  const host = `${new URL(origin).hostname}:${PUBLIC_PORT}`;
  const tcp = config.TCP[PUBLIC_PORT], web = config.Web[host], handler = web.Handlers["/"];
  return Object.keys(tcp).length === 1 && Object.keys(web).length === 1 && Object.keys(handler).length === 1;
}

// Windows' public route (scripts/foreground-funnel.mjs): the same exact
// route, held as one foreground session, with nothing else on port 443.
export function exactForegroundFunnel(config, origin, target) {
  const entries = serveConfigs(config).filter((entry) =>
    entry?.TCP?.[PUBLIC_PORT] || Object.keys(entry?.Web || {}).some((host) => host.endsWith(`:${PUBLIC_PORT}`)),
  );
  if (entries.length !== 1 || !Object.values(config?.Foreground || {}).includes(entries[0])) return false;
  const [entry] = entries;
  if (funnelRoute(entry, origin, target) !== "ours") return false;
  const host = `${new URL(origin).hostname}:${PUBLIC_PORT}`;
  const tcp = entry.TCP[PUBLIC_PORT], web = entry.Web[host], handler = web.Handlers["/"];
  return Object.keys(tcp).length === 1 && Object.keys(web).length === 1 && Object.keys(handler).length === 1;
}

export const PORT_TAKEN =
  "Port 443 on this computer's Tailscale address is used by another service, so phones without the Tailscale app can't sign in from the browser. Phones with the app still connect.";

// Reach's own route from before one address (to a separate start-page
// listener), as recorded when Reach added it: turned off so the one address
// can take its place. Never a route Reach didn't record as its own.
async function clearOwnOldRoute({ file, origin, target, inspect, run }) {
  const record = file ? loadJson(file, null) : null;
  if (
    !record ||
    record.origin !== origin ||
    typeof record.target !== "string" ||
    record.target === target ||
    funnelRoute(await inspect(), origin, record.target) !== "ours"
  )
    return false;
  await run(["funnel", `--https=${PUBLIC_PORT}`, "off"]);
  return true;
}

// Background service: a lasting `funnel --bg` route, recorded so uninstall
// removes exactly what Reach added.
export async function ensurePersistentFunnel({
  file,
  origin,
  target,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
  run = runTailscale,
}) {
  let state = funnelRoute(await inspect(), origin, target);
  const record = loadJson(file, null);
  if (
    state === "ours" &&
    record?.origin === origin &&
    record?.target === target
  )
    return true;
  if (
    state === "taken" &&
    (await clearOwnOldRoute({ file, origin, target, inspect, run }))
  )
    state = funnelRoute(await inspect(), origin, target);
  if (state === "taken") throw Error(PORT_TAKEN);
  atomicJson(file, { version: 1, origin, target });
  if (state === "free")
    await run(["funnel", "--bg", `--https=${PUBLIC_PORT}`, target]);
  if (funnelRoute(await inspect(), origin, target) !== "ours")
    throw Error("The public start link could not be verified.");
  return true;
}

export async function removePersistentFunnel({
  file,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
  run = runTailscale,
}) {
  const record = loadJson(file, null);
  if (!record) return "";
  if (funnelRoute(await inspect(), record.origin, record.target) === "ours")
    await run(["funnel", `--https=${PUBLIC_PORT}`, "off"]);
  fs.rmSync(file, { force: true });
  return "Public start link removed.";
}
