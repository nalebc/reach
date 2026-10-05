import crypto from "node:crypto";
import path from "node:path";
import { atomicJson, loadJson } from "../server/core.mjs";
import { stateDir } from "./home.mjs";

export async function pairRunningHost(
  root,
  { env = process.env, fetchHost = fetch, print = console.log, qr } = {},
) {
  const service = loadJson(path.join(stateDir(root), "service.json"), null);
  const host = loadJson(path.join(stateDir(root), "host-status.json"), null);
  if (!host?.localUrl || !host.dataDir || !host.instance)
    throw Error(
      "Reach is not ready. Start ./reach or check ./reach status and its logs.",
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
      "Reach is stopped or still connecting. Check ./reach status and retry shortly.",
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
  const url = `${origin.origin}/#${new URLSearchParams({ pair: pairing.code, name: host.name || "My computer" })}`;
  print(
    `Reach: ${origin.origin}\nPairing code: ${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}\nOne use. Expires in 10 minutes. Previous unused code replaced.`,
  );
  if (!qr) qr = (await import("qrcode-terminal")).default;
  qr.generate(url, { small: true }, print);
  return pairing;
}
