import test from "node:test";
import assert from "node:assert/strict";
import { publicNameState } from "../server/public-dns.mjs";

const system = {
  resolveNs: async (zone) => { assert.equal(zone, "ts.net"); return ["ns1.example", "ns2.example", "ns3.example"]; },
  resolve4: async (name) => ({ "ns1.example": ["192.0.2.1"], "ns2.example": ["192.0.2.2"] })[name] || [],
};
const resolver = (answer, servers = []) => () => ({
  setServers: (list) => servers.push(...list),
  resolve4: async () => { if (answer instanceof Error) throw answer; return answer; },
});
const code = (value) => Object.assign(Error(value), { code: value });

test("asks the zone's own nameservers, never the Mac's resolver", async () => {
  const servers = [];
  assert.equal(await publicNameState("mac.tail1.ts.net", { system, resolver: resolver(["203.0.113.5"], servers) }), "published");
  assert.deepEqual(servers, ["192.0.2.1", "192.0.2.2"]);
});

test("an authoritative not-found is missing; anything else is unknown", async () => {
  assert.equal(await publicNameState("mac.tail1.ts.net", { system, resolver: resolver(code("ENOTFOUND")) }), "missing");
  for (const failure of ["ETIMEOUT", "ECONNREFUSED", "ENODATA", "ESERVFAIL"])
    assert.equal(await publicNameState("mac.tail1.ts.net", { system, resolver: resolver(code(failure)) }), "unknown");
  assert.equal(await publicNameState("mac.tail1.ts.net", { system: { ...system, resolveNs: async () => { throw code("ENOTFOUND"); } }, resolver: resolver(code("ENOTFOUND")) }), "unknown");
});

test("no reachable nameserver is unknown, not missing", async () => {
  const none = { ...system, resolve4: async () => [] };
  assert.equal(await publicNameState("mac.tail1.ts.net", { system: none, resolver: resolver(code("ENOTFOUND")) }), "unknown");
});
