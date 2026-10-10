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
