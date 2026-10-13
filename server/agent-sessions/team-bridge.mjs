// Where a team's lead reaches Reach (teams.mjs): a Unix socket in Reach's
// private data folder (mode 0600: only this account's processes), one JSON
// request per line, { id, token, tool, args }, answered { id, result } or
// { id, error }. The key in each request names the team; nothing here is
// reachable from the network.
//
// Windows has no socket files: there it's a named pipe (audit #14, Oct 12),
// with the access Windows gives a new pipe (only its maker's account,
// Windows and administrators may write to it or serve it), under a name of
// its own kept in the data folder. Pipe names are one namespace every
// account sees, so the lead's bridge checks the pipe is Reach's before the
// team's key goes to it (scripts/team-mcp.mjs), and Reach can't listen on a
// name another program took first (Node makes the first instance or none).
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const LONGEST = 64 * 1024;
const NAME = /^reach-team-[0-9a-f]{32}$/;

// The team pipe for this data folder: the same across restarts (a team's
// key file names it), and not one other accounts could guess.
export function teamPipe(dataDir) {
  const file = path.join(dataDir, "team-pipe");
  let name = "";
  try {
    name = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (!NAME.test(name)) {
    name = `reach-team-${crypto.randomBytes(16).toString("hex")}`;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, name, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return `\\\\.\\pipe\\${name}`;
}

export function createTeamBridge({ socketPath, call, platform = process.platform }) {
  const pipe = platform === "win32";
  const serve = (socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > LONGEST * 4) return socket.destroy();
      for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.length > LONGEST) {
          socket.write(`${JSON.stringify({ id: null, error: "Request too long." })}\n`);
          continue;
        }
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({ id: null, error: "Not JSON." })}\n`);
          continue;
        }
        const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
        Promise.resolve()
          .then(() => call(request?.token, request?.tool, request?.args))
          .then(
            (result) => !socket.destroyed && socket.write(`${JSON.stringify({ id, result })}\n`),
            (error) => !socket.destroyed && socket.write(`${JSON.stringify({ id, error: error?.message || "It didn't work." })}\n`),
          );
      }
    });
  };
  const server = net.createServer(serve);
  let listening = false;
  return {
    socketPath,
    async listen() {
      if (!pipe) fs.rmSync(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (!pipe) fs.chmodSync(socketPath, 0o600);
      listening = true;
      return true;
    },
    close() {
      if (!listening) return;
      server.close();
      if (!pipe) fs.rmSync(socketPath, { force: true });
      listening = false;
    },
  };
}
