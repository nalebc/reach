// Exercise first-run menus, phone pairing and access against a real npm
// installation. External Tailscale identities remain deterministic fixtures;
// this must not enroll a CI runner in a maintainer's tailnet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (!process.env.npm_execpath) throw Error("Run with npm run test:ci:installed.");
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tarball = path.join(root, "release", `nalebc-reach-${pkg.version}.tgz`);
if (!fs.lstatSync(tarball).isFile()) throw Error("Missing verified release tarball.");
const portable = path.join(root, "release", `reach-${pkg.version}-portable.tar.gz`);
if (!fs.lstatSync(portable).isFile()) throw Error("Missing verified portable archive.");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ci-installed-"));
fs.mkdirSync("reports", { recursive: true });
const npm = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root, stdio: "inherit", env: { ...process.env, ...extraEnv },
  });
  child.once("error", reject);
  child.once("close", (code, signal) => code === 0 && !signal ? resolve() : reject(Error(`npm ${args[0]} failed (${signal || code}).`)));
});
try {
  await npm(["install", "--prefix", temp, "--omit=dev", "--no-audit", "--no-fund", tarball]);
  // The full menu harness still uses POSIX fixtures. QR/network onboarding
  // runs against the installed artifact on Windows too, without a platform skip.
  const files = ["test/qr-onboarding-e2e.test.mjs", ...(process.platform === "win32" ? [] : [
    "test/first-install-e2e.test.mjs", "test/first-install-phone-ui.test.mjs", "test/portable-install.test.mjs",
  ])];
  await npm(["run", "test:file", "--", "--test-timeout=540000", "--test-concurrency=1",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=junit", "--test-reporter-destination=reports/installed.xml",
    "--test-reporter=tap", "--test-reporter-destination=reports/installed.tap",
    ...files], {
      REACH_TEST_PACKAGE: path.join(temp, "node_modules", "@nalebc", "reach"),
      REACH_TEST_PORTABLE_ARCHIVE: portable,
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
