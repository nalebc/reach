// The public start page. With the Tailscale app on, the phone is already on
// the tailnet: go straight to the computer's private address (fastest, always
// preferred). Without it, sign in to Tailscale right here in the browser and
// run Reach through the page's own tailnet node.
import { setHomeOrigin } from "./home-origin";
import { installTailnet, type TailnetNode } from "./tailnet-transport";
import {
  appLink,
  browserHostname,
  directUrl,
  guestHash,
  homeReachable,
  parseGuestLink,
  parseStartConfig,
  probeDirect,
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
}) {
  view.replaceChildren();
  const card = document.createElement("section");
  card.className = "start-card";
  const mark = document.createElement("div");
  mark.className = "start-mark";
  mark.textContent = "Reach";
  const title = document.createElement("h1");
  title.textContent = parts.title;
  card.append(mark, title);
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
    const response = await fetch("/reach-start.json", { cache: "no-store" });
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

async function startNode(
  config: StartConfig,
  wasm: Promise<Response>,
  guest: GuestLink | null,
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
  return reachTailnet({
    hostname: guest?.hostname || browserHostname(navigator.userAgent),
    ...(guest?.key ? { authKey: guest.key } : {}),
    stateStorage: storeFor(guest ? "reach.guest:" : "reach.tailnet:"),
  });
}

// While in the browser, keep checking for the app: offer the faster path.
function watchForApp(config: StartConfig) {
  let shown = false;
  const check = async () => {
    if (shown || document.hidden) return;
    if (!(await probeDirect(config, undefined, 1500))) return;
    shown = true;
    const pill = document.createElement("button");
    pill.className = "start-switch";
    pill.textContent = "Tailscale app is on · Switch to the faster connection";
    pill.addEventListener("click", () =>
      location.replace(directUrl(config, location)),
    );
    document.body.append(pill);
  };
  setInterval(check, 15000);
}

async function boot(
  config: StartConfig,
  node: TailnetNode,
  guest: GuestLink | null,
) {
  installTailnet(node, tailnetSuffix(config.origin));
  setHomeOrigin(guest?.invites[0]?.origin || config.origin);
  document.documentElement.dataset.connection = "browser";
  view.remove();
  if (!guest) watchForApp(config);
  await import("./main");
}

async function browserMode(
  config: StartConfig,
  wasm: Promise<Response> | null,
  guest: GuestLink | null = null,
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
  render({ title: `Connecting to ${config.name}…`, hint: !guest });
  let node: TailnetNode;
  try {
    node = await startNode(
      config,
      wasm || fetch(`/tailnet/${config.tailnet.wasm}`),
      guest,
    );
  } catch {
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
      title: `Sign in to reach ${config.name}`,
      detail:
        "Use the Tailscale account your computer is signed in to. Nothing to install.",
      action: authURL
        ? { label: "Sign in with Tailscale", href: authURL }
        : { label: "Preparing sign-in…", busy: true },
      hint: true,
    });
  // Where this browser must get to: your computer, or the invited ones.
  const targets = guest ? guest.invites.map((x) => x.origin) : [config.origin];
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
  // A guest never signs in: the link's key does it. If Tailscale still asks,
  // the key was used already or expired (or the invitation ended).
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  const guestEnded = () =>
    render({
      title: guest?.key
        ? "This invitation link was already used or has expired"
        : "Your invitation has ended",
      detail: "Ask the person who invited you for a new link.",
    });
  node.start({
    state: (state) => {
      if (guest) {
        if (state === "NeedsLogin") keyTimer ||= setTimeout(guestEnded, 8000);
        else if (state === "Running") {
          clearTimeout(keyTimer);
          checks = 0;
          running();
        } else if (!booted && state === "Starting")
          render({ title: `Connecting to ${config.name}…` });
        return;
      }
      if (state === "NeedsLogin") {
        if (!asked) {
          asked = true;
          node.login();
        }
        signIn();
      } else if (state === "NeedsMachineAuth")
        render({
          title: "Waiting for approval",
          detail:
            "Your Tailscale admin needs to approve this browser in the Tailscale admin console.",
        });
      else if (state === "Running") {
        checks = 0;
        running();
      } else if (!booted && state === "Starting")
        render({ title: `Connecting to ${config.name}…`, hint: true });
    },
    authURL: (url) => {
      authURL = url;
      signIn();
    },
  });
}

async function main() {
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
      ? parseGuestLink(location.hash, config.origin)
      : null;
  if (guest)
    history.replaceState(null, "", `/guest${guestHash(guest.invites)}`);
  const first = guest?.invites[0]?.origin;
  const target =
    first && first !== config.origin
      ? { ...config, origin: first, instance: "" }
      : config;
  // Already on the tailnet (Tailscale app on): straight to the private address.
  if (await probeDirect(target)) {
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
  await browserMode(
    config,
    wasm,
    guest && (guest.key || joined) ? guest : null,
  );
}

void main();
