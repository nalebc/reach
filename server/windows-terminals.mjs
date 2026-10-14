import { execFile } from "node:child_process";
import { fail } from "./core.mjs";
import { windowsBinary } from "./desktop-native.mjs";
import { powershellCall } from "./powershell.mjs";
import { commandFor, windowsPowerShell, windowsShell } from "./windows-shell.mjs";

// The PC's own terminals, as a Mac's are Apple Terminal and iTerm2
// (desktop-terminals.mjs): Windows Terminal's tabs and classic console
// windows, found, read, typed into, brought forward, closed and opened by one
// C# helper (scripts/native/windows-terminals.cs) built on the PC.
export const windowsTerminalProviders = [
  { id: "windows-terminal", name: "Windows Terminal" },
  { id: "console", name: "Console window" },
];

// One argument as Windows programs read their command line (the C runtime's
// rules: quotes around it, and backslashes doubled only before a quote).
export function windowsArg(arg) {
  const text = String(arg);
  if (text && !/[\s"]/.test(text)) return text;
  let out = '"',
    slashes = 0;
  for (const c of text) {
    if (c === "\\") slashes++;
    else {
      out += "\\".repeat(c === '"' ? slashes * 2 + 1 : slashes) + c;
      slashes = 0;
    }
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}
// wt.exe splits its arguments into commands at each ";" (written \; to be
// one), then joins the new tab's command line back with plain quotes around
// any part with a space, nothing escaped. So a part of the tab's command
// never carries a quote: PowerShell is given its command encoded, and cmd
// takes the rest of its line, between outer quotes, as it is (/s /k).
export const wtEscape = (arg) => String(arg).replace(/;/g, "\\;");
const program = (file) => (/\s/.test(file) ? `"${file}"` : file);

// How a new terminal opens in `cwd`, running `command` when there is one
// (Reach's own resolved agent command, or the owner's shortcut): in the
// owner's shell (windows-shell.mjs), as Reach's terminals do. With Windows
// Terminal: a new window in the folder, its default profile when there's no
// command. Else a console window. The command is only ever a shell's argument.
export function windowsLaunch({ cwd, command, shell = windowsShell(), powershell = windowsPowerShell } = {}) {
  let use = shell,
    typed = command ? commandFor(shell.kind, command, powershellCall) : null;
  if (command && typed == null) {
    use = powershell();
    typed = powershellCall(command);
  }
  let tab = null,
    line;
  if (!command) {
    const rest = Array.isArray(use.args) ? use.args.map(windowsArg).join(" ") : String(use.args || "").trim();
    line = [program(use.file), rest].filter(Boolean).join(" ");
  } else if (use.kind === "powershell") {
    const args = ["-NoLogo", "-NoExit", "-EncodedCommand", Buffer.from(typed, "utf16le").toString("base64")];
    line = [program(use.file), ...args].join(" ");
    tab = [use.file, ...args];
  } else {
    // A space at its end makes Windows Terminal quote it, always.
    line = `${program(use.file)} /s /k "${typed}"`;
    tab = [use.file, "/s", "/k", `${typed} `];
  }
  const terminal = ["-w", "new", "new-tab", "-d", cwd, ...(tab ? ["--", ...tab] : [])]
    .map((arg) => windowsArg(wtEscape(arg)))
    .join(" ");
  return { cwd, terminal, console: { file: use.file, line } };
}

// The helper's environment: Reach's, without its own settings, which the
// terminals it opens would inherit (as Reach's terminals drop them).
const ownEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^REACH_/i.test(key)));
export function windowsTerminalRunner({ dataDir, build = windowsBinary, run = execFile, env = process.env, now = Date.now } = {}) {
  // A helper the PC wouldn't build (no csc.exe, a policy, an antivirus) is
  // said again for a minute, not built again for every look the phone takes.
  let refused = null;
  return async (payload) => {
    if (!dataDir) throw fail(503, "Reach's data folder isn't known here.");
    if (refused && now() < refused.until) throw refused.error;
    let file;
    try {
      file = await build({ dataDir }, "windows-terminals");
      refused = null;
    } catch (error) {
      refused = { error, until: now() + 60000 };
      throw error;
    }
    return new Promise((resolve, reject) => {
      const child = run(
        file,
        [],
        { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: ownEnv(env) },
        (error, stdout) => {
          let result = null;
          try {
            result = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
          } catch {}
          if (result && typeof result === "object" && !Array.isArray(result)) {
            if (result.error) return reject(fail(Number(result.status) || 502, String(result.error).slice(0, 300)));
            if (!error) return resolve(result);
          }
          reject(fail(502, "Windows didn't answer about its terminals. Try again in a moment."));
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(payload));
    });
  };
}
