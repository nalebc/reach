// Reach started on a Mac with no terminal (an agent ran it with nohup or in
// the background), and not as the installed background service: macOS gives
// the screen and control permissions to Terminal, and new devices are
// approved in this terminal, so say so where the log goes.
export function detachedWarning({ platform = process.platform, service = false, tty = !!process.stdin.isTTY } = {}) {
  if (platform !== "darwin" || service || tty) return null;
  return "Reach: started without a terminal. The live screen and its control need Terminal's macOS permissions, and new devices are approved in Reach's terminal. Start it with ./reach in Terminal, or install the background service with ./reach install.";
}
