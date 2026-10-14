import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startDom, settle } from "./dom/harness.mjs";
import { DesktopInput } from "../server/desktop-native.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { ScreenControl } from "../server/screen.mjs";

for (const platform of ["darwin", "win32"])
  for (const count of [2, 3])
    test(`${platform}: app commands recover after ${count} temporary context failures`, async (t) => {
      const dom = await startDom();
      t.after(() => dom.close());
      const { useAppContext } = await dom.load("/src/useAppContext.ts");
      const { AppCommandList } = await dom.load("/src/AppCommands.tsx");
      const { contextPicks, allCommands } = await dom.load(
        "/src/app-context.ts",
      );
      const { DesktopInputQueue } = await dom.load(
        "/src/desktop-input-queue.ts",
      );
      const calls = [];
      let context,
        failures = 0,
        currentApp = {
          name: "Google Chrome",
          bundle: platform === "darwin" ? "com.google.Chrome" : "chrome",
        };
      // Exercise the production input queue, helper error translation and server
      // acknowledgements. Only the native process is inert: no OS input is posted.
      const process = Object.assign(new EventEmitter(), {
        pid: 12345,
        alive: true,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: new EventEmitter(),
      });
      process.finish = () => {
        if (process.alive) {
          process.alive = false;
          process.emit("exit", 0);
        }
      };
      process.stdin.end = () => {};
      process.kill = () => {
        process.finish();
        return true;
      };
      process.stdin.write = (line) => {
        const action = JSON.parse(line);
        calls.push(action);
        let result = { ok: true };
        if (action.type === "context") {
          if (failures > 0) {
            failures--;
            // This is Windows' production nonfatal desktop helper error shape.
            result = {
              error:
                "Desktop action failed. Check the selected display and keep Windows unlocked.",
            };
          } else
            result = {
              ok: true,
              app: currentApp,
              stamp: currentApp.bundle,
              items: [],
            };
        }
        queueMicrotask(() => {
          if (process.alive)
            process.stdout.emit(
              "data",
              Buffer.from(JSON.stringify(result) + "\n"),
            );
        });
      };
      const phone = {
        id: "fixture-phone",
        name: "Fixture phone",
        kind: "device",
        scopes: ["admin", "screen"],
      };
      const control = new ScreenControl();
      control.acquire(phone, true);
      let queue;
      const messages = [];
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        send(line) {
          const message = JSON.parse(line);
          messages.push(message);
          if (message.type === "ack") queue.acknowledge(message.id, message);
        },
        close() {
          this.readyState = 2;
        },
      });
      const input = (message) =>
        socket.emit("message", Buffer.from(JSON.stringify(message)), false);
      queue = new DesktopInputQueue(
        (id, action) => input({ type: "input", id, action }),
        (message) => {
          throw Error(message);
        },
      );
      desktopConnection(socket, {
        config: { screen: true },
        auth: { verify: (token) => (token === phone.id ? phone : null) },
        control,
        platform,
        scanner: null,
        create: async () => new DesktopInput(process),
        register() {},
        unregister() {
          return true;
        },
      });
      t.after(async () => {
        queue.close();
        socket.emit("close", 1000);
        process.finish();
        await control.waitForInputStop();
        control.clear();
      });
      input({ type: "auth", token: phone.id, display: "primary" });
      await dom.waitFor(() => messages.some((m) => m.type === "ready"));
      const send = (action) => queue.enqueue(action);
      function ScreenCommands() {
        context = useAppContext(send, true);
        return dom.React.createElement(
          dom.React.Fragment,
          null,
          dom.React.createElement(
            "button",
            {
              "aria-label": "Switch app",
              onClick: async () => {
                await send({
                  type: "key",
                  key: "tab",
                  modifiers: [platform === "darwin" ? "meta" : "alt"],
                });
                await context.refresh();
              },
            },
            "Switch app",
          ),
          context.app &&
            dom.React.createElement(AppCommandList, {
              app: context.app,
              picks: contextPicks(platform, context.app, context.items),
              all: allCommands(platform, context.items),
              disabled: false,
              run() {},
            }),
        );
      }
      const view = await dom.render(dom.React.createElement(ScreenCommands));
      await dom.waitFor(() =>
        view.container.textContent.includes("For Google Chrome"),
      );
      failures = count;
      for (let i = 0; i < count; i++) await context.refresh();
      assert.equal(failures, 0);
      currentApp =
        platform === "darwin"
          ? { name: "TextEdit", bundle: "com.apple.TextEdit" }
          : { name: "Notepad", bundle: "notepad" };
      const before = calls.filter((c) => c.type === "context").length;
      dom.update(() =>
        view.container.querySelector('[aria-label="Switch app"]').click(),
      );
      // Both an explicit post-action refresh and the regular 2.5-second poll
      // have an opportunity to recover while screen control stays enabled.
      await settle(2800);
      const after = calls.filter((c) => c.type === "context").length;
      assert.ok(
        after > before,
        "context reads resume without cycling screen control",
      );
      assert.equal(process.alive, true);
      assert.equal(socket.readyState, 1);
      assert.equal(
        messages.filter((m) => m.type === "ack" && m.ok === false).length,
        count,
      );
      assert.ok(calls.some((c) => c.type === "key"));
      assert.deepEqual(dom.errors, []);
      assert.equal(
        context.app?.name,
        currentApp.name,
        "Recoverable errors must not permanently freeze commands for the old app",
      );
    });

test("unsupported hosts stop context reads until control restarts; temporary errors clear stale commands", async (t) => {
  const dom = await startDom();
  t.after(() => dom.close());
  const { useAppContext } = await dom.load("/src/useAppContext.ts");
  let context,
    toggle,
    failure = "",
    requests = [];
  const send = async (action) => {
    requests.push(action);
    if (failure) throw Error(failure);
    return {
      app: { name: "Chrome", bundle: "chrome" },
      stamp: "fixture",
      items: [{ path: ["File", "New Tab"] }],
    };
  };
  function Probe() {
    const [active, setActive] = dom.React.useState(true);
    toggle = (value) => dom.update(() => setActive(value));
    context = useAppContext(send, active);
    return null;
  }
  await dom.render(dom.React.createElement(Probe));
  await dom.waitFor(() => context.items.length === 1);
  failure = "Temporary refusal";
  await context.refresh();
  await settle();
  assert.equal(context.app, null);
  assert.deepEqual(context.items, []);
  failure = "";
  await context.refresh();
  assert.equal(
    requests.at(-1).since,
    undefined,
    "recovery requests a complete menu",
  );
  await settle();
  assert.equal(context.app.name, "Chrome");
  failure = "Unsupported desktop action.";
  await context.refresh();
  await settle();
  const count = requests.length;
  await context.refresh();
  assert.equal(requests.length, count);
  toggle(false);
  await context.refresh();
  assert.equal(requests.length, count);
  failure = "";
  toggle(true);
  await dom.waitFor(() => context.app?.name === "Chrome");
  assert.equal(requests.length, count + 1);
  assert.deepEqual(dom.errors, []);
});

test("an old context response cannot replace commands after control restarts", async (t) => {
  const dom = await startDom();
  t.after(() => dom.close());
  const { useAppContext } = await dom.load("/src/useAppContext.ts");
  let context,
    toggle,
    resolveOld,
    calls = 0;
  const send = async () => {
    if (++calls === 1)
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    return { app: { name: "Current app", bundle: "current" }, items: [] };
  };
  function Probe() {
    const [active, setActive] = dom.React.useState(true);
    toggle = (value) => dom.update(() => setActive(value));
    context = useAppContext(send, active);
    return null;
  }
  await dom.render(dom.React.createElement(Probe));
  toggle(false);
  toggle(true);
  await dom.waitFor(() => context.app?.name === "Current app");
  resolveOld({
    app: { name: "Old app", bundle: "old" },
    items: [{ path: ["Old", "Command"] }],
  });
  await settle();
  assert.equal(context.app.name, "Current app");
  assert.deepEqual(context.items, []);
  assert.deepEqual(dom.errors, []);
});
