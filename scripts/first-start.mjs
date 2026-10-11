// The first start's install (npm packages, the phone interface, browser
// sign-in) runs while the person sets up Tailscale, so the two waits overlap
// instead of queueing: minutes of npm and Go no longer stand between
// `./reach` and its first question. Nothing the install says reaches the
// terminal while setup's menus are on screen; it is said once setup is done.

export const seconds = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
};

// `install({ say, step })` does the work: `step(label)` names each part as it
// starts (for timing, and for "finishing: …"), `say(line)` is held for later.
// `cancel()` stops whatever runs now (a paused setup). A failure never
// surfaces mid-menu: finish() throws it once setup is done.
export function installMeanwhile(install, { cancel = () => {}, now = Date.now } = {}) {
  const said = [];
  const times = [];
  let current = null;
  let settled = false;
  const started = now();
  const step = (label) => {
    const at = now();
    if (current) current.ms = at - current.at;
    current = { label, at };
    times.push(current);
  };
  const result = Promise.resolve()
    .then(() => install({ say: (line) => said.push(line), step }))
    .then(
      () => ({}),
      (error) => ({ error }),
    )
    .then((outcome) => {
      if (current) current.ms = now() - current.at;
      settled = true;
      return outcome;
    });
  return {
    get done() {
      return settled;
    },
    cancel() {
      if (!settled) cancel();
    },
    // Waits for the install (saying what it still does), then says what it
    // held back. Resolves with how long each part took.
    async finish(print = console.log) {
      if (!settled && current)
        print(`\nReach: finishing the first install: ${current.label}…`);
      const { error } = await result;
      for (const line of said) print(line);
      if (error) throw error;
      return {
        ms: now() - started,
        parts: times.map(({ label, ms }) => ({ label, ms })),
      };
    },
  };
}
