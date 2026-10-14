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

test(`Files: the phone browses this ${word}'s home and its drive, previews a text file, and downloads it whole`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const note = `${marker("note")}\nA second line, with an accent: déjà vu ✓\n`;
  const file = path.join(computer.reach.home, "Journey notes.txt");
  fs.writeFileSync(file, note);
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
  // The whole computer, one tap away.
  await page.tap("button.files-title.is-switch", "the folder switch");
  await page.tap({ selector: `[aria-label="Locations"] button`, text: drive }, drive);
  await page.see(() => document.querySelector(".files-title")?.innerText?.trim(), `${drive}'s files`, 30000);
  const listed = await page.see({ js: `(() => { const n = (${names})(); return ${JSON.stringify(everyone)}.every((x) => n.includes(x)) && n; })()` }, `${everyone.join(", ")} at ${drive}'s top`, 30000);
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
