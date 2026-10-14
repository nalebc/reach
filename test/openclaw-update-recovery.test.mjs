import test from "node:test";
import assert from "node:assert/strict";
import {
  updateRecovery,
  installUpdateRuntime,
  publicRecovery,
} from "../server/openclaw-update-recovery.mjs";

const evidence =
  "this OpenClaw release requires Node >=24.16.0 <25 || >=26.1.0.\ndetected Node 23.7.0";
test("dependency recovery is based on a known blocker and never executes output", async () => {
  const recipe = await updateRecovery(evidence, {
    platform: "darwin",
    access: async () => {},
  });
  assert.equal(recipe.available, true);
  assert.equal(recipe.detected, "23.7.0");
  assert.equal(publicRecovery(recipe).brew, undefined);
  assert.equal(
    (await updateRecovery(evidence, { platform: "linux" })).available,
    false,
  );
  // OpenClaw 2026.10.3's own launcher words the range ", or" (found on Windows).
  const launcher = await updateRecovery("openclaw requires Node >=24.16.0 <25, or >=26.1.0.\ndetected Node 22.12.0", {
    platform: "darwin",
    access: async () => {},
  });
  assert.equal(launcher.available, true);
  assert.deepEqual(launcher.minimum, [24, 16, 0]);
  assert.equal(
    (await updateRecovery("requires Node >=28.0.0", { platform: "darwin" }))
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
  });
  const calls = [];
  let allowed = true;
  const deps = {
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
