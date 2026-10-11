import fs from "node:fs";
import path from "node:path";

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
const MAX_LINKS = 8;
const reasons = {
  missing: "it isn't there",
  owner: "it belongs to another account",
  folder: "its folder can be changed by another account",
  kind: "it isn't a socket",
  links: "it is behind too many links",
};
const told = new Set();

export class UntrustedSocket extends Error {
  constructor(file, reason) {
    super(`Codex's socket isn't one Reach can trust: ${reasons[reason]}.`);
    this.file = file;
    this.reason = reason;
    this.because = reasons[reason];
  }
}

export async function trustedSocket(file, { uid = process.getuid?.(), platform = process.platform } = {}) {
  if (platform === "win32" || uid === undefined) return file;
  const refuse = (reason) => {
    const error = new UntrustedSocket(file, reason);
    // Once per socket and reason: Reach asks on every poll.
    if (!told.has(`${file}\n${reason}`)) {
      told.add(`${file}\n${reason}`);
      console.warn(`Reach: ${error.message.slice(0, -1)} (${file}).`);
    }
    return error;
  };
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
