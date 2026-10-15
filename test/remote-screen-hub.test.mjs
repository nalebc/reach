import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteBroadcast,
  RemoteScreenHub,
  sentKeyframe,
  privateWindows,
  privateViewRefusal,
  videoFor,
} from "../server/remote-screen.mjs";
import { createWindowsGuestScreen, GUEST_CHECKING, guestRefusal, guestRules } from "../server/windows-guest-screen.mjs";
import { NativeScreenSource } from "../server/screen-stream.mjs";

// The live screen's server side, with fake capture sources: no real screen
// is captured here.
const until = async (check, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const socket = () => {
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send: (m) => ws.sent.push(m),
    close() {
      ws.readyState = 3;
    },
  };
  return ws;
};
const json = (ws) =>
  ws.sent.filter((m) => typeof m === "string").map((m) => JSON.parse(m));
const binary = (ws) => ws.sent.filter((m) => Buffer.isBuffer(m));
const video = (key) => {
  const meta = Buffer.from(JSON.stringify({ key, timestamp: 0, width: 2, height: 2, codec: "avc1.64002a" }));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(meta.length);
  return Buffer.concat([head, meta, Buffer.from([0, 0, 0, 1, 9])]);
};

test("a frame clears a viewer's keyframe request only when it was a keyframe", async () => {
  assert.equal(sentKeyframe(video(true), "h264"), true);
  assert.equal(sentKeyframe(video(false), "h264"), false);
  assert.equal(sentKeyframe(Buffer.from("garbled"), "h264"), false);
  assert.equal(sentKeyframe(Buffer.from([0xff, 0xd8, 1]), "jpeg"), true);
  const commands = [];
  // The encoder answers the first "key" with a delta (it was mid-frame).
  const answers = [video(false), video(true), video(false), video(false)];
  const group = new RemoteBroadcast(
    async () => () => ({
      next: async (c) => {
        commands.push(c);
        return answers.shift() ?? Buffer.from([0]);
      },
      stop() {},
    }),
    { fps: 60, format: "h264", quality: "high", bitrate: 1e6 },
  );
  const ws = socket();
  group.add(ws, () => true);
  await until(() => commands.length >= 4);
  group.remove(ws);
  // Still waiting for a keyframe after the delta: asked again.
  assert.deepEqual(commands.slice(0, 3), ["key", "key", "frame"]);
});

test("a stale group never frees the key a newer group holds, and empties once", async () => {
  let stops = 0;
  const hub = new RemoteScreenHub({}, async () => () => ({
    next: async () => video(true),
    stop: () => stops++,
  }));
  const first = socket();
  await hub.add(first, () => true, { display: "1", format: "h264" });
  const [key] = hub.groups.keys();
  const stale = hub.groups.get(key);
  let empties = 0;
  const onEmpty = stale.onEmpty;
  stale.onEmpty = () => {
    empties++;
    onEmpty();
  };
  await until(() => binary(first).length > 0);
  // The group drops its viewer itself (stopped responding): the hub still
  // maps the socket to it until the socket closes.
  stale.fail(first, "Screen viewer stopped responding.");
  assert.equal(hub.groups.has(key), false);
  const second = socket();
  await hub.add(second, () => true, { display: "1", format: "h264" });
  const fresh = hub.groups.get(key);
  assert.notEqual(fresh, stale);
  await until(() => binary(second).length > 0);
  // The first socket's close arrives late: the stale group stays quiet.
  hub.remove(first);
  stale.remove(first);
  assert.equal(empties, 1);
  assert.equal(hub.groups.get(key), fresh);
  // A stale onEmpty that still runs can't take the newer group's key either.
  onEmpty();
  assert.equal(hub.groups.get(key), fresh);
  hub.remove(second);
  assert.equal(hub.groups.has(key), false);
  assert.equal(stops, 2);
});

test("a display that isn't shared with this viewer is refused, with a reason", async () => {
  let started = 0;
  const hub = new RemoteScreenHub({}, async () => {
    started++;
    return () => ({ next: async () => video(true), stop() {} });
  });
  const ws = socket();
  await assert.rejects(
    hub.add(ws, () => true, { display: "901", format: "h264" }, {
      mayViewDisplay: (id) => id !== "901",
    }),
    (e) => e.status === 403 && /isn't shared with you/.test(e.message),
  );
  assert.equal(hub.viewers.size, 0, "the reservation is freed");
  assert.equal(started, 0);
  // Becoming an app's display mid-stream ends it, named, not silently.
  let shared = true;
  const viewer = socket();
  await hub.add(viewer, () => true, { display: "2", format: "h264" }, {
    mayViewDisplay: () => shared,
  });
  await until(() => binary(viewer).length > 0);
  shared = false;
  await until(() => viewer.readyState === 3);
  const error = json(viewer).find((m) => m.type === "error");
  assert.equal(error.retryable, false);
  assert.match(error.error, /isn't shared with you/);
  hub.remove(viewer);
});

test("a sleeping Mac's helper answers why; viewers hear it, keep waiting, and get a keyframe after", async () => {
  // A fake helper: a length-prefixed answer per request line. A picture,
  // then asleep, then locked, then pictures again.
  const script = `
    let n = 0;
    const out = (b) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); process.stdout.write(Buffer.concat([h, b])); };
    require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
      n++;
      process.stderr.write(line + "\\n");
      if (n === 2) out(Buffer.from([1]));
      else if (n === 3) out(Buffer.from([2]));
      else out(Buffer.from(line === "key" ? "KEYFRAME" : "delta"));
    });`;
  const lines = [];
  const group = new RemoteBroadcast(
    async () => () => {
      const source = new NativeScreenSource(process.execPath, ["-e", script]);
      source.child.stderr.on("data", (b) => lines.push(...b.toString().split("\n").filter(Boolean)));
      return source;
    },
    { fps: 60, format: "jpeg", quality: "high", bitrate: 1e6 },
  );
  const ws = socket();
  const started = Date.now();
  group.add(ws, () => true);
  await until(() => binary(ws).length > 1, 8000);
  const elapsed = Date.now() - started;
  group.remove(ws);
  const statuses = json(ws).filter((m) => m.type === "status").map((m) => m.idle);
  assert.deepEqual(statuses, ["asleep", "locked", ""]);
  assert.equal(group.idle, "");
  // Asked about once a second while there's nothing to show, not 60 times.
  assert.ok(elapsed >= 1800, `took ${elapsed} ms`);
  assert.deepEqual(lines.slice(0, 4), ["key", "frame", "key", "key"]);
  assert.deepEqual(
    binary(ws).slice(0, 2).map((p) => p.subarray(4).toString()),
    ["KEYFRAME", "KEYFRAME"],
    "the first picture after waking is a keyframe",
  );
  assert.equal(json(ws).some((m) => m.type === "error"), false);
});

test("a guest's picture is its own stream that leaves out private windows; the owner's is unchanged", async () => {
  const prepared = [];
  const hub = new RemoteScreenHub({}, async (options, extra) => {
    prepared.push(extra.privateView);
    return () => ({ next: async () => video(true), stop() {} });
  });
  const owner = socket(),
    guest = socket();
  await hub.add(owner, () => true, { display: "1", format: "h264" });
  await hub.add(guest, () => true, { display: "1", format: "h264" }, { privateView: true, platform: "darwin" });
  await until(() => binary(owner).length > 0 && binary(guest).length > 0);
  assert.equal(hub.groups.size, 2);
  assert.deepEqual(prepared, [false, true]);
  // The ready message is the same for both: the setting stays server-side.
  const ready = (ws) => json(ws).find((m) => m.type === "ready");
  assert.deepEqual(ready(guest), ready(owner));
  hub.remove(owner);
  hub.remove(guest);
  // What the Mac helper is told to leave out: the agents' lists, which its
  // decoder reads as four lists of words.
  const rules = JSON.parse(privateWindows());
  assert.deepEqual(Object.keys(rules).sort(), ["ids", "names", "titles", "words"]);
  for (const list of Object.values(rules))
    assert.ok(list.length && list.every((w) => typeof w === "string" && w === w.toLowerCase()));
  assert.ok(rules.ids.includes("com.1password"));
  assert.ok(rules.words.includes("reach"));
});

// Windows paints a guest's private windows black (server/windows-guest-screen.mjs):
// once its check passed, a guest's stream is its own, as on a Mac; before it
// (or when it failed) the guest is refused with why, before anything is
// captured, and the owner's still streams.
test("on Windows a guest's picture is its own stream once Reach can hide private windows; refused with why before then, nothing captured; the owner's still streams", async () => {
  const prepared = [];
  let check = null;
  const guestScreen = {
    probe: async () => check,
    refusal: () => (check?.ok ? "" : check ? guestRefusal(check.why) : GUEST_CHECKING),
  };
  const hub = new RemoteScreenHub(
    {},
    async (options, extra) => {
      prepared.push(extra.privateView);
      return () => ({ next: async () => video(true), stop() {} });
    },
    { guestScreen },
  );
  const owner = socket(),
    guest = socket();
  // Still checking: try again (503); failed: no (403), with the helper's words.
  await assert.rejects(
    hub.add(guest, () => true, { display: "1", format: "h264" }, { privateView: true, platform: "win32" }),
    (e) => e.status === 503 && e.message === GUEST_CHECKING,
  );
  check = { ok: false, why: "Screen capture could not hide private windows. Windows wouldn't list every window." };
  await assert.rejects(
    hub.add(guest, () => true, { display: "1", format: "h264" }, { privateView: true, platform: "win32" }),
    (e) => e.status === 403 && /^Only this PC's owner can watch or control its screen right now: Screen capture could not hide private windows\./.test(e.message),
  );
  assert.equal(hub.viewers.size, 0, "no viewer slot is held");
  await hub.add(owner, () => true, { display: "1", format: "h264" }, { platform: "win32" });
  await until(() => binary(owner).length > 0);
  assert.deepEqual(prepared, [false]);
  assert.equal(binary(guest).length, 0);
  check = { ok: true };
  await hub.add(guest, () => true, { display: "1", format: "h264" }, { privateView: true, platform: "win32" });
  await until(() => binary(guest).length > 0);
  assert.deepEqual(prepared, [false, true]);
  assert.equal(hub.groups.size, 2, "the guest's own group: the owner's picture is unchanged");
  // Without a check at all (a Windows Reach on a host that has none): no.
  assert.equal(privateViewRefusal(true, "darwin"), "");
  assert.equal(privateViewRefusal(false, "win32"), "");
  assert.match(privateViewRefusal(true, "win32"), /owner can watch or control/);
  assert.equal(privateViewRefusal(true, "win32", guestScreen), "");
  hub.remove(owner);
  hub.remove(guest);
});

test("a guest's Windows check: the helper verified, told the rules on stdin and Reach's process; its words when it can't; tried again a few minutes later", async () => {
  let at = 0;
  const runs = [];
  const verified = [];
  let answer = { stdout: '{"windows":42,"hidden":2,"ms":9}\n' };
  const said = [];
  const started = [];
  const g = createWindowsGuestScreen({
    helper: async () => ({ file: "C:\\Reach\\native\\reach-screen-video-abc.exe", sha256: "f".repeat(64) }),
    rules: () => ({ mode: "view", protectedAppNames: ["1password"] }),
    verify: (file, sha) => verified.push([file, sha]),
    run: async (file, args, input) => {
      runs.push({ file, args, input });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    start: (file, args, input) => {
      const source = { file, args, input, onExit: null };
      started.push(source);
      return source;
    },
    processId: 4242,
    now: () => at,
    log: (line) => said.push(line),
  });
  assert.equal(g.refusal(), GUEST_CHECKING, "unknown: refused, and the check starts");
  assert.deepEqual(await g.probe(), { ok: true, windows: 42, ms: 9, at: 0 });
  assert.equal(g.refusal(), "");
  assert.deepEqual(runs, [{ file: "C:\\Reach\\native\\reach-screen-video-abc.exe", args: ["--probe-private", "4242"], input: '{"mode":"view","protectedAppNames":["1password"]}\n' }]);
  assert.deepEqual(verified, [["C:\\Reach\\native\\reach-screen-video-abc.exe", "f".repeat(64)]]);
  // A stream: the display, rate, width and bitrate, then --private and
  // Reach's process; still images add --stills. The rules go first on stdin.
  const stills = (await g.source({ display: "DISPLAY2", fps: 15, width: 1600, bitrate: 6000000, format: "jpeg" }))();
  const video = (await g.source({ display: "primary", fps: 30, width: 1920, bitrate: 8000000, format: "h264" }))();
  assert.deepEqual(stills.args, ["DISPLAY2", "15", "1600", "6000000", "--private", "4242", "--stills"]);
  assert.deepEqual(video.args, ["primary", "30", "1920", "8000000", "--private", "4242"]);
  assert.equal(stills.input, '{"mode":"view","protectedAppNames":["1password"]}\n');
  assert.equal(verified.length, 3, "checked unchanged right before each start");
  // A stream whose helper gave up hiding them: the next guest is refused, with why.
  video.onExit(1, Error("Screen capture could not hide private windows. Windows wouldn't list every window."));
  assert.match(g.refusal(), /right now: Screen capture could not hide private windows\. Windows wouldn't list every window\.$/);
  stills.onExit(1, Error("Video stopped."));
  // Failing: the helper's own words, said once, and asked again later.
  const heard = [];
  const failing = createWindowsGuestScreen({
    helper: async () => ({ file: "x.exe", sha256: "0" }),
    verify: () => {},
    run: async () => {
      throw Object.assign(Error("exit 1"), { code: 1, stderr: "note: something on the way\nScreen capture could not hide private windows. Windows didn't start Reach's agent helper with the screen's own scale, so it can't place clicks on this PC.\n" });
    },
    now: () => at,
    log: (line) => heard.push(line),
  });
  const failed = await failing.probe();
  assert.equal(failed.ok, false);
  assert.equal(failed.why, "Screen capture could not hide private windows. Windows didn't start Reach's agent helper with the screen's own scale, so it can't place clicks on this PC.");
  assert.equal(failing.refusal(), `Only this PC's owner can watch or control its screen right now: ${failed.why}`);
  assert.equal(heard.length, 1);
  at += 5 * 60 * 1000;
  failing.refusal();
  await failing.probe();
  assert.equal(heard.length, 1, "the same reason isn't said twice");
  // No helper (Reach's folders aren't private): refused, with that reason.
  const none = createWindowsGuestScreen({ off: "Reach couldn't make its folders private on this PC.", now: () => at, log: () => {} });
  assert.equal((await none.probe()).why, "Reach couldn't make its folders private on this PC.");
});

test(
  "the Mac helper refuses to stream unfiltered when it can't read what to hide",
  { skip: !process.env.REACH_TEST_VIDEO_HELPER, timeout: 20000 },
  async () => {
    // Exits before any capture starts: no screen is read.
    const source = new NativeScreenSource(process.env.REACH_TEST_VIDEO_HELPER, [
      "1", "h264", "30", "640", "1000000", "auto", "", "{not json",
    ]);
    const error = await source.next().catch((e) => e);
    assert.match(error.message, /Invalid privacy rules/);
  },
);

test("the first protocol's shared Mac picture leaves out private windows for everyone on it", async () => {
  // No phone of the owner's speaks it any more; a guest still could.
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../server/screen-stream.mjs", import.meta.url), "utf8");
  const create = source.slice(source.indexOf("export async function createScreenSource"));
  assert.match(
    create,
    /new NativeScreenSource\(binary, \[\s*"primary",\s*"jpeg",\s*"15",\s*"1600",\s*"6000000",\s*"auto",\s*"",\s*privateWindows\(\),\s*\]\)/,
  );
  // A Windows PC's too: still images painted by its own helper, none until
  // it's known to make them; never screen-stream.ps1's plain pictures.
  const windows = create.slice(create.indexOf('platform === "win32"'));
  assert.match(windows, /guestScreen\.probe\(\)/);
  assert.match(windows, /guestScreen\.source\(\{ display: "primary", format: "jpeg", fps: 15, width: 1600, bitrate: 6000000 \}\)/);
  assert.doesNotMatch(create, /screen-stream\.ps1/);
});

// What a guest's picture hides on Windows is what a View agent never sees
// there: the agent guard's Windows lists, as data for agent-desktop.cs's own
// reading (built into the video helper), with Reach's names and addresses.
test("a Windows guest's picture hides what a View agent never sees: the Windows lists, Reach's names and addresses", () => {
  const rules = guestRules({ hosts: ["reach-pc.tail1234.ts.net"], titles: ["reach"] });
  assert.equal(rules.mode, "view");
  for (const name of ["1password", "bitwarden", "keepass", "credential manager", "task manager"]) assert.ok(rules.protectedAppNames.includes(name), name);
  assert.ok(rules.protectedAppIds.includes("8bitsolutionsllc.bitwardendesktop"));
  assert.ok(rules.protectedTitleWords.includes("password manager"));
  assert.ok(rules.reachWords.includes("reach") && rules.reachWords.includes("tailscale"));
  assert.ok(rules.titles.includes("reach"));
  assert.deepEqual(rules.hosts, ["reach-pc.tail1234.ts.net"]);
  assert.deepEqual(rules.hiddenApps, []);
});

// FFmpeg's video can't hide a window: a Windows guest gets still images
// (painted) instead, with why; the owner's choice is unchanged.
test("on Windows a guest never gets FFmpeg's video: still images instead, with why", async () => {
  const choose = async () => ({ source: "ffmpeg", label: "H.264 by FFmpeg", why: "No encoder. FFmpeg makes the video instead.", reason: "No encoder." });
  assert.deepEqual(await videoFor("h264", { platform: "win32", choose, privateView: true }), {
    format: "jpeg", source: "jpeg", label: "Still images", why: "No encoder. Until then, the screen comes as still images.",
  });
  assert.equal((await videoFor("h264", { platform: "win32", choose })).source, "ffmpeg");
  const own = async () => ({ source: "windows", file: "x.exe", label: "H.264", why: "" });
  assert.equal((await videoFor("h264", { platform: "win32", choose: own, privateView: true })).format, "h264");
});
