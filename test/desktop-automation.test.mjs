import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopAutomation } from "../server/desktop-automation.mjs";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { ScreenControl } from "../server/screen.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const refused = (work) => assert.rejects(work, error => error.status === 409 && error.kind === "busy" && error.waiting === true);
const known = (options) => {
  const automation = createDesktopAutomation(options);
  automation.noteForeground("com.apple.Safari");
  return automation;
};

test("desktop transactions reserve synchronously and refuse overlapping work without queuing", async () => {
  const automation = known();
  const native = deferred();
  const effects = [];
  const first = automation.run(async guard => {
    guard(); effects.push("switch");
    await native.promise;
    guard(); effects.push("restore");
    return "done";
  });
  await refused(automation.run(() => effects.push("overlap")));
  assert.equal(automation.active(), true);
  assert.deepEqual(effects, ["switch"]);
  native.resolve();
  assert.equal(await first, "done");
  assert.equal(automation.active(), false);
  assert.equal(await automation.run(() => "next"), "next");
  assert.deepEqual(effects, ["switch", "restore"]);
});

test("unknown foreground, unavailable observations and active controls refuse before any transaction", async () => {
  let blocked = false, calls = 0;
  const automation = createDesktopAutomation({ blocked: () => blocked });
  await refused(automation.run(() => calls++));
  automation.noteForeground("com.apple.Safari");
  blocked = true;
  await refused(automation.run(() => calls++));
  blocked = undefined;
  await refused(automation.run(() => calls++));
  automation.noteForeground(null);
  blocked = false;
  await refused(automation.run(() => calls++));
  assert.equal(calls, 0);
  await refused(known({ blocked: () => { throw Error("observation unavailable"); } }).run(() => calls++));
  assert.equal(calls, 0);
});

test("foreground changes invalidate future native steps even after returning to the original app", async () => {
  const automation = known();
  const native = deferred();
  const effects = [];
  const first = automation.run(async guard => {
    guard(); effects.push("switch");
    await native.promise;
    guard(); effects.push("restore");
  });
  const failure = refused(first);
  automation.noteForeground("com.apple.Mail");
  automation.noteForeground("com.apple.Safari");
  native.resolve();
  await failure;
  assert.deepEqual(effects, ["switch"]);
  assert.equal(automation.active(), false);
  assert.equal(await automation.run(guard => { automation.noteForeground("com.apple.Safari"); guard(); return "same"; }), "same");
});

test("completed native work keeps its receipt after interruption and is never replayed", async () => {
  const automation = known();
  const native = deferred();
  let sends = 0, guardAfter;
  const result = automation.run(async guard => {
    guard(); sends++;
    await native.promise;
    guardAfter = guard;
    return { sent: true };
  });
  const stopped = automation.interrupt();
  automation.noteForeground("com.apple.Mail");
  assert.equal(automation.active(), true);
  native.resolve();
  assert.deepEqual(await result, { sent: true });
  await stopped;
  assert.throws(guardAfter, { status: 409 });
  assert.equal(sends, 1);
});

test("phone control interrupts automation and waits for its native transaction before input", async () => {
  const control = new ScreenControl();
  const automation = known({ blocked: () => !!control.holder() || control.inputStopping() });
  control.onAcquire = () => {
    const stopped = automation.interrupt();
    if (stopped) control.retireInput(stopped);
  };
  const phone = { id: "owner", kind: "device", scopes: ["admin"] };
  const native = deferred();
  let restored = false, inputReady = false;
  const transaction = automation.run(async guard => {
    guard(); await native.promise;
    guard(); restored = true;
  });
  const failure = refused(transaction);
  control.acquire(phone, true);
  assert.equal(control.holder().clientId, phone.id);
  assert.equal(control.inputStopping(), true);
  const ready = control.waitForInputStop().then(() => { inputReady = true; });
  await Promise.resolve();
  assert.equal(inputReady, false);
  control.acquire(phone, false);
  native.resolve();
  await failure; await ready;
  assert.equal(restored, false, "releasing phone control does not revive stale restoration");
  assert.equal(control.inputStopping(), false);
  assert.equal(inputReady, true);
});

function desktopWorld() {
  let clock = 1000, screenAnswer = null, inputAnswer = null;
  const clients = new Map(), requests = [], helpers = [];
  const automation = known({ blocked: () => desktop.automationBusy(), now: () => clock });
  const desktop = createAgentDesktop({ screen: true }, {
    available: () => true,
    now: () => clock,
    verifyClient: id => clients.get(id),
    automationControls: () => automation.active() || automation.wanted(),
    screenChangedAt: () => automation.changedAt(),
    spawnHelper: async () => {
      const ended = deferred();
      const helper = {
        stopped: false, terminated: ended.promise, end: ended.resolve,
        async send(request, beforeSend) {
          beforeSend?.(); requests.push(request);
          if (request.op === "shot") return await (screenAnswer?.() || { ok: true, jpeg: Buffer.from([255,216,255]).toString("base64"), width:100, height:100 });
          if (request.op === "elements") return { ok: true, snapshot: "s1", app: "Safari", title: "", items: [], texts: [] };
          if (request.op === "front") return { ok: true, app:"Safari", bundle:"com.apple.Safari" };
          if (request.op === "open" || request.op === "act") return await (inputAnswer?.() || { ok: true, app:"Safari", bundle:"com.apple.Safari" });
          throw Error("Unexpected fixture operation");
        },
        stop() { this.stopped = true; },
      };
      helpers.push(helper); return helper;
    },
  });
  const add = (id = "agent", preset = "full") => {
    const policy = { browser:true, preset, roots:[],
      ...(preset === "apps" ? { apps: [{ id: "/Applications/Safari.app", bundleId: "com.apple.Safari" }] } : {}) };
    const client = { id, kind:"agent", status:"accepted", name:id, policy, scopes:presetScopes(policy), expiresAt:clock+120000 };
    clients.set(id, client); return client;
  };
  return { desktop, automation, add, clients, requests, helpers,
    authorize: client => () => clients.get(client.id), tick: ms => { clock += ms; },
    setScreen: fn => { screenAnswer = fn; }, setInput: fn => { inputAnswer = fn; },
    close() { desktop.close(); for (const helper of helpers) helper.end(); automation.close(); },
  };
}

for (const read of ["screenshot", "front"]) test(`an agent's ${read}s never hold chats' desktop work`, async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add("viewer", "readonly");
  // A live screen asks several times a second, for as long as it's open.
  for (let i = 0; i < 20; i++) { await w.desktop[read](client, w.authorize(client)); w.tick(300); }
  assert.equal(w.desktop.automationBusy(), false);
  assert.equal(w.desktop.activity().holder, null, "looking does not own the cross-agent input lease");
  assert.equal(await w.automation.run(() => "in"), "in");
});

test("an agent looks again before acting once a chat drove the Mac", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add();
  const click = () => w.desktop.act(client, { type: "click", x: 0.5, y: 0.5 }, w.authorize(client));
  await w.desktop.screenshot(client, w.authorize(client));
  w.tick(10);
  // Work that refused before driving the Mac changes nothing on screen.
  await assert.rejects(w.automation.run(() => { throw Object.assign(Error("not yet"), { waiting: true }); }));
  await click();
  w.tick(3000);
  assert.equal(await w.automation.run(guard => { guard(); return "typed"; }), "typed");
  w.tick(10);
  await assert.rejects(click(), error => error.status === 409 && error.stale === true && /Look at the screen again/.test(error.message));
  assert.equal(w.requests.filter(request => request.op === "act").length, 1, "the stale click never reached the Mac");
  await w.desktop.screenshot(client, w.authorize(client));
  await click();
  assert.equal(w.requests.filter(request => request.op === "act").length, 2);
});

test("describing the screen counts as a look, so its labels can be clicked after a chat drove the Mac", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add();
  const click = () => w.desktop.act(client, { type: "click", x: 0.5, y: 0.5 }, w.authorize(client));
  await w.desktop.screenshot(client, w.authorize(client));
  w.tick(10);
  await assert.rejects(w.automation.run(() => { throw Object.assign(Error("not yet"), { waiting: true }); }));
  assert.equal(await w.automation.run(guard => { guard(); return "typed"; }), "typed");
  w.tick(10);
  await assert.rejects(click(), error => error.stale === true);
  w.tick(10);
  await w.desktop.elements(client, w.authorize(client));
  await click();
  assert.equal(w.requests.filter(request => request.op === "act").length, 1);
});

for (const preset of ["apps", "full"]) test(`secret text follows the ${preset} preset's content restrictions`, async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add("agent", preset);
  await w.desktop.screenshot(client, w.authorize(client));
  const scripted = () => w.desktop.act(client, { type: "type", text: "javascript:alert(1)", secret: true }, w.authorize(client));
  if (preset === "apps") await assert.rejects(scripted(), error => error.kind === "blocked");
  else await scripted(); // inert helper: Full control deliberately has no content filter
  assert.equal(w.requests.filter(request => request.op === "act").length, preset === "apps" ? 0 : 1);
  await w.desktop.act(client, { type: "type", text: "hunter2", secret: true }, w.authorize(client));
  assert.equal(w.requests.filter(request => request.op === "act").length, preset === "apps" ? 1 : 2);
});

test("a chat waiting on a busy agent gets the next turn, named", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add("Spicy Llama");
  const click = () => w.desktop.act(client, { type: "click", x: 0.5, y: 0.5 }, w.authorize(client));
  await w.desktop.screenshot(client, w.authorize(client));
  await click();
  await assert.rejects(w.automation.run(() => assert.fail("agent holds the Mac")),
    error => error.kind === "busy" && error.waiting === true && /Spicy Llama is using the Mac/.test(error.message));
  assert.equal(w.automation.wanted(), true);
  // The agent's next click waits instead of renewing its lease forever.
  await assert.rejects(click(), { status: 409, kind: "busy" });
  w.tick(2500);
  assert.equal(w.desktop.automationBusy(), false);
  assert.equal(await w.automation.run(guard => { guard(); return "in"; }), "in");
  assert.equal(w.automation.wanted(), false);
  await w.desktop.screenshot(client, w.authorize(client));
  await click();
});

test("revoked and expired agents hold nothing", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add();
  await w.desktop.front(client, w.authorize(client));
  w.desktop.cancelClient(client.id); w.clients.delete(client.id);
  assert.equal(w.desktop.automationBusy(), false);
  assert.equal(await w.automation.run(() => "free"), "free");
});

test("agent input cannot dispatch during an automation transaction", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add(), native = deferred();
  const transaction = w.automation.run(async guard => { guard(); await native.promise; return "done"; });
  await assert.rejects(w.desktop.open(client, "/Applications/Safari.app", w.authorize(client)), { status:409, kind:"busy" });
  assert.equal(w.requests.some(request => request.op === "open"), false);
  native.resolve(); await transaction;
  await w.desktop.open(client, "/Applications/Safari.app", w.authorize(client));
  assert.equal(w.requests.filter(request => request.op === "open").length, 1);
});

test("a revoked native input keeps automation excluded until actual helper termination", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add(), native = deferred();
  w.setInput(() => native.promise);
  const input = w.desktop.open(client, "/Applications/Safari.app", w.authorize(client));
  const failure = assert.rejects(input, { status:403 });
  while (!w.requests.length) await new Promise(resolve => setImmediate(resolve));
  w.desktop.cancelClient(client.id); w.clients.delete(client.id); w.tick(60000);
  native.resolve({ ok:true, app:"Safari", bundle:"com.apple.Safari" });
  await Promise.resolve(); await Promise.resolve();
  assert.match(w.desktop.automationBusy(), /agent is using the Mac/);
  await refused(w.automation.run(() => assert.fail("helper has not exited")));
  w.helpers[0].end(); await failure;
  assert.equal(w.desktop.automationBusy(), false);
  assert.equal(await w.automation.run(() => "stopped"), "stopped");
});

// Actual server routes and grant state; the menu helper and agent activity are
// inert. The only input request must be rejected before the native entrypoint.
test("server foreground events and phone control share the transaction retirement barrier", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-automation-wiring-"));
  let helper, automation, sessionsAutomation, desktopOptions, observing = false, ownerYields = 0, agentRetirement = null;
  const native = deferred();
  let task, restored = false;
  const reach = await createReach({
    roots:[root], dataDir:path.join(root,"private"), screen:true, appPlatform:"darwin", menuBar:true,
    appDisplays: async ({ onEvent, onExit }) => (helper = { stopped:false, onEvent, onExit, request:async()=>({}), stop:async()=>{} }),
    agentSessionsFactory: options => {
      sessionsAutomation = options.desktopAutomation;
      return { list:async()=>({ sessions:[], errors:{}, projects:{codex:[]}, macPrompts:[] }), listRevision:()=>0, onListChange:()=>()=>{} };
    },
    agentDesktopFactory: (_config, options) => {
      desktopOptions = options;
      return { automationBusy:()=>observing, yieldForOwner:()=>{ ownerYields++; return agentRetirement; }, close() {}, cancelClient() {} };
    },
    desktopAutomationFactory: options => (automation = createDesktopAutomation(options)),
  });
  try {
    await new Promise(resolve => reach.server.listen(0,"127.0.0.1",resolve));
    const owner = reach.auth.issue("Synthetic owner",ALL_SCOPES);
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const post = (route, body) => fetch(url+route,{ method:"POST",headers:{ Authorization:`Bearer ${owner.token}`,"Content-Type":"application/json" },body:JSON.stringify(body) });
    await refused(automation.run(() => assert.fail("foreground is unknown")));
    assert.ok(helper);
    assert.equal(sessionsAutomation, automation, "all Claude paths receive this coordinator");
    assert.equal(desktopOptions.automationControls(), false);
    helper.onEvent({ event:"frontmost",bundle:"com.apple.Safari" });
    assert.equal(await automation.run(() => "ready"), "ready");
    observing = true;
    await refused(automation.run(() => assert.fail("active observer must block background UI")));
    observing = false;
    task = automation.run(async guard => { guard(); await native.promise; guard(); restored = true; });
    const failed = refused(task);
    assert.equal(desktopOptions.automationControls(), true, "agent dispatch consults the same active transaction");
    const grant = await post("/api/screen/control",{ enabled:true });
    assert.equal(grant.status,200);
    assert.equal((await grant.json()).enabled,true);
    assert.equal(ownerYields,1,"owner control retires native agent work through the same server hook");
    const input = await post("/api/screen/input",{ type:"key",key:"a" });
    assert.equal(input.status,409);
    assert.match((await input.json()).error,/previous desktop input helper to stop/);
    const disable = await post("/api/screen/control",{ enabled:false });
    assert.equal(disable.status,200);
    native.resolve(); await failed;
    assert.equal(restored,false);
    assert.equal(await automation.run(() => "released"), "released");
    const agentStopped = deferred(); agentRetirement = agentStopped.promise;
    assert.equal((await post("/api/screen/control",{enabled:true})).status,200);
    assert.equal((await post("/api/screen/input",{type:"key",key:"a"})).status,409,"agent retirement also blocks HTTP native input");
    agentStopped.resolve();
    assert.equal((await post("/api/screen/control",{enabled:false})).status,200);
    assert.equal(await automation.run(()=>"agent exited"),"agent exited");
    helper.onExit();
    await refused(automation.run(() => assert.fail("lost foreground helper must invalidate observation")));
  } finally {
    native.resolve(); await task?.catch(()=>{});
    await reach.close();
    await fs.rm(root,{ recursive:true,force:true });
  }
});

test("an agent looking mid-transaction doesn't stop it", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add("viewer","readonly"), native = deferred();
  let restored = false;
  const task = w.automation.run(async guard => { guard(); await native.promise; guard(); restored = true; return "done"; });
  await w.desktop.front(client, w.authorize(client));
  await w.desktop.screenshot(client, w.authorize(client));
  native.resolve();
  assert.equal(await task, "done");
  assert.equal(restored, true);
});

for (const revoked of [false, true]) test(`phone takeover waits for active agent native exit and ${revoked ? "rechecks a revoked owner grant" : "then enables fresh input"}`, async t => {
  const { EventEmitter } = await import("node:events");
  const { desktopConnection } = await import("../server/desktop-connection.mjs");
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add(), native = deferred();
  w.setInput(() => native.promise);
  const input = w.desktop.open(client, "/Applications/Safari.app", w.authorize(client));
  const failure = assert.rejects(input, { status:503 });
  while (!w.requests.length) await new Promise(resolve => setImmediate(resolve));
  const helper = w.helpers[0];
  helper.stop = () => { helper.stopped = true; native.reject(Object.assign(Error("inert helper stopping"),{status:503})); };
  const control = new ScreenControl();
  control.onAcquire = () => { const terminated = w.desktop.yieldForOwner(); if (terminated) control.retireInput(terminated); };
  const owner = { id:"owner",kind:"device",scopes:["screen","screen:control"] };
  let authorized = owner, creates = 0;
  const ws = Object.assign(new EventEmitter(),{
    readyState:1, sent:[], send(line) { this.sent.push(JSON.parse(line)); },
    close() { this.readyState = 3; },
  });
  t.after(() => { ws.emit("close",1000); control.clear(); });
  control.acquire(owner,true);
  assert.equal(helper.stopped,true);
  assert.equal(control.inputStopping(),true);
  desktopConnection(ws,{
    config:{screen:true},auth:{verify:()=>authorized},control,scanner:null,
    create:async()=>{ creates++; return { send:async()=>({ok:true}),stop() {},terminated:Promise.resolve() }; },
  });
  ws.emit("message",Buffer.from(JSON.stringify({type:"auth",token:"synthetic",display:"primary"})),false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates,0,"phone native helper cannot start while rejected agent request is still stopping");
  assert.equal(ws.sent.some(message=>message.type==="ready"),false);
  await assert.rejects(w.desktop.open(client,"/Applications/Safari.app",w.authorize(client)),{status:409});
  assert.equal(w.requests.filter(request=>request.op==="open").length,1,"no queued/replayed agent action");
  if (revoked) { authorized = null; control.revoke(owner.id); }
  helper.end(); await failure;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates,revoked ? 0 : 1);
  assert.equal(ws.sent.some(message=>message.type==="ready"),!revoked);
});

test("unverifiable agent termination keeps owner input fail-closed", async t => {
  const w = desktopWorld(); t.after(() => w.close());
  const client = w.add(), native = deferred();
  w.setInput(()=>native.promise);
  const input = w.desktop.open(client,"/Applications/Safari.app",w.authorize(client));
  const failure = assert.rejects(input,{status:503});
  while (!w.requests.length) await new Promise(resolve=>setImmediate(resolve));
  const helper = w.helpers[0];
  delete helper.terminated;
  helper.stop = () => { helper.stopped=true; native.reject(Object.assign(Error("inert stopping"),{status:503})); };
  const control = new ScreenControl();
  control.retireInput(w.desktop.yieldForOwner());
  await assert.rejects(control.waitForInputStop(),/termination could not be verified/);
  await failure;
  assert.equal(control.inputStopping(),true);
  control.clear();
  assert.equal(control.inputStopping(),true,"grant cleanup cannot invent a confirmed native exit");
});
