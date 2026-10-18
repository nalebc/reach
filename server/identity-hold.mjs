// A live connection's moment without Tailscale's word (transientDenial in
// server/index.mjs): the phone's whois, or this computer's own identity
// while an agent has app access, not confirmed in time. Held, not ended:
// its own checks keep refusing meanwhile, so nothing is sent, run or played
// on a stale identity, and it ends (retryable) only when none passed within
// `within`. Before, one host lookup that came late closed the live screen,
// its control, sound and terminals together, again and again (Oct 18).
export function identityHold({ within = 5000, now = Date.now, recheck = () => {} } = {}) {
  let since = 0,
    why = "";
  return {
    // Refused for a moment (why): true while it may wait, false once the
    // hold is over and the connection ends.
    hold(message = "") {
      if (!since) {
        since = now();
        why = message;
        // Tailscale is asked again now; a lookup already on its way is shared.
        Promise.resolve().then(recheck).catch(() => {});
      }
      return now() - since < within;
    },
    get held() {
      return since > 0;
    },
    // How long it's been held, and why (for the one line in Reach's log).
    get lapse() {
      return since ? { ms: now() - since, why } : null;
    },
    // A check passed: the lapse it ends, if there was one.
    clear() {
      const lapse = this.lapse;
      since = 0;
      why = "";
      return lapse;
    },
  };
}

// A viewer's or listener's check, as the hubs read it: true to send, null
// while held (skipped, kept), anything else: gone.
export const gone = (allowed) => !allowed && allowed !== null;

// Waits out a hold: the check's answer once it isn't null, or null if the
// connection went away meanwhile (alive false).
export async function settled(check, alive = () => true, every = 100) {
  let allowed = check();
  while (allowed === null && alive()) {
    await new Promise((resolve) => setTimeout(resolve, every));
    allowed = check();
  }
  return allowed;
}
