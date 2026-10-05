#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAuth, getConfig, validLeafName } from "../server/core.mjs";
import { readAgentPolicy } from "../server/agent-policy.mjs";
import {
  createAgentClient,
  privateFile,
  reachOrigin,
} from "./agent-client.mjs";
import { networkPolicy, withTailnet } from "./agent-network.mjs";
import { stateDir } from "./home.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const help = `Reach Agent CLI — private access controlled by your Mac

Owner, on the Mac:
  reach-agent policy init --folder /absolute/project --out /private/agent-policy.json
  ./reach --folder /absolute/project --agent-policy /private/agent-policy.json
  reach-agent grant --profile workspace --name bedrock --out /private/bedrock.json
  reach-agent grants
  reach-agent revoke --id CLIENT_ID
  reach-agent network-policy --mac-ip 100.90.80.70 --port 8443 --tag tag:reach-agent

Agent, on an existing tailnet connection:
  reach-agent mcp --credential /run/secrets/reach.json
  reach-agent device --credential /run/secrets/reach.json
  reach-agent files list --credential /run/secrets/reach.json --root 0 --path .
  reach-agent files read --credential /run/secrets/reach.json --path README.md
  reach-agent files put --credential /run/secrets/reach.json --file ./report.txt --path .
  reach-agent files write --credential /run/secrets/reach.json --file ./updated.txt --path notes.txt --if-match SHA256_FROM_READ
  reach-agent files mkdir --credential /run/secrets/reach.json --path . --name output
  reach-agent exec --credential /run/secrets/reach.json --command-file /tmp/task.sh
  reach-agent job get --credential /run/secrets/reach.json --id JOB_ID
  reach-agent job cancel --credential /run/secrets/reach.json --id JOB_ID

Ephemeral cloud connection (does not alter the machine's existing Tailscale):
  reach-agent join --tag tag:reach-agent --auth-key-file /run/secrets/ts-key -- COMMAND ARGS...
  reach-agent join --tag tag:reach-agent --client-id CLIENT_ID --id-token-file /run/secrets/oidc -- COMMAND ARGS...

Options: --data-dir (owner; default ~/.reach/quick, or .reach/quick in a checkout), --ttl (seconds), --max-seconds
(join; default 3600), --credential (or REACH_CREDENTIAL), --allow-local (tests).
JSON results on stdout; diagnostics on stderr. Secret files must be private.
Network grants are a reviewable fragment, not automatically applied. Review existing
allow-all rules: Tailscale grants are additive. No automatic shell access is granted.
`;
export function parseAgentArgs(args) {
  const options = {},
    words = [];
  let command = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      command = args.slice(i + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--allow-local") options["allow-local"] = true;
    else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (
        ![
          "folder",
          "file",
          "access",
          "if-match",
          "out",
          "profile",
          "name",
          "data-dir",
          "ttl",
          "mac-ip",
          "port",
          "tag",
          "credential",
          "root",
          "path",
          "command-file",
          "timeout",
          "id",
          "auth-key-file",
          "client-id",
          "id-token-file",
          "max-seconds",
          "tailscale",
          "tailscaled",
        ].includes(name)
      )
        throw Error(`Unknown option: ${arg}.`);
      if (
        !args[i + 1] ||
        args[i + 1].startsWith("--") ||
        options[name] !== undefined
      )
        throw Error(`Supply exactly one value for ${arg}.`);
      options[name] = args[++i];
    } else words.push(arg);
  }
  return { options, words, command };
}
function writePrivate(file, object) {
  fs.writeFileSync(file, JSON.stringify(object, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
function hostConfig(options) {
  const dataDir = path.resolve(
    options["data-dir"] ||
      process.env.REACH_DATA ||
      path.join(stateDir(root), "quick"),
  );
  let host;
  try {
    host = JSON.parse(
      fs.readFileSync(path.join(dataDir, "agent-host.json"), "utf8"),
    );
  } catch {
    throw Error(
      "Start Reach with --agent-policy first, or pass the running companion's --data-dir.",
    );
  }
  return getConfig({
    dataDir,
    roots: host.roots.map((folder) => fs.realpathSync.native(folder)),
    agentPolicyFile: host.agentPolicyFile,
    publicOrigin: host.publicOrigin,
    agentPolicyRequired: true,
  });
}
export async function main(args = process.argv.slice(2)) {
  const { options: o, words, command } = parseAgentArgs(args);
  if (o.help || !words.length) {
    console.log(help);
    return 0;
  }
  const [verb, sub] = words;
  const output = (value) => console.log(JSON.stringify(value, null, 2));
  if (verb === "policy" && sub === "init") {
    if (!o.folder || !o.out)
      throw Error(
        "Supply --folder and --out. Existing files are never overwritten.",
      );
    const folder = fs.realpathSync.native(o.folder);
    if (!fs.statSync(folder).isDirectory()) throw Error("Choose a folder.");
    const profile = o.profile || "workspace";
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(profile))
      throw Error("Invalid profile name.");
    const access = o.access || "read-write";
    if (!["read-only", "read-write"].includes(access))
      throw Error("Choose --access read-only or read-write.");
    writePrivate(o.out, {
      version: 1,
      profiles: {
        [profile]: {
          scopes: [
            "device",
            "files:read",
            ...(access === "read-write" ? ["files:write"] : []),
          ],
          roots: [folder],
          ttlSeconds: 3600,
          maxJobMs: 60000,
        },
      },
    });
    output({
      policy: path.resolve(o.out),
      profile,
      access,
      ttlSeconds: 3600,
    });
    return 0;
  }
  if (["grant", "grants", "revoke"].includes(verb)) {
    const config = hostConfig(o);
    const auth = createAuth(config, { rotatePairing: false });
    if (verb === "grants") {
      output(auth.list().filter((c) => c.kind === "agent"));
      return 0;
    }
    if (verb === "revoke") {
      if (
        !o.id ||
        !auth.list().some((c) => c.id === o.id && c.kind === "agent")
      )
        throw Error("Choose an existing agent client ID from grants.");
      auth.revoke(o.id);
      output({ revoked: o.id });
      return 0;
    }
    if (!o.profile || !o.name || !o.out)
      throw Error(
        "Grant requires --profile, --name, and --out. The secret is saved to that private file, never printed.",
      );
    readAgentPolicy(config.agentPolicyFile);
    reachOrigin(config.publicOrigin, o["allow-local"]);
    if (fs.existsSync(o.out))
      throw Error(
        "Credential output already exists; choose a new private filename.",
      );
    const issued = auth.issue(o.name, [], "agent", {
      profile: o.profile,
      ...(o.ttl ? { ttlSeconds: Number(o.ttl) } : {}),
    });
    try {
      writePrivate(o.out, { version: 1, url: config.publicOrigin, ...issued });
    } catch (e) {
      auth.revoke(issued.clientId);
      throw e;
    }
    output({
      clientId: issued.clientId,
      profile: o.profile,
      scopes: issued.scopes,
      expiresAt: issued.expiresAt,
      credential: path.resolve(o.out),
    });
    return 0;
  }
  if (verb === "network-policy") {
    output(
      networkPolicy(
        o["mac-ip"],
        Number(o.port || 8443),
        o.tag || "tag:reach-agent",
      ),
    );
    return 0;
  }
  if (verb === "join") return withTailnet(o, command);
  const credentialFile = o.credential || process.env.REACH_CREDENTIAL;
  if (!credentialFile)
    throw Error(
      "Supply --credential or REACH_CREDENTIAL with the private grant file from the Mac owner.",
    );
  if (verb === "mcp") {
    process.env.REACH_CREDENTIAL = path.resolve(credentialFile);
    if (o["allow-local"]) process.env.REACH_ALLOW_LOCAL = "1";
    await import("./mcp.mjs");
    return 0;
  }
  const api = createAgentClient(JSON.parse(privateFile(credentialFile)), {
    allowLocal: o["allow-local"],
  });
  const query = new URLSearchParams({
    root: o.root || "0",
    path: o.path || "",
  });
  let result;
  if (verb === "device") result = await api("/api/device");
  else if (verb === "files" && sub === "list")
    result = await api("/api/files?" + query);
  else if (verb === "files" && sub === "read")
    result = await api("/api/files/text?" + query);
  else if (verb === "files" && sub === "write") {
    if (!o.file || !o.path || !/^[a-f0-9]{64}$/.test(o["if-match"] || ""))
      throw Error(
        "Supply --file, --path and --if-match with sha256 from files read.",
      );
    if (fs.statSync(o.file).size > 128 * 1024)
      throw Error("Text edits are limited to 128 KiB.");
    result = await api("/api/files/text?" + query, "PUT", {
      text: fs.readFileSync(o.file, "utf8"),
      sha256: o["if-match"],
    });
  } else if (verb === "files" && sub === "put") {
    if (!o.file) throw Error("Supply --file with the local file to upload.");
    if (
      !fs.statSync(o.file).isFile() ||
      fs.statSync(o.file).size > 100 * 1024 * 1024
    )
      throw Error("Choose a file up to 100 MiB.");
    const name = o.name || path.basename(o.file);
    if (!validLeafName(name))
      throw Error("Choose a valid destination filename with --name.");
    const boundary = "reach-" + crypto.randomBytes(24).toString("hex");
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"; filename*=UTF-8''${encodeURIComponent(name)}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      fs.readFileSync(o.file),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    result = await api(
      "/api/files/upload?" + query,
      "POST",
      body,
      `multipart/form-data; boundary=${boundary}`,
    );
  } else if (verb === "files" && sub === "mkdir")
    result = await api("/api/files/folder", "POST", {
      root: Number(o.root || 0),
      path: o.path || "",
      name: o.name,
    });
  else if (verb === "exec") {
    if (!o["command-file"])
      throw Error(
        "Supply --command-file. This capability must be explicitly granted by the Mac owner.",
      );
    const command = fs.readFileSync(o["command-file"], "utf8");
    result = await api("/api/jobs", "POST", {
      command,
      root: Number(o.root || 0),
      path: o.path || "",
      ...(o.timeout ? { timeoutMs: Number(o.timeout) } : {}),
    });
  } else if (verb === "job" && ["get", "cancel"].includes(sub) && o.id)
    result = await api(
      "/api/jobs/" + encodeURIComponent(o.id),
      sub === "cancel" ? "DELETE" : "GET",
    );
  else throw Error("Unknown command. Run reach-agent --help.");
  output(result);
  return 0;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    });
}
