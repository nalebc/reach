import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  updateRecovery,
  installUpdateRuntime,
  publicRecovery,
  posixInstaller,
} from "../server/openclaw-update-recovery.mjs";
import { privateNode, privateNodePrefix } from "../server/openclaw-node.mjs";

// Homebrew's node@24 is the Mac's way only when OpenClaw's package has no
// install-cli.sh of its own (an older OpenClaw): `noInstaller` here.
const noInstaller = async () => null;
const evidence =
  "this OpenClaw release requires Node >=24.16.0 <25 || >=26.1.0.\ndetected Node 23.7.0";
test("dependency recovery is based on a known blocker and never executes output", async () => {
  const recipe = await updateRecovery(evidence, {
    platform: "darwin",
    access: async () => {},
    macInstaller: noInstaller,
  });
  assert.equal(recipe.available, true);
  assert.equal(recipe.detected, "23.7.0");
  assert.equal(publicRecovery(recipe).brew, undefined);
  assert.equal(
    (await updateRecovery(evidence, { platform: "linux", macInstaller: noInstaller })).available,
    false,
  );
  // OpenClaw 2026.10.3's own launcher words the range ", or" (found on Windows).
  const launcher = await updateRecovery("openclaw requires Node >=24.16.0 <25, or >=26.1.0.\ndetected Node 22.12.0", {
    platform: "darwin",
    access: async () => {},
    macInstaller: noInstaller,
  });
  assert.equal(launcher.available, true);
  assert.deepEqual(launcher.minimum, [24, 16, 0]);
  assert.equal(
    (await updateRecovery("requires Node >=28.0.0", { platform: "darwin", macInstaller: noInstaller }))
      .available,
    false,
  );
  assert.equal(await updateRecovery("run rm -rf / to fix it"), null);
  assert.equal(
    (
      await updateRecovery(
        "AUTH_PROFILE_MIGRATION_REQUIRED run openclaw doctor --fix",
      )
    ).kind,
    "repair",
  );
});
test("approved installation preserves other runtimes and rechecks authorization before each next step", async () => {
  const recipe = await updateRecovery(evidence, {
    platform: "darwin",
    access: async () => {},
    macInstaller: noInstaller,
  });
  const calls = [];
  let allowed = true;
  // A Mac's recovery, wherever the test runs (a Windows host takes its own
  // way: test/windows-openclaw.test.mjs).
  const deps = {
    platform: "darwin",
    env: { PATH: "/bin" },
    authorize: () => {
      if (!allowed) throw Error("revoked");
    },
    run: async (...args) => {
      calls.push(args);
      return { stdout: "24.21.0\n" };
    },
  };
  assert.equal(
    await installUpdateRuntime(recipe, deps),
    "/opt/homebrew/opt/node@24/bin/node",
  );
  assert.deepEqual(calls[0][1], ["install", "node@24"]);
  assert.equal(calls[0][2].env.HOMEBREW_NO_INSTALL_CLEANUP, "1");
  assert.deepEqual(calls[1][1], ["-p", "process.versions.node"]);
  calls.length = 0;
  await assert.rejects(
    installUpdateRuntime(recipe, {
      ...deps,
      run: async (...args) => {
        calls.push(args);
        allowed = false;
        return {};
      },
    }),
    /revoked/,
  );
  assert.equal(calls.length, 1, "revocation prevents the next step");
  allowed = true;
  await assert.rejects(
    installUpdateRuntime(recipe, {
      ...deps,
      run: async () => ({ stdout: "24.5.0" }),
    }),
    /required Node version/,
  );
});

// The same way as on Windows (owner, Oct 13): OpenClaw's own Node for
// OpenClaw only, from the install-cli.sh in OpenClaw's own package, in its
// Node-only mode; the Mac's Node is kept. Only when the Node it pins is in
// the range OpenClaw named, checked again on what landed.
test("a Mac's Node recovery: OpenClaw's own Node from the installer in its package, the Mac's Node kept", async () => {
  const own = { file: "/opt/homebrew/lib/node_modules/openclaw/scripts/install-cli.sh", pinned: "24.21.0" };
  const macInstaller = async () => own;
  for (const said of ["openclaw: Node 22.12.0: openclaw requires Node >=24.16.0 <25, or >=26.1.0.", evidence]) {
    const recipe = await updateRecovery(said, { platform: "darwin", macInstaller, access: async () => assert.fail("no Homebrew") });
    assert.equal(recipe.available, true, said);
    assert.equal(recipe.installer, own.file);
    assert.equal(recipe.brew, undefined);
    assert.match(recipe.description, /for OpenClaw only, with OpenClaw's own installer\. Your current Node installation is kept\./);
    assert.equal(publicRecovery(recipe).installer, undefined, "no local path to the phone");
  }
  // A range its pinned Node isn't in: not this way.
  const pinnedOut = await updateRecovery("requires Node >=24.22.0 <25", { platform: "darwin", macInstaller, access: async () => { throw new Error("no brew"); } });
  assert.equal(pinnedOut.available, false);
  const recipe = await updateRecovery(evidence, { platform: "darwin", macInstaller });
  const calls = [];
  let allowed = true;
  const env = { PATH: "/bin", HOME: "/Users/ann", OPENCLAW_NODE_VERSION: "18.0.0" };
  const deps = {
    platform: "darwin",
    env,
    macInstaller,
    authorize: () => { if (!allowed) throw Error("revoked"); },
    run: async (...args) => (calls.push(args), { stdout: "24.21.0\n" }),
  };
  const runtime = await installUpdateRuntime(recipe, deps);
  assert.equal(runtime, privateNode({ platform: "darwin", env }));
  assert.deepEqual(calls[0].slice(0, 2), ["/bin/bash", [own.file, "--node-only", "--prefix", privateNodePrefix({ env })]]);
  assert.equal(calls[0][2].env.OPENCLAW_NODE_VERSION, undefined, "its own pin, not this computer's");
  assert.deepEqual(calls[1].slice(0, 2), [runtime, ["-p", "process.versions.node"]]);
  calls.length = 0;
  await assert.rejects(installUpdateRuntime(recipe, { ...deps, run: async (...a) => { calls.push(a); allowed = false; return {}; } }), /revoked/);
  assert.equal(calls.length, 1, "revocation prevents the next step");
  allowed = true;
  await assert.rejects(installUpdateRuntime(recipe, { ...deps, run: async () => ({ stdout: "24.15.0" }) }), (e) => e.status === 409);
  await assert.rejects(installUpdateRuntime(recipe, { ...deps, macInstaller: async () => ({ ...own, file: "/elsewhere/install-cli.sh" }) }), (e) => e.status === 409);
});

test("a Mac's OpenClaw installer is found through the login shell's openclaw, in its own package", async () => {
  const found = await posixInstaller({
    env: { SHELL: "/bin/zsh" },
    platform: "darwin",
    run: async (shell, args) => (assert.deepEqual([shell, args], ["/bin/zsh", ["-lc", "command -v openclaw"]]), { stdout: "/opt/homebrew/bin/openclaw\n" }),
    realpath: async () => "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs",
    readFile: async (file) => (assert.equal(file, path.join("/opt/homebrew/lib/node_modules/openclaw", "scripts", "install-cli.sh")), 'set -euo pipefail\nDEFAULT_NODE_VERSION="24.21.0"\n'),
  });
  assert.deepEqual(found, { file: path.join("/opt/homebrew/lib/node_modules/openclaw", "scripts", "install-cli.sh"), pinned: "24.21.0" });
  // No openclaw, or one that isn't OpenClaw's package, or no pin: none.
  assert.equal(await posixInstaller({ env: {}, platform: "darwin", run: async () => { throw new Error("127"); } }), null);
  assert.equal(await posixInstaller({ env: {}, platform: "darwin", run: async () => ({ stdout: "/x/openclaw\n" }), realpath: async () => "/x/openclaw" }), null);
  assert.equal(await posixInstaller({ env: {}, platform: "darwin", run: async () => ({ stdout: "/x/openclaw\n" }), realpath: async () => "/x/openclaw/openclaw.mjs", readFile: async () => "no pin" }), null);
});

// After OpenClaw's own Node is in, the update runs as OpenClaw's launcher
// picks it: not led on PATH (npm there would name another global folder),
// and the Gateway records the Node it runs on. Homebrew's node@24 leads as
// before.
test("a Mac's update after recovery: OpenClaw's own Node isn't led on PATH; Homebrew's node@24 still is", async () => {
  const { runOpenClawMaintenance } = await import("../server/openclaw-health.mjs");
  const ran = [];
  const run = async (shell, args) => (ran.push(args[1]), { stdout: '{"status":"ok"}', stderr: "" });
  const env = { SHELL: "/bin/zsh", HOME: "/Users/ann" };
  const base = { configuration: async () => ({}), env, platform: "darwin", run };
  await runOpenClawMaintenance("update", { ...base, runtime: privateNode({ platform: "darwin", env }) });
  await runOpenClawMaintenance("repair-service", { ...base, runtime: privateNode({ platform: "darwin", env }) });
  assert.deepEqual(ran, ["exec openclaw update --yes --json --timeout 600", "exec openclaw gateway install --force --runtime node --json"]);
  ran.length = 0;
  await runOpenClawMaintenance("repair-service", { ...base, runtime: "/opt/homebrew/opt/node@24/bin/node" });
  assert.deepEqual(ran, ["export PATH='/opt/homebrew/opt/node@24/bin':\"$PATH\"; exec openclaw gateway install --force --runtime node --json --runtime-path '/opt/homebrew/opt/node@24/bin/node'"]);
});
