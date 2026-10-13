import { fail, isPlainRecord, hasReviewControls } from "./core.mjs";
import { describeScreen } from "./agent-desktop.mjs";

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

// Bounded, per-invitation history. A changed grant discards prior content.
// Fresh reads always perform live authorization; deltas never authorize input.
export function createObservations() {
  const clients = new Map();
  return (client, screen, raw = {}) => {
    const options = observationOptions(raw);
    const fingerprint = JSON.stringify([client.expiresAt, client.scopes, client.policy]);
    let entry = clients.get(client.id);
    if (!entry || entry.fingerprint !== fingerprint) entry = { fingerprint, snapshots: new Map() };
    clients.delete(client.id); clients.set(client.id, entry);
    while (clients.size > 64) clients.delete(clients.keys().next().value);
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
    result.text = description.length <= max ? description : description.slice(0, max - 70).replace(/\n[^\n]*$/, "") + "\n… output limited; narrow query/within or increase maxChars.";
    result.outputTruncated = description.length > max;
    return result;
  };
}
