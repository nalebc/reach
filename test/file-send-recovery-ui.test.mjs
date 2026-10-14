import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { startDom } from "./dom/harness.mjs";
import { NodeXHR } from "./helpers/transfer-harness.mjs";

const nodeFetch = globalThis.fetch;
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");

for (const scenario of [
  "success",
  "destination-missing",
  "destination-session-missing",
  "source-missing",
])
  test(`file send recovery: ${scenario}`, async (t) => {
    const missingDestination = scenario.startsWith("destination-");
    const missingSource = scenario === "source-missing";
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "reach-file-send-recovery-"),
    );
    const computers = [];
    let dom;
    const originalXHR = globalThis.XMLHttpRequest;
    t.after(async () => {
      await dom?.close();
      globalThis.fetch = nodeFetch;
      globalThis.XMLHttpRequest = originalXHR;
      for (const c of computers) await c.reach.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    for (const id of ["source", "destination"]) {
      const root = path.join(temporary, id, "shared");
      fs.mkdirSync(root, { recursive: true });
      const reach = await createReach({
        roots: [root],
        dataDir: path.join(temporary, id, "private"),
        fileIcons: async () => null,
      });
      await new Promise((resolve) =>
        reach.server.listen(0, "127.0.0.1", resolve),
      );
      const owner = reach.auth.issue("bug bash fixture owner", ALL_SCOPES);
      computers.push({
        root,
        reach,
        peer: {
          id,
          name: id,
          platform: process.platform,
          token: owner.token,
          url: `http://127.0.0.1:${reach.server.address().port}`,
        },
      });
    }
    const [source, destination] = computers;
    const originalBytes = Buffer.from(
      "Bug bash fixture file. Source must stay available.\n",
    );
    const sourceFile = path.join(source.root, "original.txt");
    fs.writeFileSync(sourceFile, originalBytes);
    if (scenario === "destination-missing") fs.rmdirSync(destination.root);
    dom = await startDom();
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    const calls = [],
      messages = [];
    globalThis.fetch = dom.window.fetch = async (url, init) => {
      if (
        scenario === "destination-session-missing" &&
        new URL(url).origin === destination.peer.url &&
        new URL(url).pathname.endsWith("/complete")
      ) {
        const removed = await nodeFetch(
          String(url).replace(/\/complete$/, ""),
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${destination.peer.token}` },
          },
        );
        assert.equal(removed.status, 200);
      }
      const response = await nodeFetch(url, init);
      const address = new URL(url);
      calls.push({
        computer: address.origin === source.peer.url ? "source" : "destination",
        method: init?.method || "GET",
        route: address.pathname + address.search,
        status: response.status,
      });
      return response;
    };
    globalThis.XMLHttpRequest = NodeXHR;
    const { default: Files } = await dom.load("/src/Files.tsx");
    const view = await dom.render(
      dom.React.createElement(Files, {
        peer: source.peer,
        peers: computers.map((c) => c.peer),
        device: {
          name: "source",
          platform: process.platform,
          roots: [{ id: 0, name: "Shared", path: source.root }],
          capabilities: { files: true },
        },
        onSession() {},
        toast: (message) => messages.push(message),
      }),
    );
    await dom.waitFor(() => view.container.querySelector(".file-main"));
    dom.update(() => view.container.querySelector(".file-main").click());
    await dom.waitFor(
      () =>
        view.container.querySelector(".file-viewer-body pre")?.textContent ===
        originalBytes.toString(),
    );
    const chooser = view.container.querySelector(
      '[aria-label="Destination computer"]',
    );
    dom.update(() => {
      chooser.value = "destination";
      chooser.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const send = view.container.querySelector(".file-viewer-send button");
    assert.equal(send.disabled, false);
    if (missingSource) fs.unlinkSync(sourceFile);
    dom.update(() => send.click());
    if (missingDestination) {
      await dom.waitFor(() =>
        calls.some((c) => c.computer === "destination" && c.status === 404),
      );
      await dom.waitFor(() =>
        view.container.querySelector(".file-viewer-send-error"),
      );
      assert.match(
        view.container.querySelector(".file-viewer-send-error").textContent,
        /Couldn’t send to destination/,
      );
    } else if (missingSource)
      await dom.waitFor(() =>
        messages.some((m) => m.includes("was moved or deleted")),
      );
    else await dom.waitFor(() => messages.some((m) => m.startsWith("Sent to")));
    const stillReadable = await nodeFetch(
      source.peer.url + "/api/files/content?root=0&path=original.txt",
      {
        headers: { Authorization: `Bearer ${source.peer.token}` },
      },
    );
    assert.deepEqual(dom.errors, []);
    if (missingSource) {
      assert.equal(stillReadable.status, 404);
      assert.equal(view.container.querySelector(".file-viewer"), null);
      assert.equal(
        calls.some((c) => c.computer === "destination"),
        false,
      );
      return;
    }
    assert.equal(stillReadable.status, 200);
    assert.equal(hash(fs.readFileSync(sourceFile)), hash(originalBytes));
    if (missingDestination) {
      assert.ok(
        view.container.querySelector(".file-viewer"),
        "A missing destination must not close the existing source file preview",
      );
      assert.equal(
        messages.some((m) => m.includes("was moved or deleted")),
        false,
        "Do not say that the source disappeared when only the destination is missing",
      );
    } else
      assert.equal(
        hash(fs.readFileSync(path.join(destination.root, "original.txt"))),
        hash(originalBytes),
      );
  });
