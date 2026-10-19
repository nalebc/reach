import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startComputer, phone, skip, word, windows, marker } from "../helpers/journey.mjs";

// Files: the folders a first run shares (Home, and the whole computer: a
// Mac's "/" or a PC's drives), browsed from the phone, a text file previewed
// and downloaded to the phone byte for byte; and what the computer's own
// file browser hides (Finder; File Explorer) isn't shown.
const drive = windows ? `Drive ${path.parse(process.env.SystemRoot || "C:\\Windows").root}` : "Computer";
// A drive's top folders everyone has.
const everyone = windows ? ["Users", "Windows", "Program Files"] : ["Applications", "Library", "System", "Users"];
// What the computer's own file browser hides at the drive's top, of what's
// there: File Explorer's hidden and system items (by name, as Reach knows
// them), Finder's hidden flag.
function hiddenAtTop() {
  const top = windows ? path.parse(process.env.SystemRoot || "C:\\Windows").root : "/";
  if (windows) {
    const known = ["$Recycle.Bin", "System Volume Information", "ProgramData", "Recovery", "pagefile.sys", "swapfile.sys", "DumpStack.log.tmp", "Documents and Settings"];
    const there = fs.readdirSync(top);
    return known.filter((name) => there.some((n) => n.toLowerCase() === name.toLowerCase()));
  }
  // `ls -lO`: the flags Finder reads, "hidden" among them.
  return execFileSync("/bin/ls", ["-lO", "/"], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\S+\s+\d+\s+\S+\s+\S+\s+(\S+)\s+\d+\s+\S+\s+\d+\s+\S+\s+(.+?)(?: -> .*)?$/.exec(line))
    .filter((m) => m && m[1].split(",").includes("hidden"))
    .map((m) => m[2]);
}
const names = () => [...document.querySelectorAll(".file-main .file-name")].map((n) => n.innerText.trim());

test(`Files: the phone browses this ${word}'s home and its drive, previews a text file, downloads it whole, and edits another`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const note = `${marker("note")}\nA second line, with an accent: déjà vu ✓\n`;
  const file = path.join(computer.reach.home, "Journey notes.txt");
  fs.writeFileSync(file, note);
  t.after(() => fs.rmSync(file, { force: true }));
  // Windows line endings, which a browser's text box reads as "\n".
  const ini = `[${marker("settings")}]\r\nname = déjà vu ✓\r\n`;
  const settings = path.join(computer.reach.home, "Journey settings.ini");
  fs.writeFileSync(settings, ini);
  t.after(() => fs.rmSync(settings, { force: true }));
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.tap(`nav.mobile-nav button[aria-label="More workspace options"]`, "More");
  await page.tap({ selector: `nav[aria-label="Go to"] button`, text: "Files" }, "Files, in More");
  // Home first, its files listed.
  await page.see(() => document.querySelector(".files-title")?.innerText?.trim() === "Home", "Home's files", 30000);
  await page.see({ js: `(${names})().includes("Journey notes.txt")` }, "the text file in Home", 30000);
  await page.shot("home");
  await page.tap({ selector: "button.file-main", text: "Journey notes.txt" }, "the text file");
  const shown = await page.see(
    () => document.querySelector('dialog.file-viewer[aria-label="Journey notes.txt"] .file-viewer-body')?.innerText,
    "the file's text, previewed",
    30000,
  );
  assert.equal(shown.trim(), note.trim(), "the text as it is on the computer");
  await page.shot("preview");
  // Downloaded as a browser downloads: by its own manager (said by a
  // "Downloading" note), or at once when the phone has it already.
  await page.tap(`button[aria-label="Download Journey notes.txt"]`, "Download");
  let download;
  for (const end = Date.now() + 30000; !download && Date.now() < end; await new Promise((r) => setTimeout(r, 200)))
    download = page.downloads().find((d) => d.name === "Journey notes.txt" && d.state === "completed");
  assert.ok(download, `the download finished: ${JSON.stringify(page.downloads())}`);
  assert.equal(fs.readFileSync(download.file, "utf8"), note, "the phone has the file byte for byte");
  await page.tap(`button[aria-label="Close preview"]`, "Close preview");
  // Edited on the phone and saved: the computer's file holds what was typed,
  // byte for byte, every line still ending in "\r\n", the new one too.
  await page.tap({ selector: "button.file-main", text: "Journey settings.ini" }, "the settings file");
  await page.see(
    () => document.querySelector('dialog.file-viewer[aria-label="Journey settings.ini"] .file-viewer-body pre')?.innerText,
    "the settings file, previewed",
    30000,
  );
  await page.tap(`button[aria-label="Edit Journey settings.ini"]`, "Edit");
  await page.tap("textarea.file-editor", "the file's text");
  await page.evaluate(`(() => { const el = document.querySelector("textarea.file-editor"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); })()`);
  await page.type("color = green");
  await page.key("Enter");
  await page.shot("editing");
  await page.tap({ selector: "dialog.file-viewer header button", text: "Save" }, "Save");
  await page.see(
    () => !document.querySelector("textarea.file-editor") && document.querySelector("dialog.file-viewer .file-viewer-body pre")?.innerText.includes("color = green"),
    "the saved text, previewed",
    30000,
  );
  assert.equal(fs.readFileSync(settings, "utf8"), `${ini}color = green\r\n`, "the computer's file, as typed, its line endings kept");
  await page.shot("edited");
  await page.tap(`button[aria-label="Close preview"]`, "Close preview");
  // The whole computer, one tap away.
  await page.tap("button.files-title.is-switch", "the folder switch");
  await page.tap({ selector: `[aria-label="Locations"] button`, text: drive }, drive);
  await page.see(() => document.querySelector(".files-title")?.innerText?.trim(), `${drive}'s files`, 30000);
  const listed = await page.see({ js: `(() => { const n = (${names})(); return ${JSON.stringify(everyone)}.every((x) => n.includes(x)) && n; })()` }, `${everyone.join(", ")} at ${drive}'s top`, 30000);
  // Each drawn as the computer's own file browser draws it (Finder's or
  // File Explorer's icons), not Reach's stand-in glyphs.
  await page.see(
    () => [...document.querySelectorAll(".file-main")].filter((b) => /Folder/.test(b.innerText)).every((b) => b.querySelector(".file-kind.is-native img")),
    `the drive's folders with ${windows ? "File Explorer's" : "Finder's"} own folder icon`,
    60000,
  );
  await page.shot("drive");
  // On a Mac, Reach hides only what starts with a dot; Finder also hides
  // what has its hidden flag (bin, usr, Volumes… at the top), which Node
  // can't read. Found by this journey on Oct 14 and left for the owner: the
  // phone lists them.
  await t.test(`what ${windows ? "File Explorer" : "Finder"} hides at the drive's top isn't listed`, { todo: !windows && "a Mac lists what Finder's hidden flag hides" }, () => {
    const hidden = hiddenAtTop();
    assert.ok(hidden.length > 0, "the drive's top has something its file browser hides");
    assert.deepEqual(hidden.filter((name) => listed.includes(name)), []);
  });
});

test("Files: a late save acknowledgement preserves a newer draft after the preview reopens", { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const name = "Journey late save.txt";
  const file = path.join(computer.reach.home, name);
  fs.writeFileSync(file, "original\r\n");
  t.after(() => fs.rmSync(file, { force: true }));
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.tap(`nav.mobile-nav button[aria-label="More workspace options"]`, "More");
  await page.tap({ selector: `nav[aria-label="Go to"] button`, text: "Files" }, "Files");
  await page.tap({ selector: "button.file-main", text: name }, "the draft file");
  await page.tap(`button[aria-label="Edit ${name}"]`, "Edit");
  await page.fill("textarea.file-editor", "first save\n");
  // The request and disk write are real. Hold only delivery of its completed
  // response to the app, so another preview can be opened before it settles.
  // dialog.close() below models the browser closing a modal without Cancel;
  // this is real Chrome, not a physical phone's back gesture or real Tailscale.
  await page.evaluate(`(() => {
    const fetch = window.fetch.bind(window);
    window.__lateFileSave = { calls: 0, ready: false, delivered: false };
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (new URL(typeof args[0] === "string" ? args[0] : args[0].url, location.href).pathname === "/api/files/text"
          && args[1]?.method === "PUT") {
        const held = window.__lateFileSave;
        held.calls++;
        held.ready = true;
        await new Promise(resolve => { held.release = resolve; });
        held.delivered = true;
      }
      return response;
    };
  })()`);
  t.after(() => page.evaluate("window.__lateFileSave?.release?.()").catch(() => {}));
  await page.tap({ selector: "dialog.file-viewer header button", text: "Save" }, "Save");
  await page.see(() => window.__lateFileSave.ready, "the real write completed, its response held", 30000);
  assert.equal(fs.readFileSync(file, "utf8"), "first save\r\n");
  await page.tap(`button[aria-label="Close preview"]`, "close while saving");
  await page.tap({ selector: "button.file-main", text: name }, "reopen the draft file");
  await page.see(() => document.querySelector("textarea.file-editor")?.value === "first save\n", "the pending draft is restored");
  await page.fill("textarea.file-editor", "newer unsaved draft\n");
  await page.evaluate('document.querySelector("dialog.file-viewer").close()');
  await page.see(() => !document.querySelector("dialog.file-viewer"), "the browser closed the newer preview");
  await page.evaluate("window.__lateFileSave.release()");
  await page.see(() => window.__lateFileSave.delivered, "the first response is released");
  await page.see(() => document.body.innerText.includes("Saved Journey late save.txt"), "the original save is acknowledged");
  await page.tap({ selector: "button.file-main", text: name }, "reopen after the old acknowledgement");
  await page.see(() => document.querySelector("textarea.file-editor")?.value === "newer unsaved draft\n", "the newer draft is still present");
  assert.equal(await page.evaluate("window.__lateFileSave.calls"), 1, "only the original save was sent");
  assert.equal(fs.readFileSync(file, "utf8"), "first save\r\n", "the newer draft remains unsent");
  await page.shot("late-save-newer-draft-preserved");
});
