// Reach's own updates: a newer @nalebc/reach on npm, installed into the very
// folder npm installed this Reach in, then Reach restarts on it. Phones
// follow the Mac (build-reload), and agents follow it too (they fetch the
// new runtime themselves: scripts/agent-remote.mjs runtimeUpdater).
//
// Fails closed. An update is offered only for an npm install in a layout
// Reach recognizes, a folder it can write to, and a published version newer
// than this one. Exactly the version the owner confirmed is installed, never
// "latest" at install time, never with sudo. A source checkout is left to
// git. Nothing published yet is "no release", not an error.
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { compareVersions, parseVersion } from "./versions.mjs";
import { boundedResponseText } from "./http-response.mjs";

export const PACKAGE = "@nalebc/reach";
const CHECK_EVERY_MS = 6 * 3600_000;
const RETRY_OFFLINE_MS = 10 * 60_000;
// Still running this long after asking for the restart: it didn't happen.
const RESTART_GRACE_MS = 3 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const quote = (text, platform = process.platform) =>
  platform === "win32" ? `"${text}"` : `'${String(text).replace(/'/g, "'\\''")}'`;

// Where this Reach lives, as npm laid it out: <prefix>/lib/node_modules/@nalebc/reach
// (macOS, Linux) or <prefix>\node_modules\@nalebc\reach (Windows). Anything
// else (a copy, a link into a checkout, another package manager) isn't
// updated here: the owner gets the command to run.
export function reachInstall(root, {
  platform = process.platform,
  realpath = (file) => fs.realpathSync.native(file),
  exists = (file) => fs.existsSync(file),
  readFile = (file) => fs.readFileSync(file, "utf8"),
  writable = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } },
} = {}) {
  let pkg = {};
  try { pkg = JSON.parse(readFile(path.join(root, "package.json"))); } catch { /* unreadable: no version */ }
  const version = parseVersion(pkg.version)?.text || null;
  const name = pkg.name === PACKAGE ? PACKAGE : null;
  const manual = `npm install --global ${PACKAGE}@latest`;
  if (exists(path.join(root, "src", "main.tsx"))) {
    if (exists(path.join(root, ".git"))) return { source: true, version, name };
    return { source: false, version, name, reason: "portable", manual: "Download the new portable archive from https://github.com/nalebc/reach/releases and follow docs/RELEASE.md to replace this copy." };
  }
  if (!name || !version) return { source: false, version, name, reason: "unknown", manual };
  let real;
  try { real = realpath(root); } catch { return { source: false, version, name, reason: "unknown", manual }; }
  const sep = platform === "win32" ? /[\\/]+/ : /\/+/;
  const parts = real.split(sep);
  const tail = platform === "win32" ? ["node_modules", "@nalebc", "reach"] : ["lib", "node_modules", "@nalebc", "reach"];
  const matches = parts.length > tail.length && tail.every((part, i) => parts[parts.length - tail.length + i].toLowerCase() === part);
  if (!matches) return { source: false, version, name, reason: "layout", manual };
  const prefix = parts.slice(0, parts.length - tail.length).join(platform === "win32" ? "\\" : "/") || "/";
  const modules = platform === "win32" ? path.win32.join(prefix, "node_modules") : path.posix.join(prefix, "lib", "node_modules");
  const bin = platform === "win32" ? prefix : path.posix.join(prefix, "bin");
  if (!writable(modules) || !writable(bin)) return { source: false, version, name, prefix, reason: "permission", manual: `You don't have permission to update this installation. Fix ownership of the prefix ${quote(prefix, platform)}, then run npm install --global --prefix ${quote(prefix, platform)} ${PACKAGE}@latest; or install into a user-owned prefix and use its reach command.` };
  // npm itself, from the same prefix when it's there (the one that installed
  // Reach, most likely); otherwise any npm: --prefix decides where it goes.
  const ownNpm = platform === "win32" ? path.win32.join(modules, "npm", "bin", "npm-cli.js") : path.posix.join(modules, "npm", "bin", "npm-cli.js");
  return { source: false, version, name, prefix, npm: exists(ownNpm) ? ownNpm : null };
}

// npm on PATH, as a script Node runs (the way scripts/bootstrap.mjs does).
export function npmOnPath(env = process.env, platform = process.platform) {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    if (platform === "win32") {
      const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
      if (fs.existsSync(cli)) return cli;
      continue;
    }
    const candidate = path.join(dir, "npm");
    if (fs.existsSync(candidate)) try { return fs.realpathSync.native(candidate); } catch { /* broken link */ }
  }
  return null;
}

// The exact install: this version, into this prefix.
export function installCommand(install, version, { platform = process.platform, npm = install.npm || npmOnPath(process.env, platform) } = {}) {
  const wanted = parseVersion(version)?.text;
  if (!wanted || !install.prefix || !npm) return null;
  const args = ["install", "--global", "--prefix", install.prefix, "--no-fund", "--no-audit", `${PACKAGE}@${wanted}`];
  return { file: npm, args, display: `npm install --global --prefix ${quote(install.prefix, platform)} ${PACKAGE}@${wanted}` };
}

// The newest published version: found, nothing published yet, or unknown
// (offline, a feed that says something unexpected).
export async function latestRelease({ name = PACKAGE, fetch: get = globalThis.fetch, timeoutMs = 8000, maxBytes = 64 * 1024 } = {}) {
  try {
    const res = await get(`https://registry.npmjs.org/-/package/${name}/dist-tags`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { accept: "application/json" },
    });
    // Not there for anyone: npm says 401 for a scoped package it doesn't
    // have (404 for an unscoped one), as for one that isn't public.
    if ([401, 403, 404].includes(res.status)) return { state: "unpublished" };
    if (!res.ok) return { state: "offline" };
    const text = await boundedResponseText(res, maxBytes);
    const latest = parseVersion(JSON.parse(text)?.latest)?.text;
    return latest ? { state: "found", version: latest } : { state: "offline" };
  } catch {
    return { state: "offline" };
  }
}

// Windows can't replace the files of a Reach that runs (its folder is its
// working directory, its native parts are loaded), so there the update the
// owner confirmed moves to a window of its own, which stops Reach, installs
// and starts it again (scripts/bootstrap.mjs update). What that window may
// install is this one request, written here only after the owner's tap:
// there's no switch an agent could pass to skip the phone.
export const updateRequestFile = (dataDir) => path.join(dataDir, "update-request.json");
const REQUEST_MS = 10 * 60_000;
export function askUpdate(dataDir, version, { now = Date.now() } = {}) {
  const wanted = parseVersion(version)?.text;
  if (!wanted) throw new Error("No version to update to.");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = updateRequestFile(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: wanted, requestedAt: now, expiresAt: now + REQUEST_MS }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return wanted;
}
// Read once and gone: the version asked for, while the request is fresh.
export function takeUpdateRequest(dataDir, { now = Date.now() } = {}) {
  const file = updateRequestFile(dataDir);
  let request = null;
  try {
    request = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  fs.rmSync(file, { force: true });
  const version = parseVersion(request?.version)?.text;
  return version && Number.isFinite(request.expiresAt) && request.expiresAt > now && request.requestedAt <= now ? version : null;
}

// The Mac's side: checks now and then, offers an update once per version
// (Needs you), installs the confirmed one and restarts Reach.
export function createReachUpdates({
  root,
  dataDir,
  install = reachInstall(root),
  fetch: get = globalThis.fetch,
  spawn = spawnChild,
  // Reach restarts on the new version (the same as a restart request:
  // server/index.mjs). Without one (not a Mac), the owner restarts it.
  restart = null,
  // Windows: the confirmed version's whole update, handed to a window of its
  // own (above). It stops this Reach; still running a while later, it didn't.
  handoff = null,
  platform = process.platform,
  now = Date.now,
  onChange = () => {},
  record = () => {},
  command = (version) => installCommand(install, version, { platform }),
  readVersion = () => reachInstall(root).version,
  restartGraceMs = RESTART_GRACE_MS,
} = {}) {
  const dismissedFile = dataDir ? path.join(dataDir, "update-dismissed.json") : null;
  const logFile = dataDir ? path.join(dataDir, "update.log") : null;
  let release = { state: install.source ? "source" : "unknown", checkedAt: 0 };
  let checking = null;
  let phase = "idle", target = null, error = "", child = null;
  let dismissed = null;
  try { dismissed = parseVersion(JSON.parse(fs.readFileSync(dismissedFile, "utf8")).version)?.text || null; } catch { /* none */ }
  const newer = () => release.state === "found" && compareVersions(release.version, install.version) === 1;
  const listeners = new Set([onChange]);
  const changed = () => { for (const listener of listeners) try { listener(); } catch { /* a listener's trouble isn't ours */ } };
  // Phones and Needs you hear of every change (server/index.mjs).
  const listen = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

  async function check({ fresh = false } = {}) {
    if (install.source) return status();
    // Known answers keep for hours; an unknown one is asked again sooner.
    const keepMs = release.state === "found" || release.state === "unpublished" ? CHECK_EVERY_MS : RETRY_OFFLINE_MS;
    if (!fresh && release.checkedAt && now() - release.checkedAt < keepMs) return status();
    checking ||= latestRelease({ fetch: get }).then((found) => {
      const differs = found.state !== release.state || found.version !== release.version;
      release = { ...found, checkedAt: now() };
      if (differs) changed();
    }).finally(() => { checking = null; });
    await checking;
    return status();
  }

  function status() {
    const base = { version: install.version };
    if (install.source) return { ...base, state: "source" };
    if (phase !== "idle") return { ...base, state: phase, to: target, ...(error ? { error } : {}) };
    if (release.state === "unpublished") return { ...base, state: "unpublished" };
    if (release.state !== "found") return { ...base, state: release.state === "unknown" ? "checking" : "offline" };
    if (!newer()) return { ...base, state: "current", latest: release.version };
    if (install.reason) return { ...base, state: "manual", to: release.version, reason: install.reason, command: install.manual.replace("@latest", `@${release.version}`) };
    const plan = command(release.version);
    if (!plan) return { ...base, state: "manual", to: release.version, reason: "npm", command: `npm install --global ${PACKAGE}@${release.version}` };
    return { ...base, state: "available", to: release.version, command: plan.display };
  }

  // While a new version is being installed, or waits for its restart, the
  // files on disk are newer than this server: agents aren't told about the
  // new runtime until the new server runs it.
  const busy = () => phase === "installing" || phase === "restarting" || phase === "installed";

  // Needs you: once per version, not while one is installing, never for a
  // checkout or what can't be installed from here.
  function offer() {
    const now_ = status();
    return now_.state === "available" && now_.to !== dismissed ? { from: install.version, to: now_.to } : null;
  }
  function dismiss(version) {
    const wanted = parseVersion(version)?.text;
    if (!wanted) return;
    dismissed = wanted;
    if (dismissedFile) try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(dismissedFile, JSON.stringify({ version: wanted }), { mode: 0o600 });
    } catch { /* remembered until a restart */ }
    changed();
  }

  // Install exactly `version` (what the owner saw), then restart.
  function start(version) {
    const now_ = status();
    if (busy()) throw Object.assign(Error(`Reach ${target} is already being installed.`), { status: 409 });
    if (now_.state !== "available" || parseVersion(version)?.text !== now_.to)
      throw Object.assign(Error("That update isn't the one offered now. Check again."), { status: 409 });
    const plan = command(now_.to);
    if (!plan) throw Object.assign(Error("npm wasn't found on this computer."), { status: 409 });
    phase = "installing"; target = now_.to; error = "";
    record(`Updating Reach to ${target}`);
    changed();
    if (handoff) {
      phase = "restarting";
      changed();
      try { handoff(target); }
      catch (e) { phase = "failed"; error = `The update didn't start (${e?.message || e}).`; record(`Reach ${target} didn't install: ${error}`); changed(); return status(); }
      const stuck = setTimeout(() => {
        if (phase !== "restarting") return;
        phase = "failed"; error = "The update didn't start. Run reach update on this computer.";
        record(`Reach ${target} didn't install: its window didn't stop Reach`);
        changed();
      }, restartGraceMs);
      stuck.unref?.();
      return status();
    }
    let tail = "";
    const keep = (chunk) => { tail = (tail + chunk.toString()).slice(-8192); };
    const finish = (ok, why) => {
      clearTimeout(deadline);
      child = null;
      if (logFile) try { fs.writeFileSync(logFile, `${plan.display}\n\n${tail}`, { mode: 0o600 }); } catch { /* best effort */ }
      const installed = ok && readVersion() === target;
      if (!installed) {
        phase = "failed";
        error = why || (ok ? "npm finished, but the new version isn't in place." : "npm didn't finish.");
        record(`Reach ${target} didn't install: ${error}`);
        return changed();
      }
      record(`Reach ${target} installed`);
      if (!restart) { phase = "installed"; error = "Restart Reach to finish."; return changed(); }
      phase = "restarting";
      changed();
      try { restart(); }
      catch (e) { phase = "installed"; error = `Restart Reach to finish (${e?.message || e}).`; return changed(); }
      // A restart that went right ends this process. Still here: it didn't.
      const stuck = setTimeout(() => {
        if (phase !== "restarting") return;
        phase = "installed"; error = "Reach didn't restart. Restart it to finish.";
        record(`Reach ${target} is installed, but Reach didn't restart`);
        changed();
      }, restartGraceMs);
      stuck.unref?.();
    };
    try {
      child = spawn(process.execPath, [plan.file, ...plan.args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_update_notifier: "false" } });
    } catch (e) {
      phase = "failed"; error = `npm didn't start (${e?.message || e}).`; changed();
      throw Object.assign(Error(error), { status: 500 });
    }
    const deadline = setTimeout(() => { try { child?.kill("SIGTERM"); } catch { /* gone */ } finish(false, "npm took too long."); }, INSTALL_TIMEOUT_MS);
    deadline.unref?.();
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.once("error", (e) => finish(false, `npm didn't start (${e?.message || e}).`));
    child.once("exit", (code) => { if (child) finish(code === 0, code === 0 ? "" : `npm stopped with exit code ${code}.`); });
    return status();
  }

  // A failed install can be tried again (or dismissed) from a fresh check.
  function reset() {
    if (phase === "failed") { phase = "idle"; target = null; error = ""; changed(); }
  }

  let timer = null;
  function watch({ firstMs = 60_000 } = {}) {
    if (install.source || timer) return;
    const tick = () => { void check().catch(() => {}); };
    const first = setTimeout(tick, firstMs);
    first.unref?.();
    // check() keeps a known answer for hours: this only retries sooner
    // when npm couldn't be reached.
    timer = setInterval(tick, RETRY_OFFLINE_MS);
    timer.unref?.();
    timer.first = first;
  }
  function close() {
    if (timer) { clearTimeout(timer.first); clearInterval(timer); timer = null; }
  }
  return { check, status, offer, dismiss, start, reset, busy, watch, close, listen };
}

// The Needs you card for an offered version.
export function updateNotification(offer, seal) {
  return seal(
    {
      id: `update:${offer.to}`,
      source: "update",
      sender: "Reach",
      icon: "mac",
      title: `Update Reach to ${offer.to}`,
      kind: "permission",
      detail: `You have ${offer.from}`,
      summary: "Reach installs it and starts again. Its terminals and live screens end; agents pick it up by themselves.",
      signature: offer.to,
      target: { page: "overview", needs: `update:${offer.to}` },
      actions: [
        { id: "update", label: "Update", tone: "primary" },
        { id: "deny", label: "Not now", tone: "deny" },
      ],
    },
    { type: "update", version: offer.to },
  );
}

// The owner's routes: the state (checked again on ?fresh=1), installing the
// version offered, or not now. Only the owner's own admin device, checked
// here whatever reaches the route.
export function mountReachUpdates(app, { updates, notPaused = () => {}, record = () => {}, fail }) {
  const owner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only the computer's owner updates Reach.");
    return client;
  };
  app.get("/api/reach/update", async (req, res) => {
    owner(req);
    res.set("Cache-Control", "no-store").json(req.query.fresh === "1" ? await updates.check({ fresh: true }) : updates.status());
  });
  app.post("/api/reach/update", async (req, res) => {
    owner(req);
    const { action, version } = req.body || {};
    if (!["install", "dismiss", "retry"].includes(action)) throw fail(400, "Choose install, dismiss or retry.");
    if (action === "dismiss") updates.dismiss(version);
    else if (action === "retry") { updates.reset(); await updates.check({ fresh: true }); }
    else {
      notPaused();
      try { updates.start(version); }
      catch (error) { throw fail(error.status || 500, error.message); }
      record(`Started updating Reach to ${version}`);
    }
    res.set("Cache-Control", "no-store").json(updates.status());
  });
}
