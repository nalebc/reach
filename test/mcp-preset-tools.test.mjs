import test from "node:test";
import assert from "node:assert/strict";
import { toolsFor } from "../scripts/mcp-server.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// A Claude Code or Codex agent connected with a preset credential sees the
// same tools as the agent page, with honest hints about what changes the Mac.
const access = (preset, extra = {}) => ({ preset, screen: ["full", "apps", "readonly"].includes(preset), control: ["full", "apps"].includes(preset), open: ["full", "apps"].includes(preset),
  shell: preset === "full", write: preset === "full" || extra.write === true, roots: preset === "apps" ? [] : [{ index: 0, name: "Home", path: "/Users/me" }], terminals: [], apps: preset === "apps" ? [{ id: "/Applications/Google Chrome.app" }] : [], ...extra });
const names = (preset, extra) => toolsFor(presetScopes({ preset, ...extra }), access(preset, extra)).map((tool) => tool.name);

test("preset credentials advertise the preset's tools over MCP", () => {
  const reusable = ["reach_tools", "reach_tool_protocol", "reach_define_tool", "reach_tool_operation", "reach_shortcuts", "reach_record_shortcut", "reach_save_shortcut", "reach_discard_shortcut", "reach_run_shortcut"];
  assert.deepEqual(names("full"), ["reach_access", "reach_screenshot", "reach_front", "reach_describe_screen", "reach_elements", "reach_act", "reach_desktop_apps", "reach_open_app", "reach_open_url", ...reusable, "reach_list_files", "reach_search_files", "reach_read_file", "reach_change_file", "reach_shell", "reach_shell_history"]);
  assert.deepEqual(names("apps"), ["reach_access", "reach_screenshot", "reach_front", "reach_describe_screen", "reach_elements", "reach_act", "reach_desktop_apps", "reach_open_app", "reach_open_url", ...reusable]);
  assert.deepEqual(names("files"), ["reach_access", "reach_list_files", "reach_search_files", "reach_read_file"]);
  assert.deepEqual(names("files", { write: true }), ["reach_access", "reach_list_files", "reach_search_files", "reach_read_file", "reach_change_file"]);
  assert.deepEqual(names("readonly"), ["reach_access", "reach_screenshot", "reach_front", "reach_list_files", "reach_search_files", "reach_read_file"]);
});

test("hints say what touches the Mac and what can't be undone", () => {
  const tools = Object.fromEntries(toolsFor(presetScopes({ preset: "full" }), access("full")).map((tool) => [tool.name, tool.annotations]));
  for (const name of ["reach_access", "reach_screenshot", "reach_front", "reach_describe_screen", "reach_elements", "reach_desktop_apps", "reach_list_files", "reach_read_file", "reach_shell_history", "reach_shortcuts"]) assert.equal(tools[name].readOnlyHint, true, name);
  for (const name of ["reach_act", "reach_open_app", "reach_open_url", "reach_change_file", "reach_shell", "reach_record_shortcut", "reach_save_shortcut", "reach_discard_shortcut", "reach_run_shortcut"]) assert.equal(tools[name].readOnlyHint, false, name);
  for (const name of ["reach_change_file", "reach_shell", "reach_run_shortcut"]) assert.equal(tools[name].destructiveHint, true, name);
  assert.equal(tools.reach_act.destructiveHint, false);
  assert.ok(Object.values(tools).every((annotations) => annotations.openWorldHint === false));
  assert.ok(Object.values(tools).every((annotations) => !("example" in annotations)));
});

test("a credential whose scopes were narrowed loses the matching tools", () => {
  const lowered = presetScopes({ preset: "readonly" });
  assert.ok(!toolsFor(lowered, access("full")).some((tool) => ["reach_act", "reach_shell", "reach_change_file", "reach_open_app", "reach_open_url", "reach_describe_screen", "reach_elements"].includes(tool.name)));
});


test("Read only and Files never advertise saved tasks, including stale cached catalog entries", () => {
  const savedTools = [{ id: "11111111-1111-4111-8111-111111111111", name: "Open sample", stepCount: 1, inputs: [] }];
  const shortcut = (name) => name === "reach_shortcuts" || name.endsWith("_shortcut") || name.startsWith("reach_saved_");
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
