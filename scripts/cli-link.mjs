// `./reach cli`: a `reach` command in every Terminal, like an installed CLI.
// A link to this folder's ./reach goes into a folder already on PATH that's
// yours to write (no sudo, no shell profile edits); `reach`, `reach status`,
// `reach stop` and `reach restart` then work from anywhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the link may go, in order, when the folder is on PATH and writable.
const places = (home) => [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];

const writable = (dir, files) => {
  try {
    files.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

// Another Reach folder's launcher (an older checkout): fine to point elsewhere.
const isReachLauncher = (file, files) => {
  try {
    const real = files.realpathSync(file);
    return path.basename(real) === "reach" && files.existsSync(path.join(path.dirname(real), "scripts/bootstrap.mjs"));
  } catch {
    return false;
  }
};

export function linkCli({ script, env = process.env, home = os.homedir(), files = fs } = {}) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const real = files.realpathSync(script);
  // Already done: the first `reach` on PATH is this folder's.
  for (const dir of dirs) {
    const at = path.join(dir, "reach");
    if (!files.existsSync(at)) continue;
    if (files.realpathSync(at) === real) return { ok: true, at, already: true, text: `reach already runs this Reach (${at}).` };
    break;
  }
  const dir = places(home).find((d) => dirs.includes(d) && files.existsSync(d) && writable(d, files));
  if (!dir)
    return {
      ok: false,
      text: `No folder on your PATH is yours to write. Add this line to ~/.zshrc, open a new Terminal, then run ./reach cli again:\n  export PATH="$HOME/.local/bin:$PATH"\nand first: mkdir -p ~/.local/bin`,
    };
  const at = path.join(dir, "reach");
  let replaced = "";
  if (files.existsSync(at) || isLink(at, files)) {
    if (!isLink(at, files) || (files.existsSync(at) && !isReachLauncher(at, files)))
      return { ok: false, text: `${at} is something else, not Reach. Reach left it alone; remove it first if you want reach there.` };
    replaced = safeReadlink(at, files);
    files.unlinkSync(at);
  }
  files.symlinkSync(real, at);
  // A different `reach` earlier on PATH would still win.
  const first = dirs.find((d) => files.existsSync(path.join(d, "reach")));
  const shadow = first && first !== dir ? path.join(first, "reach") : "";
  return {
    ok: true,
    at,
    text: [
      `reach now works in any Terminal (${at} → ${real}).`,
      ...(replaced ? [`It pointed to ${replaced} before.`] : []),
      ...(shadow ? [`But ${shadow} comes first on your PATH; remove it, or reach runs that one.`] : []),
      "Try: reach status",
    ].join("\n"),
  };
}

function isLink(file, files) {
  try {
    return files.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
function safeReadlink(file, files) {
  try {
    return files.readlinkSync(file);
  } catch {
    return "";
  }
}
