import { TOOL_PROTOCOL, validateToolDefinition } from "./tool-protocol.mjs";

const input = (label, extra = {}) => ({ type: "string", label, ...extra });
const handle = label => ({ type: "handle", label });
const main = { role: "main" };
const gmail = "https://mail.google.com";
const walmart = "https://www.walmart.com";
const account = input("Google account index", { enum: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], default: "0" });
const gmailUrl = suffix => ({ concat: [`${gmail}/mail/u/`, { input: "account" }, suffix] });
const definitions = [
  { id: "builtin_open_gmail", title: "Open Gmail account", description: "Reuse the exact Gmail account tab and verify its mail workspace.", origins: [gmail], inputs: { account }, steps: [
    { op: "navigate", url: gmailUrl("/#inbox") }, { op: "wait", target: { role: "textbox", name: "Search mail" } }, { op: "assert", target: main },
  ] },
  { id: "builtin_open_walmart", title: "Open Walmart account", description: "Open purchase history in the existing browser session and verify the page.", origins: [walmart], inputs: {}, steps: [
    { op: "navigate", url: `${walmart}/orders` }, { op: "wait", target: { role: "heading", name: "Purchase history" } },
  ] },
  { id: "builtin_gmail_find", title: "Find Gmail message", description: "Search one Gmail account and return handles for messages on the rendered result page.", origins: [gmail], inputs: { account, query: input("Gmail search query", { maxLength: 500 }) }, steps: [
    { op: "navigate", url: { concat: [`${gmail}/mail/u/`, { input: "account" }, "/#search/", { urlEncode: { input: "query" } }] } },
    { op: "wait", target: { role: "textbox", name: "Search mail", text: { input: "query" } } },
    { op: "wait", target: { role: "main" } }, { op: "collect", target: { css: "tr[role=row]", scope: "page" }, empty: { css: "[role=main]", text: "No conversations found.", scope: "page" }, fields: { subject: { css: ".bog" }, sender: { css: ".yW" } }, as: "messages" },
  ] },
  { id: "builtin_gmail_open", title: "Open Gmail message", description: "Open a returned message handle, verify its subject and list downloadable attachment handles.", origins: [gmail], inputs: { message: handle("Message handle") }, steps: [
    { op: "use", handle: { input: "message" } }, { op: "click", target: { css: ":scope" } },
    { op: "wait", target: { css: "h2.hP", text: { context: "subject" }, scope: "page" } },
    { op: "collect", target: { css: "a[download]", scope: "page" }, empty: { css: "h2.hP", text: { context: "subject" }, scope: "page" }, fields: { filename: { css: ":scope" } }, as: "attachments" },
  ] },
  { id: "builtin_gmail_attachment", title: "Get Gmail attachment", description: "Fetch the exact selected download link in the signed-in browser and return a private, expiring file handle.", origins: [gmail], inputs: { attachment: handle("Attachment handle") }, steps: [
    { op: "use", handle: { input: "attachment" } }, { op: "download", target: { css: ":scope" }, as: "file" },
  ] },
  { id: "builtin_walmart_find", title: "Find Walmart order", description: "Filter order cards on the rendered purchase-history page and return handles; coverage is this page only.", origins: [walmart], inputs: { query: input("Item or order text", { maxLength: 200 }) }, steps: [
    { op: "navigate", url: `${walmart}/orders` }, { op: "wait", target: { role: "heading", name: "Purchase history" } },
    { op: "collect", target: { css: "[data-testid=order-card]", scope: "page" }, fields: { order: { css: "[data-testid=order-id]" } }, filter: { input: "query" }, as: "orders" },
  ] },
  { id: "builtin_walmart_receipt", title: "Get Walmart receipt", description: "Open the selected order, verify its order number and export the visible details as a PDF receipt snapshot.", origins: [walmart], inputs: { order: handle("Order handle") }, steps: [
    { op: "use", handle: { input: "order" } }, { op: "click", target: { role: "link", name: "View details" } },
    { op: "wait", target: { css: "[data-testid=order-details]", text: { context: "order" }, scope: "page" } },
    { op: "pdf", target: { css: "[data-testid=order-details]", scope: "page" }, as: "file" },
  ] },
  { id: "builtin_walmart_track", title: "Track Walmart order", description: "Open tracking for the selected order and return the verified tracking panel text.", origins: [walmart], inputs: { order: handle("Order handle") }, steps: [
    { op: "use", handle: { input: "order" } }, { op: "click", target: { role: "button", name: "Track shipment" } },
    { op: "wait", target: { css: "[data-testid=tracking-details]", text: { context: "order" }, scope: "page" } },
    { op: "read", target: { css: "[data-testid=tracking-details]", scope: "page" }, as: "tracking" },
  ] },
  { id: "builtin_gmail_draft", title: "Create Gmail draft with file", description: "Create one new draft, attach a returned file and verify Saved to Drafts. Never sends. A stopped or uncertain run must be inspected before creating another draft.", origins: [gmail], inputs: { account, to: input("Recipient email", { maxLength: 254 }), subject: input("Subject", { maxLength: 300 }), body: input("Message body", { maxLength: 20000 }), file: { type: "file", label: "File handle" } }, steps: [
    { op: "navigate", url: gmailUrl("/#inbox") }, { op: "wait", target: { role: "button", name: "Compose" } },
    { op: "assert_absent", target: { role: "dialog" } }, { op: "click", target: { role: "button", name: "Compose" } }, { op: "wait", target: { role: "dialog" } },
    { op: "fill", target: { css: "[role=dialog] input[name=to]" }, value: { input: "to" } },
    { op: "fill", target: { css: "[role=dialog] input[name=subjectbox]" }, value: { input: "subject" } },
    { op: "fill", target: { role: "textbox", name: "Message Body" }, value: { input: "body" } },
    { op: "attach", target: { css: "[role=dialog] input[type=file]" }, file: { input: "file" } },
    { op: "wait", target: { css: "[role=dialog] .vI", text: { context: "filename" } } },
    { op: "wait", target: { role: "status", name: "Saved to Drafts" } },
    { op: "read", target: { css: "[role=dialog] input[name=subjectbox]" }, as: "draft_subject" },
  ] },
];
export const PREBUILT_TOOLS = Object.freeze(definitions.map(definition => Object.freeze(validateToolDefinition({ protocol: TOOL_PROTOCOL, ...definition }, { builtIn: true }))));
