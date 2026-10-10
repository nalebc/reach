// OpenClaw feature: skills. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir, openCommand }.
//
// Gateway 2026.3.13: skills.status {agentId?}, skills.update {skillKey,
// enabled?, apiKey?, env?}, skills.install {name, installId, timeoutMs?}.
// skills.install runs a skill's own dependency installer (brew, npm, go, uv
// or a download), not ClawHub; there's no skills.search. Install details
// come from the skill's SKILL.md (status only has the author's label).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";

const fail = (status, message) => Object.assign(new Error(message), { status });
const SOURCES = {
  "openclaw-bundled": "bundled",
  "openclaw-managed": "managed",
  "openclaw-workspace": "workspace",
  "openclaw-extra": "extra",
  "agents-skills-personal": "personal",
  "agents-skills-project": "project",
};
const KINDS = ["brew", "node", "go", "uv", "download"];
const NAME = /^[\w.@:+-]{1,100}$/;
const INSTALL_ID = /^[\w.@:+-]{1,100}$/;
const CHECK = /^[a-f0-9]{64}$/;
const SCRIPT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|command|applescript|scpt)$/i;
const INSTALL_MS = 300000;
// Same shape as channel tokens (addOpenClawChannel).
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/;
// Text for a phone: no control characters, bounded.
const clean = (value, max = 120) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, max) : "";
// Names only (bins, env vars, config paths), never values.
const names = (list) =>
  Array.isArray(list) ? [...new Set(list.map((v) => clean(v, 80)).filter(Boolean))].slice(0, 20) : [];

// OpenClaw's own install-spec checks (src/agents/skills/frontmatter.ts).
const BREW = /^[A-Za-z0-9][A-Za-z0-9@+._/-]*$/;
const GO = /^[A-Za-z0-9][A-Za-z0-9._~+\-/]*(?:@[A-Za-z0-9][A-Za-z0-9._~+\-/]*)?$/;
const UV = /^[A-Za-z0-9][A-Za-z0-9._\-[\]=<>!~+,]*$/;
const NPM = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*+-]+)?$/i;
const safe = (raw, shape, extra = () => true) => {
  if (typeof raw !== "string") return;
  const v = raw.trim();
  if (!v || v.startsWith("-") || v.includes("\\") || v.includes("..") || v.includes("://")) return;
  return shape.test(v) && extra(v) ? v : undefined;
};
const httpUrl = (raw) => {
  if (typeof raw !== "string" || !raw.trim() || /\s/.test(raw.trim())) return;
  try {
    const url = new URL(raw.trim());
    return ["http:", "https:"].includes(url.protocol) ? url : undefined;
  } catch {}
};
function parseSpec(raw) {
  if (!raw || typeof raw !== "object") return;
  const kind = String(typeof raw.kind === "string" ? raw.kind : raw.type || "").trim().toLowerCase();
  if (!KINDS.includes(kind)) return;
  const spec = { kind, id: typeof raw.id === "string" ? raw.id : undefined };
  if (kind === "brew") spec.target = safe(raw.formula, BREW) || safe(raw.cask, BREW);
  if (kind === "node") spec.target = safe(raw.package, NPM);
  if (kind === "uv") spec.target = safe(raw.package, UV);
  if (kind === "go") spec.target = safe(raw.module, GO);
  if (kind === "download") {
    spec.url = httpUrl(raw.url);
    spec.target = spec.url?.toString();
    spec.extract = raw.extract === true || (raw.extract !== false && /\.(zip|tar\.gz|tgz|tar\.bz2|tbz2)$/i.test(spec.url?.pathname || ""));
  }
  return spec.target ? spec : undefined;
}
// The `metadata:` block of SKILL.md's front matter (inline or indented).
export function skillManifest(text) {
  const doc = String(text).replace(/\r\n?/g, "\n");
  if (!doc.startsWith("---")) return;
  const end = doc.indexOf("\n---", 3);
  if (end < 0) return;
  const lines = doc.slice(4, end).split("\n");
  const at = lines.findIndex((l) => /^metadata:/.test(l));
  if (at < 0) return;
  let raw = lines[at].replace(/^metadata:\s*/, "");
  if (!raw.trim())
    for (let i = at + 1; i < lines.length && (!lines[i] || /^[ \t]/.test(lines[i])); i++) raw += "\n" + lines[i];
  try {
    const block = JSON5.parse(raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2"))?.openclaw;
    if (!block || typeof block !== "object") return;
    const install = (Array.isArray(block.install) ? block.install : []).map(parseSpec).filter(Boolean);
    return { install };
  } catch {}
}
// Who publishes what will be installed.
function publisher(spec) {
  const t = spec.target;
  if (spec.kind === "brew") return t.split("/").length === 3 ? `${t.split("/")[0]} (Homebrew tap)` : "Homebrew";
  if (spec.kind === "node") return t.startsWith("@") ? `npm ${t.split("/")[0]}` : "npm";
  if (spec.kind === "uv") return "PyPI";
  if (spec.kind === "go") return t.split("@")[0].split("/").slice(0, 2).join("/");
  return spec.url.host;
}
function command(spec, label) {
  const t = spec.target;
  if (spec.kind === "brew") return `brew install ${t}`;
  if (spec.kind === "go") return `go install ${t}`;
  if (spec.kind === "uv") return `uv tool install ${t}`;
  if (spec.kind === "download") return `download ${t}${spec.extract ? " and unpack" : ""}`;
  // OpenClaw's label names the package manager it picked.
  const manager = /\((npm|pnpm|yarn|bun)\)$/.exec(label || "")?.[1] || "npm";
  return {
    npm: `npm install -g --ignore-scripts ${t}`,
    pnpm: `pnpm add -g --ignore-scripts ${t}`,
    yarn: `yarn global add --ignore-scripts ${t}`,
    bun: `bun add -g --ignore-scripts ${t}`,
  }[manager];
}
// Script files in the skill's own folder (the agent may run them).
async function scripts(dir) {
  const found = [];
  let seen = 0;
  const walk = async (at, depth) => {
    let entries = [];
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > 400 || found.length >= 8) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(at, e.name);
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (e.isFile()) {
        const mode = SCRIPT.test(e.name) ? 0 : (await fs.stat(full).catch(() => ({ mode: 0 }))).mode;
        if (SCRIPT.test(e.name) || mode & 0o111) found.push(clean(path.relative(dir, full), 80));
      }
    }
  };
  await walk(dir, 0);
  return found;
}
async function clawHubSlugs(workspaceDir) {
  if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) return new Set();
  try {
    const lock = JSON.parse(await fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"));
    return new Set(Object.keys(lock?.skills && typeof lock.skills === "object" ? lock.skills : {}));
  } catch {
    return new Set();
  }
}

export function routes(app, client, ctx) {
  const { base, authorize } = ctx;
  const installs = new Map();
  const finishedAt = new Map();
  let installing = "";
  // A finished install is forgotten once the skill is ready, or after a while.
  const forget = (name, ready) => {
    const at = finishedAt.get(name);
    if (at === undefined) return;
    if (ready || Date.now() - at > 10 * 60 * 1000) {
      installs.delete(name);
      finishedAt.delete(name);
    }
  };
  const status = async () => {
    try {
      const data = await client.call("skills.status", {});
      return Array.isArray(data?.skills) ? data : { skills: [] };
    } catch (error) {
      if (!client.can("skills.status")) return null;
      throw error;
    }
  };
  const findSkill = (data, name) => data.skills.find((s) => s?.name === name);
  // The exact installer OpenClaw would run, read from the skill's file.
  const inspect = async (skill, installId) => {
    const option = (Array.isArray(skill.install) ? skill.install : []).find((o) => o?.id === installId);
    if (!option) throw fail(404, "This installer isn't offered anymore.");
    const file = skill.filePath;
    if (typeof file !== "string" || !path.isAbsolute(file) || path.basename(file) !== "SKILL.md")
      throw fail(409, "Reach can't check this skill. Install it on your Mac.");
    let text;
    try {
      const real = await fs.realpath(file);
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error();
      text = await fs.readFile(real, "utf8");
    } catch {
      throw fail(409, "Reach can't check this skill. Install it on your Mac.");
    }
    // OpenClaw's installId: the spec's id, or `${kind}-${index}`.
    const spec = (skillManifest(text)?.install || []).find(
      (s, i) => (s.id ?? `${s.kind}-${i}`).trim() === installId,
    );
    if (!spec || spec.kind !== option.kind || (spec.kind === "node" && !String(option.label).includes(spec.target)))
      throw fail(409, "Reach can't check this installer. Install it on your Mac.");
    const bundled = skill.bundled === true;
    const folder = await scripts(path.dirname(await fs.realpath(file)));
    const thirdPartyTap = spec.kind === "brew" && spec.target.split("/").length === 3;
    const warnings = [
      ...(bundled ? [] : ["notBundled"]),
      ...(folder.length || thirdPartyTap || spec.kind === "download" ? ["script"] : []),
      "internet",
      ...(bundled ? [] : ["unknownPublisher"]),
    ];
    const req = skill.requirements || {};
    const check = crypto
      .createHash("sha256")
      .update(JSON.stringify([skill.name, installId, text, folder]))
      .digest("hex");
    return {
      check,
      name: clean(skill.name, 100),
      emoji: clean(skill.emoji, 8),
      source: SOURCES[skill.source] || "other",
      bundled,
      publisher: bundled ? "OpenClaw" : "Unknown",
      kind: spec.kind,
      package: clean(spec.target, 200),
      packageFrom: clean(publisher(spec), 100),
      command: clean(command(spec, option.label), 260),
      scripts: folder,
      access: {
        bins: names([...(req.bins || []), ...(req.anyBins || []), ...(option.bins || [])]),
        env: names(req.env),
        config: names(req.config),
      },
      warnings,
      level: bundled ? "calm" : "strong",
    };
  };
  const validName = (value) => {
    if (typeof value !== "string" || !NAME.test(value)) throw fail(400, "Choose a skill.");
    return value;
  };

  app.get(`${base}/skills`, async (_req, res) => {
    const data = await status();
    if (!data) return res.json({ supported: false });
    const hub = await clawHubSlugs(data.workspaceDir);
    const skills = data.skills
      .filter((s) => s && typeof s.name === "string" && NAME.test(s.name))
      .map((s) => {
        const missing = s.missing || {};
        const key = typeof s.skillKey === "string" && NAME.test(s.skillKey) ? s.skillKey : s.name;
        const install = (Array.isArray(s.install) ? s.install : [])
          .filter((o) => o && KINDS.includes(o.kind) && typeof o.id === "string" && INSTALL_ID.test(o.id))
          .map((o) => ({ id: o.id, kind: o.kind, label: clean(o.label, 80) }));
        forget(s.name, s.eligible === true);
        const job = installs.get(s.name);
        // Its API key is missing: the phone can set it (write-only).
        const keyName =
          typeof s.primaryEnv === "string" && (missing.env || []).includes(s.primaryEnv) ? clean(s.primaryEnv, 80) : "";
        return {
          name: s.name,
          key,
          emoji: clean(s.emoji, 8),
          description: clean(s.description, 160),
          source:
            s.source === "openclaw-workspace" && typeof s.baseDir === "string" && hub.has(path.basename(s.baseDir))
              ? "clawhub"
              : SOURCES[s.source] || "other",
          bundled: s.bundled === true,
          state: s.disabled === true || s.blockedByAllowlist === true ? "off" : s.eligible === true ? "ready" : "setup",
          blocked: s.blockedByAllowlist === true,
          missing: {
            bins: names([...(missing.bins || []), ...(missing.anyBins || [])]),
            env: names(missing.env),
            config: names(missing.config),
            os: names(missing.os),
          },
          install,
          ...(keyName ? { keyName } : {}),
          ...(job ? { installing: job } : {}),
        };
      });
    res.json({
      supported: true,
      skills,
      canToggle: client.can("skills.update"),
      canInstall: client.can("skills.install"),
      canSetup: client.can("skills.update"),
      busy: !!installing,
    });
  });

  app.post(`${base}/skills/enable`, async (req, res) => {
    const { key, enabled } = req.body || {};
    validName(key);
    if (typeof enabled !== "boolean") throw fail(400, "Choose on or off.");
    const data = await status();
    if (!data) throw fail(409, "This OpenClaw can't change skills. Update OpenClaw on this computer.");
    if (!data.skills.some((s) => (s?.skillKey ?? s?.name) === key)) throw fail(404, "This skill isn't on this Mac anymore.");
    // The answer carries the skill's config (API key, env): never forwarded.
    await client.call("skills.update", { skillKey: key, enabled }, authorize(req));
    res.json({ key, enabled });
  });

  // A skill's API key: written to OpenClaw, never read back or echoed.
  app.post(`${base}/skills/key`, async (req, res) => {
    const { key, apiKey } = req.body || {};
    validName(key);
    if (typeof apiKey !== "string" || !KEY_SHAPE.test(apiKey.trim())) throw fail(400, "Paste the API key.");
    const data = await status();
    if (!data || !client.can("skills.update")) throw fail(409, "This OpenClaw can't change skills. Update OpenClaw on this computer.");
    const skill = data.skills.find((s) => (s?.skillKey ?? s?.name) === key);
    if (!skill) throw fail(404, "This skill isn't on this Mac anymore.");
    if (typeof skill.primaryEnv !== "string" || !skill.primaryEnv) throw fail(409, "This skill doesn't take a key. Set it up on your Mac.");
    authorize(req)();
    try {
      await client.call("skills.update", { skillKey: key, apiKey: apiKey.trim() }, authorize(req));
    } catch {
      throw fail(409, "OpenClaw didn't save the key. Try again or set it up on your Mac.");
    }
    res.json({ saved: true });
  });

  // The safety check shown before an install.
  app.get(`${base}/skills/check`, async (req, res) => {
    const name = validName(req.query.name);
    const installId = req.query.install;
    if (typeof installId !== "string" || !INSTALL_ID.test(installId)) throw fail(400, "Choose an installer.");
    const data = await status();
    if (!data || !client.can("skills.install")) throw fail(409, "This OpenClaw can't install skills. Update OpenClaw on this computer.");
    const skill = findSkill(data, name);
    if (!skill) throw fail(404, "This skill isn't on this Mac anymore.");
    res.json(await inspect(skill, installId));
  });

  // Second confirm: installs only what the phone checked (same file, same
  // installer), in the background; the list shows how it went.
  app.post(`${base}/skills/install`, async (req, res) => {
    const { name, installId, check, confirmed } = req.body || {};
    validName(name);
    if (typeof installId !== "string" || !INSTALL_ID.test(installId)) throw fail(400, "Choose an installer.");
    if (typeof check !== "string" || !CHECK.test(check) || confirmed !== true)
      throw fail(400, "Review the safety check first.");
    authorize(req)();
    if (installing) throw fail(409, "Another install is running. Wait for it to finish.");
    const data = await status();
    if (!data || !client.can("skills.install")) throw fail(409, "This OpenClaw can't install skills. Update OpenClaw on this computer.");
    const skill = findSkill(data, name);
    if (!skill) throw fail(404, "This skill isn't on this Mac anymore.");
    const checked = await inspect(skill, installId);
    if (checked.check !== check) throw fail(409, "This skill changed since its check. Check it again.");
    if (installing) throw fail(409, "Another install is running. Wait for it to finish.");
    installing = name;
    installs.set(name, { status: "running" });
    finishedAt.delete(name);
    const run = client.call(
      "skills.install",
      { name, installId, timeoutMs: INSTALL_MS },
      authorize(req),
      INSTALL_MS + 30000,
    );
    run
      .then((result) => {
        // OpenClaw scans the skill's code while installing (it doesn't stop).
        const flagged = Array.isArray(result?.warnings) && result.warnings.length > 0;
        installs.set(name, { status: "done", ...(flagged ? { flagged: true } : {}) });
        finishedAt.set(name, Date.now());
      })
      .catch((error) => {
        const text = String(error?.message || "");
        installs.set(name, {
          status: "failed",
          message: /brew not installed|homebrew is not installed/i.test(text)
            ? "Homebrew isn't installed on this Mac."
            : /(go|uv) not installed/i.test(text)
              ? `${/go not/i.test(text) ? "Go" : "uv"} isn't installed on this Mac.`
              : /did not respond in time/i.test(text)
                ? "Install took too long. Check on your Mac."
                : "Install failed. Try it on your Mac.",
        });
        finishedAt.set(name, Date.now());
      })
      .finally(() => {
        if (installing === name) installing = "";
      });
    // Waits a moment so quick refusals show at once.
    await Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, 50))]);
    res.json({ started: true, installing: installs.get(name) });
  });

  // Only values declared missing by this skill, written directly to OpenClaw.
  app.post(`${base}/skills/setup`, async (req, res) => {
    authorize(req)();
    const { key, env } = req.body || {};
    validName(key);
    if (!env || typeof env !== "object" || Array.isArray(env) || !Object.keys(env).length)
      throw fail(400, "Enter the missing skill values.");
    const data = await status();
    if (!data || !client.can("skills.update")) throw fail(409, "This OpenClaw can't change skills.");
    const skill = data.skills.find((s) => (s?.skillKey ?? s?.name) === key);
    if (!skill) throw fail(404, "This skill isn't available anymore.");
    const allowed = new Set(skill.missing?.env || []);
    const values = Object.create(null);
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !allowed.has(name) ||
          typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
        throw fail(400, "Enter valid values for this skill's missing settings.");
      values[name] = value.trim();
    }
    try {
      await client.call("skills.update", { skillKey: key, env: values }, authorize(req));
    } catch {
      throw fail(409, "OpenClaw didn't save these values. Try again.");
    }
    res.json({ saved: true });
  });
}
