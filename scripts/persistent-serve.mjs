import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJson, loadJson } from "../server/core.mjs";
import {
  tailscaleCli,
  tailscaleJson,
  assertPrivatePort,
  assertUnusedPort,
  serveConfigs,
} from "./tailscale.mjs";
const exec = promisify(execFile);
// A refusal is said in Tailscale's own words (often with the page that fixes
// it), not as "Command failed: /path/to/tailscale …".
export const runTailscale = (args) =>
  exec(tailscaleCli(), args, {
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).catch((error) => {
    const said = String(error?.stderr || error?.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ")
      .slice(0, 400);
    if (error?.code === "ENOENT")
      throw Object.assign(new Error("Tailscale is unavailable. Install and sign in to Tailscale on this computer, then rerun Reach."), { cause: error });
    throw Object.assign(
      new Error(said || (error?.killed ? "Tailscale took too long to answer." : "Tailscale refused the change.")),
      { cause: error, code: error?.code },
    );
  });

export function exactPersistentRoute(config, origin, target) {
  const u = new URL(origin),
    port = Number(u.port || 443);
  assertPrivatePort(config, port);
  // Background config only. Extra handlers or another foreground service are
  // not ours to replace or remove, even when one proxy happens to match.
  const entries = serveConfigs(config).filter(
    (c) =>
      c.TCP?.[port] ||
      Object.keys(c.Web || {}).some((host) => host.endsWith(`:${port}`)),
  );
  if (entries.length !== 1 || entries[0] !== config) return false;
  const host = `${u.hostname}:${port}`;
  const tcp = config.TCP?.[port],
    web = config.Web?.[host];
  const hosts = Object.keys(config.Web || {}).filter((host) =>
    host.endsWith(`:${port}`),
  );
  return (
    !!tcp &&
    tcp.HTTPS === true &&
    Object.keys(tcp).length === 1 &&
    hosts.length === 1 &&
    hosts[0] === host &&
    !!web &&
    Object.keys(web).length === 1 &&
    Object.keys(web.Handlers || {}).length === 1 &&
    web.Handlers["/"]?.Proxy === target &&
    Object.keys(web.Handlers["/"]).length === 1
  );
}
export function recordedRouteMatches(file, config, origin, target) {
  const record = loadJson(file, null);
  return (
    record?.origin === origin &&
    record?.target === target &&
    exactPersistentRoute(config, origin, target)
  );
}
// The route on the port is one Reach made for this address, whatever target
// it recorded then (a local port may have changed since).
export function recordedRouteOwned(file, config, origin) {
  const record = loadJson(file, null);
  return (
    record?.origin === origin &&
    typeof record?.target === "string" &&
    exactPersistentRoute(config, origin, record.target)
  );
}
// A restart from a different checkout stops the old Reach but its background
// Serve route stays registered. Carry only verified ownership into the new
// checkout; ensurePersistentRoute then replaces the old target at launch.
export async function handoffPersistentRoute({
  file,
  sources,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
}) {
  const records = sources
    .filter((source) => source !== file)
    .map((source) => loadJson(source, null))
    .filter((record) =>
      record?.version === 1 &&
      typeof record.origin === "string" &&
      typeof record.target === "string",
    );
  if (!records.length) return false;
  const config = await inspect();
  for (const record of records) {
    try {
      if (new URL(record.origin).protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (!exactPersistentRoute(config, record.origin, record.target)) continue;
    atomicJson(file, {
      version: 1,
      origin: record.origin,
      target: record.target,
    });
    return true;
  }
  return false;
}
// Returns true when a route was created, false when the recorded one was
// reused as it is (nothing on the port changed).
export async function ensurePersistentRoute({
  file,
  origin,
  target,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
  run = runTailscale,
}) {
  let config = await inspect();
  if (recordedRouteMatches(file, config, origin, target)) return false;
  const port = Number(new URL(origin).port || 443);
  if (recordedRouteOwned(file, config, origin)) {
    // Reach's own route from an earlier run, pointing at an old target:
    // replaced. Nobody else's route on the port ever is.
    await run(["serve", `--https=${port}`, "off"]);
    config = await inspect();
  }
  assertUnusedPort(config, port);
  // Save intent before mutation so a crash after Serve succeeds is recoverable.
  atomicJson(file, { version: 1, origin, target });
  await run(["serve", "--bg", `--https=${port}`, target]);
  if (!recordedRouteMatches(file, await inspect(), origin, target))
    throw Error(
      "The private Serve route could not be verified. Access stays paused.",
    );
  return true;
}
export async function removePersistentRoute({
  file,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
  run = runTailscale,
}) {
  const record = loadJson(file, null);
  if (!record) return "No managed Serve route.";
  const config = await inspect();
  if (!recordedRouteMatches(file, config, record.origin, record.target)) {
    // Missing is safe; conflicting settings remain untouched for the owner.
    assertUnusedPort(config, Number(new URL(record.origin).port || 443));
    fs.rmSync(file, { force: true });
    return "Managed Serve route was already absent.";
  }
  await run(["serve", `--https=${new URL(record.origin).port || 443}`, "off"]);
  assertUnusedPort(await inspect(), Number(new URL(record.origin).port || 443));
  fs.rmSync(file, { force: true });
  return "Managed Serve route removed.";
}
