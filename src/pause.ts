import { post, type Peer } from "./api";

// Pause (server/index.mjs setPaused): the person at the computer has it
// back. Nothing on the phone sees or uses its screen until Resume; terminals,
// agents and files carry on. The computer says so in its live connection's
// change fingerprints, so every page knows at once, and in /api/device.
// Who controls the screen, as the live connection fingerprints it: changes
// when control changes hands (a watching phone tries again then).
export function controlIn(changes?: string): string {
  if (!changes) return "";
  try {
    return String(JSON.parse(changes).control ?? "");
  } catch {
    return "";
  }
}

export function pausedIn(
  changes?: string,
  device?: { paused?: boolean } | null,
): boolean {
  if (changes)
    try {
      return JSON.parse(changes).paused === true;
    } catch {
      /* A garbled fingerprint says nothing; the device does. */
    }
  return device?.paused === true;
}

export const setPaused = (peer: Peer, paused: boolean) =>
  post<{ paused: boolean }>(peer, "/api/settings/pause", { paused });

// What the computer answers while paused (server/screen.mjs pausedMessage).
export const isPausedMessage = (message?: string) =>
  /^Reach is paused on this /.test(message || "");

// "Mac", "Windows PC" or "computer": the server says the same (server/computer-word.mjs).
export const computerWord = (platform?: string) =>
  platform === "darwin" ? "Mac" : platform === "win32" ? "Windows PC" : "computer";
