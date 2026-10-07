import type { Chat } from "./api";

const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): value is Record<string, any>[] =>
  Array.isArray(value) && value.every(record);

/** API JSON is untrusted at runtime, even when request<T> has a TS type. */
export function parseChatResponse(value: unknown, selected: string): Chat {
  if (
    !record(value) ||
    value.id !== selected ||
    !["name", "cwd", "status"].every((key) => typeof value[key] === "string") ||
    !records(value.items) ||
    !records(value.approvals) ||
    !value.items.every(
      (item) =>
        typeof item.id === "string" &&
        typeof item.type === "string" &&
        (item.content === undefined ||
          (records(item.content) &&
            item.content.every(
              (c) => c.text === undefined || typeof c.text === "string",
            ))) &&
        (item.changes === undefined ||
          (records(item.changes) &&
            item.changes.every(
              (c) =>
                typeof c.path === "string" &&
                (c.diff === undefined || typeof c.diff === "string"),
            ))) &&
        ["text", "command", "aggregatedOutput", "status", "tool"].every(
          (key) => item[key] === undefined || typeof item[key] === "string",
        ),
    ) ||
    !value.approvals.every(
      (a) =>
        ["string", "number"].includes(typeof a.id) &&
        typeof a.method === "string" &&
        record(a.params) &&
        ["reason", "command"].every(
          (key) =>
            a.params[key] === undefined || typeof a.params[key] === "string",
        ) &&
        (a.params.questions === undefined ||
          (records(a.params.questions) &&
            a.params.questions.every(
              (q) =>
                typeof q.id === "string" &&
                typeof q.question === "string" &&
                (q.options === undefined ||
                  (records(q.options) &&
                    q.options.every((o) => typeof o.label === "string"))),
            ))),
    ) ||
    (value.error != null && typeof value.error !== "string")
  ) {
    throw new Error(
      "This conversation returned incomplete data. Retrying automatically; you can still use the rest of Reach.",
    );
  }
  return value as Chat;
}
