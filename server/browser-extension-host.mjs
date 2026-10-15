// Registers Reach's native messaging host for its browser extension on
// Windows (docs/parity/G-browser-tools.md): the host built from
// scripts/native/browser-host.cs into Reach's data folder, its config (which
// pipe, which node.exe serves it), its manifest (which extensions may start
// it), and the per-user registry keys Chrome and Edge read. No administrator
// rights; done again whenever the build or the folder changes.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { windowsHelper } from "./desktop-native.mjs";
import { NATIVE_HOST, extensionIds, extensionOrigin } from "./browser-extension-ids.mjs";
import { pipeShortName } from "./browser-extension.mjs";

const exec = promisify(execFile);
export const HOST_KEYS = {
  Chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
  Edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST}`,
};
const regExe = (env = process.env) => path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "reg.exe");

export function hostManifest(file, ids = extensionIds()) {
  return {
    name: NATIVE_HOST,
    description: "Reach: saved browser tools for this computer's Reach",
    path: file,
    type: "stdio",
    allowed_origins: ids.map(extensionOrigin),
  };
}

/** The registry's default value for one browser's key: the manifest path, or null. */
export async function registeredManifest(browser, { run = exec, env = process.env } = {}) {
  try {
    const { stdout } = await run(regExe(env), ["query", HOST_KEYS[browser], "/ve"], { windowsHide: true, timeout: 15000 });
    const match = /REG_SZ\s+(.+?)\s*$/m.exec(String(stdout));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function registerExtensionHost({
  dataDir, pipe, ids = extensionIds(), server = process.execPath,
  build = windowsHelper, run = exec, env = process.env, signal,
} = {}) {
  const dir = path.join(dataDir, "browser-host");
  fs.mkdirSync(dir, { recursive: true });
  const { file } = await build("browser-host", { dir, signal });
  fs.writeFileSync(path.join(dir, "reach-browser-host.config"), `pipe=${pipeShortName(pipe)}\r\nserver=${server}\r\n`);
  const manifestFile = path.join(dir, `${NATIVE_HOST}.json`);
  fs.writeFileSync(manifestFile, `${JSON.stringify(hostManifest(file, ids), null, 2)}\n`);
  for (const browser of Object.keys(HOST_KEYS)) {
    if ((await registeredManifest(browser, { run, env })) === manifestFile) continue;
    await run(regExe(env), ["add", HOST_KEYS[browser], "/ve", "/t", "REG_SZ", "/d", manifestFile, "/f"], { windowsHide: true, timeout: 15000 });
  }
  return { file, manifest: manifestFile };
}
