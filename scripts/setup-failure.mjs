import { command } from "./home.mjs";

// What a failed first setup step (npm installing Reach's parts) most likely
// needs, read from the end of its log: said in a line, before the log's
// path. "" when the log doesn't say (docs/FIRST_RUN_MATRIX.md, H5, H13).
export function setupFailureHint(log, platform = process.platform) {
  const text = String(log || "").slice(-16384);
  if (/gyp ERR|node-gyp|make: (?:\*\*\*|not found)|g\+\+: (?:command )?not found|cc: (?:command )?not found|No Xcode or CLT|xcrun: error|python3?: (?:command )?not found|Could not find any Python/i.test(text))
    return platform === "darwin"
      ? `Reach's terminal component needs Apple's Command Line Tools to build: run xcode-select --install, then ${command} again.`
      : platform === "linux"
        ? `Reach's terminal component needs build tools on Linux: sudo apt install build-essential python3 (Debian, Ubuntu), or sudo dnf install gcc-c++ make python3 (Fedora), then ${command} again.`
        : `Reach's terminal component couldn't build. Install the build tools npm asks for in the log, then run Reach again.`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network request .* failed|getaddrinfo/i.test(text))
    return `npm couldn't reach the internet. The first setup downloads Reach's parts: check the connection, then ${command} again.`;
  if (/ENOSPC/.test(text)) return `The disk is full. Free some space, then ${command} again.`;
  if (/EACCES|EPERM/.test(text))
    return `npm wasn't allowed to write here. Run ${command} from a folder your user owns (not with sudo).`;
  return "";
}
