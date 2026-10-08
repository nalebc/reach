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
  const check = between('let known = (payload["expected"]', "text typed on your Mac");
  assert.match(check, /let current = value\(box\)/);
  // Reach's own text, or the start of it (the app can bring back an older,
  // shorter draft of the chat).
  assert.match(check, /known\.contains\(where: \{ current == trimmed\(\$0\) \|\| trimmed\(\$0\)\.hasPrefix\(current\) \}\)\s*\|\| \(!text\.isEmpty && trimmed\(text\)\.hasPrefix\(current\)\)/);
  // No raw comparison of the box's text is left (the draft check and the
  // last look before Send included).
  assert.doesNotMatch(swift, /str\((box|currentBox), kAXValueAttribute\) ==/);
  assert.match(swift, /let currentBox = window\.boxes\.first, value\(currentBox\) == trimmed\(text\)/);
});

test("a draft is read back until the editor shows it, and every text Reach may have left counts as its own", () => {
  // Read once, at once, the editor hadn't shown it yet: "couldn't update this
  // draft", with the draft in the box and Reach unaware it put it there.
  const draft = between('if payload["draft"] as? Bool == true', 'out(["drafted": true])');
  assert.match(draft, /for _ in 0\.\.<20 where value\(box\) != trimmed\(text\) \{ usleep\(50_000\) \}/);
  // The texts Reach may have left come as a list (one string still works).
  assert.match(swift, /let known = \(payload\["expected"\] as\? \[String\]\) \?\? \[\(payload\["expected"\] as\? String\) \?\? ""\]/);
  // The occupied refusal says so, so Reach doesn't count it as maybe typed.
  assert.match(swift, /text typed on your Mac\. Reach won't overwrite it: send or clear it there\.", "draft": true, "length": current\.count\]/);
});

test("all ownership candidates and a maximum message fit in the finite native JSON budget", () => {
  // JSON escapes a control character to six bytes per UTF-16 code unit:
  // nine possible drafts (confirmed + eight uncertain), each at the API's
  // 32k limit, plus a message at its 50k limit. Its escape/plain-text mix
  // also fits the HTTP parser's 256 KiB cap. Do not drop ownership evidence.
  const expected = Array.from({ length: 9 }, (_, i) => String.fromCharCode(i + 16).repeat(32000));
  const text = "\u0001".repeat(40000) + "x".repeat(10000);
  assert.ok(Buffer.byteLength(JSON.stringify({ text })) <= 256 * 1024);
  assert.ok(expected.every((text) => Buffer.byteLength(JSON.stringify({ text })) <= 256 * 1024));
  const bytes = Buffer.byteLength(JSON.stringify({ text, expected, draft: false }));
  const maximum = Number(swift.match(/let composerPayloadLimit = ([0-9_]+)/)?.[1].replaceAll("_", ""));
  assert.ok(bytes > 524288, "regresses the previous cap, with every input within its API limit");
  assert.ok(Number.isSafeInteger(maximum) && maximum <= 4 * 1024 * 1024, "still a finite input budget");
  assert.ok(bytes <= maximum, `all candidates require ${bytes} bytes`);
  const decode = between("func decodeComposerPayload(", "\nfunc attr(");
  assert.match(decode, /guard data\.count <= composerPayloadLimit else \{ return nil \}/);
  assert.match(decode, /JSONSerialization\.jsonObject\(with: data\)/);
  assert.match(swift, /guard let decoded = decodeComposerPayload\(data\)/);
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

test("native permission selection excludes Bypass and uses one session-gated menu item", () => {
  assert.match(swift, /let modeNames = \["Auto", "Manual", "Accept edits", "Plan"\]/);
  const pick = between('if let wanted = option("--mode")', 'if let wanted = option("--effort")');
  assert.match(pick, /guard modeNames\.contains\(wanted\)/);
  assert.doesNotMatch(pick, /Bypass permissions|AXUIElementPerformAction|postToPid/);
  // Check the live session before even opening its menu; never widen modes.
  assert.match(pick, /let current = settingsWindow\(\)/);
  assert.match(pick, /guard settingsPress\(button\)/);
  assert.match(pick, /text == wanted \|\| text\.hasPrefix\(wanted \+ " "\)/);
  assert.match(pick, /guard items\.count == 1 else/);
  assert.match(pick, /guard settingsPress\(items\[0\], selection: true\)/);
  const dispatch = between("func settingsPress(", "func settingsKeys(");
  assert.match(dispatch, /settings\.perform\(sessions: \{ look\(app\)\.sessions \}, selection: selection\)/);
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

test("native permission acknowledgements require the same session and preserve uncertain selection", () => {
  const pick = between('if let wanted = option("--mode")', 'if let wanted = option("--effort")');
  // Both early no-op and post-click success require native session + value.
  const confirmed = /if settings\.confirms\(current\.sessions, matched: current\.modeName == wanted\) \{ out\(\["mode": wanted\]\) \}/g;
  assert.equal([...pick.matchAll(confirmed)].length, 2);
  assert.equal([...pick.matchAll(/out\(\["mode": wanted\]\)/g)].length, 2, "no optimistic success path");
  const afterPress = pick.slice(pick.indexOf("guard settingsPress(items[0], selection: true)"));
  assert.match(afterPress, /usleep\(50_000\)\s*let current = settingsWindow\(\)/);
  assert.match(afterPress, /settingsError\("Claude didn't confirm the permission mode/);
  const gate = between("struct SettingsSessionGate", "// The permission modes");
  assert.match(gate, /guard permits\(sessions\(\)\) else \{ return false \}\s*if selection \{ selectionAttempted = true \}\s*return action\(\)/);
  assert.match(gate, /permits\(sessions\) && matched/);
  const error = between("func settingsError(", "func settingsWindow(");
  assert.match(error, /"unconfirmed": settings\.selectionAttempted/);
});
