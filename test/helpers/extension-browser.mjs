// A real Chrome or Edge with Reach's unpacked extension, for the Windows
// browser tools test (test/windows-browser-tools-native.test.mjs). Branded
// Chrome no longer honours --load-extension; it's passed anyway (Edge and
// older builds take it), then the extension is loaded over the DevTools
// protocol on a pipe (fds 3 and 4), which those builds allow with
// --enable-unsafe-extension-debugging. A fresh profile each time.
import { spawn } from "node:child_process";

export function launchWithExtension(exe, { profile, extension, args = [], url = "about:blank" }) {
  const child = spawn(exe, [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-sync",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--load-extension=${extension}`,
    ...args,
    url,
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: false });
  const pending = new Map();
  let next = 1, buffer = "";
  child.stdio[4].on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let at;
    while ((at = buffer.indexOf("\0")) >= 0) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let message;
      try { message = JSON.parse(text); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(Error(message.error.message || "CDP error"), { cdp: message.error }));
      else waiter.resolve(message.result);
    }
  });
  child.stdio[4].on("error", () => {});
  child.stdio[3].on("error", () => {});
  const send = (method, params = {}, ms = 30000) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`CDP ${method} timed out`));
    }, ms);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    child,
    send,
    exited,
    async loadExtension() {
      try {
        return { via: "cdp", ...(await send("Extensions.loadUnpacked", { path: extension })) };
      } catch (error) {
        return { via: "flag", error: error.message };
      }
    },
    async close() {
      try { await send("Browser.close", {}, 5000); } catch { child.kill(); }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill();
    },
  };
}
