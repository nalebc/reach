// Reach started with no terminal (an agent ran it with nohup or in the
// background), and not as the installed background service: on a Mac,
// macOS gives the screen and control permissions to Terminal; on a Mac and
// Windows alike, new devices are approved in Reach's own window. Said where
// the log goes.
import { command as reachCommand } from "./home.mjs";

export function detachedWarning({ platform = process.platform, service = false, tty = !!process.stdin.isTTY, command = reachCommand } = {}) {
  if (service || tty) return null;
  if (platform === "win32")
    return `Reach: started without a window. New devices are approved in Reach's own window. Start it with ${command} in a terminal, or install background mode with ${command} install.`;
  if (platform !== "darwin") return null;
  return "Reach: started without a terminal. The live screen and its control need Terminal's macOS permissions, and new devices are approved in Reach's terminal. Start it with ./reach in Terminal, or install the background service with ./reach install.";
}
