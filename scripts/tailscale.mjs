import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
// The Mac App Store and standalone apps carry the CLI inside the app without
// putting `tailscale` on PATH.
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export function findTailscaleCli({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  if (env.REACH_TAILSCALE) return env.REACH_TAILSCALE;
  const onPath = (env.PATH || "")
    .split(path.delimiter)
    .some((dir) => dir && exists(path.join(dir, "tailscale")));
  return platform === "darwin" && !onPath && exists(MAC_APP_CLI)
    ? MAC_APP_CLI
    : "tailscale";
}
let cli;
export const tailscaleCli = () =>
  process.env.REACH_TAILSCALE ||
  (cli && cli !== "tailscale" ? cli : (cli = findTailscaleCli()));
export async function tailscaleJson(args) {
  try {
    const { stdout } = await exec(tailscaleCli(), args, {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch {
    throw Error(
      "Tailscale is unavailable. Install and sign in to Tailscale on this computer and your phone, then rerun Reach.",
    );
  }
}
export function serveConfigs(config) {
  return [
    config,
    ...Object.values(config?.Foreground || {}).flatMap(serveConfigs),
  ];
}
export function assertPrivatePort(config, port) {
  for (const item of serveConfigs(config)) {
    if (
      Object.entries(item.AllowFunnel || {}).some(
        ([host, enabled]) => enabled && host.endsWith(`:${port}`),
      )
    )
      throw Error(
        `Tailscale Funnel is enabled on port ${port}. Reach requires a private Serve port.`,
      );
  }
}
export function assertUnusedPort(config, port) {
  assertPrivatePort(config, port);
  if (
    serveConfigs(config).some(
      (item) =>
        item.TCP?.[port] ||
        Object.keys(item.Web || {}).some((host) => host.endsWith(`:${port}`)),
    )
  )
    throw Error(
      `Tailscale port ${port} is already in use. Choose another with --https-port; Reach will not replace an existing service.`,
    );
}
export function ownsServeRoute(config, origin, target) {
  const u = new URL(origin);
  const port = Number(u.port || 443);
  assertPrivatePort(config, port);
  return serveConfigs(config).some(
    (item) =>
      item.TCP?.[port]?.HTTPS === true &&
      (item.Web?.[`${u.hostname}:${port}`] || item.Web?.[u.host])?.Handlers?.[
        "/"
      ]?.Proxy === target,
  );
}
export async function prepareTailscale(port, acceptExisting) {
  const status = await tailscaleJson(["status", "--json"]);
  if (status.BackendState !== "Running")
    throw Error(
      "Open Tailscale and sign in on this computer, then rerun Reach.",
    );
  const hostname = status.Self?.DNSName?.replace(/\.$/, "");
  if (!hostname || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/i.test(hostname))
    throw Error(
      "Tailscale did not provide a valid device hostname. Enable MagicDNS and HTTPS in Tailscale.",
    );
  const origin = `https://${hostname}${port === 443 ? "" : ":" + port}`;
  const config = await tailscaleJson(["serve", "status", "--json"]);
  assertPrivatePort(config, port);
  if (!acceptExisting?.(config, origin)) assertUnusedPort(config, port);
  return origin;
}
export async function checkUnused(port) {
  assertUnusedPort(await tailscaleJson(["serve", "status", "--json"]), port);
}
