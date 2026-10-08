// Where a team's lead reaches Reach (teams.mjs): a Unix socket in Reach's
// private data folder (mode 0600: only this account's processes), one JSON
// request per line, { id, token, tool, args }, answered { id, result } or
// { id, error }. The key in each request names the team; nothing here is
// reachable from the network.
import fs from "node:fs";
import net from "node:net";

const LONGEST = 64 * 1024;

export function createTeamBridge({ socketPath, call }) {
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
      if (process.platform === "win32") return false;
      fs.rmSync(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      fs.chmodSync(socketPath, 0o600);
      listening = true;
      return true;
    },
    close() {
      if (!listening) return;
      server.close();
      fs.rmSync(socketPath, { force: true });
      listening = false;
    },
  };
}
