// Serialized into the disposable journey browser. Only fixed protocol
// metadata is retained: no URL, token, focus credential or typed text.
export function createScreenControlDiagnostics() {
  const events = [], lifecycle = [];
  let dropped = 0, lifecycleDropped = 0;
  const messages = new Set([
    "Authenticate first.",
    "Desktop control ended.",
    "Desktop control expired or was revoked.",
    "Desktop control disconnected. Reconnecting…",
    "Desktop control moved to this device's newer connection.",
    "Checking this phone's connection. Reconnecting…",
    "Checking this Mac's connection. Reconnecting…",
    "Checking this PC's connection. Reconnecting…",
    "Desktop input disconnected.",
    "Desktop input disconnected. Enable control again.",
    "Desktop input rate exceeded.",
    "Invalid desktop input or full input window.",
    "Wait for desktop input to be ready.",
    "Desktop control is off.",
    "Typing target changed. Tap the field again.",
    "Typing was too slow to reach the computer. Nothing after it was typed — type it again.",
    "That action waited too long and was dropped. Try again.",
    "Windows refused the typing.",
    "Windows refused the click.",
    "Desktop action failed. Check the selected display and keep Windows unlocked.",
    "This display disconnected. Select a display again.",
    "That window runs as administrator. Windows doesn't let Reach control it.",
    "The window in front runs as administrator. Windows doesn't let Reach type into it.",
    "Desktop control reconnecting",
    "Desktop control ended",
    "Reconnecting",
    "Superseded",
    "Control off",
  ]);
  const types = new Set(["auth", "input", "ready", "ack", "error", "parked", "resume", "fields"]);
  const actions = new Set(["heartbeat", "click", "down", "up", "move", "scroll", "key", "text", "type-edit", "focus", "probe", "context", "fields", "menu", "release", "clipboard-read", "clipboard-write", "selection-read"]);
  const object = value => !!value && typeof value === "object" && !Array.isArray(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const message = value => typeof value === "string"
    ? messages.has(value) ? value : "[redacted unexpected message]"
    : undefined;
  const record = value => {
    if (!object(value) || !["in", "out", "open", "close", "error"].includes(value.dir)) return;
    const event = { dir: value.dir };
    if (integer(value.t) && value.t <= 1e12) event.t = value.t;
    if (integer(value.socket) && value.socket > 0 && value.socket <= 1e6) event.socket = value.socket;
    if (Number.isInteger(value.code) && value.code >= 1000 && value.code <= 4999) event.code = value.code;
    if (value.reason !== undefined) event.reason = message(value.reason);
    const m = object(value.m) ? value.m : null;
    if (m) {
      event.type = types.has(m.type) ? m.type : "unknown";
      if (integer(m.id) && m.id > 0) event.id = m.id;
      if (object(m.action) && actions.has(m.action.type)) event.action = m.action.type;
      for (const key of ["ok", "retryable", "superseded", "skipped"])
        if (typeof m[key] === "boolean") event[key] = m[key];
      if (Number.isInteger(m.window) && m.window >= 1 && m.window <= 8) event.window = m.window;
      if (m.error !== undefined) event.error = message(m.error);
    }
    events.push(event);
    if (events.length > 256) { events.shift(); dropped++; }
    if (["open", "close", "error"].includes(event.dir) || ["ready", "error", "parked", "resume"].includes(event.type)) {
      lifecycle.push(event);
      if (lifecycle.length > 32) { lifecycle.shift(); lifecycleDropped++; }
    }
  };
  return {
    record,
    drain() {
      const result = { version: 1, events: events.splice(0), dropped, lifecycle: lifecycle.splice(0), lifecycleDropped };
      dropped = lifecycleDropped = 0;
      return result;
    },
  };
}

export const SCREEN_CONTROL_DIAGNOSTICS = `(${createScreenControlDiagnostics.toString()})()`;
