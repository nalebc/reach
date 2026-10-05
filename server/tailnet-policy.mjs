// Reach's two lines in your Tailscale policy, added for you. The policy file
// is HuJSON (JSON with comments and trailing commas); Reach reads it without
// losing a character, and only ever inserts: its guest tag in tagOwners and
// one grant (guest devices reach Reach's port on your computers, nothing
// else). Your rules, comments and formatting stay exactly as they were.

const PUNCT = new Set(["{", "}", "[", "]", ":", ","]);

// Tokens of a HuJSON text, with their positions; comments and whitespace are
// skipped (they stay in the text, untouched).
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  const fail = (what) => {
    const line = text.slice(0, i).split("\n").length;
    throw Error(`Your Tailscale policy couldn't be read (${what}, line ${line}).`);
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) i++;
    else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) fail("an unclosed comment");
      i = end + 2;
    } else if (PUNCT.has(c)) {
      tokens.push({ type: c, start: i, end: i + 1 });
      i++;
    } else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) fail("an unclosed string");
      i++;
      tokens.push({
        type: "string",
        start,
        end: i,
        value: JSON.parse(text.slice(start, i)),
      });
    } else {
      const start = i;
      while (i < text.length && !/[\s,:\]\}\[\{\/"]/.test(text[i])) i++;
      if (i === start) fail(`an unexpected "${c}"`);
      let value;
      try {
        value = JSON.parse(text.slice(start, i));
      } catch {
        fail(`an unexpected "${text.slice(start, i)}"`);
      }
      tokens.push({ type: "literal", start, end: i, value });
    }
  }
  return tokens;
}

// The policy as a tree that remembers where each part is in the text.
function tree(tokens) {
  let i = 0;
  const expect = (type) => {
    if (tokens[i]?.type !== type)
      throw Error("Your Tailscale policy couldn't be read (unexpected structure).");
    return tokens[i++];
  };
  const node = () => {
    const t = tokens[i];
    if (!t) throw Error("Your Tailscale policy couldn't be read (it ends early).");
    if (t.type === "{") {
      i++;
      const entries = [];
      while (tokens[i]?.type !== "}") {
        const key = expect("string");
        expect(":");
        entries.push({ key: key.value, value: node() });
        if (tokens[i]?.type === ",") i++;
      }
      return { kind: "object", open: t, close: tokens[i++], entries };
    }
    if (t.type === "[") {
      i++;
      const items = [];
      while (tokens[i]?.type !== "]") {
        items.push(node());
        if (tokens[i]?.type === ",") i++;
      }
      return { kind: "array", open: t, close: tokens[i++], items };
    }
    i++;
    return { kind: t.type === "string" ? "string" : "literal", token: t, value: t.value };
  };
  const root = node();
  if (i !== tokens.length || root.kind !== "object")
    throw Error("Your Tailscale policy couldn't be read (it isn't one object).");
  return root;
}
const plain = (n) =>
  n.kind === "object"
    ? Object.fromEntries(n.entries.map((e) => [e.key, plain(e.value)]))
    : n.kind === "array"
      ? n.items.map(plain)
      : n.value;
const entry = (obj, key) => obj?.entries?.find((e) => e.key === key)?.value;

// The standard JSON value of a HuJSON policy.
export const parsePolicy = (text) => plain(tree(tokenize(text)));

// One indent step as the file uses it (tabs, or its number of spaces).
function indentUnit(text) {
  const m = text.match(/\n([ \t]+)"/);
  if (!m) return "\t";
  return m[1].startsWith("\t") ? "\t" : m[1].length >= 4 ? "    " : "  ";
}
const lineIndent = (text, pos) => {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  return text.slice(start).match(/^[ \t]*/)[0];
};

// Rules that let everyone reach everything ("src": ["*"]): with those, guest
// devices could reach more than Reach. Tailscale rules only ever allow, so
// this can only be fixed by narrowing that rule; Reach says so, it doesn't
// change your rules.
export function allowAllRules(policy) {
  const has = (list, v) => Array.isArray(list) && list.includes(v);
  const found = [];
  for (const [i, r] of (policy.acls || []).entries())
    if (
      r?.action === "accept" &&
      (has(r.src, "*") || has(r.users, "*"))
    )
      found.push(`acls[${i}]`);
  for (const [i, g] of (policy.grants || []).entries())
    if (has(g?.src, "*")) found.push(`grants[${i}]`);
  return found;
}

// Conservative checks for rules which can include a newly enrolled guest.
// Existing user/group rules do not include tagged devices. Address selectors
// and aliases cannot be proven safe without resolving Tailscale's policy, so
// setup asks the owner to narrow them instead of assuming isolation.
export function guestPolicyRisks(policy, { tag, addresses, port }) {
  const risks = new Set(allowAllRules(policy));
  const sources = (list) => Array.isArray(list) && list.some((s) =>
    typeof s === "string" && (s === tag || s === "autogroup:tagged" ||
      s.includes("/") || Object.hasOwn(policy.hosts || {}, s)));
  for (const [i, grant] of (policy.grants || []).entries()) {
    if (!sources(grant.src)) continue;
    const exactTag = grant.src.every((s) => s === tag);
    const narrow = Array.isArray(grant.dst) && grant.dst.every((d) => addresses.includes(d)) &&
      Array.isArray(grant.ip) && grant.ip.every((p) => p === `tcp:${port}`) && !grant.app;
    if (!exactTag || !narrow) risks.add(`grants[${i}]`);
  }
  for (const [i, acl] of (policy.acls || []).entries()) {
    if (acl.action !== "accept" || !sources(acl.src || acl.users)) continue;
    const allowed = addresses.map((a) => `${a}:${port}`);
    const narrow = (acl.src || acl.users).every((s) => s === tag) && acl.proto === "tcp" &&
      Array.isArray(acl.dst || acl.ports) && (acl.dst || acl.ports).every((d) => allowed.includes(d));
    if (!narrow) risks.add(`acls[${i}]`);
  }
  return [...risks];
}

// What Reach needs in your policy, and the policy text with it added.
// Returns { text, added: [lines], allowAll: [rules] }; `added` is empty
// when everything is already there (nothing to write).
export function addGuestRules(text, { tag, addresses, port }) {
  const root = tree(tokenize(text));
  const policy = plain(root);
  const unit = indentUnit(text);
  const edits = [];
  const added = [];
  const ownerValue = JSON.stringify(["autogroup:admin"]);
  const grant = { src: [tag], dst: addresses, ip: [`tcp:${port}`] };
  const grantText = `{"src": ${JSON.stringify(grant.src)}, "dst": ${JSON.stringify(grant.dst)}, "ip": ${JSON.stringify(grant.ip)}}`;
  const note = "// Added by Reach: invite links for people and agents.";

  // Insert right after an opening { or [, indented one step deeper than the
  // line it's on, keeping what followed on its own line.
  const insertAfter = (open, body) => {
    const outer = lineIndent(text, open.start);
    const depth = outer + unit;
    const rest = text.slice(open.end);
    // What followed the bracket keeps its own line: a closing bracket goes
    // back to the outer indent, other content to the inner one.
    const after = /^[ \t]*(\n|\/\/|$)/.test(rest)
      ? ""
      : /^[ \t]*[\]}]/.test(rest)
        ? `\n${outer}`
        : `\n${depth}`;
    edits.push({
      at: open.end,
      text: `\n${depth}${note}\n${depth}${body},${after}`,
    });
  };

  const owners = entry(root, "tagOwners");
  if (!policy.tagOwners?.[tag]) {
    if (owners?.kind === "object")
      insertAfter(owners.open, `${JSON.stringify(tag)}: ${ownerValue}`);
    else
      insertAfter(root.open, `"tagOwners": {${JSON.stringify(tag)}: ${ownerValue}}`);
    added.push(`tagOwners: ${tag} → autogroup:admin`);
  }
  const covers = (g) =>
    Array.isArray(g?.src) &&
    g.src.includes(tag) &&
    Array.isArray(g.dst) &&
    addresses.every((a) => g.dst.includes(a) || g.dst.includes("*")) &&
    Array.isArray(g.ip) &&
    (g.ip.includes(`tcp:${port}`) || g.ip.includes("*"));
  if (!(policy.grants || []).some(covers)) {
    const grants = entry(root, "grants");
    if (grants?.kind === "array") insertAfter(grants.open, grantText);
    else insertAfter(root.open, `"grants": [${grantText}]`);
    added.push(`grant: ${tag} → ${addresses.join(", ")} port ${port}`);
  }
  // Apply from the end so earlier positions stay right.
  let out = text;
  for (const e of edits.sort((a, b) => b.at - a.at))
    out = out.slice(0, e.at) + e.text + out.slice(e.at);
  if (added.length) parsePolicy(out); // never hand Tailscale something unreadable
  return { text: out, added, allowAll: guestPolicyRisks(policy, { tag, addresses, port }) };
}
