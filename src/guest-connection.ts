import type { GuestNetworkStep } from "./guest-network";

type Notice = {
  title: string;
  detail?: string;
  retry?: boolean;
  diagnostics?: string;
};

// NeedsLogin is also a normal startup state while a one-use key is being
// registered. Elapsed time is never proof that the invitation was spent.
export function guestConnection({
  show,
  ready,
  later = setTimeout,
  cancel = clearTimeout,
}: {
  show: (notice: Notice) => void;
  ready: () => void;
  later?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  let lastState = "Starting";
  let network: GuestNetworkStep | "not-started" = "not-started";
  let delayed = false;
  const diagnostics = () =>
    `Reach connection check v1\nState: ${lastState}\nNetwork step: ${network}\nOwner approval: not reached`;
  const slowNotice = () => {
    const detail =
      network === "https-connecting"
        ? "This browser is waiting for Tailscale’s connection service to respond. Its network may be blocking that request."
        : network === "https-ready" || network === "socket-connecting"
          ? "Tailscale’s connection service responded, but the secure WebSocket channel has not opened. This browser’s network may be blocking it."
          : network === "socket-ready"
            ? "The secure channel is open. Tailscale has not finished registering this browser yet."
            : "The network client started, but has not contacted Tailscale’s connection service yet. Retry in this tab.";
    show({
      title: "The secure connection is taking longer",
      detail,
      retry: true,
      diagnostics: diagnostics(),
    });
  };
  const stopTimer = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const waiting = () => {
    if (timer !== undefined || connected) return;
    timer = later(() => {
      timer = undefined;
      if (!connected) {
        delayed = true;
        slowNotice();
      }
    }, 30000);
  };
  return {
    state(state: string) {
      if (connected) return;
      lastState = state;
      if (state === "Running") {
        connected = true;
        delayed = false;
        stopTimer();
        ready();
      } else if (
        state === "NeedsLogin" ||
        state === "Starting" ||
        state === "NoState"
      ) {
        waiting();
      } else if (state === "NeedsMachineAuth") {
        stopTimer();
        show({
          title: "Network approval required",
          detail:
            "The Tailscale administrator needs to approve this browser’s device before Reach can ask for connection approval.",
        });
      } else if (state === "Stopped" || state === "InUseOtherUser") {
        stopTimer();
        show({
          title: "The secure connection stopped",
          detail: "Retry in this browser to continue connecting.",
          retry: true,
        });
      }
    },
    network(step: GuestNetworkStep) {
      if (connected) return;
      network = step;
      if (step === "https-failed" || step === "socket-failed") {
        stopTimer();
        delayed = true;
        show({
          title: "This browser couldn’t reach the connection service",
          detail:
            step === "https-failed"
              ? "The HTTPS request to Tailscale failed. Retry here. If it keeps failing, this browser’s network may be blocking Tailscale."
              : "The secure WebSocket connection to Tailscale failed. Retry here. If it keeps failing, this browser’s network may be blocking WebSockets.",
          retry: true,
          diagnostics: diagnostics(),
        });
      } else if (delayed) slowNotice();
    },
    error(kind: string) {
      if (connected) return;
      delayed = false;
      stopTimer();
      show(
        kind === "key"
          ? {
              title: "The network key was not accepted",
              detail:
                "It may have expired, been revoked, or been used in another browser. Ask the owner for a new link.",
            }
          : {
              title: "The secure connection could not finish",
              detail:
                "This browser could not reach the private network. Retry here. If it keeps failing, its network may block Tailscale connections.",
              retry: true,
            },
      );
    },
  };
}
