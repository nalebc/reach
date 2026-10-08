import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Execute the actual native tree search over synthetic AX trees. No app is
// opened and no permission is granted by this test.
test("native cards find request text above the footer without borrowing another card's text", {
  skip: process.platform !== "darwin",
  timeout: 120000,
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-card-tree-"));
  const stub = `
import Foundation
typealias AXUIElement = Element
let kAXWindowsAttribute = "windows", kAXParentAttribute = "parent", kAXRoleAttribute = "role"
let kAXButtonRole = "AXButton", kAXStaticTextRole = "AXStaticText", kAXValueAttribute = "value"
final class Element {
  var role: String; var text: String; var nodes: [Element]; weak var parent: Element?
  init(_ role: String, _ text: String = "", _ nodes: [Element] = []) {
    self.role = role; self.text = text; self.nodes = nodes
    for node in nodes { node.parent = self }
  }
}
func attr(_ e: Element, _ key: String) -> AnyObject? {
  if key == "windows" { return e.nodes as NSArray }
  if key == "parent" { return e.parent }
  return nil
}
func str(_ e: Element, _ key: String) -> String { key == "role" ? e.role : e.text }
func children(_ e: Element) -> [Element] { e.nodes }
func label(_ e: Element) -> String { e.text }
func starts(_ text: String, _ word: String) -> Bool { text == word || text.hasPrefix(word + " ") }
func says(_ e: Element, _ choice: String) -> Bool { starts(e.text, choice) }
func squeezed(_ text: String) -> String { text.filter { !$0.isWhitespace }.lowercased() }
func opensMenu(_ e: Element, _ role: String) -> Bool { false }
let buttonRoles: Set<String> = ["AXButton"]
let choices = ["Deny", "Allow for this session"]
func check(_ value: Bool, _ why: String) { if !value { fatalError(why) } }
func text(_ value: String) -> Element { Element("AXStaticText", value) }
func card(_ command: String) -> Element {
  Element("AXGroup", "", [text(command), Element("AXGroup", "", [Element("AXButton", "Deny"), Element("AXButton", "Allow for this session")])])
}
func app(_ nodes: [Element]) -> Element { Element("AXApplication", "", [Element("AXWindow", "", [Element("AXWebArea", "", nodes)])]) }
`;
  try {
    for (const kind of ["permission-card", "claude-consent"]) {
      const source = await fs.readFile(new URL(`../scripts/native/${kind}.swift`, import.meta.url), "utf8");
      const search = kind === "permission-card"
        ? source.slice(source.indexOf("struct Card {"), source.indexOf("// What an option says:"))
        : source.slice(source.indexOf("func findCard("), source.indexOf("@main"));
      const wrapper = kind === "permission-card"
        ? 'func found(_ root: Element, _ wanted: String) -> Bool { findCard(root, expect: [wanted]) != nil }'
        : 'func found(_ root: Element, _ wanted: String) -> Bool { var budget = 60000; return findCard(root, expect: [wanted], budget: &budget) != nil }';
      const cases = `
check(found(app([card("ls -t $(find ~ -maxdepth 4)")]), "ls -t $(find ~ -maxdepth 4)"), "nested button footer")
check(found(app([card("unrelated"), card("wanted command")]), "wanted command"), "later matching card")
check(!found(app([card("other command")]), "wanted command"), "wrong command")
check(!found(app([text("wanted command"), card("other command")]), "wanted command"), "transcript is not card text")
check(!found(app([Element("AXGroup", "", [text("wanted command"), card("other command")])]), "wanted command"), "different card body stops ancestor search")
check(!found(app([Element("AXGroup", "", [card("other"), card("wanted command")])]), "never asked"), "unrelated request")
check(!found(app([Element("AXGroup", "", [text("wanted command"), card("one"), card("two")])]), "wanted command"), "multiple cards cannot be combined")
check(found(app([card("wanted \\ncommand")]), "wanted command"), "split command whitespace")
print("${kind} passed")
`;
      const file = path.join(dir, "main.swift"), binary = path.join(dir, kind);
      await fs.writeFile(file, stub + search + wrapper + cases);
      execFileSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(dir, "cache"), file, "-o", binary], { timeout: 90000, stdio: "pipe" });
      assert.match(execFileSync(binary, { encoding: "utf8", timeout: 10000 }), /passed/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
