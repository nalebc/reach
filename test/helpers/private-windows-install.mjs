import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after } from "node:test";
import { accountSid } from "../../server/windows-private-folder.mjs";
import { createWindowsPrivateStage } from "../../server/windows-private-stage.mjs";
import { copyPrivateAcceptanceArtifact } from "../acceptance/private-artifact.mjs";

const exec = promisify(execFile);
let installed, stageDirectory;
// Register at module load, outside any one test's context: later cases in
// this file still need the same immutable artifact after the first ends.
after(async () => {
  if (installed) await installed.catch(() => {});
  if (stageDirectory) await fs.rm(stageDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

// GitHub's D:\a checkout and temp tree are writable by other accounts. Copy
// the built test artifact into a freshly private stage; do not repair their
// permissions or inherit the checkout's descriptors through CopyFile/fs.cp.
// Shared by this test process only; every launch gets separate work/state.
export function privateWindowsInstall() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return installed ||= (async () => {
    const system = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const sid = accountSid((await exec(path.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10000 })).stdout);
    const profile = await fs.realpath((await exec(path.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.WriteLine([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))"],
      { windowsHide: true, timeout: 10000 })).stdout.trim());
    // The default LocalAppData/Reach container is intentionally excluded from
    // grants. A test project/share belongs under the validated real profile,
    // with the same production ancestry and atomic private-stage checks.
    const stage = await createWindowsPrivateStage({ sid, parent: profile });
    stageDirectory = stage.dir;
    const root = path.join(stage.dir, "package"), work = path.join(stage.dir, "work");
    await fs.mkdir(root);
    await fs.mkdir(work);
    const source = process.cwd();
    const members = ["bin", "server", "scripts", "dist", "node_modules", "tailnet", "src", "public",
      "package.json", "package-lock.json", "index.html", "start.html", "agent.html", "vite.config.mjs", "tsconfig.json", "reach", "reach.cmd"];
    await copyPrivateAcceptanceArtifact({ source, destination: root, members });
    return { root, work };
  })();
}
