// After Reach restarts with a new phone interface, an open page reloads itself
// so it isn't left on the old one, but only while nothing is being typed,
// answered or signed in, so nothing is lost. The Mac's live connection says
// which interface it serves (presence `changes.build`); the first one seen is
// this page's.
let first: string | null = null;
let waiting = false;
// Live screens and app windows open on this page: a reload mid-stream threw
// the phone back to the loading scene each time an agent edited the interface.
let streams = 0;
export function holdReload() {
  let held = true;
  streams++;
  return () => {
    if (held) streams--;
    held = false;
  };
}

export function busyHere(doc: Document = document) {
  if (streams > 0) return true;
  const active = doc.activeElement as HTMLElement | null;
  if (active && /^(TEXTAREA|INPUT|SELECT)$/.test(active.tagName)) return true;
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input"))
    if (!["file", "hidden", "checkbox", "radio"].includes(el.type) && el.value.trim()) return true;
  // A sign-in under way, a question half answered, a reset being confirmed.
  return !!doc.querySelector(".sign-in[role=group], .as-prompt .chosen, .as-banner-actions > span");
}

export function noteBuild(
  build: unknown,
  { reload = () => location.reload(), busy = () => busyHere(), wait = (f: () => void) => setTimeout(f, 5000) } = {},
) {
  if (typeof build !== "string" || !build) return;
  if (first === null) {
    first = build;
    return;
  }
  if (build === first || waiting) return;
  waiting = true;
  const attempt = () => (busy() ? wait(attempt) : reload());
  attempt();
}

// Tests start each case afresh.
export function forgetBuild() {
  first = null;
  waiting = false;
}
