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
const location = { root, path: relativePath };
const requestsAllowed = (access) => access.screen === "apps" || access.restrictedTerminal === true || access.commandRequests === true;
const terminalAllowed = (access) => access.restrictedTerminal === true && !!access.roots?.length;
const actionKinds = (access) => terminalAllowed(access) ? [terminalAction] : [];

/** Tools are created afresh so a caller cannot mutate a shared schema. */
export function browserToolsFor(access = {}) {
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
    definition("reach_apps", "Shared apps", "List apps and this invitation's hidden/view/control access. Protected apps cannot be granted.", object(), {}),
    definition("reach_app_windows", "App windows", "List standard windows of an allowed app. Target IDs belong only to this invitation.", object({ appId: string(1024) }, ["appId"]), { appId: "/Applications/Safari.app" }),
    definition("reach_app_screen", "View app window", "Read only the selected window as {image: base64,mimeType}. Other apps and the desktop are excluded.", object({ target: string(128) }, ["target"]), { target: "target-from-reach_app_windows" }),
    definition("reach_app_input", "Use app window", "Interact with a control-enabled window. Unsupported controls stop; no desktop fallback. Observe results before continuing.", object({ target:string(128), action:{oneOf:[object({type:kinds("click"),x:point,y:point},["type","x","y"]), ...screenActions.slice(1)]} }, ["target","action"]), { target: "target-from-reach_app_windows", action:{type:"click",x:0.5,y:0.5} }),
    definition("reach_request_app", "Request app access", "Ask the owner to share an app for this invitation only. The agent cannot approve requests. Poll reach_list_requests.", object({appId:string(1024),mode:kinds(["view","control"]),reason},["appId","mode"]), {appId:"/Applications/Safari.app",mode:"control",reason:"Use this app for the requested task."}, {approvalRequired:true}),
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
function validate(schema, value, label = "arguments") {
  if (schema.oneOf) {
    for (const choice of schema.oneOf) {
      try { validate(choice, value, label); return; } catch { /* Try each supported exact action shape. */ }
    }
    invalid(`${label} must be one of this session's supported actions, with only its listed fields.`);
  }
  if (schema.type === "object") {
    if (!plain(value)) invalid(`${label} must be an object.`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !Object.hasOwn(schema.properties, key)) invalid(`${label} contains an unsupported field.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid(`${label} must contain only plain values.`);
      validate(schema.properties[key], descriptor.value, `${label}.${key}`);
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
  if (Object.hasOwn(input, "root")) rootAllowed(access, input.root);
  pathAllowed(input.path);
  const actions = name === "reach_request_batch" ? input.actions : name === "reach_request_action" ? [input.action] : [];
  for (const action of actions) if (action.type === "terminal") { rootAllowed(access, action.root); pathAllowed(action.cwd); }
  if (input.reason !== undefined && !input.reason.trim()) invalid("Explain the purpose for the owner.");
  if (name === "reach_read_terminal" && !access.terminals?.some((item) => item.id === input.id)) invalid("This terminal is not shared with this session.");
  const query = new URLSearchParams({ root: String(input.root ?? 0), path: input.path ?? "" });
  if (name === "reach_terminal_command") { rootAllowed(access, input.root); pathAllowed(input.cwd); }
  const get = (route, response = "json") => ({ route, method: "GET", response });
  switch (name) {
    case "reach_access": return get("/api/browser");
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
