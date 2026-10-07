// Disposable real-Tailscale test host. Never edits the real Reach data directory.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createReach } from "../../server/index.mjs";
import { approvalStore } from "../../server/device-approval.mjs";
import { serveSocketPath } from "../../server/tailscale-auth.mjs";
import { setupOwner, assertSocketSupport } from "../../scripts/configure.mjs";
import { tailscaleJson, prepareTailscale } from "../../scripts/tailscale.mjs";
import {
  ensurePersistentRoute,
  removePersistentRoute,
} from "../../scripts/persistent-serve.mjs";
import { createAuth, getConfig } from "../../server/core.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(root, ".cache");
const stateFile = path.join(cache, "fixture.json");
const [command = "start", code] = process.argv.slice(2);
const load = async () => JSON.parse(await fs.readFile(stateFile, "utf8"));
if (command === "approve") {
  const state = await load(),
    store = approvalStore(state.dataDir);
  const matches = store
    .list()
    .filter((r) => r.id.slice(0, 8) === code && r.status === "pending");
  if (matches.length !== 1)
    throw Error("Pass the eight-character approval code shown in the browser.");
  store.decide(matches[0].id, "approve");
  console.log("Approved only this disposable fixture's browser request.");
} else if (command === "revoke") {
  const state = await load();
  const auth = createAuth(
    getConfig({ dataDir: state.dataDir, roots: [state.shared] }),
    { rotatePairing: false },
  );
  for (const client of auth.list()) auth.revoke(client.id);
  console.log("Revoked all Reach credentials in the disposable fixture.");
} else if (command === "status") {
  const state = await load();
  console.log(
    JSON.stringify(
      {
        origin: state.origin,
        pid: state.pid,
        requests: approvalStore(state.dataDir)
          .list()
          .map((r) => ({
            code: r.id.slice(0, 8),
            status: r.status,
            name: r.name,
          })),
      },
      null,
      2,
    ),
  );
} else if (command === "stop") {
  const state = await load();
  process.kill(state.pid, "SIGTERM");
} else if (command === "start") {
  await fs.mkdir(cache, { recursive: true });
  try {
    const old = await load();
    let running = true;
    try {
      process.kill(old.pid, 0);
    } catch {
      running = false;
    }
    if (running)
      throw Error(
        "A fixture is already running. Stop it before creating another.",
      );
    await removePersistentRoute({ file: old.routeFile });
    await fs.rm(stateFile, { force: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const owner = setupOwner(await tailscaleJson(["status", "--json"]));
  await assertSocketSupport();
  const port = Number(process.env.REACH_BROWSER_PORT || 8446);
  const origin = await prepareTailscale(port);
  const staticOrigin = new URL(
    process.env.REACH_BROWSER_ORIGIN || "http://127.0.0.1:5199",
  );
  if (
    staticOrigin.origin !== staticOrigin.href.replace(/\/$/, "") ||
    (staticOrigin.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(staticOrigin.hostname))
  )
    throw Error(
      "Use an exact HTTPS frontend origin, or localhost for development.",
    );
  // Express download intentionally ignores dot-directories; keep the public
  // fixture file outside .cache while preserving a private 0700 parent.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-browser-host-"));
  await fs.chmod(dir, 0o700);
  const shared = path.join(dir, "shared"),
    dataDir = path.join(dir, "private"),
    routeFile = path.join(dir, "serve.json");
  await fs.mkdir(shared);
  await fs.writeFile(
    path.join(shared, "Welcome.txt"),
    "Read through Tailscale running inside the browser.\nThis is a disposable Reach test file.\n",
  );
  const reach = await createReach({
    name: "Reach browser test",
    dataDir,
    roots: [shared],
    tailscaleOwner: owner,
    publicOrigin: origin,
    allowedOrigins: [staticOrigin.origin],
    screen: false,
  });
  const socket = serveSocketPath(dir);
  const state = {
    pid: process.pid,
    dir,
    shared,
    dataDir,
    routeFile,
    origin,
    socket,
  };
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await removePersistentRoute({ file: routeFile });
    } catch (e) {
      console.error("Fixture route cleanup failed:", e.message);
      process.exitCode = 1;
    }
    await reach.close();
    if (!process.exitCode) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(stateFile, { force: true });
      await fs.rm(path.dirname(socket), { recursive: true, force: true });
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () =>
      cleanup().then(() => process.exit(process.exitCode || 0)),
    );
  try {
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socket);
    await fs.writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    await ensurePersistentRoute({
      file: routeFile,
      origin,
      target: `unix:${socket}`,
    });
    console.log(
      `Disposable private Reach endpoint: ${origin}\nFrontend: ${staticOrigin.origin}\nApproval: node experiments/browser-connect/fixture.mjs approve <code>\nStop: node experiments/browser-connect/fixture.mjs stop`,
    );
  } catch (e) {
    await cleanup();
    throw e;
  }
} else throw Error("Use start, status, approve <code>, revoke, or stop.");
