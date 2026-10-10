import { fail, isPlainRecord, hasReviewControls } from "./core.mjs";

// Real browser adapters, not PAP (its specification is not published yet).
// Do not register test providers or accept agent-supplied endpoints here.
export class ServiceConnectorError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
const browser = {
  type: "string",
  enum: ["Chrome", "Safari"],
  description: "Signed-in browser",
};
const query = (description, maxLength) => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});
const schemas = {
  gmail: {
    browser,
    account: {
      type: "string",
      enum: Array.from({ length: 10 }, (_, i) => String(i)),
      description: "Google account",
    },
    query: query("Gmail search", 500),
  },
  orders: { browser, query: query("Item or order number", 200) },
  tracking: {
    browser,
    order: {
      ...query("Order handle from Find orders", 36),
      pattern: "^[a-f0-9-]{36}$",
    },
  },
};
const unavailable = (client) => {
  if (
    !["full", "apps"].includes(client.policy?.preset) ||
    !["browser:screen", "browser:control", "browser:open"].every((scope) =>
      client.scopes?.includes(scope),
    )
  )
    return "In Agent Access, allow Chrome or Safari with the Apps preset to use signed-in services.";
  const allowed =
    client.policy.preset === "full"
      ? ["com.google.Chrome", "com.apple.Safari"]
      : (client.policy.apps || []).map((app) => app.bundleId);
  if (
    !allowed.some(
      (id) =>
        ["com.google.Chrome", "com.apple.Safari"].includes(id) &&
        !(client.policy.hidden || []).some((app) => app.bundleId === id),
    )
  )
    return "Allow Chrome or Safari in Agent Access to use signed-in services.";
  return null;
};
function validate(properties, values) {
  if (
    !isPlainRecord(values) ||
    Object.keys(values).some((key) => !Object.hasOwn(properties, key))
  )
    throw fail(400, "Use only the service's declared inputs.");
  const result = {};
  for (const [key, field] of Object.entries(properties)) {
    const value = values[key];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      hasReviewControls(value) ||
      (field.maxLength && value.length > field.maxLength) ||
      (field.enum && !field.enum.includes(value)) ||
      (field.pattern && !new RegExp(field.pattern).test(value))
    )
      throw fail(400, `Enter a valid ${field.description.toLowerCase()}.`);
    result[key] = value.trim();
  }
  return result;
}
const text = (value, max = 50000) => {
  if (typeof value !== "string" || value.length > max)
    throw Error("Invalid service result");
  return value;
};
function collection(raw, key, label, detail) {
  const value = raw.data?.[key];
  if (
    !value ||
    value.coverage !== "visible_page" ||
    !Array.isArray(value.items) ||
    value.items.length > 200
  )
    throw Error("Invalid service collection");
  return {
    browser: raw.browser,
    coverage: "visible_page",
    more: value.more === true,
    items: value.items.map((item) => {
      if (
        !/^[a-f0-9-]{36}$/.test(item.handle) ||
        !Number.isFinite(item.expiresAt)
      )
        throw Error("Invalid service handle");
      return {
        label: text(item[label]),
        ...(detail ? { detail: text(item[detail]) } : {}),
        handle: item.handle,
        expiresAt: item.expiresAt,
      };
    }),
  };
}
const action = (
  id,
  title,
  scope,
  permission,
  properties,
  example,
  project,
  extra = {},
) => ({
  id,
  title,
  scope,
  permission,
  readOnly: true,
  inputSchema: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
  example,
  validate: (values) => validate(properties, values),
  project,
  ...extra,
});
const problems = {
  setup_required:
    "On the Mac, allow browser automation for Reach and enable Allow JavaScript from Apple Events in the chosen browser, then retry.",
  login_required:
    "Sign in to this service in the chosen browser on the Mac, then retry.",
  wrong_site:
    "The browser reached another site. Finish signing in on the Mac, then retry.",
  browser_closed: "Open the chosen browser on the Mac, then retry.",
  browser_window_required:
    "Open a window in the chosen browser on the Mac, then retry.",
  browser_access: "Allow the chosen browser in Agent Access, then retry.",
  stale:
    "This result has expired or the page changed. Find the order again before tracking it.",
  busy: "Another browser tool is running. Wait for it to finish, then retry.",
};

export function createServiceConnectors(tools) {
  const make = (definition, toolIds) => ({
    ...definition,
    transport: "browser",
    account: "Your signed-in browser session",
    unavailable,
    async run(id, values, { authorize, requestId, signal }) {
      const guarded = () => {
        signal.throwIfAborted();
        const client = authorize();
        const reason = unavailable(client);
        if (reason) throw new ServiceConnectorError(reason, 403);
        return client;
      };
      guarded();
      const { browser, ...inputs } = values;
      let result;
      try {
        result = await tools.run(
          guarded,
          { id: toolIds[id], browser, values: inputs, requestId },
          { signal },
        );
      } catch (error) {
        guarded();
        throw new ServiceConnectorError(
          problems[error.code || error.kind] ||
            "Could not use this browser. Check Agent Access and the chosen browser on the Mac, then retry.",
        );
      }
      guarded();
      if (result.status !== "completed" || result.resultExpired)
        throw new ServiceConnectorError(
          problems[result.code] ||
            (result.status === "uncertain"
              ? "The live page could not be verified, and the action may have happened. Check the service in the browser on the Mac before retrying."
              : null) ||
            "The live page could not be verified. Check the service in the browser on the Mac, then retry. No service result was returned.",
        );
      return result;
    },
  });
  return [
    make(
      {
        id: "gmail",
        name: "Gmail",
        description:
          "Search real mail in your signed-in browser. Reads message subjects and senders on the visible results page.",
        actions: [
          action(
            "find",
            "Find messages",
            "mail:search",
            "Read mail subjects and senders",
            schemas.gmail,
            { browser: "Chrome", account: "0" },
            (raw) => collection(raw, "messages", "subject", "sender"),
          ),
        ],
      },
      { find: "builtin_gmail_find" },
    ),
    make(
      {
        id: "walmart",
        name: "Walmart",
        description:
          "Find your real Walmart.com orders and read shipment tracking in your signed-in browser.",
        actions: [
          action(
            "find",
            "Find orders",
            "orders:read",
            "Read orders and shipment tracking",
            schemas.orders,
            { browser: "Chrome" },
            (raw) => collection(raw, "orders", "order"),
          ),
          action(
            "track",
            "Track shipment",
            "orders:read",
            "Read orders and shipment tracking",
            schemas.tracking,
            { browser: "Chrome" },
            (raw) => ({
              browser: raw.browser,
              summary: text(raw.data?.tracking),
            }),
            { fromResult: "find" },
          ),
        ],
      },
      { find: "builtin_walmart_find", track: "builtin_walmart_track" },
    ),
  ];
}
