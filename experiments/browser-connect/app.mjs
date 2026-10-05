import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { createReachClient, privateOrigin } from "./client.mjs";

const $ = (id) => document.getElementById(id);
let ipn,
  client,
  device,
  socket,
  terminal,
  sessionId,
  pendingTimer,
  healthTimer,
  approvalGeneration = 0,
  disconnecting = false;
const fail = (e) => {
  $("error").textContent = String(e?.message || e);
};
const action = (id, fn) =>
  $(id).addEventListener("click", async () => {
    $("error").textContent = "";
    $(id).disabled = true;
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      $(id).disabled = false;
    }
  });
function ended() {
  approvalGeneration++;
  clearTimeout(pendingTimer);
  clearInterval(healthTimer);
  socket?.close();
  socket = null;
  terminal?.dispose();
  terminal = null;
  sessionId = null;
  $("terminal-status").textContent = "";
  $("file-content").textContent = "";
  $("file-list").replaceChildren();
  $("workspace").hidden = true;
  $("approval").textContent =
    "Access ended. Request approval again to reconnect.";
}
action("start", async () => {
  $("network").textContent = "Loading Tailscale into this browser…";
  const go = new window.Go();
  const response = await fetch("/main.wasm");
  if (!response.ok)
    throw Error(
      "Build the browser networking engine first: node experiments/browser-connect/build.mjs",
    );
  const { instance } = await WebAssembly.instantiate(
    await response.arrayBuffer(),
    go.importObject,
  );
  go.run(instance).catch(fail);
  if (typeof window.newIPN !== "function")
    throw Error("Tailscale did not initialize.");
  ipn = window.newIPN({
    hostname: "reach-browser-" + crypto.randomUUID().slice(0, 8),
  });
  // Omit stateStorage: keys and Reach tokens live only in this page's memory.
  ipn.run({
    notifyState(state) {
      $("network").textContent =
        {
          NeedsLogin: "Ready for Tailscale sign-in.",
          NeedsMachineAuth: "Approve this browser device in Tailscale.",
          Running: "Connected · Tailscale inside your browser",
          Starting: "Establishing encrypted connectivity…",
        }[state] || state;
      $("approve").disabled = state !== "Running";
      if (state === "NeedsLogin" && !disconnecting) ipn.login();
      if (state === "Running") $("login").hidden = true;
    },
    notifyNetMap(json) {
      const map = JSON.parse(json);
      $("node").textContent =
        `Browser node: ${map.self.name} · ${map.self.addresses.join(", ")}`;
    },
    notifyBrowseToURL(value) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "login.tailscale.com" ||
        url.username ||
        url.password
      )
        return fail(Error("Unexpected login destination refused."));
      $("login").href = url.href;
      $("login").hidden = false;
    },
    notifyPanicRecover(error) {
      client?.stop();
      ended();
      fail(error);
    },
  });
  $("start").hidden = true;
  $("disconnect").hidden = false;
});
async function connected(token, candidate, epoch) {
  if (epoch !== approvalGeneration) return;
  candidate.authenticate(token);
  device = await candidate.request("/api/device");
  if (epoch !== approvalGeneration) return;
  client = candidate;
  $("device").textContent =
    `${device.name} · files and terminal over embedded Tailscale`;
  $("workspace").hidden = false;
  $("approval").textContent =
    "Approved by your computer. Credentials stay in this tab.";
  // This exercises real authorization after owner revocation, even when idle.
  healthTimer = setInterval(
    () => client.request("/api/device").catch(fail),
    2000,
  );
}
action("approve", async () => {
  client?.stop();
  ended();
  $("approval").textContent = "Contacting your computer through Tailscale…";
  const epoch = approvalGeneration;
  const candidate = createReachClient(
    ipn,
    privateOrigin($("target").value),
    ended,
  );
  client = candidate;
  const method = await candidate.request("/api/auth/method");
  if (method.method !== "tailscale")
    throw Error(
      "This prototype requires Reach’s Tailscale device approval. Run the isolated fixture or configure private access.",
    );
  const request = await candidate.request("/api/auth/requests", {
    method: "POST",
    body: { name: "Reach browser experiment" },
  });
  $("approval").textContent =
    `On your computer, approve code ${request.verification}. For normal Reach use ./reach approve; the disposable fixture has its own approval command.`;
  const poll = async () => {
    if (epoch !== approvalGeneration) return;
    try {
      if (Date.now() >= request.expiresAt)
        throw Error("Approval expired. Request access again.");
      const result = await candidate.request(
        `/api/auth/requests/${request.id}`,
        { method: "POST", body: { secret: request.secret } },
      );
      if (epoch !== approvalGeneration) return;
      if (result.status === "approved")
        return await connected(result.token, candidate, epoch);
      if (result.status === "denied")
        throw Error("The computer declined this request.");
      pendingTimer = setTimeout(poll, 2000);
    } catch (e) {
      fail(e);
    }
  };
  await poll();
});
action("files", async () => {
  const active = client;
  const root = device.roots[0]?.id;
  if (root === undefined) throw Error("No shared folder available.");
  const listing = await active.request(`/api/files?root=${root}&path=`);
  if (active !== client) return;
  $("file-list").replaceChildren();
  for (const entry of listing.items || []) {
    if (entry.type !== "file") continue;
    const button = document.createElement("button");
    button.className = "file";
    button.textContent = entry.name;
    button.addEventListener("click", async () => {
      try {
        const bytes = await active.request(
          `/api/files/content?root=${root}&path=${encodeURIComponent(entry.path)}`,
          { bytes: true },
        );
        if (active !== client) return;
        $("file-content").hidden = false;
        $("file-content").textContent = new TextDecoder().decode(bytes);
      } catch (e) {
        fail(e);
      }
    });
    $("file-list").append(button);
  }
});
action("terminal", async () => {
  socket?.close();
  terminal?.dispose();
  if (!sessionId) {
    const session = await client.request("/api/terminals", {
      method: "POST",
      body: { root: device.roots[0]?.id, path: "", name: "Browser WASM test" },
    });
    sessionId = session.id;
  }
  $("terminal-view").hidden = false;
  terminal = new Terminal({ fontSize: 13, theme: { background: "#0a1115" } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open($("terminal-view"));
  fit.fit();
  socket = await client.terminal(
    sessionId,
    (message) => {
      if (message.type === "snapshot" || message.type === "data")
        terminal?.write(message.data);
      if (message.type === "error") fail(message.error);
    },
    (code) => {
      $("terminal-status").textContent =
        `Disconnected (${code}). ${code === 4001 ? "Access ended." : "Tap Open terminal to reconnect."}`;
    },
  );
  terminal.onData((data) => socket?.send({ type: "input", data }).catch(fail));
  await socket.send({
    type: "resize",
    cols: Math.max(10, terminal.cols),
    rows: Math.max(2, terminal.rows),
  });
  $("terminal-status").textContent =
    "Live terminal · encrypted relay · no browser-native connection to the Mac";
});
action("revoke", async () => {
  await client.request("/api/device/access", { method: "DELETE" });
  // Verify with the old credential rather than just hiding the UI.
  try {
    await client.request("/api/device");
    throw Error("Revocation did not reject the old session.");
  } catch (e) {
    if (!$("workspace").hidden) throw e;
  }
});
action("disconnect", async () => {
  disconnecting = true;
  client?.stop();
  ended();
  ipn?.logout();
  $("network").textContent =
    "Browser node disconnected. Reload to start again.";
  $("disconnect").hidden = true;
  $("login").hidden = true;
});
window.addEventListener("pagehide", () => {
  disconnecting = true;
  client?.stop();
  ipn?.logout();
});
