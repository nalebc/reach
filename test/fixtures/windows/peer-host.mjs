// Reach's half of the real-Windows peer check test, run as a standard user
// (test/windows-tailscaled-peer.test.mjs; docs/parity/D-public-door.md §8):
// its folders made private, the real peer check started, and the keyed
// listener answering whatever it lets through.
//
//   node peer-host.mjs <results folder> <state folder> <code folder>
//
// Writes <results>/peer-host.json once ready ({ port, key, ready, folders }),
// <results>/events.jsonl as things happen (each accepted connection with when,
// each answer with the connection's creation time, each request Reach got,
// each refusal), and stops when <results>/stop appears. When the check won't
// start, it first notes what Windows gives this very process (Node, as that
// user): <results>/peer-host-whoami.csv and, if the test put
// <results>/peer-probe.exe there, <results>/peer-probe-node.txt.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listenKeyedIngress, newIngressKey } from "../../../server/tailscale-auth.mjs";
import { createTailscaledPeerCheck } from "../../../server/tailscaled-peer.mjs";
import { ensurePrivateFolders } from "../../../server/windows-private-folder.mjs";

const [results, state, code] = process.argv.slice(2);
const event = (value) => fs.appendFileSync(path.join(results, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...value })}\n`);
const done = (value) => fs.writeFileSync(path.join(results, "peer-host.json"), JSON.stringify(value));
const diagnose = () => {
  const save = (name, file, args) => {
    let text;
    try {
      text = execFileSync(file, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
    } catch (error) {
      text = `failed: ${error.message}\n${error.stdout || ""}`;
    }
    fs.writeFileSync(path.join(results, name), text);
  };
  save("peer-host-whoami.csv", path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/groups", "/fo", "csv"]);
  const probe = path.join(results, "peer-probe.exe");
  if (fs.existsSync(probe)) save("peer-probe-node.txt", probe, []);
};
let folders, peerCheck;
try {
  folders = await ensurePrivateFolders({ protect: [state], check: code ? [code] : [], nativeDir: path.join(state, "native"), helpers: ["tailscaled-peer"] });
  if (!folders.ok) {
    done({ ready: { ok: false, reason: folders.reason }, folders: folders.reason });
    process.exit(0);
  }
  peerCheck = createTailscaledPeerCheck({
    helper: folders.helper("tailscaled-peer"),
    onProblem: (reason) => event({ problem: reason }),
    onAnswer: (answer) => event({ answer }),
  });
  const ready = await peerCheck.ready();
  if (!ready.ok) {
    diagnose();
    done({ ready });
    await peerCheck.close();
    await folders.dispose?.();
    process.exit(0);
  }
  const key = newIngressKey();
  const server = await listenKeyedIngress({
    key,
    peerCheck,
    resolveIdentity: async () => null,
    app: (req, res) => {
      event({ request: req.url, port: req.socket.remotePort });
      res.end("ok");
    },
    upgrade: (req, socket) => socket.destroy(),
    onRefused: (kind) => event({ refused: kind }),
  });
  server.on("connection", (socket) => event({ accepted: socket.remotePort }));
  done({ port: server.address().port, key, ready, folders: "ok", nativeDir: folders.nativeDir,
    helper: await folders.helper("tailscaled-peer")() });
  const timer = setInterval(async () => {
    if (!fs.existsSync(path.join(results, "stop"))) return;
    clearInterval(timer);
    await peerCheck.close();
    server.close(async () => { await folders.dispose?.(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  }, 200);
} catch (error) {
  await peerCheck?.close().catch(() => {});
  await folders?.dispose?.().catch(() => {});
  done({ ready: { ok: false, reason: `peer-host: ${error.message}` } });
  process.exit(1);
}
