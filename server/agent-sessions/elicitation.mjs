import { object } from "./compatibility.mjs";
import { computerWord } from "../computer-word.mjs";

// MCP also uses form mode for a confirmation with no input fields. Computer
// Use's app-access prompt is one of these, not a device-verification challenge.
// Only recognize the complete empty-object schema; never guess missing answers
// or flatten specialized native authentication/execution confirmations.
export function emptyConfirmation(params) {
  const schema = params.requestedSchema;
  if (
    params.mode !== "form" ||
    !object(schema) ||
    schema.type !== "object" ||
    !object(schema.properties) ||
    Object.keys(schema.properties).length ||
    (schema.required != null &&
      (!Array.isArray(schema.required) || schema.required.length)) ||
    Object.keys(schema).some(
      (key) => !["$schema", "type", "properties", "required"].includes(key),
    )
  )
    return false;
  const meta = params._meta;
  if (meta == null) return true;
  if (
    !object(meta) ||
    "openai/elicitation" in meta ||
    "openai/confirmation" in meta
  )
    return false;
  if (meta.codex_approval_kind == null) return true;
  return (
    meta.codex_approval_kind === "mcp_tool_call" &&
    meta.connector_id === "computer-use" &&
    ["cua_repl", "node_repl"].includes(params.serverName)
  );
}

export function elicitationPrompt(params, agent = "Codex", platform = process.platform) {
  const text = (...values) => values.find((value) => typeof value === "string" && value.trim()) || "";
  const emptyForm = emptyConfirmation(params);
  const nativeOnly = !!(params.mode || params.requestedSchema) && !emptyForm;
  return {
    kind: "elicitation",
    title: `${text(params.serverName) || "A tool"} needs your input`,
    message: text(params.message, params.description, params.title),
    decisions: nativeOnly
      ? ["decline", "cancel"]
      : ["accept", "decline", "cancel"],
    ...(emptyForm ? { emptyForm: true } : {}),
    ...(nativeOnly
      ? {
          reason: `Complete this request in ${agent} on your ${computerWord(platform)}. Reach cannot submit the required form or device verification yet.`,
        }
      : {}),
  };
}

export function elicitationAnswer(prompt, answer) {
  if (!prompt.decisions.includes(answer?.decision))
    throw Object.assign(
      new Error("That choice is not available for this prompt."),
      { status: 400 },
    );
  return {
    action: answer.decision,
    content:
      answer.decision === "accept"
        ? prompt.emptyForm
          ? {}
          : (answer.content ?? null)
        : null,
  };
}
