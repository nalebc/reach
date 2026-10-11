import fs from "node:fs/promises";
import { chmodSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { privateFile } from "./agent-client.mjs";
const exec = promisify(execFile);
export function networkPolicy(macIp, port = 8443, tag = "tag:reach-agent") {
  const parts = String(macIp).split(".").map(Number);
  if (!net.isIPv4(macIp) || parts[0] !== 100 || parts[1] < 64 || parts[1] > 127)
    throw Error("Use the Mac's Tailscale IPv4 address (100.64.0.0/10).");
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^tag:[a-z][a-z0-9-]*$/.test(tag)
  )
    throw Error("Invalid port or agent tag.");
  return {
    tagOwners: { [tag]: ["autogroup:admin"] },
    grants: [{ src: [tag], dst: [macIp], ip: [`tcp:${port}`] }],
    tests: [
      {
        src: tag,
        accept: [`${macIp}:${port}`],
        deny: [`${macIp}:${port === 22 ? 23 : 22}`],
      },
    ],
  };
}
export function joinArguments(options, socket) {
  if (!/^tag:[a-z][a-z0-9-]*$/.test(options.tag || ""))
    throw Error("Supply one dedicated --tag, such as tag:reach-agent.");
  const key = options["auth-key-file"],
    client = options["client-id"],
    identity = options["id-token-file"];
  if (key ? client || identity : !(client && identity))
    throw Error("Use --auth-key-file OR both --client-id and --id-token-file.");
  const secretPath = path.resolve(key || identity);
  privateFile(secretPath);
  const authentication = key
    ? [`--auth-key=file:${secretPath}`]
    : [`--client-id=${client}`, `--id-token=file:${secretPath}`];
  return [
    `--socket=${socket}`,
    "up",
    ...authentication,
    `--advertise-tags=${options.tag}`,
    "--accept-dns=false",
    "--accept-routes=false",
    "--ssh=false",
    "--shields-up",
    "--timeout=60s",
    `--hostname=reach-agent-${process.pid}`,
  ];
}
// The agent's way onto the tailnet: a CONNECT proxy on a socket in this
// run's private folder (0700), dialing through the isolated tailscaled with
// `tailscale nc`. No port on the machine, so no other user on it can borrow
// the agent's tailnet node; and it reaches tailnet addresses only
// (connections audit, Oct 10).
const tailnetTarget = (host) =>
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(host) ||
  (net.isIPv4(host) && host.split(".")[0] === "100" && Number(host.split(".")[1]) >= 64 && Number(host.split(".")[1]) <= 127);
export async function tailnetProxy({ file, cli, socket }) {
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req, client, head) => {
    const m = /^([^:\s]+):(\d{1,5})$/.exec(req.url || "");
    const port = Number(m?.[2]);
    if (!m || !tailnetTarget(m[1]) || port < 1 || port > 65535) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const nc = spawn(cli, [`--socket=${socket}`, "nc", m[1], String(port)], { stdio: ["pipe", "pipe", "ignore"] });
    const end = () => {
      client.destroy();
      nc.kill();
    };
    nc.once("error", end);
    nc.once("exit", () => client.destroy());
    nc.stdin.on("error", () => {});
    client.on("error", end);
    client.on("close", () => nc.kill());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) nc.stdin.write(head);
    client.pipe(nc.stdin);
    nc.stdout.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(file, 0o600);
  return server;
}
export async function withTailnet(options, command) {
  if (process.platform === "win32")
    throw Error(
      "Isolated tailnet joining currently supports Linux and macOS. Use an existing Tailscale connection on Windows.",
    );
  if (!command.length)
    throw Error(
      "Pass the agent command after --. The connection lasts only while it runs.",
    );
  const maxSeconds = Number(options["max-seconds"] || 3600);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 86400)
    throw Error("--max-seconds must be between 1 and 86400.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-agent-"));
  await fs.chmod(dir, 0o700);
  const socket = path.join(dir, "tailscaled.sock");
  const joinAbort = new AbortController();
  let daemon,
    proxy,
    child,
    timer,
    stopped = false,
    daemonError;
  const killGroup = () => {
    if (child?.pid) {
      const pid = child.pid;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }, 1000).unref();
    }
  };
  const stop = () => {
    stopped = true;
    joinAbort.abort();
    killGroup();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const args = joinArguments(options, socket);
    daemon = spawn(
      options.tailscaled || "tailscaled",
      [
        "--tun=userspace-networking",
        "--state=mem:",
        `--statedir=${dir}`,
        `--socket=${socket}`,
        "--port=0",
      ],
      { stdio: "ignore" },
    );
    daemon.once("error", () => {
      daemonError = Error(
        "Cannot start tailscaled. Install the official Tailscale CLI and daemon in this runtime.",
      );
    });
    daemon.once("exit", () => {
      if (!stopped) {
        daemonError ||= Error("The isolated Tailscale daemon stopped.");
        killGroup();
      }
    });
    let ready = false;
    for (let attempt = 0; attempt < 50 && !stopped; attempt++) {
      if (daemonError) throw daemonError;
      try {
        await fs.access(socket);
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    if (!ready)
      throw Error("The isolated Tailscale socket did not become ready.");
    const cli = options.tailscale || "tailscale";
    try {
      await exec(cli, args, {
        timeout: 65000,
        maxBuffer: 65536,
        signal: joinAbort.signal,
      });
    } catch {
      throw Error(
        "Tailscale join failed. Check the auth key or federation configuration, device approval, and tag ownership. Credentials and login output are suppressed.",
      );
    }
    if (stopped || daemonError)
      throw daemonError || Error("Connection cancelled.");
    const { stdout } = await exec(
      cli,
      [`--socket=${socket}`, "status", "--json"],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const status = JSON.parse(stdout);
    if (stopped || daemonError)
      throw daemonError || Error("Connection cancelled.");
    if (
      status.BackendState !== "Running" ||
      status.Self?.Tags?.length !== 1 ||
      status.Self.Tags[0] !== options.tag
    )
      throw Error(
        "The node did not receive exactly the requested restricted tag. Refusing to start the agent.",
      );
    const proxyFile = path.join(dir, "proxy.sock");
    proxy = await tailnetProxy({ file: proxyFile, cli, socket });
    const env = { ...process.env, REACH_PROXY: `unix:${proxyFile}` };
    for (const name of ["TS_AUTHKEY", "TS_CLIENT_SECRET", "TS_ID_TOKEN"])
      delete env[name];
    console.error(
      "Reach: private ephemeral connection ready. Tailnet grants determine network access; the Mac's agent policy determines API permissions.",
    );
    const code = await new Promise((resolve, reject) => {
      child = spawn(command[0], command.slice(1), {
        env,
        stdio: "inherit",
        detached: true,
      });
      child.once("error", () =>
        reject(Error("Cannot start the agent command.")),
      );
      child.once("exit", (code) => resolve(code ?? 130));
      timer = setTimeout(stop, maxSeconds * 1000);
    });
    if (daemonError) throw daemonError;
    return code;
  } finally {
    stopped = true;
    clearTimeout(timer);
    killGroup();
    proxy?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (daemon?.pid) {
      try {
        await exec(
          options.tailscale || "tailscale",
          [`--socket=${socket}`, "logout"],
          { timeout: 5000, maxBuffer: 65536 },
        );
      } catch {}
      const closed = new Promise((r) => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) r();
        else daemon.once("exit", r);
      });
      daemon.kill();
      const force = setTimeout(() => daemon.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(force);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
