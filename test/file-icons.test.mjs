import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isIconType,
  readFileIcons,
  readLinuxIcons,
} from "../server/file-icons.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test("file type icons are readable by anyone who can browse files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-fileicons-"));
  const asked = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    fileIcons: async (types) => {
      asked.push(types);
      return types.map((t) =>
        t === "zip" ? null : `data:image/png;base64,${t}`,
      );
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}/api/files/icons`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "guest", roots: [0], ttlSeconds: 60 })
      .invitation,
  );
  const get = (token, types) =>
    fetch(`${url}?${new URLSearchParams({ types })}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  try {
    const response = await get(guest.token, "folder,pdf,pdf,zip");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      icons: {
        folder: "data:image/png;base64,folder",
        pdf: "data:image/png;base64,pdf",
        zip: null,
      },
    });
    // Cached: asking again doesn't reach the native reader.
    await (await get(owner.token, "pdf,folder")).json();
    assert.deepEqual(asked, [["folder", "pdf", "zip"]]);
    for (const bad of [
      "",
      "../etc",
      "PDF",
      "a b",
      "x".repeat(17),
      Array(65)
        .fill("a")
        .map((a, i) => a + i)
        .join(","),
    ])
      assert.equal((await get(owner.token, bad)).status, 400, bad);
  } finally {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each platform asks its own file manager for icons", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: `${PNG.toString("base64")}\n\n` };
  };
  const mac = await readFileIcons(["folder", "pdf"], {
    platform: "darwin",
    run,
  });
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.deepEqual(calls[0][1].slice(-2), ["folder", "pdf"]);
  assert.match(mac[0], /^data:image\/png;base64,iVBORw0KGgo/);
  assert.equal(mac[1], null);
  const windows = await readFileIcons(["docx", "file"], {
    platform: "win32",
    run,
  });
  assert.equal(calls[1][0], "powershell.exe");
  const script = Buffer.from(calls[1][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /^\$types = @\('docx','file'\)\n/);
  assert.match(script, /SHGetFileInfo/);
  assert.match(windows[0], /^data:image\/png/);
  assert.deepEqual(await readFileIcons(["pdf"], { platform: "freebsd", run }), [
    null,
  ]);
  assert.equal(calls.length, 2);
  assert.ok(isIconType("folder") && isIconType("docx") && !isIconType("../x"));
});

test("Linux icons come from the desktop theme and what it inherits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-icontheme-"));
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), data);
  };
  try {
    write(
      "share/mime/globs2",
      "50:application/pdf:*.pdf\n50:text/markdown:*.md\n50:application/x-thing:*.thing\n",
    );
    write(
      "share/mime/generic-icons",
      "application/x-thing:package-x-generic\n",
    );
    write(
      "share/icons/Fancy/index.theme",
      "[Icon Theme]\nName=Fancy\nInherits=hicolor\nDirectories=48x48/mimetypes,scalable/mimetypes\n\n[48x48/mimetypes]\nSize=48\nContext=MimeTypes\nType=Fixed\n\n[scalable/mimetypes]\nSize=128\nContext=MimeTypes\nType=Scalable\n",
    );
    write("share/icons/Fancy/48x48/mimetypes/application-pdf.png", PNG);
    write("share/icons/Fancy/scalable/mimetypes/application-pdf.svg", "<svg/>");
    write("share/icons/Fancy/48x48/mimetypes/text-x-generic.png", PNG);
    write(
      "share/icons/hicolor/index.theme",
      "[Icon Theme]\nName=hicolor\nDirectories=64x64/places,64x64/mimetypes\n\n[64x64/places]\nSize=64\nContext=Places\nType=Fixed\n\n[64x64/mimetypes]\nSize=64\nContext=MimeTypes\nType=Fixed\n",
    );
    write("share/icons/hicolor/64x64/places/folder.png", PNG);
    write("share/icons/hicolor/64x64/mimetypes/package-x-generic.png", PNG);
    write(
      "share/icons/hicolor/64x64/mimetypes/text-markdown.png",
      Buffer.alloc(70 * 1024),
    );
    const [pdf, folder, thing, md, unknown] = await readLinuxIcons(
      ["pdf", "folder", "thing", "md", "xyz"],
      {
        dataDirs: [path.join(dir, "share")],
        theme: "Fancy",
        run: async () => ({ stdout: "" }),
      },
    );
    assert.equal(
      pdf,
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    );
    assert.match(folder, /^data:image\/png;base64,/);
    assert.match(thing, /^data:image\/png;base64,/); // generic icon via inheritance
    assert.match(md, /^data:image\/png;base64,/); // oversized specific icon skipped
    assert.match(unknown, /^data:image\/png;base64,/);
    // No themes at all, as in a container: Reach's own icons.
    assert.deepEqual(
      await readLinuxIcons(["pdf"], {
        dataDirs: [path.join(dir, "none")],
        theme: "",
        run: async () => ({ stdout: "" }),
      }),
      [null],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a Mac returns Finder's folder and document icons",
  { skip: process.platform !== "darwin" },
  async () => {
    const icons = await readFileIcons(["folder", "pdf", "file"]);
    for (const icon of icons)
      assert.match(icon, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.notEqual(icons[0], icons[1]);
  },
);
