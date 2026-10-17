import test from "node:test";
import assert from "node:assert/strict";
import { firstInstall, finishFirstSetup } from "./helpers/first-install.mjs";
import { phone } from "./helpers/phone-onboarding.mjs";

test("new user phone UI: iPhone and Android, app and browser setup through a real first installation", { skip: process.platform === "win32", timeout: 180000 }, async t => {
  const reach = await firstInstall(t);
  await finishFirstSetup(reach);
  let device = 50;
  for (const platform of ["iPhone", "Android"]) {
    for (const scenario of [
      { name: "Tailscale app connected" },
      { name: "no Tailscale app", browser: true },
      { name: "Tailscale app off", browser: true },
      { name: "Tailscale app signed out", browser: true },
      { name: "Tailscale app on a different tailnet", browser: true },
      { name: "browser signed into a different account, then corrected", browser: true, wrongAccount: true },
      { name: "browser requires tailnet admin approval", browser: true, adminApproval: true },
      { name: "browser blocks WebAssembly, app fallback", browser: true, wasmFails: true },
    ]) await t.test(`${platform}: ${scenario.name}`, async t => {
      await reach.cli(["pair"]);
      await phone(t, reach, { platform, ip: `100.64.0.${device++}`, ...scenario });
    });
  }
});
