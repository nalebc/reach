import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../server/index.mjs";
import { createFleet } from "../server/fleet.mjs";
import { approvalStore } from "../server/device-approval.mjs";

// Several Macs, one phone: computers you link (in their own terminals) share
// device approvals. Nothing else changes trust: a computer that isn't linked,
// another device on your account, or a tagged device gets no answer.
const owner = { userId: "42", login: "owner@example.test" };
const status = (...peers) => ({
  Peer: Object.fromEntries(
    peers.map((p, i) => [
      `k${i}`,
      { UserID: 42, Online: true, OS: "macOS", Tags: undefined, ...p },
    ]),
  ),
});

test("finds your other Reach computers and links only on request", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-fleet-"));
  try {
    const asked = [];
    const fleet = createFleet({
      dataDir: dir,
      owner,
      selfOrigin: "https://mac-a.t.ts.net:8443",
      status: async () =>
        status(
          { ID: "nB", DNSName: "mac-b.t.ts.net." },
          { ID: "nA", DNSName: "mac-a.t.ts.net." }, // this computer
          { ID: "nPhone", DNSName: "iphone.t.ts.net.", OS: "iOS" },
          { ID: "nOff", DNSName: "mac-c.t.ts.net.", Online: false },
          { ID: "nOther", DNSName: "pc.t.ts.net.", UserID: 7 },
          { ID: "nTag", DNSName: "srv.t.ts.net.", Tags: ["tag:server"] },
          { ID: "nNoReach", DNSName: "mini.t.ts.net." },
          { ID: "nLiar", DNSName: "liar.t.ts.net." },
        ),
      request: async (url) => {
        asked.push(url);
        if (url === "https://mac-b.t.ts.net/reach-start.json")
          return {
            product: "Reach",
            origin: "https://mac-b.t.ts.net:8443",
            name: "Mac B",
          };
        if (url === "https://liar.t.ts.net/reach-start.json")
          return {
            product: "Reach",
            origin: "https://mac-b.t.ts.net:8443",
            name: "Not me",
          };
        throw Error("connection refused");
      },
    });
    const found = await fleet.discover();
    assert.deepEqual(found, [
      {
        nodeId: "nB",
        name: "Mac B",
        origin: "https://mac-b.t.ts.net:8443",
        short: "mac-b",
        since: 0,
        linked: false,
      },
    ]);
    assert.deepEqual(asked.sort(), [
      "https://liar.t.ts.net/reach-start.json",
      "https://mac-b.t.ts.net/reach-start.json",
      "https://mini.t.ts.net/reach-start.json",
    ]);
    assert.deepEqual(fleet.links(), []);
    assert.deepEqual(fleet.origins(), []);
    let changes = 0;
    fleet.onChange(() => changes++);
    await assert.rejects(fleet.link("mini"), /No Reach computer named "mini"/);
    await assert.rejects(fleet.link("../x"), /Type link followed/);
    const linked = await fleet.link("MAC-B");
    assert.equal(linked.name, "Mac B");
    assert.equal(changes, 1);
    assert.deepEqual(
      fleet.links().map((l) => [l.nodeId, l.origin]),
      [["nB", "https://mac-b.t.ts.net:8443"]],
    );
    assert.deepEqual(fleet.origins(), [
      "https://mac-b.t.ts.net:8443",
      "https://mac-b.t.ts.net",
    ]);
    assert.equal((await fleet.discover({ fresh: true }))[0].linked, true);
    const later = Date.now() + 5000;
    assert.equal(
      fleet.isLinked({ userId: "42", nodeId: "nB", validUntil: later }),
      true,
    );
    assert.equal(
      fleet.isLinked({ userId: "42", nodeId: "nPhone", validUntil: later }),
      false,
    );
    assert.equal(
      fleet.isLinked({ userId: "7", nodeId: "nB", validUntil: later }),
      false,
    );
    assert.equal(
      fleet.isLinked({
        userId: "42",
        nodeId: "nB",
        tagged: true,
        validUntil: later,
      }),
      false,
    );
    assert.equal(
      fleet.isLinked({
        userId: "42",
        nodeId: "nB",
        validUntil: Date.now() - 1,
      }),
      false,
    );
    fleet.unlink("mac-b");
    assert.deepEqual(fleet.links(), []);
    assert.throws(() => fleet.unlink("mac-b"), /isn't linked/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  "approve once: a phone approved on Mac A is let in by linked Mac B, and only then",
  { skip: process.platform === "win32", timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-fleet-two-"));
    const socketDir = await fs.mkdtemp("/tmp/reach-fleet-sock-");
    const whois = (node, user = 42, tags) => ({
      Node: {
        StableID: node,
        User: user,
        Name: `${node}.t.ts.net.`,
        KeyExpiry: "0001-01-01T00:00:00Z",
        ...(tags ? { Tags: tags } : {}),
      },
      UserProfile: {
        ID: user,
        LoginName: user === 42 ? owner.login : "x@example.test",
      },
    });
    // Tailscale addresses as each Mac's Serve would report them.
    const devices = new Map([
      ["100.64.0.10", whois("nPhone")],
      ["100.64.0.11", whois("nA")],
      ["100.64.0.12", whois("nB")],
      ["100.64.0.13", whois("nLaptop")], // another device on your account
      ["100.64.0.14", whois("nTagged", 42, ["tag:ci"])],
    ]);
    const ip = { nA: "100.64.0.11", nB: "100.64.0.12" };
    const macs = {};
    const call = (mac, route, { from, body, headers = {}, method } = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath: macs[mac].socket,
            path: route,
            method: method || (body ? "POST" : "GET"),
            headers: {
              Host: "localhost",
              "X-Forwarded-For": from,
              "Tailscale-User-Login": owner.login,
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...headers,
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString();
              let json = null;
              try {
                json = JSON.parse(text);
              } catch {}
              resolve({ status: res.statusCode, json, headers: res.headers });
            });
          },
        );
        req.once("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    const origins = {
      nA: "https://mac-a.t.ts.net:8443",
      nB: "https://mac-b.t.ts.net:8443",
    };
    for (const [name, node, other] of [
      ["A", "nA", "nB"],
      ["B", "nB", "nA"],
    ]) {
      const dataDir = path.join(root, name);
      const socket = path.join(socketDir, name);
      const reach = await createReach({
        roots: [root],
        dataDir,
        port: 0,
        publicOrigin: origins[node],
        tailscaleOwner: owner,
        tailscaleIdentity: {
          lookup: async (addr) => {
            if (!devices.has(addr)) throw Error("unknown");
            return devices.get(addr);
          },
        },
        fleet: {
          status: async () =>
            status({
              ID: other,
              DNSName: `${other === "nA" ? "mac-a" : "mac-b"}.t.ts.net.`,
            }),
          // Computer-to-computer calls arrive from this Mac's Tailscale address.
          request: async (url, { method = "GET", body } = {}) => {
            const u = new URL(url);
            const target = u.hostname.startsWith("mac-a") ? "A" : "B";
            if (u.pathname === "/reach-start.json")
              return {
                product: "Reach",
                origin: origins[target === "A" ? "nA" : "nB"],
                name: `Mac ${target}`,
              };
            const r = await call(target, u.pathname, {
              from: ip[node],
              body: method === "POST" ? body : undefined,
            });
            if (r.status !== 200) throw Error(`HTTP ${r.status}`);
            return r.json;
          },
        },
      });
      await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
      await reach.listenPrivate(socket);
      macs[name] = { reach, socket, dataDir };
    }
    const phone = "100.64.0.10";
    const ask = async (mac) => {
      const created = await call(mac, "/api/auth/requests", {
        from: phone,
        body: { name: "My iPhone" },
      });
      assert.equal(created.status, 202);
      return created.json;
    };
    const poll = async (mac, r, ms = 1500) => {
      const until = Date.now() + ms;
      let last;
      do {
        last = await call(mac, `/api/auth/requests/${r.id}`, {
          from: phone,
          body: { secret: r.secret },
        });
        if (last.json?.status !== "pending") return last.json;
        await new Promise((res) => setTimeout(res, 100));
      } while (Date.now() < until);
      return last.json;
    };
    try {
      // Approved on Mac A in its terminal.
      const first = await ask("A");
      approvalStore(macs.A.dataDir).decide(first.id, "approve");
      const onA = await poll("A", first);
      assert.equal(onA.status, "approved");

      // Not linked yet: Mac B waits for its own terminal.
      assert.equal((await poll("B", await ask("B"), 700)).status, "pending");
      // B links A, but A hasn't linked B: A won't answer B, so still pending.
      await macs.B.reach.fleet.link("mac-a");
      assert.equal((await poll("B", await ask("B"), 700)).status, "pending");
      // Both linked: approved on B with no terminal step, and B's terminal is told.
      await macs.A.reach.fleet.link("mac-b");
      const third = await ask("B");
      const onB = await poll("B", third, 4000);
      assert.equal(onB.status, "approved");
      assert.ok(onB.token);
      assert.equal(
        approvalStore(macs.B.dataDir)
          .list()
          .find((r) => r.id === third.id).approvedBy,
        "Mac A",
      );
      // The credential works on B, bound to the phone.
      const me = await call("B", "/api/device", {
        from: phone,
        headers: { Authorization: `Bearer ${onB.token}` },
      });
      assert.equal(me.status, 200);

      // Revoke once: revoking the phone on B (through B's API, as the owner
      // does in Settings) drops it on A as well; another device stays.
      const onBClient = macs.B.reach.auth.list().find((c) => c.tailscale?.nodeId === "nPhone");
      const aBefore = macs.A.reach.auth.list().filter((c) => c.tailscale?.nodeId === "nPhone").length;
      assert.equal(aBefore, 1);
      const revoked = await call("B", `/api/clients/${onBClient.id}`, {
        from: phone,
        headers: { Authorization: `Bearer ${onB.token}` },
        method: "DELETE",
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(macs.A.reach.auth.list().filter((c) => c.tailscale?.nodeId === "nPhone").length, 0);
      // Only linked computers may tell A to revoke.
      const forged = await call("A", "/api/fleet/revoked", { from: "100.64.0.13", body: { userId: "42", nodeId: "nPhone" } });
      assert.equal(forged.status, 403);
      // Approve again on A for the checks below.
      const again1 = await ask("A");
      approvalStore(macs.A.dataDir).decide(again1.id, "approve");
      assert.equal((await poll("A", again1)).status, "approved");
      // …and B lets it back in by itself (approved on A again). Earlier
      // requests count toward B's limit of three per device in 5 minutes.
      await fs.rm(path.join(macs.B.dataDir, "device-requests"), { recursive: true, force: true });
      await fs.mkdir(path.join(macs.B.dataDir, "device-requests"), { mode: 0o700 });
      const backOnB = await poll("B", await ask("B"), 4000);
      assert.equal(backOnB.status, "approved");

      // Only linked computers may ask; never another device or a tagged one.
      for (const from of ["100.64.0.10", "100.64.0.13", "100.64.0.14"]) {
        const r = await call("A", "/api/fleet/approved", {
          from,
          body: { userId: "42", nodeId: "nPhone" },
        });
        assert.equal(r.status, 403, from);
      }
      const byB = await call("A", "/api/fleet/approved", {
        from: ip.nB,
        body: { userId: "42", nodeId: "nPhone" },
      });
      assert.deepEqual(byB.json, { approved: true });
      const unknownDevice = await call("A", "/api/fleet/approved", {
        from: ip.nB,
        body: { userId: "42", nodeId: "nLaptop" },
      });
      assert.deepEqual(unknownDevice.json, { approved: false });

      // Revoked on A: no longer vouched for.
      const client = macs.A.reach.auth
        .list()
        .find((c) => c.tailscale?.nodeId === "nPhone");
      macs.A.reach.auth.revoke(client.id);
      const again = await call("A", "/api/fleet/approved", {
        from: ip.nB,
        body: { userId: "42", nodeId: "nPhone" },
      });
      assert.deepEqual(again.json, { approved: false });

      // A page served by Mac A may call Mac B (one phone page, both Macs).
      const cors = await call("B", "/api/health", {
        from: phone,
        headers: { Origin: "https://mac-a.t.ts.net" },
      });
      assert.equal(
        cors.headers["access-control-allow-origin"],
        "https://mac-a.t.ts.net",
      );
      const stranger = await call("B", "/api/health", {
        from: phone,
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(stranger.status, 403);

      // The phone's list of your computers (owner credential only).
      const list = await call("B", "/api/fleet/computers", {
        from: phone,
        headers: { Authorization: `Bearer ${backOnB.token}` },
      });
      assert.deepEqual(
        list.json.computers.map((c) => [c.short, c.linked]),
        [["mac-a", true]],
      );
      assert.equal(
        (await call("B", "/api/fleet/computers", { from: phone })).status,
        401,
      );
    } finally {
      for (const m of Object.values(macs)) await m.reach.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  },
);

test("one link for the tailnet: the computer where Reach was set up first", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-fleet-home-"));
  try {
    const starts = {
      "https://mac-b.t.ts.net/reach-start.json": { product: "Reach", origin: "https://mac-b.t.ts.net:8443", name: "Mac B", since: 1000 },
      "https://mac-c.t.ts.net/reach-start.json": { product: "Reach", origin: "https://mac-c.t.ts.net:8443", name: "Mac C" },
    };
    const fleet = createFleet({
      dataDir: dir,
      owner,
      selfOrigin: "https://mac-a.t.ts.net:8443",
      status: async () => status({ ID: "nB", DNSName: "mac-b.t.ts.net." }, { ID: "nC", DNSName: "mac-c.t.ts.net." }),
      request: async (url) => starts[url],
    });
    const self = { start: "https://mac-a.t.ts.net", since: 5000 };
    assert.equal(fleet.homeLink(self), "https://mac-a.t.ts.net", "alone: its own link");
    await fleet.link("mac-c"); // no setup time known: never wins
    assert.equal(fleet.homeLink(self), "https://mac-a.t.ts.net");
    await fleet.link("mac-b"); // set up before this one
    assert.equal(fleet.homeLink(self), "https://mac-b.t.ts.net");
    assert.equal(fleet.homeLink({ start: "https://mac-a.t.ts.net", since: 500 }), "https://mac-a.t.ts.net");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reach link: lists your Reach computers and links one from any terminal", async () => {
  const { linkComputers } = await import("../scripts/link.mjs");
  const { stateDir } = await import("../scripts/home.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-link-cli-"));
  try {
    const state = stateDir(root);
    const dataDir = path.join(state, "quick");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(state, "preferences.json"),
      JSON.stringify({ version: 1, owner, folders: [root] }),
    );
    await fs.writeFile(
      path.join(state, "host-status.json"),
      JSON.stringify({ origin: "https://mac-a.t.ts.net:8443", dataDir }),
    );
    const printed = [];
    const deps = {
      print: (line) => printed.push(line),
      fleet: {
        status: async () => status({ ID: "nB", DNSName: "mac-b.t.ts.net." }),
        request: async () => ({ product: "Reach", origin: "https://mac-b.t.ts.net:8443", name: "Mac B" }),
      },
    };
    await linkComputers(root, undefined, deps);
    await linkComputers(root, "mac-b", deps);
    await linkComputers(root, undefined, deps);
    assert.deepEqual(printed, [
      "  not linked · Mac B · reach link mac-b",
      'Linked Mac B. Run "reach link mac-a" on Mac B too; then a phone approved on either works on both.',
      "✓ linked · Mac B",
    ]);
    const links = JSON.parse(await fs.readFile(path.join(dataDir, "links.json"), "utf8"));
    assert.deepEqual(links.computers.map((c) => c.nodeId), ["nB"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
