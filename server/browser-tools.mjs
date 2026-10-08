// One portable catalog for the invited browser and stdio MCP. This is a
// convenience boundary; the host reauthorizes every mapped request as well.
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
  object({ type: kinds("key"), key: kinds(["enter", "backspace", "tab", "escape", "left", "right", "up", "down"]) }, ["type", "key"]),
  object({ type: kinds("scroll"), direction: kinds(["up", "down"]), amount: integer(1, 5) }, ["type", "direction"]),
];
const terminalAction = object({
  type: kinds("terminal"), root, cwd: relativePath,
  command: { ...string(2000), description: "Use pwd, cd, ls, cat, head, tail, wc or grep. Each action supplies its own cwd; cd does not change later actions. A restricted read-only command. The host validates commands and paths and asks the owner before running." },
}, ["type", "root", "command"]);
const definition = (name, title, description, inputSchema, example, extra = {}) => ({ name, title, description, inputSchema, example, ...extra });
export const savedToolName = item => `reach_saved_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 12) || "task"}_${item.id.replace(/-/g, "")}`;
export const SAVED_TOOLS_HINT = "Before starting a laptop task, open Tools in the workspace and search the Tool library, or use reach_tools for a matching named tool. Select its button or call its reach_tool_* tool once with a requestId. To create a deterministic tool, read reach_tool_protocol and submit the same reach.tool.v1 format with reach_define_tool. Older recorded tasks remain in reach_shortcuts.";
export const deterministicToolName = item => `reach_tool_${item.id}`;
const requestId = { ...string(36), pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", description: "A fresh UUID for a new operation. Reuse it after a lost response; effects will never be repeated." };
const toolDefinitionSchema = object({ protocol: kinds("reach.tool.v1"), id: { ...string(48), pattern: "^[a-z][a-z0-9_]*$" }, title: string(80), description: string(500), origins: { type: "array", minItems: 1, maxItems: 4, items: string(2000) }, inputs: { type: "object", maxProperties: 12, additionalProperties: true }, steps: { type: "array", minItems: 1, maxItems: 24, items: { type: "object", maxProperties: 8, additionalProperties: true } } }, ["protocol", "id", "title", "description", "origins", "inputs", "steps"]);
const location = { root, path: relativePath };
const requestsAllowed = (access) => access.screen === "apps" || access.restrictedTerminal === true || access.commandRequests === true;
const terminalAllowed = (access) => access.restrictedTerminal === true && !!access.roots?.length;
const actionKinds = (access) => terminalAllowed(access) ? [terminalAction] : [];

// Preset sessions (agent-presets.mjs): the Mac itself, within the preset.
const fraction = { type: "number", minimum: 0, maximum: 1, description: "A fraction of the screen's width or height, 0 to 1, as seen in the last screenshot." };
const desktopActions = [
  object({ type: kinds("click"), x: fraction, y: fraction, button: kinds(["left", "right"]), count: integer(1, 3), modifiers: { type: "array", minItems: 0, maxItems: 4, items: kinds(["cmd", "shift", "option", "control"]) } }, ["type", "x", "y"]),
  object({ type: kinds("move"), x: fraction, y: fraction }, ["type", "x", "y"]),
  object({ type: kinds("drag"), x: fraction, y: fraction, toX: fraction, toY: fraction }, ["type", "x", "y", "toX", "toY"]),
  object({ type: kinds("scroll"), x: fraction, y: fraction, dx: { type: "number", minimum: -2000, maximum: 2000 }, dy: { type: "number", minimum: -2000, maximum: 2000, description: "Positive scrolls down." } }, ["type", "x", "y"]),
  object({ type: kinds("type"), text: { ...string(2000), description: "Typed into the focused field. Never a password: password fields are closed to you; ask the owner to sign in from their phone." } }, ["type", "text"]),
  object({ type: kinds("key"), key: { ...string(16), description: "A key name: enter, tab, escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f11, a-z, 0-9 or punctuation." }, modifiers: { type: "array", minItems: 0, maxItems: 4, items: kinds(["cmd", "shift", "option", "control"]) } }, ["type", "key"]),
];
function presetTools(access) {
  const firstRoot = access.roots?.[0]?.index ?? 0;
  const tools = [definition("reach_access", "Access", `Read this session's preset, what it may do, its shared folders and when it ends.${access.control && access.open ? ` Also returns savedTools with their callable tool names. ${SAVED_TOOLS_HINT}` : ""}`, object(), {})];
  if (access.screen) tools.push(
    definition("reach_screenshot", "Screenshot", "The Mac's screen now, as {image: base64 JPEG, mimeType}, at the display's own resolution up to maxWidth pixels (default 2560; use up to 3840 to read small controls). Reach's own windows, password apps and apps the owner hid are left out; in the Apps preset only the chosen apps appear. Coordinates for actions are fractions of this image.", object({ maxWidth: integer(320, 3840) }), { maxWidth: 2560 }),
    definition("reach_front", "What is in front", "The app and window in front, whether it takes commands (a terminal) or a password, why it is closed to you if it is, and which agent holds the Mac if another does.", object(), {}),
  );
  if (access.control) tools.push(
    definition("reach_act", "Act on the screen", "Before repeating a laptop task, check reach_shortcuts or the reach_saved_* tools for a saved method. One mouse or keyboard action, checked against exactly what it would reach. Refusals say why: blocked (never allowed there), busy (another agent holds the Mac; wait retryInMs), paused (the owner is using the Mac or controlling it from their phone; wait), retry (focus moved; look again). Take a screenshot after acting.", object({ action: { oneOf: desktopActions } }, ["action"]), { action: { type: "click", x: 0.5, y: 0.5 } }),
  );
  if (access.open) tools.push(
    definition("reach_desktop_apps", "Apps you may use", "The apps this session may open or bring forward, with whether each is running.", object(), {}),
    definition("reach_open_app", "Open an app", "Open or bring forward one of those apps by its path, then take a screenshot.", object({ app: string(4096) }, ["app"]), { app: access.apps?.[0]?.id || "/Applications/Safari.app" }),
  );
  if (access.control && access.open && access.screen) tools.push(
    definition("reach_tools", "Find deterministic tools", "Check here before browser tasks. Returns the named built-in and agent-created tools, their exact reach.tool.v1 definitions and allowed browsers. Search by task name.", object({ query: string(160) }), { query: "Gmail" }),
    definition("reach_tool_protocol", "Tool creation protocol", "Read reach.tool.v1: declared inputs, HTTPS origins, fixed DOM operations and checked results. The built-in tools use this same format. No JavaScript, shell or guessed steps.", object(), {}),
    definition("reach_define_tool", "Create deterministic tool", "Validate and save a new immutable reach.tool.v1 definition. It immediately appears as a named button and MCP tool. Read reach_tool_protocol and inspect reach_tools first; use a new ID. Creating a definition does not execute it.", object({ definition: toolDefinitionSchema }, ["definition"]), {}),
    definition("reach_tool_operation", "Check tool run", "Recover a lost response by requestId without repeating any browser action. Handles expire and do not survive a Reach restart.", object({ requestId }, ["requestId"]), {}),
    definition("reach_shortcuts", "Saved shortcuts", "Check here before app tasks. Find reusable tasks and required inputs within your current access. Without query, returns a compact catalog. Search by task name to inspect up to ten matching shortcuts' exact steps before running one. Also reports your current recording.", object({ query: string(160) }), { query: "Gmail" }),
    definition("reach_record_shortcut", "Record a shortcut", "Before doing a reusable task with no matching shortcut, record your successful reach_act and reach_open_app calls under a clear task name. Form text becomes an input supplied at replay; passwords and screenshots are never saved. Use Type for form text; text-producing key presses stop recording. Cmd+L, an HTTPS origin landing page (no path, query or fragment), Enter becomes a stable Open website step. Other addresses stay per-run inputs.", object({ name: string(80) }, ["name"]), { name: "Open Gmail" }),
    definition("reach_save_shortcut", "Save recorded shortcut", "After verifying the task succeeded, save its recording as a reusable local shortcut. Future agents can discover and replay it immediately within their own current app permissions. Saving needs no extra owner step. Discard failed or incomplete tasks instead.", object(), {}),
    definition("reach_discard_shortcut", "Discard recording", "Discard your current shortcut recording without undoing completed actions.", object(), {}),
    definition("reach_run_shortcut", "Run saved shortcut", "Run one enabled shortcut by ID in a single call, with your current permissions checked before every step. Text inputs are never stored. Stops at changed windows, password fields, owner activity, pause or revoked access. Inspect status and completedSteps; stopped steps are not rolled back. Never blindly retry a partially completed task. Take a screenshot after completion to verify the result.", object({ id: string(128), values: { type: "object", maxProperties: 60, additionalProperties: string(2000) } }, ["id"]), { id: "shortcut-id-from-reach_shortcuts" }),
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
    tools.push(definition(deterministicToolName(item), item.title, `${item.description} Fixed ${item.steps.length}-step protocol. Stops on missing, ambiguous or stale targets. Check status and completedSteps; retry only with the SAME requestId after a lost response.`, object(properties, required), example));
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
  switch (name) {
    case "reach_tools": return get(`/api/browser/tools${input.query ? `?${new URLSearchParams({ query: input.query })}` : ""}`);
    case "reach_tool_protocol": return get("/api/browser/tools/protocol");
    case "reach_define_tool": return { route: "/api/browser/tools/define", method: "POST", body: input, response: "json" };
    case "reach_tool_operation": return get(`/api/browser/tools/operations/${input.requestId}`);
    case "reach_access": return get("/api/browser");
    case "reach_shortcuts": return get(`/api/browser/shortcuts${input.query ? `?${new URLSearchParams({ query: input.query })}` : ""}`);
    case "reach_record_shortcut": return { route: "/api/browser/shortcuts/record", method: "POST", body: input, response: "json" };
    case "reach_save_shortcut": return { route: "/api/browser/shortcuts/save", method: "POST", body: input, response: "json" };
    case "reach_discard_shortcut": return { route: "/api/browser/shortcuts/record", method: "DELETE", body: input, response: "json" };
    case "reach_run_shortcut": return { route: "/api/browser/shortcuts/run", method: "POST", body: input, response: "json" };
    case "reach_screenshot": return get(`/api/browser/desktop/screen?${new URLSearchParams({ maxWidth: String(input.maxWidth ?? 2560) })}`, "image");
    case "reach_front": return get("/api/browser/desktop/front");
    case "reach_act": return { route: "/api/browser/desktop/input", method: "POST", body: { action: input.action }, response: "json" };
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
