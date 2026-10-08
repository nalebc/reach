import { fail, isPlainRecord, hasReviewControls } from "./core.mjs";

export const TOOL_PROTOCOL = "reach.tool.v1";
export const TOOL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const TOOL_BROWSERS = { Chrome: "com.google.Chrome", Safari: "com.apple.Safari" };
export const TOOL_LIMITS = { steps: 24, inputs: 12, runMs: 30000, fileBytes: 8 * 1024 * 1024, tools: 100 };
const bad = (message) => { throw fail(400, `Invalid Reach tool: ${message}`); };
const text = (value, max = 2000) => typeof value === "string" && value.length <= max && !hasReviewControls(value);
const exact = (value, keys) => isPlainRecord(value) && Object.keys(value).every(key => keys.includes(key));
const name = value => typeof value === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(value) && !["constructor", "prototype"].includes(value);
export function toolOrigin(value) {
  if (!text(value, 2000) || /[\s\\]/.test(value)) bad("use an explicit HTTPS address.");
  let url;
  try { url = new URL(value); } catch { bad("use an explicit HTTPS address."); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") ||
      /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(url.hostname) ||
      /^(192\.0\.0\.|198\.(18|19)\.|2(2[4-9]|[3-4]\d|5[0-5])\.)/.test(url.hostname) ||
      /^(172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /\.(local|localhost|ts\.net)$/.test(url.hostname)) bad("only public HTTPS websites are supported.");
  return url.origin;
}
function valueDefinition(value, inputs, context = false, depth = 0) {
  if (depth > 3) bad("value templates are too deeply nested.");
  if (typeof value === "string") { if (!text(value, 20000)) bad("invalid literal text."); return; }
  if (exact(value, ["input"]) && Object.keys(value).length === 1 && name(value.input) && Object.hasOwn(inputs, value.input)) return;
  if (context && exact(value, ["context"]) && name(value.context) && !["__proto__", "constructor", "prototype"].includes(value.context)) return;
  if (exact(value, ["urlEncode"]) && Object.keys(value).length === 1) return valueDefinition(value.urlEncode, inputs, false, depth + 1);
  if (exact(value, ["concat"]) && Array.isArray(value.concat) && value.concat.length > 0 && value.concat.length <= 8) {
    for (const part of value.concat) valueDefinition(part, inputs, context, depth + 1);
    return;
  }
  bad("values must be literals, declared inputs, or bounded templates.");
}
function targetDefinition(target, inputs) {
  if (!exact(target, ["css", "role", "name", "text", "scope"]) || (!target.css && !target.role)) bad("declare a CSS selector or accessible role.");
  if (target.css !== undefined && (!text(target.css, 300) || !target.css.trim())) bad("invalid selector.");
  if (target.role !== undefined && !["button", "link", "textbox", "heading", "dialog", "row", "main", "status", "table", "file"].includes(target.role)) bad("unsupported accessible role.");
  if (target.name !== undefined) valueDefinition(target.name, inputs, true);
  if (target.text !== undefined) valueDefinition(target.text, inputs, true);
  if (target.scope !== undefined && target.scope !== "page") bad("unsupported target scope.");
}
export function validateToolDefinition(input, { builtIn = false } = {}) {
  if (!exact(input, ["protocol", "id", "title", "description", "origins", "inputs", "steps"]) || input.protocol !== TOOL_PROTOCOL ||
      !name(input.id) || (!builtIn && input.id.startsWith("builtin_")) || !text(input.title, 80) || !input.title.trim() ||
      !text(input.description, 500) || !input.description.trim()) bad("declare protocol, id, title and description.");
  if (!Array.isArray(input.origins) || !input.origins.length || input.origins.length > 4 || input.origins.some(origin => toolOrigin(origin) !== origin) || new Set(input.origins).size !== input.origins.length) bad("declare up to four exact HTTPS origins.");
  if (!isPlainRecord(input.inputs) || Object.keys(input.inputs).length > TOOL_LIMITS.inputs) bad("declare up to twelve inputs.");
  for (const [key, field] of Object.entries(input.inputs)) {
    if (!name(key) || ["browser", "requestId", "__proto__", "constructor", "prototype"].includes(key) ||
        !exact(field, ["type", "label", "maxLength", "enum", "default", "required"]) || !["string", "handle", "file"].includes(field.type) ||
        !text(field.label, 80) || !field.label.trim() || (field.required !== undefined && typeof field.required !== "boolean") ||
        (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 20000))) bad(`invalid input ${key}.`);
    if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 20 || field.enum.some(entry => !text(entry, 100) || !entry))) bad("invalid input choices.");
    if (field.default !== undefined && (!text(field.default, field.maxLength || 2000) || (field.enum && !field.enum.includes(field.default)))) bad("invalid input default.");
  }
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > TOOL_LIMITS.steps) bad("declare one to twenty-four fixed steps.");
  let targetReady = false, verification = false;
  const outputs = new Set();
  const shapes = {
    navigate: ["op", "url"], use: ["op", "handle"], assert: ["op", "target"], assert_absent: ["op", "target"], wait: ["op", "target"],
    fill: ["op", "target", "value"], click: ["op", "target"], read: ["op", "target", "as"],
    collect: ["op", "target", "fields", "filter", "empty", "as"], download: ["op", "target", "as"],
    pdf: ["op", "target", "as"], attach: ["op", "target", "file"],
  };
  for (const step of input.steps) {
    if (!isPlainRecord(step) || !Object.hasOwn(shapes, step.op) || !exact(step, shapes[step.op])) bad("unsupported step or step fields.");
    if (step.op === "navigate") { valueDefinition(step.url, input.inputs); targetReady = true; verification = false; }
    else if (step.op === "use") {
      valueDefinition(step.handle, input.inputs);
      if (!exact(step.handle, ["input"]) || input.inputs[step.handle.input]?.type !== "handle" || input.inputs[step.handle.input]?.required === false) bad("use requires a declared, required handle input.");
      targetReady = true; verification = false;
    }
    else {
      if (!targetReady) bad("navigate to a declared site or use a returned handle before accessing a page.");
      targetDefinition(step.target, input.inputs);
      if (["fill", "attach"].includes(step.op)) valueDefinition(step[step.op === "fill" ? "value" : "file"], input.inputs);
      if (step.op === "attach" && (!exact(step.file, ["input"]) || input.inputs[step.file.input]?.type !== "file" || input.inputs[step.file.input]?.required === false)) bad("attach requires a declared, required file input.");
      if (step.op === "collect") {
        if (step.empty !== undefined) targetDefinition(step.empty, input.inputs);
        if (!isPlainRecord(step.fields) || !Object.keys(step.fields).length || Object.keys(step.fields).length > 6) bad("declare one to six collection fields.");
        for (const [key, field] of Object.entries(step.fields)) { if (!name(key)) bad("invalid collection field."); targetDefinition(field, input.inputs); }
        if (step.filter !== undefined) valueDefinition(step.filter, input.inputs);
      }
      if (step.as !== undefined) { if (!name(step.as) || outputs.has(step.as)) bad("output names must be unique."); outputs.add(step.as); }
      if (["read", "collect", "download", "pdf"].includes(step.op) && !step.as) bad("name each returned result.");
      if (["fill", "click", "attach"].includes(step.op)) verification = false;
      if (["assert", "assert_absent", "wait", "read", "collect", "download", "pdf"].includes(step.op)) verification = true;
    }
  }
  if (!targetReady || !verification) bad("finish with an explicit assertion or checked result.");
  const result = structuredClone(input);
  if (Buffer.byteLength(JSON.stringify(result)) > 24000) bad("definition exceeds 24 KiB.");
  return result;
}
export function toolInputs(definition, args) {
  if (!isPlainRecord(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputs, key))) bad("unsupported execution input.");
  const values = {};
  for (const [key, field] of Object.entries(definition.inputs)) {
    const value = args[key] ?? field.default;
    if (value === undefined && field.required === false) { values[key] = ""; continue; }
    if (!text(value, field.maxLength || 2000) || !value || (field.enum && !field.enum.includes(value)) ||
        (["file", "handle"].includes(field.type) && !TOOL_UUID.test(value))) bad(`supply ${field.label}.`);
    values[key] = value;
  }
  return values;
}
export function resolveToolValue(value, inputs, context = {}) {
  if (typeof value === "string") return value;
  if (Object.hasOwn(value, "input")) return inputs[value.input];
  if (Object.hasOwn(value, "context")) { if (context[value.context] === undefined) throw fail(409, "The expected handle context is missing."); return context[value.context]; }
  if (Object.hasOwn(value, "urlEncode")) return encodeURIComponent(resolveToolValue(value.urlEncode, inputs, context));
  return value.concat.map(part => resolveToolValue(part, inputs, context)).join("");
}
export const protocolDescription = () => ({
  protocol: TOOL_PROTOCOL, browsers: Object.keys(TOOL_BROWSERS), limits: TOOL_LIMITS,
  definitionFields: ["protocol", "id", "title", "description", "origins", "inputs", "steps"],
  inputs: "String, handle or file, with a label, optional maxLength, enum, default and required. Browser and requestId are supplied at execution.",
  targets: "CSS selector and/or role; optional exact accessible name or normalized substring text. Default scope is the selected handle; scope: page uses the whole document. Actions require exactly one visible match.",
  templates: { input: { input: "declared_input_name" }, context: { context: "field_from_selected_handle" }, urlEncode: { urlEncode: { input: "query" } }, concat: { concat: ["literal", { input: "query" }] } },
  stepFields: { navigate: ["url"], use: ["handle"], assert: ["target"], assert_absent: ["target"], wait: ["target"], fill: ["target", "value"], click: ["target"], read: ["target", "as"], collect: ["target", "fields", "filter?", "empty?", "as"], download: ["target", "as"], pdf: ["target", "as"], attach: ["target", "file"] },
  handles: "Collection handles last five minutes, private file handles fifteen minutes, both bounded by the invitation. Item handles belong to one browser and one unchanged document. All handles end on revocation or restart.",
  operations: ["navigate", "use", "assert", "assert_absent", "wait", "fill", "click", "read", "collect", "download", "pdf", "attach"],
  rules: ["Exactly one matching visible target for every action; ambiguity stops execution.", "Use returned handles for selected messages, orders and attachments.", "No JavaScript, shell, inferred steps or password fields.", "Finish with an explicit assertion or a checked result.", "Reuse the same requestId after an uncertain response; Reach never repeats its effects."],
  example: { protocol: TOOL_PROTOCOL, id: "find_invoice", title: "Find invoice", description: "Search Gmail for invoices.", origins: ["https://mail.google.com"], inputs: { query: { type: "string", label: "Gmail query", maxLength: 500 } }, steps: [
    { op: "navigate", url: { concat: ["https://mail.google.com/mail/u/0/#search/", { urlEncode: { input: "query" } }] } },
    { op: "wait", target: { role: "main" } }, { op: "read", target: { role: "main" }, as: "results" },
  ] },
});
