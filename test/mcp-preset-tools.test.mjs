import test from "node:test";
import assert from "node:assert/strict";
import { toolsFor } from "../scripts/mcp-server.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// A Claude Code or Codex agent connected with a preset credential sees the
// same tools as the agent page, with honest hints about what changes the Mac.
const access = (preset, extra = {}) => ({ preset, screen: ["full", "apps", "readonly"].includes(preset), control: ["full", "apps"].includes(preset), open: ["full", "apps"].includes(preset),
  shell: preset === "full", write: preset === "full" || extra.write === true, roots: preset === "apps" ? [] : [{ index: 0, name: "Home", path: "/Users/me" }], terminals: [], apps: preset === "apps" ? [{ id: "/Applications/Google Chrome.app" }] : [], ...extra });
const names = (preset, extra) => toolsFor(presetScopes({ preset, ...extra }), access(preset, extra)).map((tool) => tool.name).filter(name => !["reach_discover", "reach_execute", "reach_displays"].includes(name));

test("preset credentials advertise the preset's tools over MCP", () => {
  const reusable = ["reach_tools", "reach_tool_protocol", "reach_define_tool", "reach_tool_operation", "reach_shortcuts", "reach_record_shortcut", "reach_save_shortcut", "reach_discard_shortcut", "reach_run_shortcut"];
  const navigation = ["reach_find", "reach_menus", "reach_read_page", "reach_press", "reach_fill", "reach_wait_for", "reach_act", "reach_desktop_apps", "reach_open_app", "reach_open_bank", "reach_open_url", "reach_focus_window", "reach_mac_shortcuts", "reach_run_mac_shortcut"];
  assert.deepEqual(names("full"), ["reach_access", "reach_request_permission", "reach_screenshot", "reach_front", "reach_windows", "reach_describe_screen", "reach_elements", ...navigation, "reach_open_file", ...reusable, "reach_list_files", "reach_search_files", "reach_read_file", "reach_change_file", "reach_shell", "reach_shell_history"]);
  // Apps shares no folders: no file to open.
  assert.deepEqual(names("apps"), ["reach_access", "reach_request_permission", "reach_screenshot", "reach_front", "reach_windows", "reach_describe_screen", "reach_elements", ...navigation, ...reusable]);
  assert.deepEqual(names("files"), ["reach_access", "reach_request_permission", "reach_list_files", "reach_search_files", "reach_read_file"]);
  assert.deepEqual(names("files", { write: true }), ["reach_access", "reach_request_permission", "reach_list_files", "reach_search_files", "reach_read_file", "reach_change_file"]);
  assert.deepEqual(names("readonly"), ["reach_access", "reach_request_permission", "reach_screenshot", "reach_front", "reach_windows", "reach_list_files", "reach_search_files", "reach_read_file"]);
});

test("hints say what touches the Mac and what can't be undone", () => {
  const accessTool = toolsFor(presetScopes({ preset: "full" }), access("full")).find(tool => tool.name === "reach_access");
  assert.match(accessTool.description, /no command deny list, protected-window filter or shell sandbox/);
  assert.match(accessTool.description, /confirm consequential actions/);
  assert.doesNotMatch(accessTool.description, /anything that moves money or changes the account is refused/);
  const tools = Object.fromEntries(toolsFor(presetScopes({ preset: "full" }), access("full")).map((tool) => [tool.name, tool.annotations]));
  for (const name of ["reach_access", "reach_screenshot", "reach_front", "reach_windows", "reach_menus", "reach_read_page", "reach_mac_shortcuts", "reach_describe_screen", "reach_elements", "reach_desktop_apps", "reach_list_files", "reach_read_file", "reach_shell_history", "reach_shortcuts"]) assert.equal(tools[name].readOnlyHint, true, name);
  // Finding scrolls the window: it touches the Mac.
  for (const name of ["reach_act", "reach_press", "reach_fill", "reach_find", "reach_focus_window", "reach_open_file", "reach_run_mac_shortcut", "reach_open_app", "reach_open_url", "reach_change_file", "reach_shell", "reach_record_shortcut", "reach_save_shortcut", "reach_discard_shortcut", "reach_run_shortcut"]) assert.equal(tools[name].readOnlyHint, false, name);
  for (const name of ["reach_change_file", "reach_shell", "reach_run_shortcut"]) assert.equal(tools[name].destructiveHint, true, name);
  for (const name of ["reach_act", "reach_press", "reach_fill", "reach_run_mac_shortcut", "reach_open_file"]) assert.equal(tools[name].destructiveHint, true, name);
  assert.equal(tools.reach_execute.readOnlyHint, false);
  assert.equal(tools.reach_execute.destructiveHint, true);
  assert.equal(tools.reach_execute.openWorldHint, true);
  for (const name of ["reach_act", "reach_open_url", "reach_shell", "reach_run_mac_shortcut"]) assert.equal(tools[name].openWorldHint, true, name);
  for (const name of ["reach_access", "reach_list_files", "reach_read_file", "reach_change_file", "reach_shortcuts"]) assert.equal(tools[name].openWorldHint, false, name);
  assert.ok(Object.values(tools).every((annotations) => !("example" in annotations)));
});

test("a credential whose scopes were narrowed loses the matching tools", () => {
  const lowered = presetScopes({ preset: "readonly" });
  assert.ok(!toolsFor(lowered, access("full")).some((tool) => ["reach_act", "reach_press", "reach_fill", "reach_wait_for", "reach_shell", "reach_change_file", "reach_open_app", "reach_open_url", "reach_describe_screen", "reach_elements"].includes(tool.name)));
});


test("Read only and Files never advertise saved tasks, including stale cached catalog entries", () => {
  const savedTools = [{ id: "11111111-1111-4111-8111-111111111111", name: "Open sample", stepCount: 1, inputs: [] }];
  // Saved tasks (shortcuts), not the Mac's own Shortcuts, which follow the open scope.
  const shortcut = (name) => !name.includes("mac_shortcut") && (name === "reach_shortcuts" || name.endsWith("_shortcut") || name.startsWith("reach_saved_"));
  const available = names("full", { savedTools });
  assert.equal(available.filter(shortcut).length, 6, "the same catalog fixture exposes five shortcut tools and one named task with Full control");
  for (const preset of ["readonly", "files"]) {
    assert.deepEqual(names(preset, { savedTools }), names(preset), `${preset} ignores saved task metadata`);
    assert.deepEqual(names(preset, { write: true, savedTools }).filter(shortcut), [], `${preset} never gains desktop shortcuts from file write access`);
    const narrowed = toolsFor(presetScopes({ preset }), access("full", { savedTools })).map((tool) => tool.name);
    assert.deepEqual(narrowed.filter(shortcut), [], `${preset} scopes remove shortcut tools even when access metadata is stale`);
  }
});

// Security audit L6: an id of "." or ".." would become another route once
// the address is read; the old Command line tools refuse it before asking.
test("Command line tools refuse dot and empty ids before any request", async () => {
  const { callTool } = await import("../scripts/mcp-server.mjs");
  const asked = [];
  const api = async (route, method) => { asked.push(`${method || "GET"} ${route}`); return {}; };
  for (const [name, args] of [["reach_get_job", { id: ".." }], ["reach_cancel_job", { id: "." }], ["reach_get_chat", { id: "" }],
    ["reach_send_message", { id: "..", text: "hi" }], ["reach_see_app", { id: ".." }], ["reach_wait_for_person", { handoff: ".." }]])
    await assert.rejects(callTool(api, name, args), /valid id/, name);
  assert.deepEqual(asked, []);
  await callTool(api, "reach_get_job", { id: "job/1" });
  assert.deepEqual(asked, ["GET /api/jobs/job%2F1"]);
});

// The fast path, read and act with no pictures: a control from
// reach_describe_screen is pressed by its number on every connection
// (MCP over Tailscale or the public link, and the agent page's tools).
test("reach_act presses a described control by number; coordinates still work", async () => {
  const { browserToolRequest } = await import("../server/browser-tools.mjs");
  const full = access("full");
  for (const action of [
    { type: "element", snapshot: "ab12cd34", n: 7 },
    { type: "element", snapshot: "ab12cd34", n: 7, button: "right", count: 2 },
    { type: "click", x: 0.5, y: 0.5 },
  ]) assert.deepEqual(browserToolRequest("reach_act", { action }, full),
    { route: "/api/browser/desktop/input", method: "POST", body: { action }, response: "json" });
  for (const action of [
    { type: "element", snapshot: "../x", n: 1 },
    { type: "element", snapshot: "ab12cd34", n: 0 },
    { type: "element", snapshot: "ab12cd34", n: 1, x: 0.5 },
    { type: "element", n: 1 },
  ]) assert.throws(() => browserToolRequest("reach_act", { action }, full), /supported actions/, JSON.stringify(action));
  // Through the agent's own runtime, as Muse calls it.
  const { callTool } = await import("../scripts/mcp-server.mjs");
  const sent = [];
  await callTool(async (route, method, body) => { sent.push([method, route, body]); return { ok: true }; }, "reach_act", { action: { type: "element", snapshot: "ab12cd34", n: 7 } }, full);
  assert.deepEqual(sent, [["POST", "/api/browser/desktop/input", { action: { type: "element", snapshot: "ab12cd34", n: 7 } }]]);
});

test("reach_act sends a batch and describe in one request; one form at a time", async () => {
  const { browserToolRequest } = await import("../server/browser-tools.mjs");
  const full = access("full");
  const actions = [{ type: "element", snapshot: "ab12cd34", n: 3 }, { type: "type", text: "diapers" }, { type: "wait", ms: 400 }, { type: "key", key: "enter" }];
  assert.deepEqual(browserToolRequest("reach_act", { actions, describe: true }, full),
    { route: "/api/browser/desktop/input", method: "POST", body: { actions, describe: true }, response: "json" });
  assert.deepEqual(browserToolRequest("reach_act", { action: actions[0], describe: true }, full).body, { action: actions[0], describe: true });
  for (const args of [{}, { action: actions[0], actions }, { actions: [] }, { actions: Array.from({ length: 11 }, () => actions[3]) },
    { action: { type: "wait", ms: 400 } }, { actions: [{ type: "wait", ms: 5000 }] }, { actions, describe: false }])
    assert.throws(() => browserToolRequest("reach_act", args, full), /Invalid tool arguments/, JSON.stringify(args).slice(0, 60));
});

// Press by name, fill a form, wait for the screen: one request each, with
// the same checks on the Mac as a click or typing; in batches too.
test("press, fill and wait_for map to the Mac's routes", async () => {
  const { browserToolRequest } = await import("../server/browser-tools.mjs");
  const full = access("full");
  assert.deepEqual(browserToolRequest("reach_press", { name: "Add to cart", role: "Button", describe: true }, full),
    { route: "/api/browser/desktop/input", method: "POST", body: { action: { type: "press", name: "Add to cart", role: "Button" }, describe: true }, response: "json" });
  const fields = [{ label: "Email", text: "from the vault", secret: true }, { label: "Password", text: "from the vault", secret: true }];
  assert.deepEqual(browserToolRequest("reach_fill", { fields, submit: true }, full),
    { route: "/api/browser/desktop/input", method: "POST", body: { action: { type: "fill", fields, submit: true } }, response: "json" });
  assert.deepEqual(browserToolRequest("reach_wait_for", { text: "Order placed", timeoutMs: 3000 }, full),
    { route: "/api/browser/desktop/wait", method: "POST", body: { text: "Order placed", timeoutMs: 3000 }, response: "json" });
  assert.equal(browserToolRequest("reach_act", { actions: [{ type: "press", name: "Search" }, { type: "fill", fields: [{ label: "Search", text: "diapers" }], submit: true }] }, full).body.actions.length, 2);
  for (const [name, args] of [["reach_press", {}], ["reach_press", { name: "x", role: "not a role" }], ["reach_fill", { fields: [] }], ["reach_fill", { fields: [{ label: "Email" }] }],
    ["reach_fill", { fields, secret: true }], ["reach_fill", { fields: [{ label: "a", text: "b", secret: false }] }], ["reach_wait_for", {}], ["reach_wait_for", { text: "a", name: "b" }], ["reach_wait_for", { text: "a", timeoutMs: 100 }]])
    assert.throws(() => browserToolRequest(name, args, full), /Invalid tool arguments/, `${name} ${JSON.stringify(args)}`);
});
