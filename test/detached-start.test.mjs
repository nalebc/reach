import test from "node:test";
import assert from "node:assert/strict";
import { detachedWarning } from "../scripts/detached.mjs";

// An agent restarted Reach in the background (nohup) twice: it ran without
// Terminal's screen and control permissions, couldn't take device approvals,
// and the user's own ./reach then refused. Reach now says so in its log.
test("a Mac start with no terminal says what it costs and how to start it", () => {
  const text = detachedWarning({ platform: "darwin", service: false, tty: false });
  assert.match(text, /without a terminal/);
  assert.match(text, /\.\/reach in Terminal/);
});

test("in a terminal, as the background service, or off the Mac: nothing to say", () => {
  assert.equal(detachedWarning({ platform: "darwin", service: false, tty: true }), null);
  assert.equal(detachedWarning({ platform: "darwin", service: true, tty: false }), null);
  assert.equal(detachedWarning({ platform: "linux", service: false, tty: false }), null);
});

// The same on Windows (audit #10): no permissions to name there, but new
// devices are approved in Reach's own window all the same.
test("a Windows start with no window says how to start it in one, in the PC's words", () => {
  const text = detachedWarning({ platform: "win32", service: false, tty: false, command: ".\\reach.cmd" });
  assert.equal(text, "Reach: started without a window. New devices are approved in Reach's own window. Start it with .\\reach.cmd in a terminal, or install background mode with .\\reach.cmd install.");
  assert.doesNotMatch(text, /Terminal's|macOS|\.\/reach/);
  assert.equal(detachedWarning({ platform: "win32", service: true, tty: false }), null);
  assert.equal(detachedWarning({ platform: "win32", service: false, tty: true }), null);
});
