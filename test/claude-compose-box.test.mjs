import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Messages from the phone to a Claude app chat stayed queued, "This chat's
// box in the Claude app has text typed on your Mac", with the box empty: the
// Claude app's empty message box reads "\n" through accessibility, and the
// helper compared that raw. Right after Send now switched to the chat, its
// header could also still name the chat before, failing as "showing another
// chat". The helper needs the Claude app, so this reads its source, as the
// other native helpers' tests do.
const swift = fs.readFileSync(new URL("../scripts/native/claude-compose.swift", import.meta.url), "utf8");
const between = (start, end) => {
  const from = swift.indexOf(start);
  assert.ok(from >= 0, `found ${start}`);
  return swift.slice(from, swift.indexOf(end, from));
};

test("an empty Claude message box (read as a line break) isn't taken for text typed on the Mac", () => {
  // `value` reads the box without the space around its text.
  assert.match(swift, /func value\(_ box: AXUIElement\) -> String \{ str\(box, kAXValueAttribute\)\.trimmingCharacters\(in: \.whitespacesAndNewlines\) \}/);
  const check = between('let expected = (payload["expected"]', "text typed on your Mac");
  assert.match(check, /let current = value\(box\)/);
  assert.match(check, /current == trimmed\(expected\) \|\| \(!text\.isEmpty && current == trimmed\(text\)\)/);
  // No raw comparison of the box's text is left (the draft check and the
  // last look before Send included).
  assert.doesNotMatch(swift, /str\((box|currentBox), kAXValueAttribute\) ==/);
  assert.match(swift, /let currentBox = window\.boxes\.first, value\(currentBox\) == trimmed\(text\)/);
});

test("right after switching chats, the helper waits for the window to show this chat, by its id", () => {
  const guard = between("guard let title = option", 'out(["error": "The Claude app is showing another chat."');
  assert.match(guard, /let showing = \{ \(w: Window\) -> Bool in session\.map \{ w\.sessions == \[\$0\] \} \?\? \(w\.titles == \[title\]\) \}/);
  assert.match(guard, /while !showing\(window\), Date\(\) < until \{\s*usleep\(250_000\)\s*window = look\(app\)/);
});

test("typing a message into the Claude app has no fixed pauses and reads the window in one call per element", () => {
  // Each element's attributes in one call (a walk was ~1/3 slower one by one).
  const look = between("func look(_ app: AXUIElement) -> Window", "\nfunc value(");
  assert.match(look, /AXUIElementCopyMultipleAttributeValues\(e, looked/);
  assert.doesNotMatch(look, /str\(e, kAXRoleAttribute\)/);
  // After the text goes in: no 300 ms pause; Send is looked for at once.
  const send = between("// The text, then a last look", 'out(["sent": true, "unconfirmed": true])');
  assert.doesNotMatch(send, /usleep\(300_000\)/);
  assert.doesNotMatch(send, /usleep\(200_000\)/);
  // The box emptying is read on the box, not by walking the window again.
  const after = send.slice(send.indexOf("AXUIElementPerformAction(send"));
  assert.doesNotMatch(after, /look\(app\)/);
  assert.match(after, /value\(currentBox\)\.isEmpty/);
});

test("the helper picks a permission mode from the Claude app's own menu, and never Bypass permissions", () => {
  assert.match(swift, /let modeNames = \["Auto", "Manual", "Accept edits", "Plan"\]/);
  const pick = between('if let wanted = option("--mode")', 'if args.contains("--stop")');
  assert.match(pick, /guard modeNames\.contains\(wanted\)/);
  // Already in it: nothing is opened.
  assert.match(pick, /if window\.modeName == wanted \{ out\(\["mode": wanted\]\) \}\s*guard AXUIElementPerformAction\(button/);
  // The menu item is the one that starts with the mode's name; then checked.
  assert.match(pick, /text == wanted \|\| text\.hasPrefix\(wanted \+ " "\)/);
  assert.match(pick, /look\(app\)\.modeName == wanted/);
});

test("typing a message into the Claude app has no fixed pauses and reads the window in one call per element", () => {
  // Each element's attributes in one call (a walk was ~1/3 slower one by one).
  const look = between("func look(_ app: AXUIElement) -> Window", "\nfunc value(");
  assert.match(look, /AXUIElementCopyMultipleAttributeValues\(e, looked/);
  assert.doesNotMatch(look, /str\(e, kAXRoleAttribute\)/);
  // After the text goes in: no 300 ms pause; Send is looked for at once.
  const send = between("// The text, then a last look", 'out(["sent": true, "unconfirmed": true])');
  assert.doesNotMatch(send, /usleep\(300_000\)/);
  assert.doesNotMatch(send, /usleep\(200_000\)/);
  // The box emptying is read on the box, not by walking the window again.
  const after = send.slice(send.indexOf("AXUIElementPerformAction(send"));
  assert.doesNotMatch(after, /look\(app\)/);
  assert.match(after, /value\(currentBox\)\.isEmpty/);
});

test("the helper picks a permission mode from the Claude app's own menu, and never Bypass permissions", () => {
  assert.match(swift, /let modeNames = \["Auto", "Manual", "Accept edits", "Plan"\]/);
  const pick = between('if let wanted = option("--mode")', 'if args.contains("--stop")');
  assert.match(pick, /guard modeNames\.contains\(wanted\)/);
  // Already in it: nothing is opened.
  assert.match(pick, /if window\.modeName == wanted \{ out\(\["mode": wanted\]\) \}\s*guard AXUIElementPerformAction\(button/);
  // The menu item is the one that starts with the mode's name; then checked.
  assert.match(pick, /text == wanted \|\| text\.hasPrefix\(wanted \+ " "\)/);
  assert.match(pick, /look\(app\)\.modeName == wanted/);
});
