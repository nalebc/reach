// OpenClaw feature: health. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir, openCommand }.
//
// A pill on the status line (Healthy, Slow, Needs attention) and a sheet:
// uptime, the state files' size, channel issues, logs, Restart and Doctor.
// Only numbers and Reach's own labels leave the host; log lines are scrubbed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { localOpenClawConfig } from "./openclaw.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

// Over this, a database (or its -wal) needs attention: a WAL of 1–3 GB has
// kept Gateways from starting.
export const DB_WARN_BYTES = 500 * 1024 * 1024;
// A `health` answer slower than this reads as Slow.
export const SLOW_MS = 2000;
const LINE_MAX = 300;
const LOG_LINES = 200;

// Channel ids the Gateway may name, in Reach's words; anything else is "Other".
const CHANNELS = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
  bluebubbles: "iMessage",
  googlechat: "Google Chat",
  msteams: "Teams",
  matrix: "Matrix",
  mattermost: "Mattermost",
  line: "LINE",
  feishu: "Feishu",
  zalo: "Zalo",
  nostr: "Nostr",
  irc: "IRC",
  webchat: "Web chat",
};
const channelLabel = (id) =>
  Object.hasOwn(CHANNELS, id) ? CHANNELS[id] : "Other";

// --- Scrubbing: log text can carry keys, tokens, people's numbers. ---------
const hidden = "[hidden]";
const SCRUBS = [
  // ANSI colors and control characters.
  [/\x1b\[[0-9;?]*[A-Za-z]/g, ""],
  [/[\u0000-\u0008\u000b-\u001f\u007f]/g, " "],
  // Authorization headers.
  [/\b(Bearer|Basic|Token)\s+[^\s"',;]+/gi, `$1 ${hidden}`],
  // Named secrets: key=value, key: value, "key":"value" (logged objects).
  [
    /(["']?)([\w-]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|auth|authorization|cookie|session[_-]?key|private[_-]?key|credential)s?)\1(\s*[:=]\s*)(?:(["'])((?:(?!\4).){0,400})\4|([^\s"',;}&]+))/gi,
    // Counts stay ("tokens=1200"), anything else is hidden.
    (all, q, key, sep, vq = "", quoted, bare) =>
      /^(\d{1,9}|true|false|null|undefined|none|unset)$/i.test(quoted ?? bare)
        ? all
        : `${q}${key}${q}${sep}${vq}${hidden}${vq}`,
  ],
  // Known key shapes.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, hidden],
  [/\bxox[a-z]?-[A-Za-z0-9-]{6,}/gi, hidden],
  [/\bxapp-[A-Za-z0-9-]{6,}/gi, hidden],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, hidden],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, hidden],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, hidden],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, hidden],
  // Telegram bot tokens (also inside its API URLs).
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, hidden],
  // URLs: no credentials, no path or query (both can carry tokens).
  [
    /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]+@)?([^\s/?#"'<>]+)[^\s"'<>]*/gi,
    (_, scheme, host) => `${scheme}${host.replace(/:[^:]*$/, (p) => (/^:\d+$/.test(p) ? p : ""))}`,
  ],
  // Queries on bare paths (/oauth/callback?code=…).
  [/(\/[\w./%~-]*)\?[^\s"'<>]+/g, "$1"],
  // Emails and chat addresses (WhatsApp's 123@s.whatsapp.net).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Phone numbers: +1 514 555 0100, (514) 555-0100, 514-555-0100.
  [/\+\d[\d\s().-]{6,}\d/g, "[phone]"],
  [/\(\d{3}\)\s?\d{3}[-.\s]\d{4}\b/g, "[phone]"],
  [/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]"],
  // Long numbers: phone numbers without +, chat and user ids.
  [/(?<![.\d])\b\d{10,}\b/g, hidden],
  // Home folders name the person.
  [/(?:\/Users|\/home)\/[^\s/"']+/g, "~"],
  [/[A-Za-z]:\\Users\\[^\s\\"']+/g, "~"],
  // Long hex.
  [/\b[0-9a-fA-F]{24,}\b/g, hidden],
];
// Long base64/base64url runs: tokens. Paths are looked at a segment at a
// time (/opt/homebrew/… stays), and dashed names with a version in them
// (claude-sonnet-4-5-20250929, a UUID) stay too.
const mixed = (s) => /\d/.test(s) && /[A-Za-z]/.test(s);
const tokenish = (run) =>
  run
    .split("/")
    .map((part) =>
      part.split(/[-_]/).some((piece) => piece.length >= 20 && mixed(piece)) ||
      (part.length >= 24 && mixed(part) && /[a-z]/.test(part) && /[A-Z]/.test(part))
        ? hidden
        : part,
    )
    .join("/");

export function scrubLine(value, max = LINE_MAX) {
  // Capped before the patterns run (they never see megabytes), then after;
  // a word cut by the first cap is dropped, never shown in part.
  let text = String(value ?? "").replace(/\s+/g, " ");
  if (text.length > max * 4) text = text.slice(0, max * 4).replace(/\S*$/, "");
  for (const [pattern, replacement] of SCRUBS)
    text = text.replace(pattern, replacement);
  text = text.replace(/[A-Za-z0-9+/_=-]{24,}/g, tokenish);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];
// One line of OpenClaw's file log (tslog JSON), as parseLogLine reads it:
// never the raw line (its _meta has paths and the host's name).
export function readLogLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw).slice(0, 64 * 1024));
  } catch {
    const text = scrubLine(raw);
    return text ? { time: 0, level: "info", source: "", text } : null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const meta = parsed._meta && typeof parsed._meta === "object" ? parsed._meta : {};
  let source = "";
  try {
    const name = JSON.parse(meta.name);
    if (typeof name?.subsystem === "string") source = name.subsystem;
  } catch {}
  const parts = [];
  for (const key of Object.keys(parsed)) {
    if (!/^\d+$/.test(key)) continue;
    const item = parsed[key];
    if (key === "0" && typeof item === "string" && item === meta.name) continue;
    parts.push(typeof item === "string" ? item : JSON.stringify(item));
  }
  const level = String(meta.logLevelName || "").toLowerCase();
  const time = Date.parse(typeof parsed.time === "string" ? parsed.time : meta.date);
  const text = scrubLine(parts.join(" "));
  if (!text) return null;
  return {
    time: Number.isFinite(time) ? time : 0,
    level: LEVELS.includes(level) ? level : "info",
    source: scrubLine(source, 40).replace(/[^\w/.-]/g, ""),
    text,
  };
}

// --- State files ---------------------------------------------------------
// OpenClaw's own databases (memory/<agent>.sqlite and the like) with their
// -wal and -shm. Agents' workspaces and media aren't OpenClaw's state.
// QMD's index sits at agents/<id>/qmd/xdg-cache/qmd/index.sqlite.
const SKIP = /^(workspace|media|canvas|sessions|logs|node_modules|\.)/;
const DB = /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i;
export async function stateFiles({ env = process.env, home = os.homedir(), depth = 6, limit = 20000 } = {}) {
  const root = env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  const sizes = { dbBytes: 0, walBytes: 0, largestBytes: 0, files: 0 };
  let seen = 0;
  const walk = async (dir, level) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > limit) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (level < depth && !SKIP.test(entry.name)) await walk(file, level + 1);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks are never followed
      const kind = DB.exec(entry.name);
      if (!kind) continue;
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      if (kind[2]) sizes.walBytes += stat.size;
      else sizes.files++;
      sizes.dbBytes += stat.size;
      sizes.largestBytes = Math.max(sizes.largestBytes, stat.size);
    }
  };
  try {
    if (!(await fs.lstat(root)).isDirectory()) return { supported: false };
  } catch {
    return { supported: false };
  }
  await walk(root, 1);
  return {
    supported: true,
    ...sizes,
    warn: sizes.dbBytes > DB_WARN_BYTES || sizes.walBytes > DB_WARN_BYTES,
  };
}

// The Gateway's own readiness (its HTTP /readyz, answered in full only to
// loopback): uptime and the channels it counts as failing.
export async function readiness({ configuration = localOpenClawConfig, fetch: get = fetch, timeoutMs = 3000 } = {}) {
  try {
    const { url } = await configuration();
    const port = Number(new URL(url).port);
    if (!Number.isInteger(port) || port < 1) return { supported: false };
    const res = await get(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    const body = await res.json().catch(() => null);
    if (!body || typeof body.ready !== "boolean") return { supported: false };
    const failing = Array.isArray(body.failing)
      ? [...new Set(body.failing.filter((id) => typeof id === "string").map(channelLabel))].slice(0, 12)
      : [];
    return {
      supported: true,
      ready: body.ready,
      ...(Number.isFinite(body.uptimeMs) && body.uptimeMs >= 0
        ? { uptimeMs: Math.round(body.uptimeMs) }
        : {}),
      failing,
    };
  } catch {
    return { supported: false };
  }
}

// `openclaw gateway restart` (launchd, systemd or schtasks), fixed args, as
// startOpenClawGateway runs `gateway start`.
export async function restartOpenClawGateway({
  configuration = localOpenClawConfig,
  run = promisify(execFile),
  env = process.env,
  platform = process.platform,
  authorize = () => {},
} = {}) {
  authorize();
  // Refuses a remote profile: only this computer's own Gateway.
  await configuration();
  authorize();
  try {
    if (platform === "win32")
      await run("cmd.exe", ["/d", "/c", "openclaw gateway restart"], {
        timeout: 25000,
        windowsHide: true,
      });
    else
      await run(env.SHELL || "/bin/sh", ["-lc", "openclaw gateway restart"], {
        timeout: 25000,
      });
  } catch {
    throw fail(
      503,
      "OpenClaw’s Gateway didn’t restart. On this computer, run: openclaw gateway restart",
    );
  }
}

export function routes(
  app,
  client,
  {
    base,
    authorize,
    openCommand,
    env = process.env,
    home = os.homedir(),
    restart = restartOpenClawGateway,
    ready = readiness,
    files = stateFiles,
    settleMs = 1000,
    // Phones give up on a request after 35 s: answer before, back or not.
    waitMs = 30000,
    filesMs = 60000,
    now = Date.now,
  } = {},
) {
  // The state files are walked at most once a minute.
  let filesAt = 0,
    filesKept = null;
  const sizes = async () => {
    if (!filesKept || now() - filesAt > filesMs) {
      filesKept = await files({ env, home });
      filesAt = now();
    }
    return filesKept;
  };

  app.get(`${base}/health`, async (_req, res) => {
    const started = now();
    const [answer, readyz, storage] = await Promise.all([
      client.can("health")
        ? client.call("health", {}, undefined, 5000).then(
            (snap) => ({ ok: snap?.ok !== false, ms: now() - started }),
            () => ({ ok: false, ms: now() - started }),
          )
        : null,
      ready(),
      sizes(),
    ]);
    const server = client.server?.() || {};
    const version =
      typeof server.version === "string" && /^[\w.+-]{1,32}$/.test(server.version)
        ? server.version
        : undefined;
    const failing = readyz.supported ? readyz.failing : [];
    const status =
      (answer && !answer.ok) || failing.length || storage.warn
        ? "attention"
        : answer && answer.ms > SLOW_MS
          ? "slow"
          : "ok";
    res.json({
      status,
      gateway: answer
        ? { supported: true, answered: answer.ok, ms: answer.ms, ...(version ? { version } : {}) }
        : { supported: false },
      uptime: readyz.supported && readyz.uptimeMs !== undefined
        ? { supported: true, ms: readyz.uptimeMs }
        : { supported: false },
      channels: readyz.supported ? { supported: true, failing } : { supported: false },
      // OpenClaw 2026.3.13 doesn't report its process memory.
      memory: Number.isFinite(server.rssBytes)
        ? { supported: true, bytes: server.rssBytes }
        : { supported: false },
      storage,
    });
  });

  // The last lines of OpenClaw's log, scrubbed; ?errors=1 keeps errors only.
  app.get(`${base}/health/logs`, async (req, res) => {
    if (!client.can("logs.tail")) return res.json({ supported: false });
    const errors = req.query?.errors === "1";
    let tail;
    try {
      tail = await client.call(
        "logs.tail",
        errors ? { limit: 5000, maxBytes: 1000000 } : { limit: LOG_LINES, maxBytes: 250000 },
        undefined,
        8000,
      );
    } catch {
      throw fail(503, "OpenClaw’s log couldn’t be read. Try again.");
    }
    let lines = (Array.isArray(tail?.lines) ? tail.lines : [])
      .slice(errors ? -5000 : -LOG_LINES)
      .map(readLogLine)
      .filter(Boolean);
    if (errors) lines = lines.filter((l) => ["error", "fatal"].includes(l.level));
    res.json({ supported: true, lines: lines.slice(-LOG_LINES) });
  });

  // Restart, confirmed on the phone; answers once a new Gateway does.
  app.post(`${base}/health/restart`, async (req, res) => {
    if (req.body?.confirm !== true) throw fail(400, "Confirm the restart.");
    const current = authorize(req);
    current();
    const started = now();
    await restart({ authorize: current, env });
    current();
    while (now() - started < waitMs) {
      current();
      const up = await ready();
      current();
      // A new Gateway: up for less time than since the restart began.
      if (up.supported && up.uptimeMs !== undefined && up.uptimeMs <= now() - started + 1000) {
        const overview = await client.overview();
        current();
        if (overview.connected) return res.json({ restarted: true, back: true });
      }
      await new Promise((r) => setTimeout(r, settleMs));
    }
    // Still starting: the phone keeps reading /health.
    res.json({ restarted: true, back: false });
  });

  // `openclaw doctor` in a Reach terminal: its prompts are answered there.
  app.post(`${base}/health/doctor`, async (req, res) => {
    authorize(req)();
    if (!openCommand) throw fail(409, "Reach can't open OpenClaw's doctor here.");
    res.json({ terminal: await openCommand("openclaw doctor", "OpenClaw doctor", req) });
  });
}
