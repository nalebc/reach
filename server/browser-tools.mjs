// One portable catalog for the invited browser and stdio MCP. This is a
// convenience boundary; the host reauthorizes every mapped request as well.
import { MONEY_BANKS } from "./money-sites.mjs";
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (maxLength = 1000, minLength = 1) => ({ type: "string", minLength, maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) });
const root = integer(0);
const relativePath = { ...string(4096, 0), description: "Path relative to one shared folder. No absolute paths or .. segments." };
const reason = { ...string(), description: "Explain the purpose of these exact actions for the owner." };
const point = { type: "number", minimum: 0, maximum: 1, description: "Screen coordinate as a fraction of width or height, from 0 to 1." };
const kinds = (value) => ({ type: "string", enum: Array.isArray(value) ? value : [value] });
const screenActions = [
  object({ type: kinds("click"), x: point, y: point, button: kinds(["left", "right"]), count: { ...integer(1, 2), enum: [1, 2] } }, ["type", "x", "y"]),
  object({ type: kinds("text"), text: string(2000) }, ["type", "text"]),
  object({ type: kinds("element"), snapshot: { ...string(40), description: "The snapshot from reach_elements." }, n: { ...integer(1, 500), description: "The element's number from reach_elements: clicked at its live center, exactly." }, button: kinds(["left", "right"]), count: integer(1, 3) }, ["type", "snapshot", "n"]),
  object({ type: kinds("key"), key: kinds(["enter", "backspace", "tab", "escape", "left", "right", "up", "down"]) }, ["type", "key"]),
  object({ type: kinds("scroll"), direction: kinds(["up", "down"]), amount: integer(1, 5) }, ["type", "direction"]),
];
const terminalAction = object({
  type: kinds("terminal"), root, cwd: relativePath,
  command: { ...string(2000), description: "Use pwd, cd, ls, cat, head, tail, wc or grep. Each action supplies its own cwd; cd does not change later actions. A restricted read-only command. The host validates commands and paths and asks the owner before running." },
}, ["type", "root", "command"]);
const definition = (name, title, description, inputSchema, example, extra = {}) => ({ name, title, description, inputSchema, example, ...extra });
export const CODING_TASK_NAMES = Object.freeze(["reach_start_coding_task", "reach_get_coding_task", "reach_list_coding_tasks", "reach_cancel_coding_task"]);
const codingId = { ...string(128), pattern: "^[A-Za-z0-9_-]+$", description: "The task id returned by reach_start_coding_task." };
// Shared with legacy stdio clients: those credentials offer Codex only.
// Preset clients receive both engines only with explicit Full control v1.
export function codingTaskTools(agents = ["codex"]) {
  const annotations = (readOnlyHint, destructiveHint = false, openWorldHint = false) => ({ annotations: { readOnlyHint, destructiveHint, openWorldHint } });
  return [
    definition(CODING_TASK_NAMES[0], "Start a coding task", "Delegate one coding task in a shared folder. Starts asynchronously; use reach_get_coding_task for bounded progress, actual command outputs, recorded diffs and needsOwner. Choose one requestId and reuse the same requestId after an error or lost reply; never create a new id just to retry. Approval requests remain for the owner in Reach.", object({
      requestId: { ...string(80, 8), pattern: "^[A-Za-z0-9_-]+$" }, agent: kinds(agents),
      root: { ...integer(0), default: 0 }, path: { ...string(4096, 0), default: "" }, task: { ...string(16000), pattern: "\\S" },
      title: { ...string(120, 0), pattern: "^[^\\x00-\\x1f\\x7f]*$" }, timeoutSeconds: { ...integer(60, 3600), default: 1800 },
    }, ["requestId", "agent", "task"]), { requestId: "coding_task_1", agent: agents[0], root: 0, path: "", task: "Implement the requested change and report the checks." }, annotations(false, true, true)),
    definition(CODING_TASK_NAMES[1], "Check a coding task", "Read your task's bounded summary, commands with actual outputs/status, recorded diffs, progress, needsOwner and version/status. Supply after and waitSeconds to wait up to 25 seconds for a newer version. This cannot approve an engine request.", object({ id: codingId, after: integer(0), waitSeconds: integer(0, 25) }, ["id"]), { id: "task-id-from-start", after: 0, waitSeconds: 25 }, annotations(true)),
    definition(CODING_TASK_NAMES[2], "List coding tasks", "List bounded metadata for this Reach agent's most recent coding tasks, up to 50. Other sessions and transcripts are not exposed.", object(), {}, annotations(true)),
    definition(CODING_TASK_NAMES[3], "Cancel a coding task", "Request cancellation of one of your coding tasks and read its current status. Poll while cancelling or cancellationPending is true. Completed commands and file changes cannot be undone by cancellation.", object({ id: codingId }, ["id"]), { id: "task-id-from-start" }, annotations(false, true)),
  ];
}
export function codingTaskRequest(name, args, { agents = ["codex"], access } = {}) {
  const tool = codingTaskTools(agents).find(tool => tool.name === name);
  if (!tool) throw Error("This coding tool is not available.");
  validate(tool.inputSchema, args);
  const input = JSON.parse(JSON.stringify(args));
  if (name === "reach_start_coding_task") {
    pathAllowed(input.path);
    if (access) rootAllowed(access, input.root ?? 0);
    return { route: "/api/coding-tasks", method: "POST", body: { ...input, root: input.root ?? 0, path: input.path ?? "", timeoutSeconds: input.timeoutSeconds ?? 1800 }, response: "json" };
  }
  if (name === "reach_list_coding_tasks") return { route: "/api/coding-tasks", method: "GET", response: "json" };
  const route = `/api/coding-tasks/${encodeURIComponent(input.id)}`;
  if (name === "reach_cancel_coding_task") return { route: route + "/cancel", method: "POST", body: {}, response: "json" };
  const query = new URLSearchParams();
  for (const key of ["after", "waitSeconds"]) if (input[key] !== undefined) query.set(key, String(input[key]));
  return { route: route + (query.size ? `?${query}` : ""), method: "GET", response: "json" };
}
export const savedToolName = item => `reach_saved_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 12) || "task"}_${item.id.replace(/-/g, "")}`;
export const SAVED_TOOLS_HINT = "Before starting a laptop task, open Tools in the workspace, search for a matching task, and click Run, or use reach_tools and call its reach_tool_* tool once with a requestId. Apps, Files, Commands and Access are under More. To create a deterministic tool, read reach_tool_protocol and submit the same reach.tool.v1 format with reach_define_tool. Recorded tasks are in Tools under Recorded tasks, and in reach_shortcuts.";
export const deterministicToolName = item => `reach_tool_${item.id}`;
// How acting goes, said the same way by every tool that acts and by the
// agent's guide (agent-guide.mjs), so on every connection (Oct 12: "make
// navigation super fast and smooth"): one turn per step, not act, look, act.
export const ACT_AND_SEE = "Acting answers with the screen as text, only what changed since your last look (full: true for all of it); use that result for your next decision. When no screen state is needed, describe: false returns only the action receipt and skips the read and settling wait.";
export const GO_FAST = "Act and you get the screen back as text; use that result for your next decision. Batch up to 10 actions in one reach_act and observe once at the end. Use describe: false when you need only the action receipt; observe: {within, query, maxChars} for a known region or relevant text. Prefer stable element refs. Use reach_wait_for instead of looking again and again.";
export const FULL_CONTROL_ACTIONS = "Carry out the owner's requests without asking for separate action approval, including payments, sending messages and deleting files. Follow any limits the owner gives; ask for missing information when needed.";
const requestId = { ...string(36), pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", description: "A fresh UUID for a new operation. Reuse it after a lost response; effects will never be repeated." };
const toolDefinitionSchema = object({ protocol: kinds("reach.tool.v1"), id: { ...string(48), pattern: "^[a-z][a-z0-9_]*$" }, title: string(80), description: string(500), origins: { type: "array", minItems: 1, maxItems: 4, items: string(2000) }, inputs: { type: "object", maxProperties: 12, additionalProperties: true }, steps: { type: "array", minItems: 1, maxItems: 24, items: { type: "object", maxProperties: 8, additionalProperties: true } } }, ["protocol", "id", "title", "description", "origins", "inputs", "steps"]);
const location = { root, path: relativePath };
const requestsAllowed = (access) => access.screen === "apps" || access.restrictedTerminal === true || access.commandRequests === true;
const terminalAllowed = (access) => access.restrictedTerminal === true && !!access.roots?.length;
const actionKinds = (access) => terminalAllowed(access) ? [terminalAction] : [];

// Preset sessions (agent-presets.mjs): the Mac itself, within the preset.
const fraction = { type: "number", minimum: 0, maximum: 1, description: "A fraction of the screen's width or height, 0 to 1, as seen in the last screenshot." };
// A long press: the button stays down this long, then lets go (one press).
const holdMs = { ...integer(100, 10000), description: "Hold the button down this many milliseconds before letting go: a long press, or a \"press and hold\" button. Up to 10000. One press only." };
const desktopActions = [
  object({ type: kinds("click"), x: fraction, y: fraction, button: kinds(["left", "right"]), count: integer(1, 3), modifiers: { type: "array", minItems: 0, maxItems: 4, items: kinds(["cmd", "shift", "option", "control"]) }, holdMs }, ["type", "x", "y"]),
  object({ type: kinds("move"), x: fraction, y: fraction }, ["type", "x", "y"]),
  object({ type: kinds("drag"), x: fraction, y: fraction, toX: fraction, toY: fraction, holdMs: { ...integer(0, 5000), description: "Milliseconds to hold the button down at the start before moving, for a long press that picks something up. Up to 5000." }, durationMs: { ...integer(50, 5000), description: "Milliseconds the move takes, for a slower drag (a slider, a file onto a folder). Up to 5000." } }, ["type", "x", "y", "toX", "toY"]),
  object({ type: kinds("scroll"), x: fraction, y: fraction, dx: { type: "number", minimum: -2000, maximum: 2000 }, dy: { type: "number", minimum: -2000, maximum: 2000, description: "Positive scrolls down." } }, ["type", "x", "y"]),
  object({ type: kinds("type"), text: { ...string(2000), description: "Typed into the focused field." }, secret: { type: "boolean", const: true, description: "Set for credentials so the value is typed without being echoed, logged or saved. Apps requires this for password fields and refuses secrets in terminals." }, paste: { type: "boolean", enum: [true], description: "Long text in one go: through the clipboard and ⌘V instead of keystrokes (the owner's clipboard text comes back after). Not for vault values." } }, ["type", "text"]),
  object({ type: kinds("key"), key: { ...string(16), description: "A key name: enter, tab, escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f11, a-z, 0-9 or punctuation." }, modifiers: { type: "array", minItems: 0, maxItems: 4, items: kinds(["cmd", "shift", "option", "control"]) } }, ["type", "key"]),
  // A control from reach_describe_screen, pressed at its live center on the
  // Mac: no screenshot, no coordinates (agent-desktop.mjs normalizeAction).
  object({ type: kinds("element"), snapshot: { ...string(40), pattern: "^[A-Za-z0-9-]{1,40}$", description: "The snapshot from reach_describe_screen or reach_elements." }, n: { ...integer(1, 500), description: "The control's [number] there." }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs }, ["type", "snapshot", "n"]),
  // The same by name (press), and a form's fields by their labels (fill).
  object({ type: kinds("press"), name: { ...string(120), description: "The control's name as the screen describes it." }, role: { ...string(40), pattern: "^[A-Za-z]{1,40}$", description: "Narrow to a role: Button, Link, Tab, MenuItem, CheckBox…" }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs }, ["type", "name"]),
  object({ type: kinds("fill"), fields: { type: "array", minItems: 1, maxItems: 12, items: object({ label: { ...string(120), description: "The field's label or placeholder as the screen describes it." }, text: string(2000), secret: { type: "boolean", enum: [true], description: "A username, email or password from your vault: typed unseen, never echoed." } }, ["label", "text"]) }, submit: { type: "boolean", enum: [true], description: "Press Enter after the last field." }, replace: { type: "boolean", enum: [true], description: "Clear each field first; clearing a password field requires Full control." }, paste: { type: "boolean", enum: [true], description: "Paste each field's text instead of typing it (long text); vault values are still typed." } }, ["type", "fields"]),
  // A menu item by its path, pressed through accessibility: no pointer needed.
  object({ type: kinds("menu"), path: { type: "array", minItems: 1, maxItems: 6, items: string(80), description: "The menu's title, then each item down to the one to press: [\"File\", \"Export As\", \"PDF…\"]. reach_menus lists them." } }, ["type", "path"]),
];
// A pause between batched actions, for a page or menu to appear.
const waitAction = object({ type: kinds("wait"), ms: { ...integer(50, 2000), description: "Milliseconds, up to 2000." } }, ["type", "ms"]);
const displayId = { ...integer(1, 4294967295), description: "Display id from reach_displays; omitted means the main display." };
const observationFields = { query: string(200), within: string(200), maxChars: integer(500, 30000), sinceSnapshot: string(40), displayId };
const waitFor = object({ text: string(200), name: string(120), role: string(40), within: string(200), state: kinds(["present", "absent"]), timeoutMs: integer(500, 15000) });
const observation = { oneOf: [{ type: "boolean", enum: [true] }, object(observationFields)] };
// The whole screen text after acting, not only what changed.
const fullField = { type: "boolean", enum: [true], description: "The whole screen text, not only what changed." };
const afterFields = { observe: observation, waitFor, full: fullField };
// What comes back after acting: the screen as text unless the agent says
// describe: false (the routes themselves answer without it when not asked).
const after = input => ({
  ...Object.fromEntries(["observe", "waitFor"].filter(key => input[key] !== undefined).map(key => [key, input[key]])),
  ...(input.describe === false ? {} : { describe: true, ...(input.full === true ? { full: true } : {}) }),
});
// (The enum is what this file's validator checks for a boolean.)
const describeField = { type: "boolean", enum: [true, false], description: "false: no screen after acting." };
const readQuery = input => Object.keys(input).length ? `?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}` : "";
for (const action of desktopActions) action.properties.displayId = displayId;
desktopActions.push(object({ type: kinds("element"), ref: { ...string(40), pattern: "^e-[a-f0-9-]+$" }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs, displayId }, ["type", "ref"]));
desktopActions.find(action => action.properties.type.enum.includes("press")).properties.within = string(200);
const compactNames = new Set(["reach_access", "reach_discover", "reach_execute", "reach_describe_screen", "reach_act", "reach_open_app", "reach_open_url", "reach_windows", "reach_focus_window", "reach_screenshot", "reach_displays", "reach_tools"]);
export const compactTools = tools => tools.filter(tool => compactNames.has(tool.name)).map(tool => {
  if (tool.name !== "reach_act") return tool;
  const schema = structuredClone(tool.inputSchema);
  // JSON Schema references remove the duplicated single/batch action schema.
  // The full profile remains available for clients without $ref support.
  schema.$defs = { action: schema.properties.action };
  schema.properties.action = { $ref: "#/$defs/action" };
  schema.properties.actions.items = { oneOf: [{ $ref: "#/$defs/action" }, waitAction, object({ ...waitFor.properties, type: kinds("wait_for"), displayId }, ["type"])] };
  return { ...tool, inputSchema: schema };
});

function presetTools(access) {
  const firstRoot = access.roots?.[0]?.index ?? 0;
  const tools = [definition("reach_access", "Access", `Read this session's preset, what it may do, its shared folders and when it ends. Your user's request is your permission: act without asking at each step, but ask your user before paying, sending a message or deleting something. Sign in with reach_act type + secret from your vault; read emailed codes in Gmail or Mail on the Mac. The Mac refuses for a missing permission: ask the owner with reach_request_permission. Bank, card and brokerage sites (reach_open_bank) are read-only: sign in, read balances and transactions, search, filter by date, download statements, then sign out; anything that moves money or changes the account is refused.${access.control && access.open ? ` Also returns savedTools with their callable tool names. ${SAVED_TOOLS_HINT}` : ""}`, object(), {})];
  if (access.preset === "full" && access.fullControlVersion === 1 && access.shell === true) tools.push(...codingTaskTools(["codex", "claude"]));
  // Any preset: a permission the Mac lacks goes to the owner as one tap.
  tools.push(definition("reach_request_permission", "Ask the owner for a Mac permission", "When the Mac refuses for a missing permission (\"setup_required\", \"Allow JavaScript from Apple Events\", Automation, Screen Recording, Accessibility), ask the owner here instead of telling them where to click: they get a notification and one tap on their phone. need: browser-tools (with browser: Chrome or Safari on a Mac, Chrome or Edge on Windows), screen-recording or accessibility; reason: one sentence for the owner. Answers ready (already allowed), pending (asked; call again in a minute), allowed or denied. Ask once per need; repeats return the same request.", object({ need: { ...string(20), enum: ["browser-tools", "screen-recording", "accessibility"] }, browser: { ...string(10), enum: ["Chrome", "Safari", "Edge"] }, reason: string(300) }, ["need", "reason"]), { need: "browser-tools", browser: "Chrome", reason: "To check your Uber Eats cart with the saved tool, many items at once." }));
  if (access.services) {
    const full = access.preset === "full";
    tools.push(
      definition("reach_services", "Services", `Discover available service tools and this agent's service access. ${full ? "Full control includes service access without separate approval." : "Service consent is separate from laptop permissions."}`, object(), {}),
      definition("reach_service_request", "Request service access", full ? "Read service access included in this Full control invitation. No separate owner approval is needed; explicit service revocation still applies." : "Request read-only service access from the owner once for this agent session. Repeated calls reuse an open request. Poll reach_services; never approve your own access.", object({ connectorId: string(48), reason: string(300) }, ["connectorId", "reason"]), access.services.connectors?.[0] ? { connectorId: access.services.connectors[0].id, reason: "Read the requested information." } : {}, { approvalRequired: !full }),
    );
    for (const connector of access.services.connectors || []) for (const action of connector.unavailable ? [] : connector.actions) {
      tools.push(definition(`reach_service_${connector.id}_${action.id}`, `${action.title} · ${connector.name}`,
        `${connector.description} ${action.permission}. ${full ? "Run directly using the access included in the Full control invitation; no separate service approval is needed. Explicit service revocation still applies." : "First request service access with reach_service_request if not approved; after approval reuse it for this session."}`,
        { ...action.inputSchema, properties: { ...action.inputSchema.properties, requestId }, required: [...(action.inputSchema.required || []), "requestId"] },
        { ...action.example, requestId: "00000000-0000-4000-8000-000000000001" }));
    }
  }
  if (access.screen) tools.push(
    definition("reach_screenshot", "Screenshot", "The Mac's screen now, as {image: base64 JPEG, mimeType}, at the display's own resolution up to maxWidth pixels (default 2560; use up to 3840 to read small controls). Reach's own windows, password apps and apps the owner hid are left out; in the Apps preset only the chosen apps appear. Coordinates for actions are fractions of this image. While a person uses the Mac through Reach, looks are refused too (kind paused): wait retryInMs, then look again.", object({ maxWidth: integer(320, 3840) }), { maxWidth: 2560 }),
    definition("reach_front", "What is in front", "The app and window in front, whether it takes commands (a terminal) or a password, why it is closed to you if it is, and which agent holds the Mac if another does. A browser: its page's address (url) and its tabs (tabs, the chosen one marked).", object(), {}),
    definition("reach_windows", "Every open window", "Every window you may know of, across apps: {id, app, title, minimized, front} and, for a browser window, its page (url) and its tabs ([{title, selected}]). Use it to find the right window or tab instead of guessing, then reach_focus_window. Apps the owner hid or protected aren't listed.", object(), {}),
  );
  if (access.control) tools.push(
    definition("reach_describe_screen", "Describe the screen", "Start here: the front window as text, from the Mac's accessibility tree. Its app and title, the text a person reads there in reading order, and every button, link and field inline as [n] {ref} Role \"name\". Prefer reach_act {action: {type: \"element\", ref}}: it checks the live control directly. Older screens without refs accept snapshot and n. No screenshot needed. Look once to start: every action then answers with the screen. Something not listed yet (a long page): reach_find scrolls to it; the whole text: reach_read_page. Pictures, maps and games have no text: use reach_screenshot for those.", object(), {}),
    definition("reach_elements", "Screen controls", "The same as reach_describe_screen, as data: {snapshot, app, title, items: [{n, ref, role, name, value, x, y, w, h}], texts: [{text, heading, x, y, w, h}]} (fractions of the screen). Prefer reach_act {action: {type: \"element\", ref}} to check and click the live control directly. Use snapshot and n if no ref is returned.", object(), {}),
    definition("reach_find", "Find on the screen", "Find something in the front window by its words, wherever it is, what is scrolled out of view included: text (a heading, a price, a label) or a control by name (and role). It is scrolled into view, then the screen is read again: you get its ref in a fresh snapshot, ready for reach_act {action: {type: \"element\", ref}}. Use snapshot and n if no ref is returned. One call instead of scroll, describe, scroll, describe. found: false means it isn't in this window. inView: false with a direction and distance: scroll that way, then find again.", object({ text: string(200), name: string(120), role: { ...string(40), pattern: "^[A-Za-z]{1,40}$", description: "With name: narrow to a role such as Button, Link, TextField." } }), { text: "Order total" }),
    definition("reach_menus", "Read the menu bar", "The front app's menu bar: each menu's items with their keyboard shortcuts (key, like ⇧⌘S), dimmed ones (enabled: false), checked ones, and which open a submenu. Give menu to read one menu with its submenus. Then press an item with reach_act {action: {type: \"menu\", path: [\"File\", \"Export As\", \"PDF…\"]}} (no pointer needed, so it runs beside the person), or use the shortcut with a key action. Never the Apple menu.", object({ menu: string(80) }), { menu: "File" }),
    definition("reach_read_page", "Read the page", "The front window's whole text, in reading order, what is scrolled out of view included: a web page, an email, a document, a terminal. Controls appear in [brackets]; no numbers, no coordinates. Up to 12000 characters a call: more: true means call again with the offset given as nextOffset. For a browser it reads the page, not the toolbar.", object({ offset: integer(0, 60000) }), {}),
    definition("reach_press", "Press a control by name", "Press a button, link, tab or menu item by the name reach_describe_screen shows, no number needed: the exact name first, then one starting with it. Several match: choose a returned candidate ref or narrow with within. Nothing matches: describe the screen. Works inside reach_act batches as {type: \"press\", name}. For a \"press and hold\" button or a long press, add holdMs.", object({ name: string(120), role: { ...string(40), pattern: "^[A-Za-z]{1,40}$", description: "Narrow to a role: Button, Link, Tab, MenuItem, CheckBox…" }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs, describe: describeField }, ["name"]), { name: "Add to cart" }),
    definition("reach_fill", "Fill a form", "Type into a form's fields by their labels, all in one call (reach_describe_screen lists them under Fields): each field is clicked, then typed into; submit: true presses Enter at the end; replace: true clears a field first (text appends otherwise). To sign in, \"Sign in with Google\" (Apple, Microsoft) on the owner's account where the site offers it. Otherwise a username, email or password from your vault, with secret: true on that field: it goes in unseen and is never shown back to you; only a secret goes into a password field. Skip the browser's saved passwords and passkeys: they wait for the owner's fingerprint. Works inside reach_act batches as {type: \"fill\", fields}.", object({ fields: { type: "array", minItems: 1, maxItems: 12, items: object({ label: string(120), text: string(2000), secret: { type: "boolean", enum: [true] } }, ["label", "text"]) }, submit: { type: "boolean", enum: [true] }, replace: { type: "boolean", enum: [true] }, describe: describeField }, ["fields"]), { fields: [{ label: "Email", text: "from your vault", secret: true }, { label: "Password", text: "from your vault", secret: true }], submit: true }),
    definition("reach_wait_for", "Wait for the screen", "The Mac waits until its screen shows some text, or a control by name (a page loaded, a dialog appeared), up to 15 seconds, then returns the screen as text, only what changed since your last look (full: true for all of it); found: false after the wait. One call instead of describing again and again.", object({ text: string(200), name: string(120), timeoutMs: integer(500, 15000) }), { text: "Order placed", timeoutMs: 8000 }),
    definition("reach_act", "Act on the screen", "Act on the Mac and get the screen back: one action, or actions: up to 10 in order (they stop at the first one refused). Prefer {type: \"element\", ref} from the screen text: it checks the live control directly. Use snapshot and n only if no ref is returned. Batch the click, type and key actions. Where a page has to load: {type: \"wait_for\", text} (or {type: \"wait\", ms}). Menu items: {type: \"menu\", path} (reach_menus). Long text: type with paste: true. Something out of view: reach_find instead of scrolling blind. Long press or \"press and hold\": holdMs on click, element or press (the button stays down that long). Drag: holdMs to hold before moving, durationMs for a slower move. Each action is checked against exactly what it would reach. Refusals say why: blocked (never allowed there), busy (another agent holds the Mac; wait retryInMs), paused (the owner paused you, or a person is using the Mac: wait retryInMs, then look again), retry (the screen changed; describe again).", object({ action: { oneOf: desktopActions }, actions: { type: "array", minItems: 1, maxItems: 10, items: { oneOf: [...desktopActions, waitAction, object({ ...waitFor.properties, type: kinds("wait_for"), displayId }, ["type"])] } }, describe: describeField }), { actions: [{ type: "element", ref: "e-01234567-89ab-cdef-0123-456789abcdef" }, { type: "type", text: "diapers" }, { type: "key", key: "enter" }] }),
  );
  if (access.open) tools.push(
    definition("reach_desktop_apps", "Apps you may use", "The apps this session may open or bring forward, with whether each is running.", object(), {}),
    definition("reach_open_app", "Open an app", "Open or bring forward one of those apps by its name (\"Calculator\") or path. Answers once it is in front and settled. A particular window or tab of an app: reach_windows, then reach_focus_window.", object({ app: string(4096) }, ["app"]), { app: access.apps?.[0]?.name || "Calculator" }),
    definition("reach_open_bank", "Open the owner's bank", `Read the owner's bank, card or brokerage accounts (balances, transactions, statements): opens ${MONEY_BANKS.slice(0, 4).map((bank) => bank.name).join(", ")} or another listed bank at its sign-in, in the owner's browser. Then sign in with reach_fill from your vault (an emailed code: Gmail or Mail), read with reach_describe_screen or reach_read_page, open Statements or Documents and press Download (the file lands in Downloads), and sign out. Bank pages are read-only: anything that moves money or changes the account is refused, and saved tools don't run there.`, object({ bank: { ...string(40), enum: MONEY_BANKS.map((bank) => bank.name) }, browser: string(4096) }, ["bank"]), { bank: MONEY_BANKS[1].name }),
    definition("reach_open_url", "Open a website", "Open a web address in the owner's own browser, with their sign-ins and cookies: the default browser, or browser by name (\"Google Chrome\"). Answers once the page is in front and settled (up to 3 s). Reach's own pages and saved-password pages stay closed. A bank: reach_open_bank. In Chrome (or Edge on Windows) its tab closes on its own 5 minutes after you stop, sooner with reach_close_tabs; in other browsers close it yourself when done.", object({ url: string(2048), browser: string(4096) }, ["url"]), { url: "https://www.ubereats.com" }),
    definition("reach_close_tabs", "Close your tabs", "Close the browser tabs you opened with reach_open_url or reach_open_bank once you no longer need them: all of them, or url: those on that site. Tabs opened another way (a link, a new tab): Command+W, or Ctrl+W on Windows, with reach_act.", object({ url: string(2048) }), {}),
    definition("reach_focus_window", "Bring a window forward", "Bring one window forward by the id reach_windows gave (its title checked again), unminimizing it if needed; in a browser window, also choose a tab by its title (tab). Answers once it is in front and settled.", object({ id: { ...string(12), pattern: "^[0-9]{1,8}:[0-9]{1,2}$" }, title: string(200, 0), tab: string(120) }, ["id"]), { id: "4242:0", title: "Inbox", tab: "Order confirmation" }),
    definition("reach_mac_shortcuts", "Mac shortcuts you may run", "The Mac's own Shortcuts (the Shortcuts app) the owner allowed agents to run, by name. Run one with reach_run_mac_shortcut. Asking for one that isn't allowed tells the owner, who can switch it on in Reach.", object(), {}),
    definition("reach_run_mac_shortcut", "Run a Mac shortcut", "Run one allowed shortcut by name, with optional text input, and get its text output: a deterministic step into Mail, Calendar, Notes, Finder or anything the owner automated, in one call. Up to 60 seconds. Not allowed yet: refused, and the owner is told once.", object({ name: string(120), input: string(20000, 0) }, ["name"]), { name: "Today's events" }),
  );
  if (access.open && access.roots?.length) tools.push(
    definition("reach_open_file", "Open a file", "Open a file from a shared folder in the app that owns it (a PDF in Preview, a spreadsheet in Numbers), or reveal: true to show it selected in the Finder. Answers once the app is in front and settled. Programs, scripts and installers never open this way.", object({ root, path: relativePath, reveal: { type: "boolean", enum: [true] } }, ["root", "path"]), { root: firstRoot, path: "Invoices/march.pdf" }),
  );
  // The same saved tool for a list of items, each in a Chrome (or, on
  // Windows, Edge) tab of its own
  // (agent-tools.mjs batch): offered with the tools it runs, and named in
  // their descriptions so an agent repeating one finds it.
  const batchable = (access.browserTools?.tools || []).filter(item => item.protocol === "reach.tool.v1" && /^[a-z][a-z0-9_]{0,47}$/.test(item.id));
  const batchBrowsers = (access.browserTools?.browsers || []).filter(name => name === "Chrome" || name === "Edge");
  const batchOffered = !!(access.control && access.open && access.screen && batchable.length && batchBrowsers.length);
  if (access.control && access.open && access.screen) tools.push(
    definition("reach_tools", "Find deterministic tools", `Check here before browser tasks. Returns brief built-in and agent-created tool matches and allowed browsers. Give id or detail:true for full definitions. Search by task name.${batchOffered ? " For the same tool over a list of items, use reach_tool_batch." : ""}`, object({ query: string(160) }), { query: "Gmail" }),
    definition("reach_tool_protocol", "Tool creation protocol", "Read reach.tool.v1: declared inputs, HTTPS origins, fixed DOM operations and checked results. The built-in tools use this same format. No JavaScript, shell or guessed steps.", object(), {}),
    definition("reach_define_tool", "Create deterministic tool", "Validate and save a new immutable reach.tool.v1 definition. It immediately appears as a named button and MCP tool. Read reach_tool_protocol and inspect reach_tools first; use a new ID. Creating a definition does not execute it.", object({ definition: toolDefinitionSchema }, ["definition"]), {}),
    definition("reach_tool_operation", "Check tool run", "Recover a lost response by requestId without repeating any browser action. Handles expire and do not survive a Reach restart.", object({ requestId }, ["requestId"]), {}),
    definition("reach_shortcuts", "Saved shortcuts", "Check here before app tasks. Find reusable tasks and required inputs within your current access. Without query, returns a compact catalog. Search by task name to inspect up to ten matching shortcuts' exact steps before running one. Also reports your current recording.", object({ query: string(160) }), { query: "Gmail" }),
    definition("reach_record_shortcut", "Record a shortcut", "Before doing a reusable task with no matching shortcut, record your successful reach_act and reach_open_app calls under a clear task name. Form text becomes an input supplied at replay; passwords and screenshots are never saved. Use Type for form text; text-producing key presses stop recording. Cmd+L, an HTTPS origin landing page (no path, query or fragment), Enter becomes a stable Open website step. Other addresses stay per-run inputs.", object({ name: string(80) }, ["name"]), { name: "Open Gmail" }),
    definition("reach_save_shortcut", "Save recorded shortcut", "After verifying the task succeeded, save its recording as a reusable local shortcut. Future agents can discover and replay it immediately within their own current app permissions. Saving needs no extra owner step. Discard failed or incomplete tasks instead.", object(), {}),
    definition("reach_discard_shortcut", "Discard recording", "Discard your current shortcut recording without undoing completed actions.", object(), {}),
    definition("reach_run_shortcut", "Run saved shortcut", "Run one enabled shortcut by ID in a single call, with your current permissions checked before every step. Text inputs are never stored. Stops at changed windows, password fields, owner activity, pause or revoked access. Inspect status and completedSteps; stopped steps are not rolled back. Never blindly retry a partially completed task. Take a screenshot after completion to verify the result.", object({ id: string(128), values: { type: "object", maxProperties: 60, additionalProperties: string(2000) } }, ["id"]), { id: "shortcut-id-from-reach_shortcuts" }),
  );
  if (batchOffered) tools.push(
    definition("reach_tool_batch", "Run a tool on many tabs at once", "Run one saved tool for a list of up to 10 items at once, each in its own " + batchBrowsers.join(" or ") + " tab: a grocery list, several searches, prices to compare. The tabs open behind and their pages load in parallel; the steps then run tab by tab, so cart clicks never collide. Returns one result per item. More than 10: call again with the next 10 and a new requestId. Lost or partial response: call again with the SAME requestId and items; finished items are never repeated. Shopping: first batch a search tool with keepTabs: true, pick each item's handle, then batch a handle tool (add to cart) on those handles; read the cart once at the end.", object({
      id: { ...kinds(batchable.map(item => item.id)), description: "The tool to run for every item (reach_tools)." },
      browser: kinds(batchBrowsers),
      requestId,
      items: { type: "array", minItems: 1, maxItems: 10, description: "One object of the tool's declared inputs per tab.", items: object(Object.fromEntries(batchable.flatMap(item => Object.keys(item.inputs || {})).filter(key => !["browser", "requestId"].includes(key)).map(key => [key, string(2000, 0)]))) },
      keepTabs: { type: "boolean", description: "Keep the tabs open for the item handles they returned. Otherwise the tabs Reach opened close at the end." },
    }, ["id", "browser", "requestId", "items"]), { id: batchable[0].id, browser: batchBrowsers[0], requestId: "00000000-0000-4000-8000-000000000001", items: [{}] }),
  );
  if (access.control && access.open && access.screen) for (const item of access.browserTools?.tools || []) {
    if (item.protocol !== "reach.tool.v1" || !/^[a-z][a-z0-9_]{0,47}$/.test(item.id) || !plain(item.inputs) || !Array.isArray(item.steps)) continue;
    const properties = { browser: kinds(access.browserTools.browsers), requestId };
    const required = ["browser", "requestId"];
    const example = { browser: access.browserTools.browsers[0] };
    for (const [key, field] of Object.entries(item.inputs)) {
      if (["browser", "requestId"].includes(key)) continue;
      properties[key] = { ...string(field.maxLength || 2000, field.required === false ? 0 : 1), description: field.label, ...(field.enum ? { enum: field.enum } : {}), ...(field.default !== undefined ? { default: field.default } : {}), ...(["handle", "file"].includes(field.type) ? { pattern: requestId.pattern } : {}) };
      if (field.required !== false && field.default === undefined) required.push(key);
      if (field.default !== undefined) example[key] = field.default;
    }
    tools.push(definition(deterministicToolName(item), item.title, `${item.description} Fixed ${item.steps.length}-step protocol. Stops on missing, ambiguous or stale targets. Check status and completedSteps; retry only with the SAME requestId after a lost response.${batchOffered ? " Several items at once: reach_tool_batch." : ""}`, object(properties, required), example));
  }
  if (access.control && access.open && access.screen) for (const item of access.savedTools || []) {
    if (typeof item.name !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || !Array.isArray(item.inputs) || item.inputs.some(key => !/^text[1-9][0-9]*$/.test(key))) continue;
    const properties = Object.fromEntries(item.inputs.map(key => [key, { ...string(2000), description: "Text for this run only; never persisted. Password fields remain blocked." }]));
    tools.push(definition(savedToolName(item), item.name, `Execute the saved task “${item.name}” (${item.stepCount} steps) immediately, using your current app access. Stops if the app/window changes or the owner takes control. Check the returned progress and take a screenshot to verify the result; never blindly retry a partially completed task.`, object(properties, item.inputs), {}));
  }
  if (access.roots?.length) tools.push(
    definition("reach_list_files", "List files", "List one shared folder.", object(location, ["root"]), { root: firstRoot, path: "" }),
    definition("reach_search_files", "Find files", "Find files by name inside one shared folder.", object({ root, query: string(160) }, ["root", "query"]), { root: firstRoot, query: "readme" }),
    definition("reach_read_file", "Read a file", "Read a UTF-8 file from a shared folder, up to 1 MiB.", object(location, ["root", "path"]), { root: firstRoot, path: "README.md" }),
  );
  if (access.write) tools.push(
    definition("reach_change_file", "Change a file", "Write a whole file (content up to 1 MiB), make a folder, remove a file, or copy one, inside a shared folder. Changes are immediate and visible to the owner.", object({ op: kinds(["write", "mkdir", "rm", "cp"]), root, path: relativePath, to: relativePath, content: { type: "string", minLength: 0, maxLength: 1048576 } }, ["op", "root", "path"]), { op: "write", root: firstRoot, path: "notes.md", content: "# Notes\n" }),
  );
  if (access.terminals?.length) tools.push(definition("reach_read_terminal", "Read terminal output", "Read output from a terminal the owner chose to share. Output only.", object({ id: string(256) }, ["id"]), { id: access.terminals[0].id }));
  if (access.shell) tools.push(
    definition("reach_shell", "Run a command", `Run one shell command as the owner's OS account, with no Reach command deny list or sandbox. Uses a clean environment, a 60-second limit and 256 KiB of output. Choose a root from reach_access and a working folder within it. ${process.platform === "win32" ? "Runs inside a Job Object as the owner's Windows account." : "macOS permissions still apply."} Commands and outcomes are logged; pause and revoked access stop execution.`, object({ command: string(4000), root, cwd: relativePath }, ["command", "root"]), { command: "ls -la", root: firstRoot, cwd: "" }),
    definition("reach_shell_history", "Command history", "This session's commands and their outcomes.", object(), {}),
  );
  tools.push(
    definition("reach_discover", "Find any permitted tool", "Search permitted tools by task. Returns short matches; give name for its full input schema. Use reach_execute to call a discovered tool in the compact profile.", object({ query: string(160), name: string(128) }), { query: "file" }),
    definition("reach_execute", "Execute a discovered tool", "Execute an exact permitted tool by name and its declared arguments. Discover its schema first. Same permissions and validation as the named tool; no nested reach_execute.", object({ name: string(128), arguments: { type: "object", additionalProperties: true } }, ["name", "arguments"]), {}),
  );
  if (access.screen) tools.push(definition("reach_displays", "Connected displays", "Display ids, sizes and main display. Pass displayId when observing or acting on another monitor.", object(), {}));
  for (const tool of tools) {
    if (tool.name === "reach_access" && !access.control) {
      tool.description = `Read this session's current permissions, shared folders and expiry before working. ${access.preset === "files" ? "Use the returned root indexes to list, search and read shared files; editing is available only when granted." : "Read only: observe the permitted screen, shared files and explicitly shared terminal output; no input or commands."} Access can change during a task. Discover current tools again after a denial; an ended session needs a new invitation.`;
    }
    if (access.preset === "full") {
      const descriptions = {
        reach_access: `Read this session's access, filesystem roots and expiry. Full control can use every app, page, file and command as the owner's OS account, including Reach and security settings. It has no command deny list, protected-window filter or shell sandbox. ${FULL_CONTROL_ACTIONS} Operating system permissions, connection approval, pause and revocation still apply.${access.control && access.open ? ` Also returns savedTools with their callable tool names. ${SAVED_TOOLS_HINT}` : ""}`,
        reach_screenshot: "See the whole Mac display as a JPEG, up to maxWidth pixels. Full control does not hide apps or windows. Coordinates are fractions of this image.",
        reach_windows: "List all open windows and browser tabs, then target one with reach_focus_window. Full control does not filter protected or hidden apps.",
        reach_open_url: "Open an HTTP(S) address in the owner's browser with its existing sign-ins. Full control has no Reach page restrictions. Use reach_act for browser-internal addresses. In Chrome (or Edge on Windows) its tab closes on its own 5 minutes after you stop, sooner with reach_close_tabs; in other browsers close it yourself when done.",
        reach_open_file: "Open a file, program or installer in its associated app, or reveal it in Finder. Use a root from reach_access and a path within it. macOS permissions apply.",
        reach_fill: "Fill fields by label, optionally replace their text and submit. To sign in, use \"Sign in with Google\" (Apple, Microsoft) where the site offers it, else your vault; skip the browser's saved passwords and passkeys, which wait for the owner's fingerprint. Full control can fill password fields; mark vault credentials secret:true so they are not logged or saved.",
        reach_open_bank: "Open the chosen bank in the owner's browser. Full control can interact with it as the owner; follow the owner's instructions.",
        reach_menus: "Read the front app's menu bar, including the Apple menu, with items, shortcuts and enabled states. Give menu to read a submenu. Press an item with reach_act {action:{type:'menu',path:[menu,item]}}.",
        reach_mac_shortcuts: "List every installed Mac Shortcut. Full control can run any of them with reach_run_mac_shortcut.",
        reach_run_mac_shortcut: "Run any installed Mac Shortcut by name as the owner, with optional text input and returned text output. Up to 60 seconds.",
      };
      if (descriptions[tool.name]) tool.description = descriptions[tool.name];
    }
    if (["reach_describe_screen", "reach_elements"].includes(tool.name)) Object.assign(tool.inputSchema.properties, observationFields);
    if (["reach_act", "reach_press", "reach_fill", "reach_open_app", "reach_open_url", "reach_open_bank", "reach_open_file", "reach_focus_window"].includes(tool.name)) {
      Object.assign(tool.inputSchema.properties, afterFields, { describe: describeField });
      tool.description += ` ${ACT_AND_SEE} waitFor: {text or name, timeoutMs} waits for something to appear first; observe: {query, within, maxChars, displayId} narrows the text. A completed action is reported even if reading the screen fails.`;
    }
    if (["reach_describe_screen", "reach_elements"].includes(tool.name)) tool.description += " within skips unrelated native values and geometry on macOS. query/maxChars narrow output; sinceSnapshot returns changes.";
    if (tool.name === "reach_act") tool.description += " In actions, use {type:'wait_for',text or name,timeoutMs} for readiness between steps. Use displayId for coordinates on another display.";
    if (tool.name === "reach_press") tool.inputSchema.properties.within = string(200);
    if (["reach_press", "reach_fill"].includes(tool.name)) tool.inputSchema.properties.displayId = displayId;
    if (tool.name === "reach_wait_for") Object.assign(tool.inputSchema.properties, waitFor.properties, { observe: observation, full: fullField });
    if (tool.name === "reach_screenshot") tool.inputSchema.properties.displayId = displayId;
    if (tool.name === "reach_focus_window") {
      tool.inputSchema.properties.id = { ...string(40), pattern: "^(w-[a-f0-9-]+|[0-9]{1,8}:[0-9]{1,2})$" };
      tool.inputSchema.properties.tabRef = string(40);
    }
    if (tool.name === "reach_tools") Object.assign(tool.inputSchema.properties, { detail: { type: "boolean" }, id: string(48) });
  }
  return tools;
}

/** Tools are created afresh so a caller cannot mutate a shared schema. */
export function browserToolsFor(access = {}) {
  if (access.preset !== undefined) return JSON.parse(JSON.stringify(presetTools(access)));
  const firstRoot = access.roots?.[0]?.index ?? 0;
  const tools = [definition("reach_access", "Access", "Read the session's current limits, expiry, shared folders and terminals.", object(), {})];
  if (access.roots?.length) tools.push(
    definition("reach_list_files", "List files", "List one shared folder. Files are read-only.", object(location, ["root"]), { root: firstRoot, path: "" }),
    definition("reach_search_files", "Find files", "Find files by name inside one shared folder.", object({ root, query: string(160) }, ["root", "query"]), { root: firstRoot, query: "readme" }),
    definition("reach_read_file", "Read a file", "Read a UTF-8 file from a shared folder, subject to the host's size limit.", object(location, ["root", "path"]), { root: firstRoot, path: "README.md" }),
  );
  if (access.terminals?.length) tools.push(definition("reach_read_terminal", "Read terminal output", "Read output from an explicitly shared terminal. This cannot type into or run commands in that terminal.", object({ id: string(256) }, ["id"]), { id: access.terminals[0].id }));
  if (terminalAllowed(access)) tools.push(
    definition("reach_terminal_command", "Run a terminal command", "Submit one command. Supported read-only commands run immediately; other commands require separate owner approval if granted, otherwise are blocked. Every command is logged. Do not resubmit a pending command.", object({ command: string(4000), root, cwd: relativePath }, ["command", "root"]), { command: "pwd", root: firstRoot, cwd: "" }),
    definition("reach_terminal_history", "Command history", "Read this session’s command history and outcomes.", object(), {}),
  );
  if (access.screen === "apps") tools.push(
    definition("reach_apps", "Shared apps", "List apps and this invitation's hidden/view access; host app control requires isolation. Protected apps cannot be granted.", object(), {}),
    definition("reach_app_windows", "App windows", "List standard windows of an allowed app. Target IDs belong only to this invitation.", object({ appId: string(1024) }, ["appId"]), { appId: "/System/Applications/TextEdit.app" }),
    definition("reach_app_screen", "View app window", "Read only the selected window as {image: base64,mimeType}. Other apps and the desktop are excluded.", object({ target: string(128) }, ["target"]), { target: "target-from-reach_app_windows" }),
    definition("reach_request_app", "Request app access", "Ask the owner to share an app for this invitation only. The agent cannot approve requests. Poll reach_list_requests.", object({appId:string(1024),mode:kinds(["view"]),reason},["appId","mode"]), {appId:"/System/Applications/TextEdit.app",mode:"view",reason:"View this app for the requested task."}, {approvalRequired:true}),
  );
  const actions = actionKinds(access);
  if (actions.length) {
    const example = { type: "terminal", root: firstRoot, cwd: "", command: "pwd" };
    tools.push(
      definition("reach_request_action", "Request one action", "Ask the owner to approve one exact restricted terminal command. Returns a pending request; submitting does not execute it.", object({ action: { oneOf: actions }, reason }, ["action", "reason"]), { action: example, reason: "Describe the action's purpose here." }, { approvalRequired: true }),
      definition("reach_request_batch", "Request an action batch", "Ask once for up to five exact actions, in order. Use only restricted terminal commands; no desktop actions or nested batches. Approval covers only the listed actions. Poll reach_list_requests for step outcomes.", object({ actions: { type: "array", minItems: 1, maxItems: 5, items: { oneOf: actions } }, reason }, ["actions", "reason"]), { actions: [example], reason: "Describe this short sequence's purpose here." }, { approvalRequired: true }),
    );
  }
  if (requestsAllowed(access)) tools.push(
    definition("reach_list_requests", "Check requests", "List only this session's requests, their status and any action results. Never repeat a request just because it is pending.", object(), {}),
    definition("reach_cancel_request", "Cancel a request", "Cancel this session's pending or remaining actions. Already completed actions cannot be undone.", object({ id: { ...string(128), pattern: "^[A-Za-z0-9_-]+$" } }, ["id"]), { id: "request-id-from-result" }),
  );
  return JSON.parse(JSON.stringify(tools));
}

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = (detail) => { throw Error(`Invalid tool arguments: ${detail}`); };
function boundedJSON(value, depth = 0) {
  if (depth > 12) invalid("The tool definition is too deeply nested.");
  if (typeof value === "string") { validate(string(20000, 0), value); return; }
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 24 || Reflect.ownKeys(value).some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid("Use a bounded plain array.");
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid("Use plain array values.");
      boundedJSON(descriptor.value, depth + 1);
    }
    return;
  }
  if (!plain(value) || Reflect.ownKeys(value).length > 24) invalid("Use a bounded JSON tool definition.");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key) || !descriptor || !Object.hasOwn(descriptor, "value")) invalid("Use plain definition fields.");
    boundedJSON(descriptor.value, depth + 1);
  }
}
function validate(schema, value, label = "arguments") {
  if (!Object.keys(schema).length) { boundedJSON(value); return; }
  if (schema.oneOf) {
    for (const choice of schema.oneOf) {
      try { validate(choice, value, label); return; } catch { /* Try each supported exact action shape. */ }
    }
    invalid(`${label} must be one of this session's supported actions, with only its listed fields.`);
  }
  if (schema.type === "object") {
    if (!plain(value)) invalid(`${label} must be an object.`);
    if (schema.maxProperties !== undefined && Reflect.ownKeys(value).length > schema.maxProperties) invalid(`${label} has too many fields.`);
    for (const key of Reflect.ownKeys(value)) {
      const property = typeof key === "string" && (Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : schema.additionalProperties === true ? {} : schema.additionalProperties && typeof schema.additionalProperties === "object" && /^text[1-9][0-9]*$/.test(key) ? schema.additionalProperties : null);
      if (!property) invalid(`${label} contains an unsupported field.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid(`${label} must contain only plain values.`);
      validate(property, descriptor.value, `${label}.${key}`);
    }
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required.`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > 24 || value.length < schema.minItems || value.length > schema.maxItems) invalid(`${label} must contain ${schema.minItems} to ${schema.maxItems} items.`);
    if (Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid(`${label} contains unsupported array fields.`);
    // Schemas narrow this further, but caller-controlled lengths never set
    // the loop bound, even if a future definition omits its maximum.
    for (let index = 0; index < 24; index++) {
      if (index >= value.length) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid(`${label} must contain plain actions.`);
      validate(schema.items, descriptor.value, `${label}[${index}]`);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < schema.minLength || value.length > schema.maxLength) invalid(`${label} has an invalid length or type.`);
    if (/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) invalid(`${label} contains hidden control characters.`);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) || value < schema.minimum || (schema.maximum !== undefined && value > schema.maximum)) invalid(`${label} is outside its allowed range.`);
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(`${label} has an unsupported format.`);
  if (schema.enum && !schema.enum.includes(value)) invalid(`${label} is not a supported value.`);
}
function pathAllowed(value) {
  if (value === undefined) return;
  if (value.startsWith("/") || /^[a-z]:/i.test(value) || value.includes("\\") || value.split("/").some((part) => part === "..")) invalid("Paths must remain inside their shared folder.");
}
function rootAllowed(access, value) {
  if (!access.roots?.some((item) => item.index === value)) invalid("Choose a currently shared folder index from reach_access.");
}

/** Returns a fixed request plan. Arbitrary routes, owner APIs and engine configuration are never accepted. */
export function browserToolRequest(name, args, access) {
  const tool = browserToolsFor(access).find((item) => item.name === name);
  if (!tool) throw Error("This tool is not available in the current session.");
  validate(tool.inputSchema, args);
  // Copy before the asynchronous request; later mutations cannot change approval content.
  const input = JSON.parse(JSON.stringify(args));
  if (CODING_TASK_NAMES.includes(name)) return codingTaskRequest(name, input, { agents: ["codex", "claude"], access });
  if (name === "reach_execute") {
    if (input.name === "reach_execute") invalid("Nested execution is not allowed.");
    return browserToolRequest(input.name, input.arguments, access);
  }
  for (const connector of access.services?.connectors || []) for (const action of connector.actions) {
    if (name === `reach_service_${connector.id}_${action.id}`) {
      const { requestId, ...values } = input;
      return { route: "/api/browser/services/run", method: "POST", body: { connectorId: connector.id, action: action.id, values, requestId }, response: "json" };
    }
  }
  if (name === "reach_define_tool" && new TextEncoder().encode(JSON.stringify(input.definition)).length > 24000) invalid("The definition exceeds 24 KiB.");
  const deterministic = (access.browserTools?.tools || []).find(item => deterministicToolName(item) === name);
  if (deterministic) {
    const { browser, requestId, ...values } = input;
    return { route: "/api/browser/tools/run", method: "POST", body: { id: deterministic.id, browser, requestId, values }, response: "json" };
  }
  const saved = (access.savedTools || []).find(item => savedToolName(item) === name);
  if (saved) return { route: "/api/browser/shortcuts/run", method: "POST", body: { id: saved.id, values: input }, response: "json" };
  if (Object.hasOwn(input, "root")) rootAllowed(access, input.root);
  pathAllowed(input.path);
  const actions = name === "reach_request_batch" ? input.actions : name === "reach_request_action" ? [input.action] : [];
  for (const action of actions) if (action.type === "terminal") { rootAllowed(access, action.root); pathAllowed(action.cwd); }
  if (input.reason !== undefined && !input.reason.trim()) invalid("Explain the purpose for the owner.");
  if (name === "reach_read_terminal" && !access.terminals?.some((item) => item.id === input.id)) invalid("This terminal is not shared with this session.");
  const query = new URLSearchParams({ root: String(input.root ?? 0), path: input.path ?? "" });
  if (name === "reach_terminal_command") { rootAllowed(access, input.root); pathAllowed(input.cwd); }
  const get = (route, response = "json") => ({ route, method: "GET", response });
  if (name === "reach_change_file") {
    rootAllowed(access, input.root); pathAllowed(input.to);
    if ((input.op === "cp") !== (input.to !== undefined)) invalid("cp needs to; other operations take no to.");
    if ((input.op === "write") !== (input.content !== undefined)) invalid("write needs content; other operations take no content.");
  }
  if (name === "reach_shell") { rootAllowed(access, input.root); pathAllowed(input.cwd); }
  if (name === "reach_open_file" && (typeof input.path !== "string" || !input.path.trim())) invalid("Name the file inside the shared folder.");
  switch (name) {
    case "reach_services": return get("/api/browser/services");
    case "reach_service_request": return { route: "/api/browser/services/request", method: "POST", body: input, response: "json" };
    case "reach_tools": return get(`/api/browser/tools${readQuery(input)}`);
    case "reach_discover": return get(`/api/browser/mcp/discover${readQuery(input)}`);
    case "reach_displays": return get("/api/browser/desktop/displays");
    case "reach_tool_protocol": return get("/api/browser/tools/protocol");
    case "reach_define_tool": return { route: "/api/browser/tools/define", method: "POST", body: input, response: "json" };
    case "reach_tool_operation": return get(`/api/browser/tools/operations/${input.requestId}`);
    case "reach_tool_batch": return { route: "/api/browser/tools/batch", method: "POST", body: input, response: "json" };
    case "reach_access": return get("/api/browser");
    case "reach_shortcuts": return get(`/api/browser/shortcuts${input.query ? `?${new URLSearchParams({ query: input.query })}` : ""}`);
    case "reach_record_shortcut": return { route: "/api/browser/shortcuts/record", method: "POST", body: input, response: "json" };
    case "reach_save_shortcut": return { route: "/api/browser/shortcuts/save", method: "POST", body: input, response: "json" };
    case "reach_discard_shortcut": return { route: "/api/browser/shortcuts/record", method: "DELETE", response: "json" };
    case "reach_run_shortcut": return { route: "/api/browser/shortcuts/run", method: "POST", body: input, response: "json" };
    case "reach_screenshot": return get(`/api/browser/desktop/screen?${new URLSearchParams({ maxWidth: String(input.maxWidth ?? 2560), ...(input.displayId ? { displayId: String(input.displayId) } : {}) })}`, "image");
    case "reach_front": return get("/api/browser/desktop/front");
    case "reach_windows": return get("/api/browser/desktop/windows");
    case "reach_focus_window": return { route: "/api/browser/desktop/focus", method: "POST", body: { id: input.id, ...(input.title ? { title: input.title } : {}), ...(input.tab ? { tab: input.tab } : {}), ...(input.tabRef ? { tabRef: input.tabRef } : {}), ...after(input) }, response: "json" };
    case "reach_menus": return get(`/api/browser/desktop/menus${input.menu ? `?${new URLSearchParams({ menu: input.menu })}` : ""}`);
    case "reach_read_page": return get(`/api/browser/desktop/read${input.offset ? `?${new URLSearchParams({ offset: String(input.offset) })}` : ""}`);
    case "reach_find":
      if (("text" in input) === ("name" in input)) invalid("Find text, or a control by name.");
      if ("role" in input && !("name" in input)) invalid("A role narrows a name.");
      return { route: "/api/browser/desktop/find", method: "POST", body: input, response: "json" };
    case "reach_open_file": return { route: "/api/browser/desktop/open-file", method: "POST", body: { root: input.root, path: input.path, ...(input.reveal ? { reveal: true } : {}), ...after(input) }, response: "json" };
    case "reach_mac_shortcuts": return get("/api/browser/desktop/mac-shortcuts");
    case "reach_run_mac_shortcut": return { route: "/api/browser/desktop/mac-shortcuts/run", method: "POST", body: { name: input.name, ...(input.input !== undefined ? { input: input.input } : {}) }, response: "json" };
    case "reach_elements": return get(`/api/browser/desktop/elements${readQuery(input)}`);
    case "reach_describe_screen": return get(`/api/browser/desktop/describe${readQuery(input)}`);
    case "reach_request_permission":
      if ((input.need === "browser-tools") !== (input.browser !== undefined)) invalid(input.need === "browser-tools" ? "Name the browser: Chrome, Safari or Edge." : "Only browser-tools names a browser.");
      return { route: "/api/browser/permissions/request", method: "POST", body: input, response: "json" };
    case "reach_open_bank": return { route: "/api/browser/desktop/open-url", method: "POST", body: { url: MONEY_BANKS.find((bank) => bank.name === input.bank).url, ...(input.browser ? { browser: input.browser } : {}), ...after(input) }, response: "json" };
    case "reach_close_tabs": return { route: "/api/browser/desktop/close-tabs", method: "POST", body: input.url ? { url: input.url } : {}, response: "json" };
    case "reach_open_url": return { route: "/api/browser/desktop/open-url", method: "POST", body: { url: input.url, ...(input.browser ? { browser: input.browser } : {}), ...after(input) }, response: "json" };
    case "reach_act":
      if (("action" in input) === ("actions" in input)) invalid("Send action, or actions: a list of up to 10.");
      return { route: "/api/browser/desktop/input", method: "POST", body: { ...("action" in input ? { action: input.action } : { actions: input.actions }), ...after(input) }, response: "json" };
    case "reach_press": {
      const { describe, observe, waitFor, full, ...rest } = input;
      return { route: "/api/browser/desktop/input", method: "POST", body: { action: { type: "press", ...rest }, ...after(input) }, response: "json" };
    }
    case "reach_fill": {
      const { describe, observe, waitFor, full, ...rest } = input;
      return { route: "/api/browser/desktop/input", method: "POST", body: { action: { type: "fill", ...rest }, ...after(input) }, response: "json" };
    }
    case "reach_wait_for":
      if (("text" in input) === ("name" in input)) invalid("Wait for text, or for a control's name.");
      return { route: "/api/browser/desktop/wait", method: "POST", body: input, response: "json" };
    case "reach_desktop_apps": return get("/api/browser/desktop/apps");
    case "reach_open_app": return { route: "/api/browser/desktop/open", method: "POST", body: { app: input.app, ...after(input) }, response: "json" };
    case "reach_change_file": return { route: "/api/browser/files/change", method: "POST", body: input, response: "json" };
    case "reach_shell": return { route: "/api/browser/shell", method: "POST", body: input, response: "json" };
    case "reach_shell_history": return get("/api/browser/shell/history");
    case "reach_apps": return get("/api/browser/apps");
    case "reach_app_windows": return get(`/api/browser/apps/windows?${new URLSearchParams({appId:input.appId})}`);
    case "reach_app_screen": return get(`/api/browser/apps/screen?${new URLSearchParams({target:input.target})}`, "image");
    case "reach_app_input": return {route:"/api/browser/apps/input",method:"POST",body:input,response:"json"};
    case "reach_request_app": return {route:"/api/browser/apps/requests",method:"POST",body:input,response:"json"};
    case "reach_list_files": return get(`/api/files?${query}`);
    case "reach_search_files": return get(`/api/browser/files/search?${new URLSearchParams({ root: String(input.root), q: input.query })}`);
    case "reach_read_file": return get(`/api/files/text?${query}`);
    case "reach_terminal_command": return { route: "/api/browser/terminal", method: "POST", body: input, response: "json" };
    case "reach_terminal_history": return get("/api/browser/terminal/history");
    case "reach_read_terminal": return get(`/api/browser/terminals/${encodeURIComponent(input.id)}`);
    case "reach_request_action": return { route: "/api/browser/requests", method: "POST", body: { ...input.action, reason: input.reason }, response: "json" };
    case "reach_request_batch":
      if (new TextEncoder().encode(JSON.stringify({ type: "batch", actions: input.actions, reason: input.reason })).length > 12000) invalid("The batch is too large. Keep the complete request under 12,000 bytes.");
      return { route: "/api/browser/requests", method: "POST", body: { type: "batch", actions: input.actions, reason: input.reason }, response: "json" };
    case "reach_list_requests": return get("/api/browser/requests");
    case "reach_cancel_request": return { route: `/api/browser/requests/${encodeURIComponent(input.id)}`, method: "DELETE", response: "json" };
    default: throw Error("This tool is not available in the current session.");
  }
}
