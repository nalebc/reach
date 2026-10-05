import test from "node:test";
import assert from "node:assert/strict";
import {
  addGuestRules,
  parsePolicy,
  allowAllRules,
} from "../server/tailnet-policy.mjs";

// Reach adds its tag and one grant to your Tailscale policy for you. Only
// insertions: every comment, rule and format choice of yours stays as it was.
const TAG = "tag:reach-guest";
const opts = { tag: TAG, addresses: ["100.64.0.5"], port: 8443 };
const GRANT = { src: [TAG], dst: ["100.64.0.5"], ip: ["tcp:8443"] };

// Every line of the original is still there, in order (only lines added).
function keptEverything(before, after) {
  let at = 0;
  for (const line of before.split("\n")) {
    const found = after.indexOf(line, at);
    assert.ok(found >= 0, `lost or moved: ${JSON.stringify(line)}`);
    at = found + line.length;
  }
}

const DEFAULT_POLICY = `// Example/default ACLs for unrestricted connections.
{
\t// Declare static groups of users.
\t"groups": {"group:family": ["me@example.com"]},

\t// Define the tags which can be applied to devices and by which users.
\t// "tagOwners": {"tag:example": ["autogroup:admin"]},

\t"grants": [
\t\t// Allow all connections.
\t\t// Comment this section out if you want to define specific restrictions.
\t\t{"src": ["*"], "dst": ["*"], "ip": ["*"]},
\t],

\t"ssh": [
\t\t{
\t\t\t"action": "check",
\t\t\t"src":    ["autogroup:member"],
\t\t\t"dst":    ["autogroup:self"],
\t\t\t"users":  ["autogroup:nonroot", "root"],
\t\t},
\t],
}
`;

test("the default policy: tag and grant added, every comment kept, allow-all flagged", () => {
  const out = addGuestRules(DEFAULT_POLICY, opts);
  keptEverything(DEFAULT_POLICY, out.text);
  const policy = parsePolicy(out.text);
  assert.deepEqual(policy.tagOwners, { [TAG]: ["autogroup:admin"] });
  assert.deepEqual(policy.grants[0], GRANT, "Reach's grant comes first");
  assert.deepEqual(policy.grants[1], { src: ["*"], dst: ["*"], ip: ["*"] });
  assert.deepEqual(policy.ssh, parsePolicy(DEFAULT_POLICY).ssh, "ssh untouched");
  assert.equal(out.added.length, 2);
  // The commented-out "tagOwners" in a comment was not mistaken for the real one.
  assert.match(out.text, /\/\/ "tagOwners": \{"tag:example"/);
  // Guests could still reach everything through the allow-all rule.
  assert.deepEqual(out.allowAll, ["grants[0]"]);
  // Indented with tabs, like the file.
  assert.match(out.text, /\n\t\t\{"src": \["tag:reach-guest"\]/);
});

test("existing tagOwners and old-style acls: inserted into tagOwners, grants added", () => {
  const before = `{
  "tagOwners": {
    "tag:server": ["me@example.com"], // my NAS
  },
  /* legacy rules */
  "acls": [
    {"action": "accept", "src": ["*"], "dst": ["*:*"]},
  ],
}`;
  const out = addGuestRules(before, opts);
  keptEverything(before, out.text);
  const policy = parsePolicy(out.text);
  assert.deepEqual(policy.tagOwners, {
    [TAG]: ["autogroup:admin"],
    "tag:server": ["me@example.com"],
  });
  assert.deepEqual(policy.grants, [GRANT]);
  assert.deepEqual(policy.acls, parsePolicy(before).acls);
  assert.deepEqual(out.allowAll, ["acls[0]"]);
  assert.match(out.text, /\n    "tag:reach-guest"/, "two-space file, four-space nesting");
});

test("already set up: nothing added, text unchanged; running twice adds nothing more", () => {
  const once = addGuestRules(DEFAULT_POLICY, opts);
  const twice = addGuestRules(once.text, opts);
  assert.deepEqual(twice.added, []);
  assert.equal(twice.text, once.text);
  // A wider grant (all ports, all addresses) also counts.
  const wide = `{"tagOwners": {"${TAG}": ["autogroup:admin"]}, "grants": [{"src": ["${TAG}"], "dst": ["*"], "ip": ["*"]}]}`;
  assert.deepEqual(addGuestRules(wide, opts).added, []);
  // A grant for another computer doesn't: Reach adds one for this one.
  const other = `{"tagOwners": {"${TAG}": ["autogroup:admin"]}, "grants": [{"src": ["${TAG}"], "dst": ["100.64.0.9"], "ip": ["tcp:8443"]}]}`;
  assert.deepEqual(parsePolicy(addGuestRules(other, opts).text).grants[0], GRANT);
});

test("one-line and empty sections, strings that look like keys", () => {
  const before = `{"tagOwners": {}, "grants": [], "hosts": {"note": "\\"grants\\": [ is not a key"}}`;
  const out = addGuestRules(before, opts);
  const policy = parsePolicy(out.text);
  assert.deepEqual(policy.tagOwners, { [TAG]: ["autogroup:admin"] });
  assert.deepEqual(policy.grants, [GRANT]);
  assert.equal(policy.hosts.note, '"grants": [ is not a key');
  // No tagOwners or grants at all: added at the top.
  const bare = addGuestRules(`{"acls": []}`, opts);
  assert.deepEqual(parsePolicy(bare.text).tagOwners, { [TAG]: ["autogroup:admin"] });
  assert.deepEqual(parsePolicy(bare.text).grants, [GRANT]);
  assert.deepEqual(bare.allowAll, []);
  // Several computers: one grant covering all of them.
  const many = addGuestRules(`{}`, { ...opts, addresses: ["100.64.0.5", "100.64.0.6"] });
  assert.deepEqual(parsePolicy(many.text).grants[0].dst, ["100.64.0.5", "100.64.0.6"]);
});

test("an unreadable policy is refused with a plain reason, never rewritten", () => {
  assert.throws(() => addGuestRules(`{"grants": [ /* oops`, opts), /couldn't be read \(an unclosed comment/);
  assert.throws(() => addGuestRules(`{"a": "b`, opts), /an unclosed string/);
  assert.throws(() => addGuestRules(`["not", "an object"]`, opts), /isn't one object/);
  assert.throws(() => addGuestRules(`{"a": nope}`, opts), /unexpected "nope"/);
});

test("allow-all detection: only rules that let everyone reach everything", () => {
  assert.deepEqual(
    allowAllRules({
      acls: [
        { action: "accept", users: ["*"], ports: ["*:*"] },
        { action: "accept", src: ["group:family"], dst: ["*:*"] },
        { action: "accept", src: ["*"], dst: ["tag:web:443"] },
      ],
      grants: [
        { src: ["autogroup:member"], dst: ["*"], ip: ["*"] },
        { src: ["*"], dst: ["*"], ip: ["*"] },
      ],
    }),
    ["acls[0]", "grants[1]"],
  );
});
