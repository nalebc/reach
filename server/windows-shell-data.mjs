import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsBinary } from "./desktop-native.mjs";

const exec = promisify(execFile);
let shellFolder = null;
export const useWindowsShellFolder = (dir) => { shellFolder = dir || null; };
export const windowsShellFolder = () => shellFolder;

// The existing shell icon helper also reads AppsFolder and file type icons.
// Build it once through the same private Windows build provider. Launching
// Windows PowerShell and compiling inline C# on every icon lookup exceeded
// the first-call deadlines on a real ARM64 PC; the native operation keeps
// those deadlines, independently of the normal shared helper build bound.
async function shellData(args, { dataDir = shellFolder, build = windowsBinary, run = exec, authorize = () => {}, ...options } = {}) {
  if (!dataDir) throw Object.assign(new Error("Reach's Windows shell data folder is not ready."), { status: 503 });
  const file = await build({ dataDir }, "app-icons");
  // A cold build can outlive the grant: check again at actual dispatch.
  authorize();
  return run(file, args, { ...options, windowsHide: true });
}

const text = (value) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error("Windows returned an invalid app catalog.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw Error("Windows returned an invalid app catalog.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
};

export async function readWindowsApps(options = {}) {
  const { stdout } = await shellData(["apps"], { ...options, timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
  const rows = String(stdout).split(/\r?\n/).filter(Boolean);
  return rows.map((line) => {
    const parts = line.split("\t");
    if (parts.length !== 2) throw Error("Windows returned an invalid app catalog.");
    const [id, name] = parts.map(text);
    if (!id || !name || id.includes("\0") || name.includes("\0")) throw Error("Windows returned an invalid app catalog.");
    return { id, name };
  });
}

export async function readWindowsFileTypeIcons(types, options = {}) {
  if (!types.length) return [];
  if (types.length > 64 || types.some((type) => typeof type !== "string" || !/^(?:folder|file|[a-z0-9]{1,16})$/.test(type))) throw Error("Choose valid file icon types.");
  const { stdout } = await shellData(["types", ...types], { ...options, timeout: 20000 + types.length * 250, maxBuffer: types.length * 64 * 1024 });
  const lines = String(stdout).split(/\r?\n/);
  return types.map((_, i) => (lines[i] || "").trim());
}

// The caller has already found this exact ID in the computer's catalog.
// One ShellExecute request, with no retry if its delivery is unknown.
export async function openWindowsApp(id, options = {}) {
  if (typeof id !== "string" || !id || id.includes("\0")) throw Error("Choose an application from this computer's app list.");
  await shellData(["open", id], { ...options, timeout: 12000, maxBuffer: 65536 });
}
