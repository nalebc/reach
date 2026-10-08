import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileSearch, fuzzyScore } from "../server/agent-sessions/file-search.mjs";
import { createAgentFiles, safeFileName } from "../server/agent-sessions/images.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { startDom, settle } from "./dom/harness.mjs";

// Files in messages, as both apps take them: "@" picks one of the chat
// folder's files; any file from the phone goes as its path (@path for
// Claude Code, the path for Codex).
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-files-"));

test("@ finds the folder's files by name first, then by letters in order; git's list, or a walk outside a repository", async () => {
  assert.ok(fuzzyScore("src/Connectors.tsx", "conn") > fuzzyScore("server/agent-sessions/connectors-old/x.mjs", "conn"));
  assert.equal(fuzzyScore("src/App.tsx", "zzz"), null);
  assert.ok(fuzzyScore("src/AgentSession.tsx", "agss") !== null);
  const runs = [];
  const search = createFileSearch({ run: async (cmd, args) => (runs.push(args), { stdout: "src/App.tsx\nsrc/Connectors.tsx\nREADME.md\n" }) });
  assert.deepEqual((await search.search("/repo", "conn")).map((f) => f.path), ["src/Connectors.tsx"]);
  await search.search("/repo", "app");
  assert.equal(runs.length, 1, "the list is kept a while");
  assert.deepEqual(runs[0], ["-C", "/repo", "ls-files", "-co", "--exclude-standard"]);
  // Not a repository: a short walk, skipping node_modules and dot folders.
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "x", "notes.md"), "");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "notes.md"), "");
  const walking = createFileSearch({ run: async () => Promise.reject(new Error("not a git repository")) });
  assert.deepEqual((await walking.search(dir, "notes")).map((f) => f.path), ["docs/notes.md"]);
  assert.deepEqual(await walking.search("relative/dir", "x"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file from the phone is kept under Reach's own id, its name cleaned; never a path the phone chose", () => {
  const dir = tmp();
  const files = createAgentFiles({ dir });
  const upload = path.join(dir, "upload.tmp");
  fs.writeFileSync(upload, "%PDF");
  const id = files.add(upload, "../../Quarterly report.pdf");
  assert.match(id, /^[0-9a-f-]{36}\/\.\.-\.\.-Quarterly report\.pdf$|^[0-9a-f-]{36}\/-\.\.-Quarterly report\.pdf$|^[0-9a-f-]{36}\/[^/]+$/);
  const [file] = files.paths([id]);
  assert.ok(file.startsWith(dir + path.sep));
  assert.equal(fs.readFileSync(file, "utf8"), "%PDF");
  assert.equal(safeFileName("a/b\\c:d"), "a-b-c-d");
  assert.equal(safeFileName("..hidden"), "hidden");
  assert.throws(() => files.paths(["../../etc/passwd"]), /Unknown file/);
  assert.throws(() => files.paths([`${id.split("/")[0]}/missing.pdf`]), /gone/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a message carries its files as paths, @path for Claude Code, the path for Codex; owners only", async () => {
  const root = tmp();
  const sent = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      health: async () => [],
      send: async (agent, id, body) => (sent.push([agent, body.text]), { turnId: "t" }),
      findFiles: async () => [{ path: "src/App.tsx", name: "App.tsx" }],
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["files"], "agent");
  try {
    const form = new FormData();
    form.append("file", new Blob(["hello"]), "notes.txt");
    const up = await fetch(`${url}/api/sessions/files`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: form });
    const { id, name } = await up.json();
    assert.equal(name, "notes.txt");
    const post = (agentName, body, token = owner.token) =>
      fetch(`${url}/api/sessions/${agentName}/11111111-2222-4333-8444-555555555555/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await post("claude", { text: "Read this", files: [id] });
    await post("codex", { text: "Read this", files: [id] });
    const stored = path.join(root, ".reach", "agent-files", id);
    assert.deepEqual(sent, [
      ["claude", `Read this\n\n@${stored}`],
      ["codex", `Read this\n\n${stored}`],
    ]);
    assert.equal((await post("claude", { text: "x", files: ["../../etc/passwd"] })).status, 400);
    assert.equal((await post("claude", { text: "x" }, agent.token)).status, 403);
    const found = await fetch(`${url}/api/sessions/claude/11111111-2222-4333-8444-555555555555/files?q=app`, { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.deepEqual(await found.json(), { files: [{ path: "src/App.tsx", name: "App.tsx" }] });
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("@ in the box lists the folder's files; picking one hands back its path", async () => {
  const dom = await startDom({
    routes: { "/api/sessions/claude/s1/files": (init, url) => ({ files: [{ path: `src/${url.searchParams.get("q")}.tsx`, name: `${url.searchParams.get("q")}.tsx` }] }) },
  });
  try {
    const { default: MentionMenu } = await dom.load("/src/MentionMenu.tsx");
    const picked = [];
    const view = await dom.render(
      dom.React.createElement(MentionMenu, { peer: { id: "m", url: "https://reach.test", token: "t" }, session: { agent: "claude", id: "s1" }, query: "App", onPick: (p) => picked.push(p) }),
    );
    await dom.waitFor(() => view.container.querySelector(".as-mentions button"));
    assert.match(view.container.textContent, /App\.tsx/);
    dom.update(() => view.container.querySelector(".as-mentions button").click());
    await settle();
    assert.deepEqual(picked, ["src/App.tsx"]);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    dom.close();
  }
});
