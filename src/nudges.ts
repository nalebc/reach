// Reach's suggestions that come back from time to time (PhonePrompts.tsx):
// how many times each was put away and when, remembered on this phone. Where
// storage is blocked (private browsing), for this visit only.

export type NudgeState = { dismissed: number; lastAt: number; done: boolean };
export type NudgeRule = {
  // After "Not now", how long until it may show again.
  againMs: number;
  // Put away this many times, it stops (or shrinks, its caller decides).
  maxDismissed: number;
};

const DAY = 24 * 60 * 60 * 1000;
export const NUDGES = {
  // Phones without the Tailscale app: the next visit a day later, three times;
  // the small "faster with the app" link stays after that.
  "tailscale-app": { againMs: DAY, maxDismissed: 3 },
  // On the app connection: a week later, three times; never once added.
  "home-screen": { againMs: 7 * DAY, maxDismissed: 3 },
  // On the app connection without a fallback yet: three days later, three
  // times. Once set up it isn't needed; Settings keeps the way to it.
  fallback: { againMs: 3 * DAY, maxDismissed: 3 },
} satisfies Record<string, NudgeRule>;
export type NudgeName = keyof typeof NUDGES;

const memory = new Map<string, NudgeState>();
const key = (name: string) => `reach.nudge.${name}`;
const fresh = (): NudgeState => ({ dismissed: 0, lastAt: 0, done: false });

export function readNudge(name: NudgeName): NudgeState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(name));
  } catch {
    return memory.get(name) || fresh();
  }
  if (raw == null) return fresh();
  try {
    const value = JSON.parse(raw);
    return {
      dismissed: Number.isInteger(value?.dismissed) && value.dismissed > 0 ? value.dismissed : 0,
      lastAt: Number.isFinite(value?.lastAt) ? value.lastAt : 0,
      done: value?.done === true,
    };
  } catch {
    return fresh();
  }
}
function write(name: NudgeName, state: NudgeState) {
  try {
    localStorage.setItem(key(name), JSON.stringify(state));
  } catch {
    memory.set(name, state); // blocked: kept for this visit
  }
}

// Whether it may show now: never put away, or put away long enough ago and
// not too often; never once done.
export function nudgeDue(name: NudgeName, now = Date.now()) {
  const state = readNudge(name);
  const rule: NudgeRule = NUDGES[name];
  if (state.done || state.dismissed >= rule.maxDismissed) return false;
  return !state.dismissed || now - state.lastAt >= rule.againMs;
}
// Put away for now ("Not now").
export function dismissNudge(name: NudgeName, now = Date.now()) {
  const state = readNudge(name);
  write(name, { ...state, dismissed: state.dismissed + 1, lastAt: now });
}
// Done for good: the Tailscale app is on, Reach is on the Home Screen.
export function finishNudge(name: NudgeName) {
  write(name, { ...readNudge(name), done: true });
}
// Put away as often as it may be: what's left is the quiet way to it.
export function nudgeRetired(name: NudgeName) {
  const state = readNudge(name);
  return state.done || state.dismissed >= NUDGES[name].maxDismissed;
}
