import { appLabel } from "./app-identity.mjs";
import { FULL_CONTROL_ACTIONS, GO_FAST } from "./browser-tools.mjs";

// What an agent is told once it's in (Oct 12: "a very small prompt with a
// link; the instructions come when they connect"): what it may do, then the
// few rules the invite message used to carry. Built from its access as it is
// now, on every ask, so the owner's later changes show; told only to the
// agent itself. Names only (folders, apps): never a path, a token or an
// invitation. Pure: the caller names the computer and the folders.
//
// `word`: "Mac", "Windows PC" or "computer" (computer-word.mjs).
// `folders`: the names of the folders it has now, in order.
// `page`: asked from its browser page, where vault passwords go in with Sign
// in; a program (its MCP server, `join`, a hosted connector) types them.

// A name the owner chose, quoted, short, with no characters that reorder or
// hide text (the phone quotes them the same way).
const quote = (value) =>
  JSON.stringify(
    value.length > 160 ? value.slice(0, 157) + "…" : value,
  ).replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const listWords = (items) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
// Three by name, then how many more.
const some = (names) =>
  names.length > 3
    ? `${names.slice(0, 3).map(quote).join(", ")} and ${names.length - 3} more`
    : listWords(names.map(quote));
const appName = (app) =>
  typeof app?.name === "string" && app.name.trim()
    ? app.name.trim()
    : typeof app?.id === "string" ? appLabel(app.id) : "";
const names = (apps) => (Array.isArray(apps) ? apps.map(appName).filter(Boolean) : []);

// Restricted invitations ask before consequential actions. Full control
// already authorizes the actions needed for the owner's requested task.
const ASK_FIRST = "Ask me before paying, sending or deleting anything.";
const CREDENTIALS = "Don't share your Reach credentials.";
// How it signs in (Oct 13: "they can log in to my accounts… I should not
// intervene, so either sign in SSO, or something like their vault"): the
// owner's Google (Apple, Microsoft) sign-in in the browser, else its own
// vault. Never what waits for the owner: the browser's saved passwords (a
// fill can ask for the owner's fingerprint), passkeys, the computer's
// password.
const signIn = (page) =>
  `Sign in with "Sign in with Google" (or Apple, Microsoft) on my account where the site offers it, otherwise from your vault, ${page ? "with Sign in" : 'typed with "secret":true'}. I won't be there to help: skip my browser's saved passwords and passkeys, and cancel anything that asks for my fingerprint or password.`;
const STAY_OUT = "Stay out of password apps, Reach and Tailscale.";

export function agentGuide(client, { word = "computer", folders = [], page = false } = {}) {
  if (client?.kind !== "agent") return "";
  const policy = client.policy && typeof client.policy === "object" ? client.policy : {};
  const scopes = Array.isArray(client.scopes) ? client.scopes : [];
  const where = folders.length ? some(folders) : "";
  const lines = [];
  let hands = false, acts = false;
  if (policy.browser === true && policy.preset !== undefined) {
    // A preset: what it may do follows from it (agent-presets.mjs).
    if (policy.preset === "full") {
      lines.push(`You have full control of my ${word} as my user account: all apps, files, browser pages and shell commands.`);
      acts = true;
    } else if (policy.preset === "apps") {
      const apps = names(policy.apps);
      lines.push(apps.length
        ? `You get only ${some(apps)}, on my screen. Nothing else.`
        : "You get only the apps I chose, on my screen. Nothing else.");
      hands = acts = true;
    } else if (policy.preset === "files")
      lines.push(where
        ? `You can ${policy.write === true ? "read and change" : "read"} files in ${where}. No screen, no commands.`
        : "No folders are shared with you right now. No screen, no commands.");
    else if (policy.preset === "readonly") {
      lines.push(`You can look: my screen${where ? ` and files in ${where}` : ""}. No clicks, no changes.`);
      const hidden = names(policy.hidden);
      if (hidden.length) lines.push(`Hidden from you: ${listWords(hidden.map(quote))}.`);
    }
    if (policy.standing === true) lines.push("Your access lasts until I end it.");
  } else if (policy.browser === true) {
    // An older browser invitation (before presets): only what it shared.
    if (policy.screen === "apps") {
      lines.push("You get only the apps I chose, on my screen.");
      hands = true;
    }
    if (where && scopes.includes("files:read")) lines.push(`You can read files in ${where}.`);
    if (Array.isArray(policy.terminalIds) && policy.terminalIds.length) lines.push("You can read the terminals I shared.");
  } else {
    // A command-line agent: its folders, and what it may do in them. Only
    // what its scopes say; anything else gets the rules alone.
    const files = !!where && (scopes.includes("files:read") || scopes.includes("files"));
    const run = files && scopes.includes("exec");
    const apps = scopes.includes("apps:drive");
    if (files)
      lines.push(`You can ${scopes.includes("files:write") ? "read and change" : "read"} files in ${where}${run ? ", and run commands there" : ""}.`);
    if (scopes.includes("codex")) lines.push(`You can use the Codex chats on my ${word}.`);
    if (apps) lines.push(`You can use my ${word}'s apps out of sight, and hand one to me when you need me.`);
    const closed = [!apps && "no screen", !run && "no commands"].filter(Boolean);
    if (closed.length) lines.push(`${closed.join(", ").replace(/^n/, "N")}.`);
    if (run) lines.push("Commands run as my user account: keep them to those folders.");
  }
  if (acts || hands) lines.push(signIn(page));
  if (hands) lines.push(STAY_OUT);
  // How to go fast on the screen, said as every tool that acts says it.
  if (acts) lines.push(GO_FAST);
  lines.push(policy.browser === true && policy.preset === "full" ? FULL_CONTROL_ACTIONS : ASK_FIRST, CREDENTIALS);
  return lines.join("\n");
}
