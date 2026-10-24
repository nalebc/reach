// Reach's MCP tools over stdio JSON-RPC, for any way of reaching the
// computer: `api(route, method, body)` does the requests (HTTPS on the
// tailnet, or the agent's own tailnet node). Only JSON-RPC goes to `output`.
import readline from "node:readline";
import { REACH_VERSION } from "../server/reach-version.mjs";
import { agentErrorDetails, idSegment } from "../server/agent-transport.mjs";
import { browserToolsFor, browserToolRequest, compactTools, CODING_TASK_NAMES, codingTaskTools, codingTaskRequest } from "../server/browser-tools.mjs";

const BROWSER_ONLY_NAMES = new Set(["reach_discover", "reach_execute", "reach_displays","reach_shortcuts", "reach_record_shortcut", "reach_save_shortcut", "reach_discard_shortcut", "reach_run_shortcut", "reach_access", "reach_search_files", "reach_read_terminal", "reach_screen", "reach_scroll", "reach_request_action", "reach_request_batch", "reach_list_requests", "reach_cancel_request", "reach_terminal_command", "reach_terminal_history", "reach_apps", "reach_app_windows", "reach_app_screen", "reach_request_app", "reach_screenshot", "reach_front", "reach_act", "reach_press", "reach_fill", "reach_wait_for", "reach_elements", "reach_describe_screen", "reach_open_url", "reach_desktop_apps", "reach_change_file", "reach_shell", "reach_shell_history",
  "reach_windows", "reach_focus_window", "reach_find", "reach_menus", "reach_read_page", "reach_open_file", "reach_mac_shortcuts", "reach_run_mac_shortcut", "reach_open_bank", "reach_request_permission"]);
const BROWSER_TOOL_SCOPES = {
  reach_discover: "browser:read", reach_execute: "browser:read", reach_displays: "browser:screen",
  reach_services: "browser:read", reach_service_request: "browser:read",
  reach_tools: "browser:control", reach_tool_protocol: "browser:control", reach_define_tool: "browser:control", reach_tool_operation: "browser:control",
  reach_access: "browser:read", reach_list_files: "files:read", reach_search_files: "files:read", reach_read_file: "files:read",
  reach_read_terminal: "browser:read", reach_screen: "browser:read", reach_scroll: "browser:scroll",
  reach_request_action: "browser:request", reach_request_batch: "browser:request", reach_list_requests: "browser:request", reach_cancel_request: "browser:request",
  reach_terminal_command: "browser:request", reach_terminal_history: "browser:request",
  reach_apps: "browser:read", reach_app_windows: "browser:read", reach_app_screen: "browser:read", reach_request_app: "browser:request",
  // Preset sessions (server/agent-presets.mjs): the Mac itself, within the preset.
  reach_screenshot: "browser:screen", reach_front: "browser:screen", reach_act: "browser:control",
  reach_elements: "browser:control", reach_describe_screen: "browser:control",
  reach_press: "browser:control", reach_fill: "browser:control", reach_wait_for: "browser:control",
  reach_find: "browser:control", reach_menus: "browser:control", reach_read_page: "browser:control", reach_windows: "browser:screen",
  reach_desktop_apps: "browser:open", reach_open_app: "browser:open", reach_open_url: "browser:open", reach_change_file: "browser:write",
  reach_focus_window: "browser:open", reach_open_file: "browser:open", reach_mac_shortcuts: "browser:open", reach_run_mac_shortcut: "browser:open",
  reach_open_bank: "browser:open", reach_request_permission: "browser:read",
  reach_shell: "browser:shell", reach_shell_history: "browser:shell",
  reach_start_coding_task: "browser:shell", reach_get_coding_task: "browser:shell", reach_list_coding_tasks: "browser:shell", reach_cancel_coding_task: "browser:shell",
  reach_shortcuts: "browser:control", reach_record_shortcut: "browser:control", reach_save_shortcut: "browser:control", reach_discard_shortcut: "browser:control", reach_run_shortcut: "browser:control",
};
// Tools that change the Mac, and the ones whose changes can't be undone.
const BROWSER_WRITES = new Set(["reach_start_coding_task", "reach_cancel_coding_task", "reach_execute","reach_service_request", "reach_record_shortcut", "reach_save_shortcut", "reach_discard_shortcut", "reach_run_shortcut", "reach_scroll", "reach_request_action", "reach_request_batch", "reach_cancel_request", "reach_terminal_command", "reach_request_app", "reach_act", "reach_press", "reach_fill", "reach_open_app", "reach_open_url", "reach_change_file", "reach_shell", "reach_find", "reach_focus_window", "reach_open_file", "reach_run_mac_shortcut", "reach_open_bank", "reach_request_permission"]);
const BROWSER_DESTRUCTIVE = new Set(["reach_start_coding_task", "reach_cancel_coding_task", "reach_execute", "reach_run_shortcut", "reach_terminal_command", "reach_change_file", "reach_shell", "reach_act", "reach_press", "reach_fill", "reach_open_app", "reach_open_url", "reach_open_file", "reach_run_mac_shortcut", "reach_discard_shortcut", "reach_cancel_request"]);
const BROWSER_OPEN_WORLD = new Set(["reach_start_coding_task", "reach_execute", "reach_run_shortcut", "reach_terminal_command", "reach_shell", "reach_act", "reach_press", "reach_fill", "reach_scroll", "reach_find", "reach_focus_window", "reach_open_app", "reach_open_url", "reach_open_bank", "reach_open_file", "reach_run_mac_shortcut", "reach_request_action", "reach_request_batch", "reach_request_app"]);
function browserAnnotations(name, approvalRequired) {
  const toolEffect = name.startsWith("reach_tool_") && !["reach_tool_protocol", "reach_tool_operation"].includes(name);
  const savedEffect = name.startsWith("reach_saved_");
  // MCP's destructiveHint:false promises only additive updates. Arbitrary
  // clicks, forms, commands and saved steps can delete or send; granting them
  // does not turn their effects into harmless or closed-world operations.
  return {
    readOnlyHint: !BROWSER_WRITES.has(name) && name !== "reach_define_tool" && !savedEffect && !toolEffect,
    destructiveHint: approvalRequired === true || BROWSER_DESTRUCTIVE.has(name) || savedEffect || toolEffect,
    openWorldHint: BROWSER_OPEN_WORLD.has(name) || savedEffect || toolEffect || name.startsWith("reach_service_") && name !== "reach_service_request",
  };
}
// The protocol revisions Reach speaks: a client's own when it's one of them,
// else the newest, and the client decides.
export const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
// What a client is told at initialize when the agent may drive the browser:
// the same over stdio and at Reach's own /mcp endpoint (server/hosted-mcp.mjs).
// Kept to a line: the tools' own names and descriptions carry the rest.
export const serverInstructions = (scopes, profile = "full") => scopes?.includes("browser:control") ? { instructions: "Check reach_tools before using the screen. For a list of items, use reach_tool_batch. For a bank, use reach_open_bank." + (profile === "compact" ? " This is the compact catalog: reach_discover finds all permitted tools and their schemas; reach_execute calls them." : "") } : {};
// Those, then what this agent may do and its rules, from its access now
// (server/agent-guide.mjs, said by the computer): the invite message is two
// lines, so this is where an agent first reads them.
export const withGuide = (told, guide) => {
  const text = [told?.instructions, typeof guide === "string" ? guide.trim() : ""].filter(Boolean).join("\n\n");
  return text ? { instructions: text } : {};
};
// How long initialize waits for the computer to say it: a connection still
// starting answers without it (reach_device and reach_access say it too).
const GUIDE_WAIT_MS = 5000;

const location = {
  root: {
    type: "integer",
    minimum: 0,
    description: "Shared folder index, from reach_device. Defaults to 0.",
  },
  path: { type: "string", description: "Path relative to the shared folder." },
};
export const tools = [
  ...codingTaskTools().map(({ example, ...tool }) => tool),
  {
    name: "reach_device",
    description: "Read the connected computer, its shared folders, and your guide: what you may do there and the owner's rules.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reach_list_files",
    description: "List files in a shared folder on the remote computer.",
    inputSchema: { type: "object", properties: location },
  },
  {
    name: "reach_read_file",
    description: "Read a UTF-8 text file up to 1 MB on the remote computer.",
    inputSchema: { type: "object", properties: location, required: ["path"] },
  },
  {
    name: "reach_write_file",
    description:
      "Update an existing UTF-8 file up to 128 KiB. Requires files:write and sha256 from its last read; a conflict must be reconciled, never blindly retried.",
    inputSchema: {
      type: "object",
      properties: {
        ...location,
        text: { type: "string" },
        sha256: { type: "string" },
      },
      required: ["path", "text", "sha256"],
    },
  },
  {
    name: "reach_create_folder",
    description:
      "Create a folder inside an allowed shared folder. Requires files:write.",
    inputSchema: {
      type: "object",
      properties: { ...location, name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "reach_run_command",
    description:
      "Run a shell command as the computer user. Returns a job ID; poll reach_get_job for output. Only execute commands authorized by the user.",
    inputSchema: {
      type: "object",
      properties: {
        ...location,
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
      required: ["command"],
    },
  },
  {
    name: "reach_get_job",
    description: "Read a command job’s status, output, and exit code.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "reach_cancel_job",
    description: "Stop a command job and its child processes.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "reach_list_chats",
    description: "List Codex conversations created through Reach.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reach_create_chat",
    description:
      "Create a Codex conversation in a shared folder. Requires codex scope.",
    inputSchema: {
      type: "object",
      properties: { ...location, name: { type: "string" } },
    },
  },
  {
    name: "reach_send_message",
    description:
      "Send instructions to a Reach Codex conversation. Approval requests must be reviewed by a user in the Reach app.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
  },
  {
    name: "reach_get_chat",
    description:
      "Read a Codex conversation, including pending approvals. This tool does not grant approvals.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  // Tag in: apps on the Mac, on hidden displays only this agent uses.
  {
    name: "reach_list_apps",
    description:
      "List the Mac's installed apps (id and name) and the apps this agent has open. Requires apps:drive.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reach_open_app",
    description:
      "Open a Mac app on its own hidden display, phone-shaped, where only this agent works; the Mac's own screen is untouched. Returns its id. An app a person has open can't be used.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "An id from reach_list_apps." },
      },
      required: ["appId"],
    },
  },
  {
    name: "reach_see_app",
    description:
      "A picture of the app's window. Its pixels are the x/y coordinates for reach_app_action.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "reach_app_action",
    description:
      "Act in an app this agent opened: click (x, y; button, count), type (text, into the field last clicked), key (key such as enter, tab, escape, a–z; modifiers such as meta for Command), menu (path of menu titles, like [\"Image\", \"Adjustments\", \"Brightness/Contrast…\"]), or scroll (x, y, dy > 0 for further down). Runs alongside the person using the Mac when the app can take it directly (single clicks, typing, keys); menus and anything needing the pointer answer 'try again' until nobody is at the Mac. Returns a fresh picture unless see is false.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        type: {
          type: "string",
          enum: ["click", "type", "key", "scroll", "menu"],
        },
        path: { type: "array", items: { type: "string" } },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] },
        count: { type: "integer", enum: [1, 2] },
        text: { type: "string" },
        key: { type: "string" },
        modifiers: {
          type: "array",
          items: {
            type: "string",
            enum: ["meta", "alt", "control", "shift"],
          },
        },
        dx: { type: "number" },
        dy: { type: "number" },
        see: { type: "boolean" },
      },
      required: ["id", "type"],
    },
  },
  {
    name: "reach_hand_to_person",
    description:
      "Hand the live app to the person on their phone for what only a person should do (a sign-in code, a payment, a confirmation, 'does this look right?'). Say what to do in one sentence. Then call reach_wait_for_person.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
  {
    name: "reach_wait_for_person",
    description:
      "Wait up to 25 seconds for the person to hand the app back. state 'waiting': call again; 'back': continue (read their note); 'stopped': stop this task.",
    inputSchema: {
      type: "object",
      properties: { handoff: { type: "string" } },
      required: ["handoff"],
    },
  },
  {
    name: "reach_close_app",
    description:
      "Done with an app: it goes back to the Mac (or closes, for a window opened for this agent).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];
export async function callTool(api, name, a, browserAccess) {
  if (browserAccess || BROWSER_ONLY_NAMES.has(name) || name.startsWith("reach_service_") || name === "reach_services" || name.startsWith("reach_saved_") || name.startsWith("reach_tool_") || ["reach_tools", "reach_define_tool"].includes(name)) {
    const access = browserAccess || await api("/api/browser");
    const plan = browserToolRequest(name, a, access);
    return api(plan.route, plan.method, plan.body);
  }
  if (CODING_TASK_NAMES.includes(name)) {
    const plan = codingTaskRequest(name, a);
    return api(plan.route, plan.method, plan.body);
  }
  const query = new URLSearchParams({
    root: String(a.root || 0),
    path: a.path || "",
  });
  const encoded = () => idSegment(a.id);
  switch (name) {
    case "reach_device":
      return api("/api/device");
    case "reach_list_files":
      return api("/api/files?" + query);
    case "reach_read_file":
      return api("/api/files/text?" + query);
    case "reach_write_file":
      return api("/api/files/text?" + query, "PUT", {
        text: a.text,
        sha256: a.sha256,
      });
    case "reach_create_folder":
      return api("/api/files/folder", "POST", a);
    case "reach_run_command":
      return api("/api/jobs", "POST", a);
    case "reach_get_job":
      return api("/api/jobs/" + encoded());
    case "reach_cancel_job":
      return api("/api/jobs/" + encoded(), "DELETE");
    case "reach_list_chats":
      return api("/api/chats");
    case "reach_create_chat":
      return api("/api/chats", "POST", a);
    case "reach_send_message":
      return api("/api/chats/" + encoded() + "/messages", "POST", {
        text: a.text,
      });
    case "reach_get_chat":
      return api("/api/chats/" + encoded());
    case "reach_list_apps":
      return api("/api/drive/apps");
    case "reach_open_app":
      return api("/api/drive/apps", "POST", { appId: a.appId });
    case "reach_see_app":
      return api("/api/drive/apps/" + encoded());
    case "reach_app_action":
      return appAction(api, a);
    case "reach_hand_to_person":
      return api("/api/drive/apps/" + encoded() + "/handoff", "POST", {
        reason: a.reason,
      });
    case "reach_wait_for_person":
      return api(
        "/api/drive/handoffs/" + idSegment(a.handoff) + "?wait=25",
      );
    case "reach_close_app":
      return api("/api/drive/apps/" + encoded(), "DELETE");
    default:
      throw Error("Unknown tool");
  }
}
// One action, then (unless `see` is false) a fresh picture of the result.
async function appAction(api, a) {
  const { id, see, ...action } = a;
  const route = "/api/drive/apps/" + idSegment(id);
  await api(route + "/actions", "POST", action);
  if (see === false) return { done: true };
  // The app draws what the action changed before the picture is taken.
  await new Promise((r) => setTimeout(r, 400));
  return { done: true, ...(await api(route)) };
}
// A result as MCP content: a picture as an image, the screen described as
// plain text, the rest as JSON text. An action's answer with the screen
// after it: what was done as JSON, a blank line, then the screen as plain
// text as a look gives it (not escaped inside the JSON), in the one block
// every client hands its model.
export function toContent(result) {
  if (result && typeof result.screenText === "string")
    return [{ type: "text", text: result.screenText }];
  if (result && result.screen && typeof result.screen === "object" && typeof result.screen.text === "string") {
    const { screen: { text, ...screen }, ...rest } = result;
    return [{ type: "text", text: `${JSON.stringify({ ...rest, screen }, null, 2)}\n\n${text}` }];
  }
  if (
    result &&
    typeof result.image === "string" &&
    typeof result.mimeType === "string"
  ) {
    const { image, mimeType, ...rest } = result;
    return [
      { type: "image", data: image, mimeType },
      { type: "text", text: JSON.stringify(rest, null, 2) },
    ];
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}
// The scope each tool needs; a tool missing here is never offered.
const TOOL_SCOPES = {
  reach_start_coding_task: "codex",
  reach_get_coding_task: "codex",
  reach_list_coding_tasks: "codex",
  reach_cancel_coding_task: "codex",
  reach_device: null,
  reach_list_files: "files:read",
  reach_read_file: "files:read",
  reach_write_file: "files:write",
  reach_create_folder: "files:write",
  reach_run_command: "exec",
  reach_get_job: "exec",
  reach_cancel_job: "exec",
  reach_list_chats: "codex",
  reach_create_chat: "codex",
  reach_send_message: "codex",
  reach_get_chat: "codex",
  reach_list_apps: "apps:drive",
  reach_open_app: "apps:drive",
  reach_see_app: "apps:drive",
  reach_app_action: "apps:drive",
  reach_hand_to_person: "apps:drive",
  reach_wait_for_person: "apps:drive",
  reach_close_app: "apps:drive",
};
// Tools the credential's access allows (the computer enforces it anyway).
export function toolsFor(scopes, browserAccess) {
  if (scopes.includes("browser:read")) return browserToolsFor(browserAccess).filter((tool) => scopes.includes(tool.name.startsWith("reach_service_") ? "browser:read" : tool.name.startsWith("reach_saved_") || tool.name.startsWith("reach_tool_") ? "browser:control" : BROWSER_TOOL_SCOPES[tool.name])).map(({ example, approvalRequired, ...tool }) => ({
    ...tool, annotations: browserAnnotations(tool.name, approvalRequired),
  }));
  return tools.filter((tool) => {
    if (!Object.hasOwn(TOOL_SCOPES, tool.name)) return false;
    const scope = TOOL_SCOPES[tool.name];
    return (
      scope === null ||
      scopes.includes(scope) ||
      (scope.startsWith("files:") && scopes.includes("files"))
    );
  });
}

// Reach's own list of this agent's tools, and the request each call makes
// (server/browser-access.mjs /api/browser/mcp): a copy offers the tools Reach
// has now, whatever its own version, and the request then goes out as any
// other. A computer from before them, or one that fails to answer: this
// copy's own tools, as before (an ended access then fails there too). Only
// the planner's own refusal (400: no such tool, wrong arguments) stands.
// `route` adds what the computer is told (the runtime).
export async function computerTools(api, route = (path) => path, profile = "full") {
  try {
    const answer = await api(route("/api/browser/mcp/tools" + (profile === "compact" ? "?profile=compact" : "")));
    return Array.isArray(answer?.tools) ? answer : null;
  } catch {
    return null;
  }
}
export async function computerPlan(api, name, args, route = (path) => path) {
  let answer;
  try {
    answer = await api(route("/api/browser/mcp/plan"), "POST", { name, arguments: args });
  } catch (error) {
    if (error?.status === 400) throw error;
    return null;
  }
  // An answer with no plan in it comes from a computer that doesn't plan.
  if (!answer || typeof answer !== "object" || !("plan" in answer)) return null;
  const plan = answer.plan;
  if (typeof plan?.route !== "string" || !plan.route.startsWith("/api/") || !["GET", "HEAD", "POST", "PUT", "DELETE"].includes(plan.method))
    throw Error("Reach named no request for this tool.");
  return answer;
}

// How long a tools/list waits for a newer runtime before answering with this
// one's tools (the new ones follow with notifications/tools/list_changed).
const UPGRADE_WAIT_MS = 8000;
// A runtime that couldn't be loaded is tried again after this long.
const UPGRADE_RETRY_MS = 10 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;

export function serveMcp({
  api,
  scopes = [],
  // Ask the computer for the credential's current access (or trust `scopes`).
  liveScopes = true,
  profile = process.env.REACH_MCP_PROFILE === "compact" ? "compact" : "full",
  input = process.stdin,
  output = process.stdout,
  name = "reach",
  // The computer's newer runtime (scripts/agent-remote.mjs runtimeUpdater):
  // { current: sha256, update(sha256) → { toolsFor, callTool, toContent } }. Its tools
  // replace these while this server keeps running. Without it, nothing
  // changes (a source checkout, or updates turned off).
  runtime = null,
  // This runtime's own hash, said to the computer even with updates off
  // (agent-runtimes.mjs): the owner sees which agents run what.
  report = undefined,
  upgradeWaitMs = UPGRADE_WAIT_MS,
  guideWaitMs = GUIDE_WAIT_MS,
  now = Date.now,
}) {
  const write = (message) =>
    output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  // Answers still on their way when input ends are sent before finishing.
  const pending = new Set();
  let currentScopes = scopes;
  // The version of Reach's own list the client last read (computerTools).
  let listed, dispatch = false;
  let impl = { toolsFor, callTool };
  let current = runtime?.current;
  const said = (route) => {
    const sha = current || report;
    return typeof sha === "string" && SHA256.test(sha) ? `${route}${route.includes("?") ? "&" : "?"}runtime=${sha}` : route;
  };
  // What the computer says this agent may do, now; "" when it doesn't
  // answer in time (an older computer says nothing).
  const guide = () => {
    let timer;
    return Promise.race([
      Promise.resolve().then(() => api(said("/api/device"))).then((device) => (typeof device?.guide === "string" ? device.guide : "")),
      new Promise((resolve) => { timer = setTimeout(resolve, guideWaitMs, ""); }),
    ]).catch(() => "").finally(() => clearTimeout(timer));
  };
  const tried = new Map(); // sha256 → when it was last tried
  // Fails closed: a runtime that can't be fetched, doesn't match its hash or
  // doesn't load leaves this one's tools as they are.
  const upgrade = async (sha, waitMs = 0) => {
    if (!runtime || typeof sha !== "string" || !SHA256.test(sha) || sha === current) return;
    if (tried.has(sha) && now() - tried.get(sha) < UPGRADE_RETRY_MS) return;
    tried.set(sha, now());
    const loaded = Promise.resolve()
      .then(() => runtime.update(sha))
      .then((next) => (typeof next?.toolsFor === "function" && typeof next?.callTool === "function"
        ? { toolsFor: next.toolsFor, callTool: next.callTool, ...(typeof next.toContent === "function" ? { toContent: next.toContent } : {}) } : null))
      .catch((error) => { console.error(`Reach: kept this runtime; the computer's newer one didn't load (${error?.message || error}).`); return null; });
    const swap = (next) => { if (!next) return false; impl = next; current = sha; tried.delete(sha); return true; };
    const later = () => loaded.then((next) => { if (swap(next)) write({ method: "notifications/tools/list_changed" }); });
    if (!waitMs) return void later();
    let timer;
    const first = await Promise.race([loaded, new Promise((resolve) => { timer = setTimeout(resolve, waitMs, later); })]);
    clearTimeout(timer);
    if (first === later) return void later();
    swap(first);
  };
  lines.on("line", (line) => {
    const answer = handle(line).finally(() => pending.delete(answer));
    pending.add(answer);
  });
  async function handle(line) {
    let r;
    // JSON-RPC's own errors for a line that isn't one request object: not
    // JSON, or a batch (MCP over stdio sends one message a line).
    try { r = JSON.parse(line); }
    catch { write({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      write({ id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    try {
      if (r.id === undefined) return;
      let result;
      if (r.method === "initialize")
        result = {
          protocolVersion: PROTOCOLS.includes(r.params?.protocolVersion) ? r.params.protocolVersion : PROTOCOLS.at(-1),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name, version: REACH_VERSION },
          ...withGuide(serverInstructions(scopes, profile), liveScopes ? await guide() : ""),
        };
      else if (r.method === "ping") result = {};
      // Not offered, so an orderly client never asks; one that asks anyway
      // gets empty lists, not errors in its log.
      else if (r.method === "resources/list") result = { resources: [] };
      else if (r.method === "resources/templates/list") result = { resourceTemplates: [] };
      else if (r.method === "prompts/list") result = { prompts: [] };
      else if (r.method === "tools/list") {
        const device = liveScopes ? await api(said("/api/device")) : undefined;
        currentScopes = device?.access?.scopes || scopes || [];
        // A newer runtime on the computer: its tools, in this answer if it
        // loads in time.
        await upgrade(device?.runtime, upgradeWaitMs);
        // Reach's own list when it has one: every tool it has now.
        const served = currentScopes.includes("browser:read") ? await computerTools(api, said, profile) : null;
        listed = served?.list;
        dispatch = served?.dispatch === true;
        if (served) result = { tools: served.tools };
        else {
          const access = currentScopes.includes("browser:read") ? await api(said("/api/browser")) : undefined;
          result = { tools: profile === "compact" && access?.preset !== undefined ? compactTools(impl.toolsFor(currentScopes, access)) : impl.toolsFor(currentScopes, access) };
        }
      } else if (r.method === "tools/call") {
        const args = r.params?.arguments;
        if (typeof r.params?.name !== "string" || (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))) {
          write({ id: r.id, error: { code: -32602, message: "Name a tool and pass arguments as an object." } });
          return;
        }
        try {
          const executed = dispatch ? await api(said("/api/browser/mcp/call"), "POST", { name: r.params?.name, arguments: r.params?.arguments || {} }) : null;
          const planned = !dispatch && currentScopes.includes("browser:read") ? await computerPlan(api, r.params?.name, r.params?.arguments || {}, said) : null;
          if (dispatch) {
            // Never fall back or retry after a dispatch error: a mutation may
            // already have completed, even when its response was lost.
            if (!executed || !Object.hasOwn(executed, "result")) throw Error("Reach returned an invalid tool result. Check its state before retrying.");
            void upgrade(executed.runtime);
            if (listed && executed.list && listed !== executed.list) { listed = executed.list; write({ method: "notifications/tools/list_changed" }); }
            result = { content: (impl.toContent || toContent)(executed.result) };
          } else if (planned) {
            void upgrade(planned.runtime);
            // Reach's tools changed since the client read them: it reads again.
            if (listed && typeof planned.list === "string" && planned.list !== listed) {
              listed = planned.list;
              write({ method: "notifications/tools/list_changed" });
            }
            result = { content: (impl.toContent || toContent)(await api(planned.plan.route, planned.plan.method, planned.plan.body)) };
          } else {
            const access = currentScopes.includes("browser:read") ? await api(said("/api/browser")) : undefined;
            void upgrade(access?.runtime);
            if (access && !impl.toolsFor(currentScopes, access).some((tool) => tool.name === r.params.name)) throw Error("This tool is not available in the current browser session.");
            result = {
              content: (impl.toContent || toContent)(
                await impl.callTool(api, r.params.name, r.params.arguments || {}, access),
              ),
            };
          }
        } catch (e) {
          const details = agentErrorDetails(e);
          result = {
            isError: true,
            content: [{ type: "text", text: details.kind ? JSON.stringify(details) : details.error }],
          };
        }
      } else {
        write({
          id: r.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      write({ id: r.id, result });
      if (r.method === "tools/call" && ["reach_save_shortcut", "reach_define_tool"].includes(r.params?.name) && !result?.isError)
        write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    } catch (e) {
      write({ id: r?.id ?? null, error: { code: -32603, message: agentErrorDetails(e).error } });
    }
  }
  return new Promise((resolve) =>
    lines.once("close", () => Promise.allSettled([...pending]).then(resolve)),
  );
}
