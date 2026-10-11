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
export const savedToolName = item => `reach_saved_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 12) || "task"}_${item.id.replace(/-/g, "")}`;
export const SAVED_TOOLS_HINT = "Before starting a laptop task, open Tools in the workspace, search for a matching task, and click Run, or use reach_tools and call its reach_tool_* tool once with a requestId. Apps, Files, Commands and Access are under More. To create a deterministic tool, read reach_tool_protocol and submit the same reach.tool.v1 format with reach_define_tool. Recorded tasks are in Tools under Recorded tasks, and in reach_shortcuts.";
export const deterministicToolName = item => `reach_tool_${item.id}`;
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
  object({ type: kinds("type"), text: { ...string(2000), description: "Typed into the focused field." }, secret: { type: "boolean", const: true, description: "Set for a username, email or password from your vault: it goes into the focused field (password fields included, never a terminal) and is never echoed, logged or saved. Plain text never goes into a password field." }, paste: { type: "boolean", enum: [true], description: "Long text in one go: through the clipboard and ⌘V instead of keystrokes (the owner's clipboard text comes back after). Not for vault values." } }, ["type", "text"]),
  object({ type: kinds("key"), key: { ...string(16), description: "A key name: enter, tab, escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f11, a-z, 0-9 or punctuation." }, modifiers: { type: "array", minItems: 0, maxItems: 4, items: kinds(["cmd", "shift", "option", "control"]) } }, ["type", "key"]),
  // A control from reach_describe_screen, pressed at its live center on the
  // Mac: no screenshot, no coordinates (agent-desktop.mjs normalizeAction).
  object({ type: kinds("element"), snapshot: { ...string(40), pattern: "^[A-Za-z0-9-]{1,40}$", description: "The snapshot from reach_describe_screen or reach_elements." }, n: { ...integer(1, 500), description: "The control's [number] there." }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs }, ["type", "snapshot", "n"]),
  // The same by name (press), and a form's fields by their labels (fill).
  object({ type: kinds("press"), name: { ...string(120), description: "The control's name as the screen describes it." }, role: { ...string(40), pattern: "^[A-Za-z]{1,40}$", description: "Narrow to a role: Button, Link, Tab, MenuItem, CheckBox…" }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs }, ["type", "name"]),
  object({ type: kinds("fill"), fields: { type: "array", minItems: 1, maxItems: 12, items: object({ label: { ...string(120), description: "The field's label or placeholder as the screen describes it." }, text: string(2000), secret: { type: "boolean", enum: [true], description: "A username, email or password from your vault: typed unseen, never echoed." } }, ["label", "text"]) }, submit: { type: "boolean", enum: [true], description: "Press Enter after the last field." }, replace: { type: "boolean", enum: [true], description: "Clear each field first (not a password field)." }, paste: { type: "boolean", enum: [true], description: "Paste each field's text instead of typing it (long text); vault values are still typed." } }, ["type", "fields"]),
  // A menu item by its path, pressed through accessibility: no pointer needed.
  object({ type: kinds("menu"), path: { type: "array", minItems: 1, maxItems: 6, items: string(80), description: "The menu's title, then each item down to the one to press: [\"File\", \"Export As\", \"PDF…\"]. reach_menus lists them." } }, ["type", "path"]),
];
// A pause between batched actions, for a page or menu to appear.
const waitAction = object({ type: kinds("wait"), ms: { ...integer(50, 2000), description: "Milliseconds, up to 2000." } }, ["type", "ms"]);
function presetTools(access) {
  const firstRoot = access.roots?.[0]?.index ?? 0;
  const tools = [definition("reach_access", "Access", `Read this session's preset, what it may do, its shared folders and when it ends. Your user's request is your permission: act without asking at each step, but ask your user before paying, sending a message or deleting something. Sign in with reach_act type + secret from your vault; read emailed codes in Gmail or Mail on the Mac. The Mac refuses for a missing permission: ask the owner with reach_request_permission. Bank, card and brokerage sites (reach_open_bank) are read-only: sign in, read balances and transactions, search, filter by date, download statements, then sign out; anything that moves money or changes the account is refused.${access.control && access.open ? ` Also returns savedTools with their callable tool names. ${SAVED_TOOLS_HINT}` : ""}`, object(), {})];
  // Any preset: a permission the Mac lacks goes to the owner as one tap.
  tools.push(definition("reach_request_permission", "Ask the owner for a Mac permission", "When the Mac refuses for a missing permission (\"setup_required\", \"Allow JavaScript from Apple Events\", Automation, Screen Recording, Accessibility), ask the owner here instead of telling them where to click: they get a notification and one tap on their phone. need: browser-tools (with browser: Chrome or Safari), screen-recording or accessibility; reason: one sentence for the owner. Answers ready (already allowed), pending (asked; call again in a minute), allowed or denied. Ask once per need; repeats return the same request.", object({ need: { ...string(20), enum: ["browser-tools", "screen-recording", "accessibility"] }, browser: { ...string(10), enum: ["Chrome", "Safari"] }, reason: string(300) }, ["need", "reason"]), { need: "browser-tools", browser: "Chrome", reason: "To check your Uber Eats cart with the saved tool, many items at once." }));
  if (access.services) {
    tools.push(
      definition("reach_services", "Services", "Discover available service tools and this agent's service access. Service consent is separate from laptop permissions.", object(), {}),
      definition("reach_service_request", "Request service access", "Request read-only service access from the owner once for this agent session. Repeated calls reuse an open request. Poll reach_services; never approve your own access.", object({ connectorId: string(48), reason: string(300) }, ["connectorId", "reason"]), access.services.connectors?.[0] ? { connectorId: access.services.connectors[0].id, reason: "Read the requested information." } : {}, { approvalRequired: true }),
    );
    for (const connector of access.services.connectors || []) for (const action of connector.unavailable ? [] : connector.actions) {
      tools.push(definition(`reach_service_${connector.id}_${action.id}`, `${action.title} · ${connector.name}`,
        `${connector.description} ${action.permission}. First request service access with reach_service_request if not approved; after approval reuse it for this session.`,
        { ...action.inputSchema, properties: { ...action.inputSchema.properties, requestId }, required: [...(action.inputSchema.required || []), "requestId"] },
        { ...action.example, requestId: "00000000-0000-4000-8000-000000000001" }));
    }
  }
  if (access.screen) tools.push(
    definition("reach_screenshot", "Screenshot", "The Mac's screen now, as {image: base64 JPEG, mimeType}, at the display's own resolution up to maxWidth pixels (default 2560; use up to 3840 to read small controls). Reach's own windows, password apps and apps the owner hid are left out; in the Apps preset only the chosen apps appear. Coordinates for actions are fractions of this image.", object({ maxWidth: integer(320, 3840) }), { maxWidth: 2560 }),
    definition("reach_front", "What is in front", "The app and window in front, whether it takes commands (a terminal) or a password, why it is closed to you if it is, and which agent holds the Mac if another does. A browser: its page's address (url) and its tabs (tabs, the chosen one marked).", object(), {}),
    definition("reach_windows", "Every open window", "Every window you may know of, across apps: {id, app, title, minimized, front} and, for a browser window, its page (url) and its tabs ([{title, selected}]). Use it to find the right window or tab instead of guessing, then reach_focus_window. Apps the owner hid or protected aren't listed.", object(), {}),
  );
  if (access.control) tools.push(
    definition("reach_describe_screen", "Describe the screen", "Start here: the front window as text, from the Mac's accessibility tree. Its app and title, the text a person reads there in reading order, and every button, link and field inline as [n] Role \"name\". Click one with reach_act {type: \"element\", snapshot, n}; no screenshot needed. Describe again after the screen changes. Something not listed yet (a long page): reach_find scrolls to it; the whole text: reach_read_page. Pictures, maps and games have no text: use reach_screenshot for those.", object(), {}),
    definition("reach_elements", "Numbered elements", "The same as reach_describe_screen, as data: {snapshot, app, title, items: [{n, role, name, value, x, y, w, h}], texts: [{text, heading, x, y, w, h}]} (fractions of the screen). Click one exactly with reach_act {type: \"element\", snapshot, n}.", object(), {}),
    definition("reach_find", "Find on the screen", "Find something in the front window by its words, wherever it is, what is scrolled out of view included: text (a heading, a price, a label) or a control by name (and role). It is scrolled into view, then the screen is read again: you get its [n] in a fresh snapshot, ready for reach_act {type: \"element\", snapshot, n}. One call instead of scroll, describe, scroll, describe. found: false means it isn't in this window. inView: false with a direction and distance: scroll that way, then find again.", object({ text: string(200), name: string(120), role: { ...string(40), pattern: "^[A-Za-z]{1,40}$", description: "With name: narrow to a role such as Button, Link, TextField." } }), { text: "Order total" }),
    definition("reach_menus", "Read the menu bar", "The front app's menu bar: each menu's items with their keyboard shortcuts (key, like ⇧⌘S), dimmed ones (enabled: false), checked ones, and which open a submenu. Give menu to read one menu with its submenus. Then press an item with reach_act {type: \"menu\", path: [\"File\", \"Export As\", \"PDF…\"]} (no pointer needed, so it runs beside the person), or use the shortcut with a key action. Never the Apple menu.", object({ menu: string(80) }), { menu: "File" }),
    definition("reach_read_page", "Read the page", "The front window's whole text, in reading order, what is scrolled out of view included: a web page, an email, a document, a terminal. Controls appear in [brackets]; no numbers, no coordinates. Up to 12000 characters a call: more: true means call again with the offset given as nextOffset. For a browser it reads the page, not the toolbar.", object({ offset: integer(0, 60000) }), {}),
    definition("reach_press", "Press a control by name", "Press a button, link, tab or menu item by the name reach_describe_screen shows, no number needed: the exact name first, then one starting with it. Several match: refused with the count (press one by number). Nothing matches: describe the screen. Works inside reach_act batches as {type: \"press\", name}. For a \"press and hold\" button or a long press, add holdMs. Add describe: true for the screen as text after.", object({ name: string(120), role: { ...string(40), pattern: "^[A-Za-z]{1,40}$", description: "Narrow to a role: Button, Link, Tab, MenuItem, CheckBox…" }, button: kinds(["left", "right"]), count: integer(1, 3), holdMs, describe: { type: "boolean", enum: [true] } }, ["name"]), { name: "Add to cart", describe: true }),
    definition("reach_fill", "Fill a form", "Type into a form's fields by their labels, all in one call (reach_describe_screen lists them under Fields): each field is clicked, then typed into; submit: true presses Enter at the end; replace: true clears a field first (text appends otherwise). For a username, email or password from your vault, set secret: true on that field: it goes in unseen and is never shown back to you; only a secret goes into a password field. Works inside reach_act batches as {type: \"fill\", fields}.", object({ fields: { type: "array", minItems: 1, maxItems: 12, items: object({ label: string(120), text: string(2000), secret: { type: "boolean", enum: [true] } }, ["label", "text"]) }, submit: { type: "boolean", enum: [true] }, replace: { type: "boolean", enum: [true] }, describe: { type: "boolean", enum: [true] } }, ["fields"]), { fields: [{ label: "Email", text: "from your vault", secret: true }, { label: "Password", text: "from your vault", secret: true }], submit: true, describe: true }),
    definition("reach_wait_for", "Wait for the screen", "The Mac waits until its screen shows some text, or a control by name (a page loaded, a dialog appeared), up to 15 seconds, then returns the screen as text; found: false after the wait. One call instead of describing again and again.", object({ text: string(200), name: string(120), timeoutMs: integer(500, 15000) }), { text: "Order placed", timeoutMs: 8000 }),
    definition("reach_act", "Act on the screen", "Act on the Mac: one action, or actions: up to 10 in order (they stop at the first one refused). Prefer {type: \"element\", snapshot, n} from reach_describe_screen, then type and key: for example [element 3, type \"diapers\", key enter]. Add {type: \"wait\", ms} where a page has to load. Menu items: {type: \"menu\", path} (reach_menus). Long text: type with paste: true. Something out of view: reach_find instead of scrolling blind. Long press or \"press and hold\": holdMs on click, element or press (the button stays down that long). Drag: holdMs to hold before moving, durationMs for a slower move. Add describe: true to get the screen as text back in the same call, with a fresh snapshot: act and see in one step, no screenshot. Each action is checked against exactly what it would reach. Refusals say why: blocked (never allowed there), busy (another agent holds the Mac; wait retryInMs), paused (the owner paused you or is controlling the Mac; wait), retry (the screen changed; describe again).", object({ action: { oneOf: desktopActions }, actions: { type: "array", minItems: 1, maxItems: 10, items: { oneOf: [...desktopActions, waitAction] } }, describe: { type: "boolean", enum: [true], description: "Return the screen as text after acting." } }), { actions: [{ type: "element", snapshot: "SNAPSHOT", n: 3 }, { type: "type", text: "diapers" }, { type: "key", key: "enter" }], describe: true }),
  );
  if (access.open) tools.push(
    definition("reach_desktop_apps", "Apps you may use", "The apps this session may open or bring forward, with whether each is running.", object(), {}),
    definition("reach_open_app", "Open an app", "Open or bring forward one of those apps by its name (\"Calculator\") or path. Answers once it is in front; then describe the screen. A particular window or tab of an app: reach_windows, then reach_focus_window.", object({ app: string(4096) }, ["app"]), { app: access.apps?.[0]?.name || "Calculator" }),
    definition("reach_open_bank", "Open the owner's bank", `Read the owner's bank, card or brokerage accounts (balances, transactions, statements): opens ${MONEY_BANKS.slice(0, 4).map((bank) => bank.name).join(", ")} or another listed bank at its sign-in, in the owner's browser. Then sign in with reach_fill from your vault (an emailed code: Gmail or Mail), read with reach_describe_screen or reach_read_page, open Statements or Documents and press Download (the file lands in Downloads), and sign out. Bank pages are read-only: anything that moves money or changes the account is refused, and saved tools don't run there.`, object({ bank: { ...string(40), enum: MONEY_BANKS.map((bank) => bank.name) }, browser: string(4096) }, ["bank"]), { bank: MONEY_BANKS[1].name }),
    definition("reach_open_url", "Open a website", "Open a web address in the owner's own browser, with their sign-ins and cookies: the default browser, or browser by name (\"Google Chrome\"). Answers once it is in front; then describe the screen. Reach's own pages and saved-password pages stay closed. A bank: reach_open_bank.", object({ url: string(2048), browser: string(4096) }, ["url"]), { url: "https://www.ubereats.com" }),
    definition("reach_focus_window", "Bring a window forward", "Bring one window forward by the id reach_windows gave (its title checked again), unminimizing it if needed; in a browser window, also choose a tab by its title (tab). Answers once it is in front; then describe the screen.", object({ id: { ...string(12), pattern: "^[0-9]{1,8}:[0-9]{1,2}$" }, title: string(200, 0), tab: string(120) }, ["id"]), { id: "4242:0", title: "Inbox", tab: "Order confirmation" }),
    definition("reach_mac_shortcuts", "Mac shortcuts you may run", "The Mac's own Shortcuts (the Shortcuts app) the owner allowed agents to run, by name. Run one with reach_run_mac_shortcut. Asking for one that isn't allowed tells the owner, who can switch it on in Reach.", object(), {}),
    definition("reach_run_mac_shortcut", "Run a Mac shortcut", "Run one allowed shortcut by name, with optional text input, and get its text output: a deterministic step into Mail, Calendar, Notes, Finder or anything the owner automated, in one call. Up to 60 seconds. Not allowed yet: refused, and the owner is told once.", object({ name: string(120), input: string(20000, 0) }, ["name"]), { name: "Today's events" }),
  );
  if (access.open && access.roots?.length) tools.push(
    definition("reach_open_file", "Open a file", "Open a file from a shared folder in the app that owns it (a PDF in Preview, a spreadsheet in Numbers), or reveal: true to show it selected in the Finder. Answers once the app is in front; then describe the screen. Programs, scripts and installers never open this way.", object({ root, path: relativePath, reveal: { type: "boolean", enum: [true] } }, ["root", "path"]), { root: firstRoot, path: "Invoices/march.pdf" }),
  );
  // The same saved tool for a list of items, each in a Chrome tab of its own
  // (agent-tools.mjs batch): offered with the tools it runs, and named in
  // their descriptions so an agent repeating one finds it.
  const batchable = (access.browserTools?.tools || []).filter(item => item.protocol === "reach.tool.v1" && /^[a-z][a-z0-9_]{0,47}$/.test(item.id));
  const batchOffered = !!(access.control && access.open && access.screen && batchable.length && access.browserTools.browsers?.includes("Chrome"));
  if (access.control && access.open && access.screen) tools.push(
    definition("reach_tools", "Find deterministic tools", `Check here before browser tasks. Returns the named built-in and agent-created tools, their exact reach.tool.v1 definitions and allowed browsers. Search by task name.${batchOffered ? " For the same tool over a list of items, use reach_tool_batch." : ""}`, object({ query: string(160) }), { query: "Gmail" }),
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
    definition("reach_tool_batch", "Run a tool on many tabs at once", "Run one saved tool for a list of up to 10 items at once, each in its own Chrome tab: a grocery list, several searches, prices to compare. The tabs open behind and their pages load in parallel; the steps then run tab by tab, so cart clicks never collide. Returns one result per item. More than 10: call again with the next 10 and a new requestId. Lost or partial response: call again with the SAME requestId and items; finished items are never repeated. Shopping: first batch a search tool with keepTabs: true, pick each item's handle, then batch a handle tool (add to cart) on those handles; read the cart once at the end.", object({
      id: { ...kinds(batchable.map(item => item.id)), description: "The tool to run for every item (reach_tools)." },
      browser: kinds(["Chrome"]),
      requestId,
      items: { type: "array", minItems: 1, maxItems: 10, description: "One object of the tool's declared inputs per tab.", items: object(Object.fromEntries(batchable.flatMap(item => Object.keys(item.inputs || {})).filter(key => !["browser", "requestId"].includes(key)).map(key => [key, string(2000, 0)]))) },
      keepTabs: { type: "boolean", description: "Keep the tabs open for the item handles they returned. Otherwise the tabs Reach opened close at the end." },
    }, ["id", "browser", "requestId", "items"]), { id: batchable[0].id, browser: "Chrome", requestId: "00000000-0000-4000-8000-000000000001", items: [{}] }),
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
    definition("reach_shell", "Run a command", "Run one shell command as the owner, from a folder inside a shared folder, with a 60-second and 256 KiB limit. Commands that need the owner's password, erase the Mac, read secrets or touch Reach are refused and logged; everything else runs at once and is logged. Returns the record with its output.", object({ command: string(4000), root, cwd: relativePath }, ["command", "root"]), { command: "ls -la", root: firstRoot, cwd: "" }),
    definition("reach_shell_history", "Command history", "This session's commands and their outcomes.", object(), {}),
  );
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
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) invalid(`${label} must contain ${schema.minItems} to ${schema.maxItems} items.`);
    if (Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid(`${label} contains unsupported array fields.`);
    for (let index = 0; index < value.length; index++) {
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

/** Returns a fixed request plan. Arbitrary routes, execution, owner APIs and delegation are never accepted. */
export function browserToolRequest(name, args, access) {
  const tool = browserToolsFor(access).find((item) => item.name === name);
  if (!tool) throw Error("This tool is not available in the current session.");
  validate(tool.inputSchema, args);
  // Copy before the asynchronous request; later mutations cannot change approval content.
  const input = JSON.parse(JSON.stringify(args));
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
    case "reach_tools": return get(`/api/browser/tools${input.query ? `?${new URLSearchParams({ query: input.query })}` : ""}`);
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
    case "reach_screenshot": return get(`/api/browser/desktop/screen?${new URLSearchParams({ maxWidth: String(input.maxWidth ?? 2560) })}`, "image");
    case "reach_front": return get("/api/browser/desktop/front");
    case "reach_windows": return get("/api/browser/desktop/windows");
    case "reach_focus_window": return { route: "/api/browser/desktop/focus", method: "POST", body: { id: input.id, ...(input.title ? { title: input.title } : {}), ...(input.tab ? { tab: input.tab } : {}) }, response: "json" };
    case "reach_menus": return get(`/api/browser/desktop/menus${input.menu ? `?${new URLSearchParams({ menu: input.menu })}` : ""}`);
    case "reach_read_page": return get(`/api/browser/desktop/read${input.offset ? `?${new URLSearchParams({ offset: String(input.offset) })}` : ""}`);
    case "reach_find":
      if (("text" in input) === ("name" in input)) invalid("Find text, or a control by name.");
      if ("role" in input && !("name" in input)) invalid("A role narrows a name.");
      return { route: "/api/browser/desktop/find", method: "POST", body: input, response: "json" };
    case "reach_open_file": return { route: "/api/browser/desktop/open-file", method: "POST", body: { root: input.root, path: input.path, ...(input.reveal ? { reveal: true } : {}) }, response: "json" };
    case "reach_mac_shortcuts": return get("/api/browser/desktop/mac-shortcuts");
    case "reach_run_mac_shortcut": return { route: "/api/browser/desktop/mac-shortcuts/run", method: "POST", body: { name: input.name, ...(input.input !== undefined ? { input: input.input } : {}) }, response: "json" };
    case "reach_elements": return get("/api/browser/desktop/elements");
    case "reach_describe_screen": return get("/api/browser/desktop/describe");
    case "reach_request_permission":
      if ((input.need === "browser-tools") !== (input.browser !== undefined)) invalid(input.need === "browser-tools" ? "Name the browser: Chrome or Safari." : "Only browser-tools names a browser.");
      return { route: "/api/browser/permissions/request", method: "POST", body: input, response: "json" };
    case "reach_open_bank": return { route: "/api/browser/desktop/open-url", method: "POST", body: { url: MONEY_BANKS.find((bank) => bank.name === input.bank).url, ...(input.browser ? { browser: input.browser } : {}) }, response: "json" };
    case "reach_open_url": return { route: "/api/browser/desktop/open-url", method: "POST", body: { url: input.url, ...(input.browser ? { browser: input.browser } : {}) }, response: "json" };
    case "reach_act":
      if (("action" in input) === ("actions" in input)) invalid("Send action, or actions: a list of up to 10.");
      return { route: "/api/browser/desktop/input", method: "POST", body: { ...("action" in input ? { action: input.action } : { actions: input.actions }), ...(input.describe ? { describe: true } : {}) }, response: "json" };
    case "reach_press": {
      const { describe, ...rest } = input;
      return { route: "/api/browser/desktop/input", method: "POST", body: { action: { type: "press", ...rest }, ...(describe ? { describe: true } : {}) }, response: "json" };
    }
    case "reach_fill": {
      const { describe, ...rest } = input;
      return { route: "/api/browser/desktop/input", method: "POST", body: { action: { type: "fill", ...rest }, ...(describe ? { describe: true } : {}) }, response: "json" };
    }
    case "reach_wait_for":
      if (("text" in input) === ("name" in input)) invalid("Wait for text, or for a control's name.");
      return { route: "/api/browser/desktop/wait", method: "POST", body: input, response: "json" };
    case "reach_desktop_apps": return get("/api/browser/desktop/apps");
    case "reach_open_app": return { route: "/api/browser/desktop/open", method: "POST", body: { app: input.app }, response: "json" };
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
