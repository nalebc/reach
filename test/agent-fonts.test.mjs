import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentFonts } from "../server/agent-sessions/fonts.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// The Claude app's typefaces, read from its installed files: which ones its
// own stylesheet names (the names change with each update), and the routes
// that hand them to the phone.
const SANS = Buffer.from("wOF2-sans");
const SERIF = Buffer.from("wOF2-serif");
async function claudeAssets() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-assets-"));
  await fs.writeFile(path.join(dir, "a1.css"), ".x{color:red}");
  await fs.writeFile(
    path.join(dir, "c6a992d55-D4kZGt22.css"),
    [
      '@font-face{font-family:anthropic-sans;src:url(/assets/v1/cc27851ad-DDVos-BJ.woff2)format("woff2");font-weight:300 800;font-style:normal;font-display:swap}',
      '@font-face{font-family:anthropic-sans;src:url(/assets/v1/c9d3a3a49-CJtkx3-S.woff2)format("woff2");font-weight:300 800;font-style:italic;font-display:swap}',
      '@font-face{font-family:anthropic-serif;src:url(/assets/v1/c66fc489e-2VcCjn5t.woff2)format("woff2");font-weight:300 800;font-style:normal;font-display:swap}',
    ].join(""),
  );
  await fs.writeFile(path.join(dir, "cc27851ad-DDVos-BJ.woff2"), SANS);
  await fs.writeFile(path.join(dir, "c9d3a3a49-CJtkx3-S.woff2"), Buffer.from("italic"));
  await fs.writeFile(path.join(dir, "c66fc489e-2VcCjn5t.woff2"), SERIF);
  return dir;
}

test("finds the Claude app's upright Sans and Serif from its own stylesheet", async () => {
  const dir = await claudeAssets();
  try {
    const fonts = createAgentFonts({ dir });
    const { version, fonts: families } = fonts.list();
    assert.deepEqual(families.sort(), ["anthropic-sans", "anthropic-serif"]);
    assert.equal(fonts.file("anthropic-sans"), path.join(dir, "cc27851ad-DDVos-BJ.woff2"), "the upright one");
    assert.equal(fonts.file("anthropic-serif"), path.join(dir, "c66fc489e-2VcCjn5t.woff2"));
    assert.equal(fonts.file("../../etc/passwd"), null);
    assert.equal(fonts.list().version, version, "the same until the app changes");
    // Without the app (or its files), none: the phone uses its own.
    const none = createAgentFonts({ dir: path.join(dir, "missing") });
    assert.deepEqual(none.list().fonts, []);
    assert.equal(none.file("anthropic-serif"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the font routes serve the files to the owner, ahead of the session routes", async () => {
  const dir = await claudeAssets();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-font-routes-"));
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentFonts: createAgentFonts({ dir }),
    agentSessions: {
      read: async () => {
        throw new Error("a font is not a session");
      },
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const get = (route, token = owner.token) => fetch(url + route, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const list = await (await get("/api/sessions/fonts")).json();
    assert.deepEqual(list.fonts.sort(), ["anthropic-sans", "anthropic-serif"]);
    const serif = await get(`/api/sessions/fonts/anthropic-serif?v=${list.version}`);
    assert.equal(serif.status, 200);
    assert.equal(serif.headers.get("content-type"), "font/woff2");
    assert.match(serif.headers.get("cache-control"), /immutable/);
    assert.deepEqual(Buffer.from(await serif.arrayBuffer()), SERIF);
    assert.equal((await get("/api/sessions/fonts/anthropic-mono")).status, 404);
    assert.equal((await get("/api/sessions/fonts", "wrong")).status, 401);
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
