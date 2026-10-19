import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { readFileIcons } from "../server/file-icons.mjs";
import { defaultFileRoots, refreshDriveRoots } from "../server/file-roots.mjs";
import { zipFixture } from "./helpers/archive-fixtures.mjs";

// Files on a real Windows PC (parity audit #22): every way Windows can name a
// place outside a shared folder, or Reach's own private data inside it (the
// common case: Home shared, Reach's data in it), through /api/files and each
// route beside it. A junction, a directory and a file symbolic link, an 8.3
// short name, an alternate data stream, a trailing dot or space, another
// case, and UNC and device spellings: none gets out, nothing outside is
// read, written or made. What's really inside still works, short names
// included. Then Explorer's own icons, and the PC's real drives.
const onWindows = { skip: process.platform !== "win32" && "a real Windows PC", timeout: 180000 };
const run = (file, args, options = {}) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 30000, ...options }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code ?? -1 : 0, stdout, stderr })));
// Its 8.3 name, as cmd says it ("" when the volume makes none).
const shortName = async (file) => {
  const { stdout } = await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"for %I in ("${file}") do @echo %~sI"`], { windowsVerbatimArguments: true });
  const short = path.win32.basename(stdout.trim());
  return short && short.toLowerCase() !== path.win32.basename(file).toLowerCase() ? short : "";
};

async function sharedFolder(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-files-")));
  const share = path.join(base, "shared folder");
  const outside = path.join(base, "outside place");
  const data = path.join(share, "reach private data");
  for (const dir of [share, outside, data]) fs.mkdirSync(dir, { recursive: true });
  const marks = { outside: `outside-${crypto.randomUUID()}`, private: `private-${crypto.randomUUID()}` };
  fs.writeFileSync(path.join(outside, "secret.txt"), marks.outside);
  fs.writeFileSync(path.join(outside, "secret.docx"), marks.outside);
  fs.writeFileSync(path.join(data, "secret-note.txt"), marks.private);
  fs.writeFileSync(path.join(share, "notes.txt"), "inside");
  fs.writeFileSync(path.join(share, "a long file name.txt"), "inside, long");
  // Links: a junction (any user may make one), directory and file symbolic
  // links (an administrator, as the runner is, or Developer Mode).
  const links = { junction: "junction", privateJunction: "private junction", dirLink: "dir link", fileLink: "file link.txt" };
  fs.symlinkSync(outside, path.join(share, links.junction), "junction");
  fs.symlinkSync(data, path.join(share, links.privateJunction), "junction");
  const made = new Set([links.junction, links.privateJunction]);
  for (const [name, target, type] of [[links.dirLink, outside, "dir"], [links.fileLink, path.join(outside, "secret.txt"), "file"]])
    try {
      fs.symlinkSync(target, path.join(share, name), type);
      made.add(name);
    } catch (error) {
      t.diagnostic(`${type} symbolic link not made here: ${error.code}`);
    }
  const reach = await createReach({ roots: [share], dataDir: data, agentPolicyFile: path.join(base, "none.json") });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await reach.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const api = async (method, route, { json, form, raw } = {}) => {
    const response = await fetch(origin + route, {
      method,
      headers: { Authorization: `Bearer ${owner.token}`, ...(json && { "Content-Type": "application/json" }), ...(raw && { "Content-Type": "application/octet-stream" }) },
      body: json ? JSON.stringify(json) : form || raw,
    });
    return { status: response.status, text: await response.text() };
  };
  return { base, share, outside, data, marks, links, made, api, reach };
}
// Everything under a folder, to see that nothing was written there.
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).sort();
const q = (relative) => `root=0&path=${encodeURIComponent(relative)}`;

test("Windows Files: no junction, link, short name, stream, trailing dot, case or UNC spelling gets out of a shared folder or into Reach's data", onWindows, async (t) => {
  const { base, share, outside, data, marks, links, made, api } = await sharedFolder(t);
  const privateShort = await shortName(data);
  const junctionShort = await shortName(path.join(share, links.junction));
  if (!privateShort) t.diagnostic("this volume makes no 8.3 names: short names not tried");
  const drive = base.slice(0, 2);
  const outsideFile = path.join(outside, "secret.txt");
  const folders = [
    ...[links.junction, links.privateJunction, links.dirLink].filter((name) => made.has(name)),
    "reach private data", "REACH PRIVATE DATA", "reach private data.", "reach private data::$INDEX_ALLOCATION",
    ...(privateShort ? [privateShort] : []), ...(junctionShort ? [junctionShort] : []),
    `${links.junction}.`, "..", "..\\outside place", "../outside place",
    `${drive}..\\outside place`, `\\\\?\\${outside}`, `\\\\.\\${outside}`, `\\\\localhost\\${drive[0]}$${outside.slice(2)}`,
    `//localhost/${drive[0]}$${outside.slice(2).replaceAll("\\", "/")}`, `\\\\?\\UNC\\localhost\\${drive[0]}$${outside.slice(2)}`,
    outside, `${drive}${outside.slice(2)}`.toLowerCase(),
  ];
  const files = [
    ...folders.map((folder) => `${folder}\\${folder.startsWith("reach") || folder.startsWith("REACH") || folder === privateShort || folder === links.privateJunction ? "secret-note.txt" : "secret.txt"}`),
    ...(made.has(links.fileLink) ? [links.fileLink, `${links.fileLink}::$DATA`] : []),
    "reach private data\\secret-note.txt::$DATA", "reach private data\\secret-note.txt.", "reach private data\\secret-note.txt ",
    "reach private data\\SECRET~1.TXT", outsideFile, `\\\\?\\${outsideFile}`,
  ];
  const leaked = (text) => text.includes(marks.outside) || text.includes(marks.private);
  const before = { outside: listing(outside), data: listing(data) };
  for (const folder of folders) {
    const listed = await api("GET", `/api/files?${q(folder)}`);
    assert.ok([400, 403, 404].includes(listed.status), `list ${folder}: ${listed.status} ${listed.text}`);
    assert.ok(!leaked(listed.text) && !listed.text.includes("secret"), `list ${folder}: ${listed.text}`);
    const folderMade = await api("POST", "/api/files/folder", { json: { root: 0, path: folder, name: "made here" } });
    assert.ok([400, 403, 404].includes(folderMade.status), `mkdir in ${folder}: ${folderMade.status}`);
    const form = new FormData();
    form.append("file", new Blob(["uploaded"]), "uploaded.txt");
    const uploaded = await api("POST", `/api/files/upload?${q(folder)}`, { form });
    assert.ok([400, 403, 404].includes(uploaded.status), `upload into ${folder}: ${uploaded.status}`);
    const resumable = await api("POST", "/api/files/uploads", { json: { root: 0, path: folder, name: "uploaded.txt", size: 8 } });
    assert.ok([400, 403, 404].includes(resumable.status), `resumable upload into ${folder}: ${resumable.status}`);
  }
  for (const file of files) {
    for (const route of ["/api/files/text", "/api/files/content", "/api/files/download-link", "/api/files/document-text"]) {
      const read = await api("GET", `${route}?${q(route.endsWith("document-text") ? file.replace(/secret(-note)?\.txt/, "secret.docx") : file)}`);
      assert.ok([400, 403, 404, 415].includes(read.status), `${route} ${file}: ${read.status} ${read.text.slice(0, 200)}`);
      assert.ok(!leaked(read.text), `${route} ${file}: ${read.text.slice(0, 200)}`);
    }
    const sha256 = crypto.createHash("sha256").update(file.includes("secret-note") ? marks.private : marks.outside).digest("hex");
    const written = await api("PUT", `/api/files/text?${q(file)}`, { json: { text: "overwritten", sha256 } });
    assert.ok([400, 403, 404, 409].includes(written.status), `write ${file}: ${written.status}`);
  }
  // Nothing outside, or in Reach's data, was read into a reply above, or
  // changed, or made.
  assert.deepEqual(listing(outside), before.outside);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), marks.outside);
  assert.equal(fs.readFileSync(path.join(data, "secret-note.txt"), "utf8"), marks.private);
  assert.ok(!listing(data).some((name) => /made here|uploaded/.test(name)), listing(data).join(", "));
  // The folder's own listing: its files, none of the ways out, none of Reach's.
  const shown = JSON.parse((await api("GET", "/api/files?root=0&path=")).text).items.map((item) => item.name);
  assert.deepEqual(shown.sort(), ["a long file name.txt", "notes.txt"]);
});

test("Windows Files: what's inside still works, short names, streams and Windows' own separators included; bad names are refused", onWindows, async (t) => {
  const { share, api } = await sharedFolder(t);
  assert.deepEqual(JSON.parse((await api("GET", `/api/files/text?${q("notes.txt")}`)).text).text, "inside");
  const short = await shortName(path.join(share, "a long file name.txt"));
  if (short) {
    const read = await api("GET", `/api/files/text?${q(short)}`);
    assert.equal(read.status, 200, read.text);
    assert.equal(JSON.parse(read.text).text, "inside, long");
  } else t.diagnostic("this volume makes no 8.3 names: short names not tried");
  fs.mkdirSync(path.join(share, "sub folder"));
  fs.writeFileSync(path.join(share, "sub folder", "deep.txt"), "deep");
  for (const spelled of ["sub folder\\deep.txt", "sub folder/deep.txt", "SUB FOLDER\\DEEP.TXT"]) {
    const read = await api("GET", `/api/files/text?${q(spelled)}`);
    assert.equal(read.status, 200, `${spelled}: ${read.text}`);
    assert.equal(JSON.parse(read.text).text, "deep");
  }
  // A stream of a file that's shared is the file's own: read or not, never
  // anything else's.
  fs.writeFileSync(path.join(share, "notes.txt:extra"), "a stream");
  const stream = await api("GET", `/api/files/text?${q("notes.txt:extra")}`);
  t.diagnostic(`a shared file's own stream: ${stream.status}`);
  assert.ok([200, 400, 403, 404].includes(stream.status));
  if (stream.status === 200) assert.equal(JSON.parse(stream.text).text, "a stream");
  // Names Windows would change or refuse: never made. (An upload's name
  // loses any folder part on the way in, as browsers send it.)
  const names = ["x.txt:evil", "x.txt.", "x.txt ", "CON", "con.txt", "LPT1.log", "a<b.txt", "a|b.txt"];
  for (const name of names) {
    const form = new FormData();
    form.append("file", new Blob(["data"]), name);
    const uploaded = await api("POST", `/api/files/upload?${q("")}`, { form });
    assert.equal(uploaded.status, 400, `${name}: ${uploaded.status} ${uploaded.text}`);
  }
  for (const name of [...names, "a\\b", "a/b", "..", "C:"]) {
    const folder = await api("POST", "/api/files/folder", { json: { root: 0, path: "", name } });
    assert.equal(folder.status, 400, `folder ${name}: ${folder.status}`);
  }
  assert.deepEqual(fs.readdirSync(share).sort(), ["a long file name.txt", "junction", "notes.txt", "private junction", "reach private data", "sub folder", ...["dir link", "file link.txt"].filter((name) => fs.existsSync(path.join(share, name)))].sort());
  // An archive opened in place: what's in it lands beside it; one naming a
  // way out, a stream or a device opens nothing.
  fs.writeFileSync(path.join(share, "good.zip"), zipFixture([{ name: "inside/hello.txt", data: "hello" }]));
  const opened = await api("POST", "/api/files/extract", { json: { root: 0, path: "good.zip" } });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(fs.readFileSync(path.join(share, "inside", "hello.txt"), "utf8"), "hello");
  for (const [i, name] of ["../escaped.txt", "..\\escaped.txt", "C:/escaped.txt", "x.txt:stream", "CON", "nul.txt", "dots./x.txt", "trailing /x.txt"].entries()) {
    fs.writeFileSync(path.join(share, `bad${i}.zip`), zipFixture([{ name, data: "nope" }]));
    const refused = await api("POST", "/api/files/extract", { json: { root: 0, path: `bad${i}.zip` } });
    assert.equal(refused.status, 422, `${name}: ${refused.status} ${refused.text}`);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(share), "escaped.txt")), false);
  assert.equal(fs.existsSync("C:\\escaped.txt"), false);
});

test("Windows Files: Explorer's own icons, a distinct picture per kind", onWindows, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-file-type-icons-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const kinds = ["folder", "file", "txt", "pdf", "zip", "exe"];
  const icons = await readFileIcons(kinds, { windows: { dataDir } });
  for (const [i, icon] of icons.entries()) {
    assert.match(icon || "", /^data:image\/png;base64,iVBORw0KGgo/, kinds[i]);
    const png = Buffer.from(icon.split(",")[1], "base64");
    // 48 px, as asked (SHIL_EXTRALARGE).
    assert.equal(png.readUInt32BE(16), 48, `${kinds[i]} width`);
    assert.equal(png.readUInt32BE(20), 48, `${kinds[i]} height`);
  }
  assert.notEqual(icons[0], icons[1], "a folder isn't a file");
  assert.notEqual(icons[1], icons[5], "a program isn't any file");
  assert.ok(new Set(icons).size >= 3, "kinds have their own pictures");
});

test("Windows Files: the default roots are Home and the PC's real drives", onWindows, () => {
  const home = os.homedir();
  const roots = defaultFileRoots();
  assert.equal(roots[0], home);
  const drives = roots.filter((root) => /^[A-Z]:\\$/.test(root));
  assert.ok(drives.includes(path.win32.parse(home).root), roots.join(", "));
  const system = `${(process.env.SystemDrive || "C:").toUpperCase()}\\`;
  assert.ok(drives.includes(system), roots.join(", "));
  for (const drive of drives) assert.ok(fs.statSync(drive).isDirectory(), drive);
  assert.equal(new Set(roots).size, roots.length, "each once");
  // Drives attached later join a whole-drive share at the end.
  assert.deepEqual(refreshDriveRoots([system]).map((root) => root.path), drives.filter((drive) => drive === system).concat(drives.filter((drive) => drive !== system)));
});
