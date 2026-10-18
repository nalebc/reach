import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Letters and digits from the phone press the key that types them on the
// Mac's own keyboard layout. On AZERTY the US key positions sent ⌘Q (quit)
// for ⌘A and ⌘W for ⌘Z. These read layouts only: no input source is ever
// selected, nothing is typed and no event is posted.
const read = () => fs.readFile(new URL("../scripts/native/desktop-input.swift", import.meta.url), "utf8");
const block = (source) => source.split("// BEGIN KEY LAYOUT")[1].split("// END KEY LAYOUT")[0];
async function run(t, name, swift) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), `reach-${name}-`));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "main.swift"), binary = path.join(folder, name);
  // Never select a layout: that would change the owner's keyboard.
  assert.doesNotMatch(swift, /TISSelectInputSource|TISEnableInputSource|TISSetInputMethodKeyboardLayoutOverride/);
  await fs.writeFile(file, swift);
  const built = spawnSync("xcrun", ["swiftc", "-module-cache-path", path.join(folder, "cache"), file, "-o", binary], { encoding: "utf8", timeout: 90000 });
  assert.equal(built.status, 0, built.stderr);
  const checked = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  return checked.stdout;
}
// The US key positions the helper falls back to, as in its key table.
const US = String.raw`
let us: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
  "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]
func installed(_ id: String) -> TISInputSource {
  let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource],
    let source = list.first else { preconditionFailure("\(id) is not installed") }
  return source
}
`;

test("letters and digits resolve to the keys that type them on AZERTY, QWERTZ, Dvorak – QWERTY ⌘ and Cyrillic layouts", {
  skip: process.platform !== "darwin", timeout: 120000,
}, async (t) => {
  const source = await read();
  assert.match(source, /guard var code = keys\[key\]/, "the US table stays the fallback");
  const stdout = await run(t, "key-layout", "import Carbon\nimport Foundation\n" + block(source) + US + String.raw`
let cmd: CGEventFlags = .maskCommand
func check(_ name: String, _ translate: KeyLayout.Translate, _ key: String, _ flags: CGEventFlags,
  _ expected: (CGKeyCode, Bool)?) {
  let found = KeyLayout.resolve(key, flags, us: us[key]!, translate)
  precondition(found?.0 == expected?.0 && found?.1 == expected?.1,
    "\(name) \(key) \(flags.rawValue): \(String(describing: found)), not \(String(describing: expected))")
}
// Fixture layouts: the US table's characters with each layout's changes, and
// a keypad that types digits unshifted (as every Mac layout's does).
var usText: [UInt16: String] = [:]
for (key, code) in us { usText[code] = key }
let shiftedDigits = Array(")!@#$%^&*(")
func layout(_ base: [UInt16: String], _ shifted: [UInt16: String] = [:],
  command: [UInt16: String]? = nil) -> KeyLayout.Translate {
  { code, modifiers in
    let keypad: [UInt16: String] = [82: "0", 83: "1", 84: "2", 85: "3", 86: "4", 87: "5", 88: "6", 89: "7", 91: "8", 92: "9"]
    if let digit = keypad[code] { return digit }
    let layer = modifiers & cmdKey != 0 ? command ?? base : base
    let text = layer[code]
    guard modifiers & shiftKey != 0 else { return text }
    if let shifted = shifted[code] { return shifted }
    if let text, let digit = Int(text) { return String(shiftedDigits[digit]) }
    return text?.uppercased()
  }
}
let qwerty = layout(usText)
for key in us.keys {
  check("US", qwerty, key, [], (us[key]!, false))
  check("US", qwerty, key, cmd, (us[key]!, false))
}
var azertyText = usText
for (code, text) in [(0, "q"), (12, "a"), (6, "w"), (13, "z"), (46, ","), (41, "m"),
  (18, "&"), (19, "é"), (20, "\""), (21, "'"), (23, "("), (22, "§"), (26, "è"), (28, "!"), (25, "ç"), (29, "à")]
{ azertyText[UInt16(code)] = text }
var azertyShifted: [UInt16: String] = [:]
for digit in "0123456789" { azertyShifted[us[String(digit)]!] = String(digit) }
let azerty = layout(azertyText, azertyShifted)
check("AZERTY", azerty, "a", [], (12, false))
check("AZERTY", azerty, "a", cmd, (12, false))
check("AZERTY", azerty, "q", cmd, (0, false))
check("AZERTY", azerty, "z", cmd, (13, false))
check("AZERTY", azerty, "w", cmd, (6, false))
check("AZERTY", azerty, "m", cmd, (41, false))
// Digits: Shift for plain typing, never the keypad; ⌘1 is the 1 key alone.
check("AZERTY", azerty, "1", [], (18, true))
check("AZERTY", azerty, "0", [], (29, true))
check("AZERTY", azerty, "1", cmd, nil)
check("AZERTY", azerty, "1", .maskControl, nil)
check("AZERTY", azerty, "1", .maskShift, nil)
var qwertzText = usText
qwertzText[6] = "y"; qwertzText[16] = "z"
let qwertz = layout(qwertzText)
check("QWERTZ", qwertz, "z", [], (16, false))
check("QWERTZ", qwertz, "z", cmd, (16, false))
check("QWERTZ", qwertz, "y", cmd, (6, false))
check("QWERTZ", qwertz, "1", [], (18, false))
var dvorakText: [UInt16: String] = usText
for (code, text) in [(0, "a"), (1, "o"), (2, "e"), (3, "u"), (4, "d"), (5, "i"), (6, ";"), (7, "q"),
  (8, "j"), (9, "k"), (11, "x"), (12, "'"), (13, ","), (14, "."), (15, "p"), (16, "f"), (17, "y"),
  (31, "r"), (32, "g"), (34, "c"), (35, "l"), (37, "n"), (38, "h"), (40, "t"), (45, "b"), (46, "m"),
  (41, "s"), (44, "z"), (43, "w"), (47, "v")]
{ dvorakText[UInt16(code)] = text }
let dvorak = layout(dvorakText, command: usText)
check("Dvorak", dvorak, "c", [], (34, false))
check("Dvorak", dvorak, "c", .maskControl, (34, false))
check("Dvorak", dvorak, "c", cmd, (8, false))
check("Dvorak", dvorak, "v", cmd, (9, false))
check("Dvorak", dvorak, "z", cmd, (6, false))
var cyrillicText = usText
for (key, code) in us where Int(key) == nil { cyrillicText[code] = "ф" }
let cyrillic = layout(cyrillicText, command: usText)
check("Cyrillic", cyrillic, "a", [], nil)
check("Cyrillic", cyrillic, "a", cmd, (0, false))
check("Cyrillic", cyrillic, "c", cmd, (8, false))
check("Cyrillic", cyrillic, "1", [], (18, false))
print("fixture layouts passed")
// Apple's own layouts, read from their key layout data.
let french = KeyLayout.translator(installed("com.apple.keylayout.French"))!
check("French", french, "a", [], (12, false))
check("French", french, "a", cmd, (12, false))
check("French", french, "q", cmd, (0, false))
check("French", french, "z", cmd, (13, false))
check("French", french, "w", [], (6, false))
check("French", french, "m", [], (41, false))
check("French", french, "1", [], (18, true))
check("French", french, "0", [], (29, true))
check("French", french, "1", cmd, nil)
let german = KeyLayout.translator(installed("com.apple.keylayout.German"))!
check("German", german, "z", cmd, (16, false))
check("German", german, "y", [], (6, false))
check("German", german, "1", [], (18, false))
let qwertyCommand = KeyLayout.translator(installed("com.apple.keylayout.DVORAK-QWERTYCMD"))!
check("Dvorak – QWERTY ⌘", qwertyCommand, "c", [], (34, false))
check("Dvorak – QWERTY ⌘", qwertyCommand, "c", cmd, (8, false))
check("Dvorak – QWERTY ⌘", qwertyCommand, "v", cmd, (9, false))
let russian = KeyLayout.translator(installed("com.apple.keylayout.RussianWin"))!
check("Russian", russian, "a", [], nil)
check("Russian", russian, "a", cmd, (0, false))
check("Russian", russian, "c", cmd, (8, false))
// Every letter on these layouts goes to a key that types it.
for (name, translate) in [("French", french), ("German", german), ("Belgian",
  KeyLayout.translator(installed("com.apple.keylayout.Belgian"))!), ("Czech",
  KeyLayout.translator(installed("com.apple.keylayout.Czech"))!)]
{
  for key in "abcdefghijklmnopqrstuvwxyz0123456789".map(String.init) {
    guard let found = KeyLayout.resolve(key, [], us: us[key]!, translate) else {
      preconditionFailure("\(name) \(key) not found")
    }
    let (code, shift) = found
    precondition(!(65...92).contains(code), "\(name) \(key) on the keypad")
    precondition(translate(code, shift ? shiftKey : 0)?.lowercased() == key, "\(name) \(key) at \(code)")
  }
}
print("installed layouts passed")
// This Mac's own layout, whichever it is, through the helper's lookup.
let current = TISCopyCurrentKeyboardLayoutInputSource()!.takeRetainedValue()
let translate = KeyLayout.translator(current)!
let lookup = KeyLayout()
for key in us.keys {
  for flags in [CGEventFlags(), cmd] {
    guard let found = lookup.key(key, flags, us: us[key]!) else { continue }
    let (code, shift) = found
    let modifiers = (flags.contains(.maskCommand) ? cmdKey : 0) | (shift ? shiftKey : 0)
    precondition(translate(code, modifiers)?.lowercased() == key, "current layout \(key) at \(code)")
    precondition(lookup.key(key, flags, us: us[key]!)! == (code, shift), "the lookup is cached")
  }
}
precondition(lookup.key("enter", [], us: 36) == nil && lookup.key("f1", [], us: 122) == nil)
print("current layout passed")
`);
  assert.match(stdout, /fixture layouts passed/);
  assert.match(stdout, /installed layouts passed/);
  assert.match(stdout, /current layout passed/);
});

// The helper's real key action, with each event it would post captured
// instead, and the "current" layout handed in from Apple's installed ones.
test("key actions press the layout's own key, Shift as a real key for AZERTY digits, and follow a layout switch", {
  skip: process.platform !== "darwin", timeout: 120000,
}, async (t) => {
  const source = await read();
  const helper = source.split("@main struct DesktopInput")[0]
    .replaceAll("e?.post(tap: .cghidEventTap)", "posted(e)")
    .replaceAll("$0.post(tap: .cghidEventTap)", "posted($0)")
    .replaceAll("CGEvent(source: nil)?.location", "Optional(CGPoint.zero)");
  assert.doesNotMatch(helper, /\.post\(/, "no event can reach the desktop");
  const stdout = await run(t, "key-action", helper + US + String.raw`
var events: [CGEvent] = []
func posted(_ e: CGEvent?) { if let e { events.append(e) } }
func AXIsProcessTrusted() -> Bool { true }
func CGDisplayIsActive(_ display: CGDirectDisplayID) -> boolean_t { 1 }
var layoutID = "com.apple.keylayout.French"
func TISCopyCurrentKeyboardLayoutInputSource() -> Unmanaged<TISInputSource>? {
  Unmanaged.passRetained(installed(layoutID))
}
let input = Input(1)
// The key pressed and the flags it carried, and the modifier keys pressed
// and released around it.
func press(_ key: String, _ modifiers: [String] = []) -> (code: Int64, flags: CGEventFlags, modifiers: [Int64]) {
  events = []
  _ = try! input.action(["type": "key", "key": key, "modifiers": modifiers])
  let codes = events.map { $0.getIntegerValueField(.keyboardEventKeycode) }
  let modifier = { (e: CGEvent) in [54, 55, 56, 58, 59, 63].contains(e.getIntegerValueField(.keyboardEventKeycode)) }
  let main = events.filter { !modifier($0) }
  precondition(main.count == 2 && main[0].type == .keyDown && main[1].type == .keyUp, "\(key): \(codes)")
  precondition(main[0].getIntegerValueField(.keyboardEventKeycode) == main[1].getIntegerValueField(.keyboardEventKeycode))
  return (main[0].getIntegerValueField(.keyboardEventKeycode), main[0].flags,
    events.filter(modifier).map { $0.getIntegerValueField(.keyboardEventKeycode) })
}
let a = press("a", ["meta"])
precondition(a.code == 12 && a.flags.contains(.maskCommand) && !a.flags.contains(.maskShift), "AZERTY ⌘A selects all")
precondition(a.modifiers == [55, 55])
precondition(press("z", ["meta"]).code == 13, "AZERTY ⌘Z undoes")
precondition(press("q", ["meta"]).code == 0, "AZERTY ⌘Q is its own key")
precondition(press("m").code == 41)
let one = press("1")
precondition(one.code == 18 && one.flags.contains(.maskShift) && one.modifiers == [56, 56], "AZERTY 1 types with Shift held")
let commandOne = press("1", ["meta"])
precondition(commandOne.code == 18 && !commandOne.flags.contains(.maskShift) && commandOne.modifiers == [55, 55])
precondition(press("enter").code == 36 && press("f5").code == 96, "named keys are positions")
// The owner switches layouts: the next key follows.
layoutID = "com.apple.keylayout.German"
precondition(press("z", ["meta"]).code == 16, "QWERTZ ⌘Z")
let germanOne = press("1")
precondition(germanOne.code == 18 && !germanOne.flags.contains(.maskShift) && germanOne.modifiers.isEmpty)
layoutID = "com.apple.keylayout.DVORAK-QWERTYCMD"
precondition(press("c").code == 34 && press("c", ["meta"]).code == 8, "Dvorak – QWERTY ⌘")
layoutID = "com.apple.keylayout.RussianWin"
precondition(press("a").code == 0 && press("c", ["meta"]).code == 8, "Cyrillic: its ⌘ layer, else the US key")
layoutID = "com.apple.keylayout.US"
for key in us.keys { precondition(press(key).code == Int64(us[key]!), "US \(key)") }
print("key actions passed")
`);
  assert.match(stdout, /key actions passed/);
});
