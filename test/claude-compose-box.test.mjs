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

test("right after switching chats, the helper waits for the header to name this chat", () => {
  const guard = between("guard let title = option", 'out(["error": "The Claude app is showing another chat."');
  assert.match(guard, /while window\.titles != \[title\], looks < 8 \{\s*usleep\(250_000\)\s*window = look\(app\)/);
});
