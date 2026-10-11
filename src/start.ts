// The public start page: what the internet gets at your computer's address.
// With the Tailscale app on, the phone is on the tailnet and gets Reach itself
// at that same address, so it never sees this page (older Reach: it is sent to
// the private address). Without the app, sign in to Tailscale right here in
// the browser and run Reach through the page's own tailnet node.
import "./abort-polyfill";
import "./storage-fallback";
// Keeps the browser's install prompt from page load: the app comes later here.
import "./home-screen";
import { watchForApp } from "./app-watch";
import { openReach } from "./app-boot";
import { guestConnection } from "./guest-connection";
import { observeGuestNetwork } from "./guest-network";
import {
  FACE_DEVICE,
  faceDevice,
  forgetIfFresh,
  forgetSaved,
  saveTicket,
  startFresh,
} from "./face-start";
import { setHomeOrigin } from "./home-origin";
import {
  faceIdError,
  faceIdReady,
  signWithFaceId,
  type FaceOptions,
} from "./passkeys";
import { installTailnet, type TailnetNode } from "./tailnet-transport";
import {
  appLink,
  browserHostname,
  directUrl,
  guestHash,
  guestStartConnected,
  homeReachable,
  ownOrigin,
  parseGuestLink,
  parseStartConfig,
  probeDirect,
  resumeGuestStart,
  tailnetSuffix,
  type GuestLink,
  type StartConfig,
} from "./start-flow";
import "./start.css";

declare global {
  // Defined by the browser client (tailnet/main.go) and wasm_exec.js.
  function reachTailnet(config: {
    hostname: string;
    authKey?: string;
    stateStorage: {
      getState(key: string): string;
      setState(key: string, value: string): void;
    };
  }): TailnetNode;
  // eslint-disable-next-line no-var
  var Go: new () => {
    importObject: WebAssembly.Imports;
    run(i: WebAssembly.Instance): Promise<void>;
  };
}

const view = document.getElementById("start")!;
const USED = "reach.tailnet.used";
// Your browser's Tailscale device, or an invited guest's (kept apart, so a
// guest link opened on your phone never replaces your own device).
const storeFor = (prefix: string) => ({
  getState: (key: string) => {
    try {
      return localStorage.getItem(`${prefix}${key}`) || "";
    } catch {
      return "";
    }
  },
  setState: (key: string, value: string) => {
    try {
      localStorage.setItem(`${prefix}${key}`, value);
    } catch {}
  },
});

function render(parts: {
  title: string;
  detail?: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
    busy?: boolean;
  };
  secondary?: { label: string; onClick: () => void };
  hint?: boolean;
  // Where you are, signing in without the app: "Step 1 of 2 · Join your network".
  step?: string;
  diagnostics?: string;
}) {
  const diagnosticsOpen =
    !!view.querySelector<HTMLDetailsElement>(".start-diagnostics")?.open;
  view.replaceChildren();
  const card = document.createElement("section");
  card.className = "start-card";
  const mark = document.createElement("div");
  mark.className = "start-mark";
  mark.textContent = "Reach";
  const title = document.createElement("h1");
  title.textContent = parts.title;
  card.append(mark);
  if (parts.step) {
    const step = document.createElement("p");
    step.className = "start-step";
    step.textContent = parts.step;
    card.append(step);
  }
  card.append(title);
  if (parts.detail) {
    const p = document.createElement("p");
    p.textContent = parts.detail;
    card.append(p);
  }
  if (parts.action) {
    const a = parts.action;
    const el = document.createElement(a.href ? "a" : "button");
    el.className = "start-action";
    el.textContent = a.label;
    if (a.href) {
      (el as HTMLAnchorElement).href = a.href;
      (el as HTMLAnchorElement).target = "_blank";
      (el as HTMLAnchorElement).rel = "noopener noreferrer";
    }
    if (a.busy) el.setAttribute("aria-busy", "true");
    if (a.onClick) el.addEventListener("click", a.onClick);
    card.append(el);
  }
  if (parts.secondary) {
    const b = document.createElement("button");
    b.className = "start-secondary";
    b.textContent = parts.secondary.label;
    b.addEventListener("click", parts.secondary.onClick);
    card.append(b);
  }
  if (parts.diagnostics) {
    const details = document.createElement("details");
    details.className = "start-diagnostics";
    details.open = diagnosticsOpen;
    const summary = document.createElement("summary");
    summary.textContent = "Connection details";
    const pre = document.createElement("pre");
    pre.textContent = parts.diagnostics;
    const copy = document.createElement("button");
    copy.className = "start-secondary";
    copy.textContent = "Copy details";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent || "");
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select and copy the details above";
      }
    });
    details.append(summary, pre, copy);
    card.append(details);
  }
  if (parts.hint) {
    // The app connects device to device; the browser goes through a relay.
    const hint = document.createElement("p");
    hint.className = "start-hint";
    const link = document.createElement("a");
    link.href = appLink(navigator.userAgent);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Get the Tailscale app";
    hint.append(
      link,
      " for a faster connection. Reach switches to it automatically once it’s on.",
    );
    card.append(hint);
  }
  view.append(card);
}

async function loadConfig(): Promise<StartConfig | null> {
  try {
    const response = await fetch("/reach-start.json", {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    return parseStartConfig(await response.json());
  } catch {
    return null;
  }
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(Error("The secure connection could not load."));
    document.head.append(s);
  });
}

// Joining with the one-time key a Face ID sign-in gave this browser.
type FaceJoin = { key: string; hostname: string };

async function startNode(
  config: StartConfig,
  wasm: Promise<Response>,
  guest: GuestLink | null,
  face?: FaceJoin,
) {
  const files = config.tailnet!;
  await loadScript(`/tailnet/${files.exec}`);
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(
    wasm,
    go.importObject,
  );
  void go.run(instance).then(() => {
    // The Go side never exits on purpose; if it does, start over.
    render({
      title: "Connection stopped",
      action: { label: "Reconnect", onClick: () => location.reload() },
    });
  });
  const key = face?.key || guest?.key;
  return reachTailnet({
    hostname:
      face?.hostname || guest?.hostname || browserHostname(navigator.userAgent),
    ...(key ? { authKey: key } : {}),
    stateStorage: storeFor(guest ? "reach.guest:" : "reach.tailnet:"),
  });
}

async function boot(
  config: StartConfig,
  node: TailnetNode,
  guest: GuestLink | null,
) {
  installTailnet(node, tailnetSuffix(config.origin));
  // A device that joined with Face ID may only use Reach's private port.
  setHomeOrigin(
    guest?.invites[0]?.origin ||
      (faceDevice() ? config.origin : ownOrigin(config)),
  );
  document.documentElement.dataset.connection = "browser";
  if (!guest) watchForApp(config);
  await openReach(() => import("./main"), view);
}

async function browserMode(
  config: StartConfig,
  wasm: Promise<Response> | null,
  guest: GuestLink | null = null,
  {
    face,
    faceOk = false,
  }: {
    // Joining now with a Face ID sign-in's key.
    face?: FaceJoin;
    // Face ID sign-in is there to fall back on: a device of this browser that
    // needs a Tailscale login again signs in with Face ID instead.
    faceOk?: boolean;
  } = {},
) {
  if (!config.tailnet) {
    render({
      title: `Connect to ${config.name}`,
      detail:
        "Install the Tailscale app on this phone, sign in with the same account as your computer, then open this link again.",
      action: { label: "Get Tailscale", href: appLink(navigator.userAgent) },
    });
    return;
  }
  // Signing in without the app takes two steps: join the network (Tailscale),
  // then connect to Reach (Face ID or the code). Guests skip both, and so
  // does Face ID sign-in (one step: Face ID).
  const JOIN = guest || face ? undefined : "Step 1 of 2 · Join your network";
  render({ title: `Connecting to ${config.name}…`, hint: !guest, step: JOIN });
  let node: TailnetNode;
  const guestJoin = guest
    ? guestConnection({
        show: ({ title, detail, retry, diagnostics }) =>
          render({
            title,
            detail,
            diagnostics,
            ...(retry
              ? {
                  action: {
                    label: "Retry connection",
                    onClick: () => location.reload(),
                  },
                }
              : {}),
          }),
        ready: () => {
          stopNetworkObservation();
          guestStartConnected(sessionStorage);
          checks = 0;
          running();
        },
      })
    : null;
  const stopNetworkObservation = guestJoin
    ? observeGuestNetwork(globalThis, (step) => guestJoin.network(step))
    : () => {};
  try {
    node = await startNode(
      config,
      wasm || fetch(`/tailnet/${config.tailnet.wasm}`),
      guest,
      face,
    );
  } catch {
    stopNetworkObservation();
    render({
      title: "This browser couldn’t start the secure connection",
      detail: "Try again, or use the Tailscale app.",
      action: { label: "Try again", onClick: () => location.reload() },
      hint: !guest,
    });
    return;
  }
  try {
    if (!guest) localStorage.setItem(USED, "1");
  } catch {}
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 3000) node.wake();
  });
  let authURL = "",
    asked = false,
    booted = false,
    checks = 0;
  const signIn = () =>
    render({
      step: JOIN,
      title: "Sign in with Tailscale",
      detail: "Puts this browser on your private network. Nothing to install.",
      action: authURL
        ? { label: "Sign in with Tailscale", href: authURL }
        : { label: "Preparing sign-in…", busy: true },
      hint: true,
    });
  // Where this browser must get to: your computer, or the invited ones.
  const targets = guest
    ? guest.invites.map((x) => x.origin)
    : [ownOrigin(config)];
  const running = () => {
    if (booted) return;
    const states = targets.map((t) => homeReachable(node.status(), t));
    const reach = states.includes("ok")
      ? "ok"
      : states.includes("offline")
        ? "offline"
        : "missing";
    if (reach === "ok") {
      booted = true;
      void boot(config, node, guest);
      return;
    }
    // The peer list can trail the "Running" state by a moment.
    if (reach === "missing" && checks++ < 6) {
      setTimeout(running, 500);
      return;
    }
    const login = node.status().self.login;
    if (guest) {
      render(
        reach === "offline"
          ? {
              title: "The computer is offline",
              detail: "Try again when it's on.",
              action: { label: "Try again", onClick: () => location.reload() },
            }
          : {
              title: "You're in, but the computer isn't reachable yet",
              detail:
                "Ask the person who invited you to finish setting up guest access (./reach invites on their computer).",
              action: { label: "Try again", onClick: () => location.reload() },
            },
      );
      return;
    }
    render(
      reach === "offline"
        ? {
            title: `${config.name} is offline`,
            detail: "Make sure Reach is running on it, then try again.",
            action: { label: "Try again", onClick: () => location.reload() },
          }
        : face || faceDevice()
          ? {
              title: `${config.name} isn’t reachable from this browser yet`,
              detail:
                "Try again in a moment. If it keeps happening, run ./reach setup invites on your computer.",
              action: { label: "Try again", onClick: () => location.reload() },
            }
          : {
              title: `This account can’t reach ${config.name}`,
              detail: `Signed in as ${login || "another account"}. Sign in with the Tailscale account your computer uses.`,
              action: {
                label: "Use another account",
                onClick: () => {
                  asked = false;
                  authURL = "";
                  node.logout();
                },
              },
            },
    );
  };
  // Network startup can briefly report NeedsLogin while registering a valid
  // key. Only a real key rejection may say the key was not accepted.
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  // The same for a Face ID sign-in's key (it lasts ten minutes).
  const faceFailed = () =>
    render({
      title: "Face ID sign-in didn't finish",
      detail: "Try again.",
      action: { label: "Try again", onClick: startFresh },
    });
  node.start({
    state: (state) => {
      if (guestJoin) {
        guestJoin.state(state);
        return;
      }
      if (state === "NeedsLogin") {
        if (face) {
          keyTimer ||= setTimeout(faceFailed, 8000);
          return;
        }
        // This browser's device needs a Tailscale login again (its access
        // here ended and it was removed, or it expired): Face ID instead.
        if (faceOk) {
          startFresh();
          return;
        }
        if (!asked) {
          asked = true;
          // From now on a device of your Tailscale account, not a Face ID one.
          try {
            localStorage.removeItem(FACE_DEVICE);
          } catch {}
          node.login();
        }
        signIn();
      } else if (state === "NeedsMachineAuth")
        render({
          step: JOIN,
          title: "Waiting for approval",
          detail:
            "Your Tailscale admin needs to approve this browser in the Tailscale admin console.",
        });
      else if (state === "Running") {
        clearTimeout(keyTimer);
        checks = 0;
        running();
      } else if (!booted && state === "Starting")
        render({
          title: `Joining your network…`,
          hint: true,
          step: JOIN,
        });
    },
    authURL: (url) => {
      if (guestJoin) {
        guestJoin.error("key");
        return;
      }
      authURL = url;
      signIn();
    },
    error: (kind) => guestJoin?.error(kind),
  });
}

// Face ID sign-in: no Tailscale login. Your computer checks the passkey and
// gives this browser a one-time key to join your tailnet as a limited device;
// Reach's Connect then uses its one-time ticket (src/ConnectForm.tsx).
async function faceMode(config: StartConfig, wasm: Promise<Response>) {
  let ask: { id: string; options: FaceOptions } | null = null;
  let note = "";
  let renew: ReturnType<typeof setTimeout> | undefined;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(value?.error || "Face ID sign-in isn't available right now.");
    return value;
  };
  const show = () =>
    render({
      title: `Open ${config.name}`,
      detail: note || "With Face ID on this phone. Nothing to install.",
      action: {
        label: ask ? "Continue with Face ID" : "Preparing Face ID…",
        onClick: tap,
        busy: !ask,
      },
      secondary: {
        label: "Sign in with Tailscale instead",
        onClick: () => {
          clearTimeout(renew);
          void browserMode(config, wasm);
        },
      },
    });
  // Fetched ahead (Safari only shows Face ID straight from a tap), and
  // renewed before the two-minute challenge runs out.
  const load = async () => {
    clearTimeout(renew);
    try {
      ask = await post("/faceid/options", {});
      renew = setTimeout(load, 100000);
    } catch (e) {
      ask = null;
      note = (e as Error).message;
    }
    show();
  };
  function tap() {
    if (!ask) return;
    const { id, options } = ask;
    ask = null;
    note = "";
    clearTimeout(renew);
    const answer = signWithFaceId(options); // first thing in the tap
    render({ title: `Opening ${config.name}…` });
    answer
      .then((credential) => post("/faceid/join", { id, credential }))
      .then(({ key, hostname, ticket }) => {
        saveTicket(ticket, config.origin);
        try {
          localStorage.setItem(FACE_DEVICE, "1");
        } catch {}
        return browserMode(config, wasm, null, { face: { key, hostname } });
      })
      .catch((e) => {
        note = faceIdError(e);
        void load();
      });
  }
  show();
  await load();
}

async function main() {
  // Signing in with Face ID again: this browser's old device goes first.
  forgetIfFresh();
  // An agent's invitation opened in a browser: it stays unused, for the agent.
  if (location.pathname === "/agent") {
    history.replaceState(null, "", "/agent");
    render({
      title: "This link is for an AI agent",
      detail:
        "Give it to your agent (Claude Code, Codex…) with the command Reach showed you. It joins by itself.",
    });
    return;
  }
  render({ title: "Opening Reach…" });
  const config = await loadConfig();
  if (!config) {
    render({
      title: "Reach isn’t available right now",
      detail: "Make sure Reach is running on your computer, then try again.",
      action: { label: "Try again", onClick: () => location.reload() },
    });
    return;
  }
  // A browser that signed in here before needs the client again: start
  // fetching it now (usually from cache) while checking for the app.
  let used = false;
  try {
    used = localStorage.getItem(USED) === "1";
  } catch {}
  const wasm =
    used && config.tailnet ? fetch(`/tailnet/${config.tailnet.wasm}`) : null;
  // An invitation: the key is single use; take it out of the address now.
  const guest =
    location.pathname === "/guest"
      ? resumeGuestStart(
          parseGuestLink(location.hash, config.origin),
          sessionStorage,
          localStorage,
        )
      : null;
  if (guest)
    history.replaceState(null, "", `/guest${guestHash(guest.invites)}`);
  const first = guest?.invites[0]?.origin;
  const target =
    first && first !== config.origin
      ? { ...config, origin: first, instance: "" }
      : config;
  // Already on the tailnet (Tailscale app on): straight to the private address.
  // With one address, your own devices on the tailnet get Reach right here and
  // never this page, so there is nowhere else to send you.
  if ((guest || !config.home) && (await probeDirect(target))) {
    location.replace(
      guest
        ? `${target.origin}/guest${guestHash(guest.invites)}`
        : directUrl(config, location),
    );
    return;
  }
  // An invited guest's browser (a key now, or joined with one before) uses
  // its guest device; a guest link without a key signs in to Tailscale.
  const joined = !!storeFor("reach.guest:").getState("_current-profile");
  // Your own browser without a Tailscale device yet (a new one, or signing
  // in again): whatever it saved belonged to its old device.
  const device = !!storeFor("reach.tailnet:").getState("_current-profile");
  if (!guest && !device) forgetSaved();
  // Face ID sign-in, when your computer offers it.
  const faceOk =
    !guest && !!config.faceId && !!config.tailnet && (await faceIdReady());
  if (faceOk && !device) {
    await faceMode(config, wasm || fetch(`/tailnet/${config.tailnet!.wasm}`));
    return;
  }
  await browserMode(
    config,
    wasm,
    guest && (guest.key || joined) ? guest : null,
    { faceOk },
  );
}

void main();
