import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultFileRoots } from "../server/file-roots.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";

test("default locations include Home and computer volumes without duplicate roots", () => {
  assert.deepEqual(
    defaultFileRoots({ platform: "darwin", home: "/Users/alex" }),
    ["/Users/alex", "/"],
  );
  assert.deepEqual(defaultFileRoots({ platform: "linux", home: "/" }), ["/"]);
  assert.deepEqual(
    defaultFileRoots({
      platform: "win32",
      home: "C:\\Users\\Alex",
      exists: (p) => ["C:\\", "D:\\"].includes(p),
    }),
    ["C:\\Users\\Alex", "C:\\", "D:\\"],
  );
});

test("computer-wide browsing still blocks Reach state and confines guests and agent profiles", async () => {
  const tmp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "reach-roots-")),
  );
  const shared = path.join(tmp, "shared");
  const privateDir = path.join(tmp, ".reach");
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, "allowed.txt"), "allowed");
  await fs.writeFile(path.join(tmp, "outside.txt"), "outside");
  const policy = path.join(privateDir, "policy.json");
  atomicJson(policy, {
    version: 1,
    profiles: { limited: { scopes: ["files:read"], roots: [shared] } },
  });
  const volume = path.parse(tmp).root;
  const reach = await createReach({
    roots: [shared, volume],
    dataDir: privateDir,
    privatePaths: [privateDir],
    agentPolicyFile: policy,
  });
  try {
    await new Promise((resolve) =>
      reach.server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("Owner", ALL_SCOPES);
    const agent = reach.auth.issue("Limited agent", ["files:read"], "agent", {
      profile: "limited",
    });
    const call = (route, token = owner.token, body) =>
      fetch(url + route, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const file = (root, relative) =>
      `/api/files/text?${new URLSearchParams({ root: String(root), path: relative })}`;
    assert.equal(
      (
        await call(
          file(1, path.relative(volume, path.join(tmp, "outside.txt"))),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          file(1, path.relative(volume, path.join(privateDir, "clients.json"))),
        )
      ).status,
      403,
    );
    const inviteResponse = await call("/api/guests", owner.token, {
      name: "Guest",
      ttlSeconds: 900,
      roots: [0],
      write: false,
    });
    assert.equal(inviteResponse.status, 201);
    const invite = await inviteResponse.json();
    const redeemed = await call("/api/guest/redeem", "", {
      invitation: invite.invitation,
    });
    assert.equal(redeemed.status, 200);
    const guest = await redeemed.json();
    for (const token of [guest.token, agent.token]) {
      const device = await (await call("/api/device", token)).json();
      assert.deepEqual(
        device.roots.map((r) => r.path),
        [shared],
      );
      assert.equal((await call(file(0, "allowed.txt"), token)).status, 200);
      assert.equal((await call(file(0, "../outside.txt"), token)).status, 403);
      assert.equal((await call(file(1, "outside.txt"), token)).status, 400);
    }
  } finally {
    await reach.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Files hides what the computer's own browser hides (parity audit #29):
// Finder's dot-names on a Mac; on Windows what Explorer hides, by name and
// place, since Node can't read the hidden and system attributes.
test("Files hides what Finder or Explorer hides, and only there", async () => {
  const { hiddenByOs } = await import("../server/file-roots.mjs");
  const mac = (name, dir = "/Users/sam") => hiddenByOs(name, dir, { platform: "darwin", home: "/Users/sam" });
  assert.equal(mac(".git"), true);
  assert.equal(mac("Library"), false);
  assert.equal(mac("AppData"), false, "a Mac keeps its own rule");
  const win = (name, dir) => hiddenByOs(name, dir, { platform: "win32", home: "C:\\Users\\Sam" });
  for (const name of ["AppData", "NTUSER.DAT", "ntuser.dat.LOG1", "NTUSER.DAT{016888bd-6c6f-11de-8d1d-001e0bcde3ec}.TM.blf", "ntuser.ini", "Application Data", "Start Menu"])
    assert.equal(win(name, "C:\\Users\\sam"), true, name);
  for (const name of ["$Recycle.Bin", "System Volume Information", "ProgramData", "pagefile.sys", "Documents and Settings"])
    assert.equal(win(name, "D:\\"), true, name);
  assert.equal(win("desktop.ini", "C:\\Users\\Sam\\Pictures"), true);
  assert.equal(win(".env", "C:\\Users\\Sam\\code"), true);
  // The same names elsewhere are someone's own.
  for (const [name, dir] of [["Templates", "C:\\Users\\Sam\\code"], ["Recovery", "C:\\Users\\Sam\\Documents"], ["ProgramData", "C:\\Users\\Sam"], ["Documents", "C:\\Users\\Sam"], ["Program Files", "C:\\"]])
    assert.equal(win(name, dir), false, `${dir}\\${name}`);
});
