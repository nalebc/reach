import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Oct 6: tapping a text field in Chrome on the live screen never opened the
// phone's keyboard. Reach asked apps to list their fields with
// AXManualAccessibility, which only Electron understands: Chrome answers
// "unsupported" and keeps its pages' fields hidden from macOS. Browsers list
// them once asked with AXEnhancedUserInterface (VoiceOver's request), and need
// a few seconds after that, so the helper asks every running browser as it
// starts. Measured on a fresh Chrome: before, 0 of 4 fields found; after, 4 of 4.
const swift = readFileSync(new URL("../scripts/native/desktop-input.swift", import.meta.url), "utf8");

test("browsers are asked to list their pages' text fields the way they understand", () => {
  const list = swift.match(/static let browsers: Set<String> = \[([\s\S]*?)\]/)?.[1] || "";
  for (const id of ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox"])
    assert.ok(list.includes(`"${id}"`), `${id} is a browser`);
  const describe = swift.match(/func describe\(_ pid: pid_t\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(describe, /"AXManualAccessibility"/, "Electron apps still asked their way");
  assert.match(describe, /Input\.browsers\.contains\(id\)[\s\S]*"AXEnhancedUserInterface"/, "browsers asked theirs");
});

test("taps, the field map and the helper's start all ask the app first", () => {
  const probe = swift.match(/func probe\([\s\S]*?\n  \}/)?.[0] || "";
  const fields = swift.match(/func fields\([\s\S]*?\n  \}/)?.[0] || "";
  assert.match(probe, /describe\(pid\)/);
  assert.match(fields, /describe\(pid\)/);
  assert.match(swift, /runningApplications\s*where Input\.browsers\.contains[\s\S]{0,80}input\.describe\(app\.processIdentifier\)/);
});
