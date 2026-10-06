import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserScreenSnapshots } from "../server/browser-screen.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("HTTP snapshots reuse one native startup, take a new frame each time, then stop when idle", async () => {
  let starts = 0,
    stops = 0,
    frames = 0;
  const commands = [];
  const snapshots = new BrowserScreenSnapshots(
    async () => () => {
      starts++;
      return {
        next: async (command) => {
          commands.push(command);
          return Buffer.from(`frame-${++frames}`);
        },
        stop: () => stops++,
      };
    },
    { idleMs: 25 },
  );
  try {
    for (let i = 1; i <= 12; i++)
      assert.equal(
        (await snapshots.capture(() => {})).toString(),
        `frame-${i}`,
      );
    assert.equal(
      starts,
      1,
      "twelve refreshes pay the helper startup cost once",
    );
    assert.equal(frames, 12, "the speedup does not reuse stale JPEGs");
    assert.deepEqual(commands, Array(12).fill("key"));
    await sleep(45);
    assert.equal(stops, 1);
    assert.equal(snapshots.source, null);
    assert.equal((await snapshots.capture(() => {})).toString(), "frame-13");
    assert.equal(starts, 2);
  } finally {
    snapshots.stop();
  }
});

test("simultaneous HTTP viewers share a frame operation but authorize independently before delivery", async () => {
  const frame = deferred();
  let captures = 0;
  let allowed = true;
  const snapshots = new BrowserScreenSnapshots(async () => () => ({
    next: () => {
      captures++;
      return frame.promise;
    },
    stop() {},
  }));
  try {
    const revoked = snapshots.capture(() => {
      if (!allowed) throw Error("revoked");
    });
    const active = snapshots.capture(() => {});
    await sleep(0);
    allowed = false;
    frame.resolve(Buffer.from("private fixture"));
    // The first viewer also owns the pre-capture check; no denied reader gets
    // a frame, even if that means a valid concurrent reader needs to refresh.
    await assert.rejects(revoked, /revoked/);
    await assert.rejects(active, /revoked/);
    assert.equal(captures, 1);
  } finally {
    snapshots.stop();
  }
});

test("a revoked secondary viewer cannot receive a shared result", async () => {
  const frame = deferred();
  let allowed = true;
  const snapshots = new BrowserScreenSnapshots(async () => () => ({
    next: () => frame.promise,
    stop() {},
  }));
  try {
    const active = snapshots.capture(() => {});
    const revoked = snapshots.capture(() => {
      if (!allowed) throw Error("revoked");
    });
    await sleep(0);
    allowed = false;
    frame.resolve(Buffer.from("private fixture"));
    assert.equal((await active).toString(), "private fixture");
    await assert.rejects(revoked, /revoked/);
  } finally {
    snapshots.stop();
  }
});

test("pause or shutdown during preparation cancels readers and never starts a helper later", async () => {
  const prepared = deferred();
  let starts = 0,
    fallback = 0;
  const snapshots = new BrowserScreenSnapshots(() => prepared.promise, {
    fallback: async () => {
      fallback++;
      return Buffer.from("fallback");
    },
  });
  const pending = snapshots.capture(() => {});
  snapshots.stop("Paused");
  await assert.rejects(pending, /Paused/);
  prepared.resolve(() => {
    starts++;
    return { next: async () => Buffer.from("never"), stop() {} };
  });
  await sleep(0);
  assert.equal(starts, 0);
  assert.equal(fallback, 0);
});

test("an old preparation timeout cannot stop the helper created after resume", async () => {
  const oldPreparation = deferred();
  let preparations = 0,
    starts = 0,
    stops = 0;
  const source = {
    next: async () => Buffer.from("new-session-frame"),
    stop: () => stops++,
  };
  const snapshots = new BrowserScreenSnapshots(
    () => {
      if (++preparations === 1) return oldPreparation.promise;
      return Promise.resolve(() => {
        starts++;
        return source;
      });
    },
    { timeoutMs: 20, idleMs: 1000 },
  );
  try {
    const previous = snapshots.capture(() => {});
    snapshots.stop("Paused");
    await assert.rejects(previous, /Paused/);
    assert.equal(
      (await snapshots.capture(() => {})).toString(),
      "new-session-frame",
    );
    await sleep(45);
    assert.equal(
      stops,
      0,
      "a cancelled generation must not stop the resumed helper",
    );
    assert.equal(snapshots.source, source);
    oldPreparation.resolve(() => {
      starts++;
      return source;
    });
    await sleep(0);
    assert.equal(
      starts,
      1,
      "the cancelled preparation must not start a late helper",
    );
    assert.equal(
      (await snapshots.capture(() => {})).toString(),
      "new-session-frame",
    );
    assert.equal(stops, 0);
  } finally {
    snapshots.stop();
  }
});

test("stopping during a native frame discards it and does not fall back", async () => {
  const frame = deferred();
  let stops = 0,
    fallback = 0;
  const snapshots = new BrowserScreenSnapshots(
    async () => () => ({
      next: () => frame.promise,
      stop: () => stops++,
    }),
    {
      fallback: async () => {
        fallback++;
        return Buffer.from("fallback");
      },
    },
  );
  const pending = snapshots.capture(() => {});
  await sleep(0);
  snapshots.stop("Screen access was turned off.");
  await assert.rejects(pending, /turned off/);
  frame.resolve(Buffer.from("must stay on host"));
  await sleep(0);
  assert.equal(stops, 1);
  assert.equal(fallback, 0);
});

test("native failure falls back without repeating helper startup on every refresh", async () => {
  let now = 1000,
    starts = 0,
    fallback = 0,
    stops = 0;
  const snapshots = new BrowserScreenSnapshots(
    async () => () => {
      starts++;
      return {
        next: async () => {
          throw Error("native unavailable");
        },
        stop: () => stops++,
      };
    },
    {
      now: () => now,
      fallback: async () => Buffer.from(`fallback-${++fallback}`),
    },
  );
  try {
    assert.equal((await snapshots.capture(() => {})).toString(), "fallback-1");
    assert.equal((await snapshots.capture(() => {})).toString(), "fallback-2");
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    now += 30001;
    assert.equal((await snapshots.capture(() => {})).toString(), "fallback-3");
    assert.equal(starts, 2);
  } finally {
    snapshots.stop();
  }
});

test("slow native preparation times out, uses a checked fallback, and cannot start a late helper", async () => {
  const prepared = deferred();
  let starts = 0;
  const snapshots = new BrowserScreenSnapshots(() => prepared.promise, {
    timeoutMs: 20,
    fallback: async () => Buffer.from("fallback"),
  });
  const keepingTestAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await snapshots.capture(() => {})).toString(), "fallback");
    prepared.resolve(() => {
      starts++;
      return { next: async () => Buffer.from("late"), stop() {} };
    });
    await sleep(0);
    assert.equal(starts, 0);
  } finally {
    clearTimeout(keepingTestAlive);
    snapshots.stop();
  }
});

test("native unchanged markers and oversized frames are never served as screen JPEGs", async () => {
  for (const frame of [Buffer.from([0]), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    let stops = 0;
    const snapshots = new BrowserScreenSnapshots(async () => () => ({
      next: async () => frame,
      stop: () => stops++,
    }));
    await assert.rejects(
      snapshots.capture(() => {}),
      /too large or unavailable/,
    );
    assert.equal(stops, 1);
    snapshots.stop();
  }
});

test("only browser viewing uses the warm helper; approval evidence and execution use fresh full captures", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "reach-browser-screen-"),
  );
  let starts = 0,
    stops = 0,
    frames = 0,
    fullCaptures = 0,
    inputs = 0;
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    screen: true,
    browserScreenSupported: true,
    desktopTerminals: {
      platform: "linux",
      run: async () => assert.fail("No native terminal access"),
    },
    browserScreenFactory: async () => () => {
      starts++;
      return {
        next: async () => Buffer.from(`view-${++frames}`),
        stop: () => stops++,
      };
    },
    browserCapture: async () => {
      fullCaptures++;
      return Buffer.from("full-resolution-approval-fixture");
    },
    browserInput: async (_config, _payload, authorize) => {
      authorize();
      inputs++;
      return { ok: true };
    },
  });
  t.after(async () => {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const invite = reach.auth.inviteBrowser({
    name: "Muse",
    folders: [],
    terminalIds: [],
    screen: "ask",
    ttlSeconds: 600,
  });
  const agent = admitAgent(reach.auth, invite.invitation);
  const request = (
    route,
    token = agent.token,
    body,
    method = body ? "POST" : "GET",
  ) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  for (let i = 1; i <= 3; i++) {
    const image = await request("/api/browser/screen");
    assert.equal(image.status, 200);
    assert.equal(await image.text(), `view-${i}`);
  }
  assert.equal(starts, 1);
  assert.equal(fullCaptures, 0);
  const submitted = await request("/api/browser/requests", agent.token, {
    type: "click",
    x: 0.25,
    y: 0.5,
    button: "left",
    count: 1,
    reason: "Open a fixture",
  });
  assert.equal(submitted.status, 201);
  const action = await submitted.json();
  const evidence = await request(
    `/api/agents/browser-requests/${action.id}/screen`,
    owner.token,
  );
  assert.equal(await evidence.text(), "full-resolution-approval-fixture");
  assert.equal(fullCaptures, 1);
  const approved = await request(
    `/api/agents/browser-requests/${action.id}`,
    owner.token,
    { decision: "approve" },
  );
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "executed");
  assert.equal(fullCaptures, 2);
  assert.equal(inputs, 1);
  assert.equal(frames, 3);
  const paused = await request("/api/settings/pause", owner.token, {
    paused: true,
  });
  assert.equal(paused.status, 200);
  assert.equal(stops, 1);
  assert.equal((await request("/api/browser/screen")).status, 423);
  assert.equal(starts, 1);
  await request("/api/settings/pause", owner.token, { paused: false });
  assert.equal((await request("/api/browser/screen")).status, 200);
  assert.equal(starts, 2);
  await request("/api/settings", owner.token, { screen: false });
  assert.equal(stops, 2);
  assert.equal((await request("/api/browser/screen")).status, 403);
  await request("/api/settings", owner.token, { screen: true });
  assert.equal((await request("/api/browser/screen")).status, 200);
  assert.equal(starts, 3);
  await request(
    `/api/clients/${agent.clientId}`,
    owner.token,
    undefined,
    "DELETE",
  );
  assert.equal(stops, 3);
  assert.equal((await request("/api/browser/screen")).status, 401);
});
