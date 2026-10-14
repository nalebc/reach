import fs from "node:fs";
import path from "node:path";
import { PIPE, pipeOwner } from "../windows-owners.mjs";

// A Codex socket only you could have put there, for all three of Reach's
// Codex connections (the session service, the Codex app's IPC, its task
// owner). The rule is what keeps another account from posing as Codex: the
// socket is yours, in a folder that's yours or root's and that no one else
// can write to (or sticky, as /tmp is). Nothing else about the layout is
// assumed: links are followed (the socket, or a folder on the way), each one
// held to the same rule, and the socket they end at is returned, the one to
// connect to. Oct 11: Codex moved its session service socket behind a link
// (~/.codex/app-server-control/…sock → /tmp/codex-daemon-501/<hash>) and a
// check that wanted the socket itself refused it, so Codex vanished from the
// phone.
//
// Windows has no socket files, only named pipes in one namespace any account
// can name: the rule there is the pipe's own (audit #17, Oct 12). It was made
// by you, Windows or an administrator; the process serving it runs as you;
// and no other account may serve it too (a new instance answering in its
// place) or change who may. What Windows won't say isn't refused: a Mac's
// check can't fail that way, and chats stay in sync across the agent's app,
// its CLI and Reach (owner, Oct 12). Only a pipe known to be another
// account's is; one that couldn't be checked is said once in Reach's window.
const MAX_LINKS = 8;
const reasons = {
  missing: "it isn't there",
  owner: "it belongs to another account",
  folder: "its folder can be changed by another account",
  kind: "it isn't a socket",
  links: "it is behind too many links",
  pipe: "it isn't a named pipe",
  shared: "another account can serve it too",
};
// Windows itself and administrators, as root may own a Mac socket's folder.
const SYSTEM = ["S-1-5-18", "S-1-5-32-544"];
// In a pipe's list, two names that stand for its owner (checked on its own)
// or for no one: OWNER RIGHTS, and CREATOR OWNER outside inheritance.
const OWNER_NAMES = ["S-1-3-4", "S-1-3-0"];
const SID = /^S-1-\d+(?:-\d+)+$/;
const told = new Set();
const refusal = (file, reason) => {
  const error = new UntrustedSocket(file, reason);
  // Once per socket and reason: Reach asks on every poll.
  if (!told.has(`${file}\n${reason}`)) {
    told.add(`${file}\n${reason}`);
    console.warn(`Reach: ${error.message.slice(0, -1)} (${file}).`);
  }
  return error;
};

export class UntrustedSocket extends Error {
  constructor(file, reason) {
    super(`Codex's socket isn't one Reach can trust: ${reasons[reason]}.`);
    this.file = file;
    this.reason = reason;
    this.because = reasons[reason];
  }
}

// owner: who serves a pipe, as owners.cs answers (windows-owners.mjs).
export async function trustedSocket(file, { uid = process.getuid?.(), platform = process.platform, dataDir, owner = (pipe) => pipeOwner(pipe, { dataDir }) } = {}) {
  if (platform === "win32") return trustedPipe(file, owner);
  if (uid === undefined) return file;
  const refuse = (reason) => refusal(file, reason);
  let at = file;
  for (let hops = 0; hops <= MAX_LINKS; hops++) {
    const folderPath = await fs.promises.realpath(path.dirname(at)).catch(() => { throw refuse("missing"); });
    at = path.join(folderPath, path.basename(at));
    const [entry, folder] = await Promise.all([fs.promises.lstat(at), fs.promises.stat(folderPath)]).catch(() => { throw refuse("missing"); });
    if (!folder.isDirectory()) throw refuse("missing");
    if (folder.uid !== uid && folder.uid !== 0) throw refuse("folder");
    if (folder.mode & 0o022 && !(folder.mode & 0o1000)) throw refuse("folder");
    if (entry.uid !== uid) throw refuse("owner");
    if (entry.isSocket()) return at;
    if (!entry.isSymbolicLink()) throw refuse("kind");
    const target = await fs.promises.readlink(at).catch(() => { throw refuse("missing"); });
    at = path.resolve(folderPath, target);
  }
  throw refuse("links");
}

// Whether a named pipe is served by this very account's own process, with no
// one else able to serve it too (owners.cs's answer). Unlike trustedPipe,
// this never fails open: a missing, unreadable or partial answer is false.
// Reach's permission hook (scripts/agent-hook.mjs) uses it to be sure the
// pipe it reached is the owner's Reach before it trusts an "allow"; if it
// can't be sure, it prints nothing and Claude Code's own dialog decides, as
// the whole feature does whenever anything is in doubt.
export function pipeServedByMe(seen) {
  if (!seen || typeof seen !== "object" || seen.error) return false;
  if (!SID.test(seen.self) || !SID.test(seen.owner) || !SID.test(seen.user) || !Array.isArray(seen.serves)) return false;
  const yours = [seen.self, ...(Array.isArray(seen.logon) ? seen.logon.filter((sid) => SID.test(sid)) : [])];
  const trusted = (sid) => yours.includes(sid) || SYSTEM.includes(sid);
  if (!trusted(seen.owner)) return false; // made by you, Windows or an administrator
  if (seen.user !== seen.self) return false; // served by your own process, this account
  return seen.serves.every((sid) => trusted(sid) || OWNER_NAMES.includes(sid)); // no one else's to serve
}

async function trustedPipe(file, owner) {
  const refuse = (reason) => refusal(file, reason);
  if (typeof file !== "string" || !PIPE.test(file)) throw refuse("pipe");
  const unchecked = (why) => {
    if (!told.has(`${file}\nunchecked`)) {
      told.add(`${file}\nunchecked`);
      console.warn(`Reach: couldn't check who serves ${file}${why ? ` (${String(why).slice(0, 200)})` : ""}; it's used as yours, as on a Mac.`);
    }
    return file;
  };
  let seen;
  try {
    seen = await owner(file);
  } catch (e) {
    return unchecked(e?.message);
  }
  if (seen?.error === "missing") throw refuse("missing");
  if (seen?.error || !SID.test(seen?.self)) return unchecked(seen?.error);
  const yours = [seen.self, ...(Array.isArray(seen.logon) ? seen.logon.filter((sid) => SID.test(sid)) : [])];
  const trusted = (sid) => yours.includes(sid) || SYSTEM.includes(sid);
  // Made by you (or Windows, or an administrator)...
  if (SID.test(seen.owner) && !trusted(seen.owner)) throw refuse("owner");
  // ...served by a process of yours...
  if (SID.test(seen.user) && seen.user !== seen.self) throw refuse("owner");
  // ...and no one else's to serve.
  if (Array.isArray(seen.serves) && !seen.serves.every((sid) => trusted(sid) || OWNER_NAMES.includes(sid))) throw refuse("shared");
  if (!SID.test(seen.owner) || !SID.test(seen.user) || !Array.isArray(seen.serves)) return unchecked("part of the answer was missing");
  return file;
}
