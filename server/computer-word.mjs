// What the phone calls the computer Reach runs on: "Mac" on macOS, "Windows
// PC" on Windows, "computer" anywhere else (the same words as the phone's own
// computerWord, src/pause.ts).
export const computerWord = (platform = process.platform) =>
  platform === "darwin" ? "Mac" : platform === "win32" ? "Windows PC" : "computer";
