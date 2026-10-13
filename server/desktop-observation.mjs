import { fail, isPlainRecord, hasReviewControls } from "./core.mjs";
import { controlLine, describeScreen } from "./agent-desktop.mjs";

const words = value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
export function observationOptions(value = {}) {
  if (value === true) return { maxChars: 6000 };
  if (!isPlainRecord(value) || Object.keys(value).some(key => !["query", "within", "maxChars", "sinceSnapshot", "displayId"].includes(key)))
    throw fail(400, "Choose query, within, maxChars, sinceSnapshot or displayId for the observation.");
  const result = { ...value };
  for (const key of ["query", "within", "sinceSnapshot"]) if (value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key].trim() || value[key].length > (key === "sinceSnapshot" ? 40 : 200) || hasReviewControls(value[key])))
    throw fail(400, `Invalid observation ${key}.`);
  for (const [key, min, max] of [["maxChars", 500, 30000], ["displayId", 1, 4294967295]]) if (value[key] !== undefined) {
    const n = Number(value[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `Invalid observation ${key}.`);
    result[key] = n;
  }
  return result;
}

export function waitOptions(value) {
  if (!isPlainRecord(value) || Object.keys(value).some(key => !["text", "name", "role", "within", "state", "timeoutMs"].includes(key)) ||
      (value.text === undefined) === (value.name === undefined)) throw fail(400, "Wait for text or a control name.");
  for (const key of ["text", "name", "role", "within"]) if (value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 200 || hasReviewControls(value[key]))) throw fail(400, `Invalid wait ${key}.`);
  if (value.state !== undefined && !["present", "absent"].includes(value.state)) throw fail(400, "Wait for present or absent.");
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 500 || value.timeoutMs > 15000)) throw fail(400, "Wait up to 15000 milliseconds.");
  return value;
}

export function screenMatches(screen, wanted) {
  const scope = entry => !wanted.within || words(entry.context).includes(words(wanted.within));
  const matches = wanted.text !== undefined
    ? (!wanted.within && words(screen.title).includes(words(wanted.text))) || [...(screen.texts || []), ...(screen.items || [])].some(entry => scope(entry) && words([entry.text, entry.name, entry.value].join(" ")).includes(words(wanted.text)))
    : (screen.items || []).some(entry => scope(entry) && (!wanted.role || words(entry.role) === words(wanted.role).replace(/^ax/, "")) && words(entry.name).startsWith(words(wanted.name)));
  // An incomplete read cannot prove absence.
  return wanted.state === "absent" ? !matches && !screen.truncated : matches;
}

export async function waitForScreen({ read, changed, authorize, wanted, now = Date.now }) {
  const start = now(), end = start + (wanted.timeoutMs ?? 8000);
  for (;;) {
    authorize();
    const screen = await read();
    authorize();
    const found = screenMatches(screen, wanted);
    if (found || now() >= end) return { found, waitedMs: now() - start, screen };
    const ms = Math.min(400, Math.max(0, end - now()));
    if (changed) await changed(screen.revision, ms);
    else await new Promise(resolve => setTimeout(resolve, Math.min(ms, 100)));
  }
}

// After an action or an open, the screen an agent gets back is the one the
// action made, not the one before it: Reach waits until the front window has
// been still for one short window (no accessibility change), then reads it
// once. Bounded: about a second after an action, three after opening an app,
// a page or a file (a page still loading, its Stop button showing, is waited
// for within that). The same on a Mac and on Windows: the helper's
// wait-change where it has one (no reads, so no snapshot spent), else reads
// compared by what they show. Never longer than `capMs`, authorized on every
// round; an explicit waitFor replaces it.
export const SETTLE = { actMs: 1000, openMs: 3000, openMinMs: 800, quietMs: 300 };
const loading = (screen) => (screen?.items || []).some((item) => item.role === "Button" && /^stop\b/i.test(String(item.name || "")));
const shown = (screen) => JSON.stringify([screen?.app, screen?.title, (screen?.items || []).map((item) => [item.role, item.name, item.value]), (screen?.texts || []).map((line) => line.text)]);
export async function settleScreen({ read, changed, authorize, capMs, minMs = 0, quietMs = SETTLE.quietMs, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const start = now(), end = start + capMs;
  let revision, moved = false, fresh = false, screen = null, last = null, watch = changed;
  const still = () => moved || now() - start >= minMs;
  while (now() < end) {
    authorize();
    if (watch) {
      let result;
      // A helper that can't wait for changes (an older one, or one that
      // refuses): reads compared by what they show, as with no signal at
      // all. A read refused is said as any refusal is.
      try { result = await watch(revision, Math.max(1, Math.min(quietMs, end - now()))); } catch { watch = null; continue; }
      authorize();
      if (Number.isSafeInteger(result?.revision)) revision = result.revision;
      if (result?.changed) { moved = true; fresh = false; continue; }
      // Still, and already read since it last changed: keep waiting.
      if (!still() || (screen && fresh)) continue;
      screen = await read();
      fresh = true;
      authorize();
      // A page still loading: its changes are coming, within the cap.
      if (loading(screen) && now() < end) continue;
      break;
    }
    const next = await read();
    authorize();
    const seen = shown(next);
    if (last !== null && seen !== last) moved = true;
    const settled = last !== null && seen === last && still() && !loading(next);
    screen = next;
    last = seen;
    if (settled) break;
    await sleep(Math.max(0, Math.min(quietMs, end - now())));
  }
  return { screen, settledMs: now() - start };
}

// What changed on the screen since the agent last saw it whole (Oct 12:
// "send only what changed"): controls new (+), changed (~) or gone (-), and
// text that came (+) or went (-), each line as the whole text shows it. A
// control whose number moved counts as changed, so every control not listed
// keeps its number in the new snapshot, which the list names: an element is
// still clicked by snapshot and number, checked by the Mac as ever. The
// whole text instead on the first look, another window or page (its title),
// after CHANGES_MS, when asked (full), or when the list would be more than
// CHANGES_SHARE of the whole text.
export const CHANGES_MS = 5 * 60_000;
export const CHANGES_SHARE = 0.5;
const textLine = (line) => (line.heading ? `# ${line.text}` : line.text);
const keyed = (items) => {
  const seen = new Map();
  return new Map(items.map((item) => {
    const base = item.ref || JSON.stringify([item.role, item.name, item.context || ""]);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return [count ? `${base}#${count}` : base, item];
  }));
};
const shownAs = (item) => JSON.stringify([item.n, item.role, item.name, item.value ?? "", item.context ?? "", item.secure === true]);
const tally = (texts) => {
  const counts = new Map();
  for (const line of texts) counts.set(textLine(line), (counts.get(textLine(line)) || 0) + 1);
  return counts;
};
export function screenChanges(before, screen) {
  const old = keyed(before.items || []), current = keyed(screen.items || []);
  const lines = [];
  for (const [key, item] of current)
    if (!old.has(key)) lines.push(`+ ${controlLine(item)}`);
    else if (shownAs(old.get(key)) !== shownAs(item)) lines.push(`~ ${controlLine(item)}`);
  for (const [key, item] of old) if (!current.has(key)) lines.push(`- ${controlLine(item)}`);
  const was = tally(before.texts || []), now = tally(screen.texts || []);
  for (const [line, count] of now) for (let i = was.get(line) || 0; i < count; i++) lines.push(`+ ${line}`);
  for (const [line, count] of was) for (let i = now.get(line) || 0; i < count; i++) lines.push(`- ${line}`);
  const click = `Click a [number] with reach_act {"action":{"type":"element","snapshot":"${screen.snapshot}","n":NUMBER}}.`;
  return [`${screen.app || ""}${screen.title ? ` — ${screen.title}` : ""}`,
    lines.length ? `Changed since your last look; the rest is as it was, numbers included. ${click}` : `Nothing changed since your last look. ${click}`,
    ...lines].join("\n") + (screen.truncated ? "\n… more is on screen than listed: scroll, then describe again." : "");
}

// Bounded, per-invitation history. A changed grant discards prior content.
// Fresh reads always perform live authorization; deltas never authorize input.
// `mode.changes`: answer with what changed since the agent's last whole look
// (after acting); `mode.full` asks for the whole text anyway.
export function createObservations({ now = Date.now } = {}) {
  const clients = new Map();
  const entryOf = (client) => {
    const fingerprint = JSON.stringify([client.expiresAt, client.scopes, client.policy]);
    let entry = clients.get(client.id);
    if (!entry || entry.fingerprint !== fingerprint) entry = { fingerprint, snapshots: new Map(), seen: null };
    clients.delete(client.id); clients.set(client.id, entry);
    while (clients.size > 64) clients.delete(clients.keys().next().value);
    return entry;
  };
  // What the agent now has of this screen, whole; only that is a baseline.
  const baseline = (screen) => ({ at: now(), snapshot: screen.snapshot, app: screen.app, title: screen.title, windowRef: screen.windowRef, displayId: screen.displayId,
    items: structuredClone(screen.items || []), texts: structuredClone(screen.texts || []) });
  const observe = (client, screen, raw = {}, mode = {}) => {
    const options = observationOptions(raw);
    const entry = entryOf(client);
    const previous = entry.snapshots.get(options.sinceSnapshot);
    const compatible = previous && Date.now() - previous.savedAt <= 60000 && previous.app === screen.app && previous.title === screen.title && previous.windowRef === screen.windowRef && previous.displayId === screen.displayId;
    const scoped = item => (!options.within || words(item.context).includes(words(options.within))) &&
      (!options.query || words([item.name, item.value, item.text, item.context].join(" ")).includes(words(options.query)));
    const identity = item => item.ref || JSON.stringify([item.role, item.name, item.text, item.x, item.y]);
    const changes = (items, old = []) => {
      const before = new Map(old.map(item => [identity(item), JSON.stringify(item)]));
      return items.filter(item => scoped(item) && (!compatible || before.get(identity(item)) !== JSON.stringify(item)));
    };
    const result = { ...screen, items: changes(screen.items || [], previous?.items), texts: changes(screen.texts || [], previous?.texts) };
    result.fields = result.items.filter(item => /Field|TextArea|ComboBox/.test(item.role)).map(({ n, ref, name, role, value, secure }) => ({ n, ...(ref ? { ref } : {}), label: name, role, ...(value !== undefined ? { value } : {}), ...(secure ? { secure: true } : {}) }));
    if (options.sinceSnapshot) {
      result.delta = !!compatible;
      if (!compatible) result.reset = true;
      else {
        const present = new Set((screen.items || []).map(identity));
        result.removed = (previous.items || []).filter(item => scoped(item) && !present.has(identity(item))).map(item => ({ ref: item.ref, n: item.n, name: item.name }));
        const presentText = new Set((screen.texts || []).map(identity));
        result.removed.push(...(previous.texts || []).filter(item => scoped(item) && !presentText.has(identity(item))).map(item => ({ text: item.text, context: item.context })));
      }
    }
    for (const [id, old] of entry.snapshots) if (Date.now() - old.savedAt > 60000) entry.snapshots.delete(id);
    if (screen.snapshot) entry.snapshots.set(screen.snapshot, { ...structuredClone(screen), savedAt: Date.now() });
    while (entry.snapshots.size > 16) entry.snapshots.delete(entry.snapshots.keys().next().value);
    const max = options.maxChars ?? 30000;
    const lead = options.sinceSnapshot ? (compatible
      ? `Changes since ${options.sinceSnapshot}.${result.removed?.length ? " Removed: " + result.removed.map(item => item.ref || item.name || item.text).join(", ") : ""}\n`
      : "Previous snapshot unavailable or context changed; full observation follows.\n") : "";
    const description = lead + describeScreen(result);
    // Only what changed, against the last whole look of this same window.
    const whole = !options.query && !options.within && !options.sinceSnapshot;
    const seen = entry.seen;
    const comparable = mode.changes && !mode.full && whole && seen && now() - seen.at <= CHANGES_MS && seen.app === screen.app && seen.title === screen.title &&
      seen.windowRef === screen.windowRef && seen.displayId === screen.displayId;
    const changed = comparable ? screenChanges(seen, screen) : null;
    const text = changed !== null && changed.length <= CHANGES_SHARE * description.length ? changed : description;
    result.text = text.length <= max ? text : text.slice(0, max - 70).replace(/\n[^\n]*$/, "") + "\n… output limited; narrow query/within or increase maxChars.";
    result.outputTruncated = text.length > max;
    if (text === changed) {
      result.diff = true;
      // Tokens the agent didn't read again (about four characters each).
      result.saved = Math.max(0, Math.ceil((description.length - text.length) / 4));
    }
    entry.seen = whole && !result.outputTruncated ? baseline(screen) : null;
    return result;
  };
  // A look given whole some other way (reach_find), or a screen the agent
  // may not have seen whole (a find that scrolled and found nothing).
  observe.remember = (client, screen) => { entryOf(client).seen = baseline(screen); };
  observe.forget = (client) => { entryOf(client).seen = null; };
  return observe;
}
