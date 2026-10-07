import test from "node:test";
import assert from "node:assert/strict";
import { checkCodexSchemas } from "../scripts/agent-protocol-canary.mjs";

test("protocol canary rejects missing or weakened required acknowledgements", () => {
  const schemas = Object.fromEntries([
    ["v2/ThreadQueueAddResponse.json", "queuedSubmission", "object"],
    ["v2/ThreadQueueDeleteResponse.json", "deleted", "boolean"],
    ["v2/TurnStartResponse.json", "turn", "object"],
    ["v2/TurnSteerResponse.json", "turnId", "string"],
    ["v2/ThreadTurnsListResponse.json", "data", "array"],
    ["ToolRequestUserInputParams.json", "questions", "array"],
    ["CommandExecutionRequestApprovalParams.json", "threadId", "string"],
  ].map(([file, field, type]) => [file, { required: [field], properties: { [field]: { type } } }]));
  assert.doesNotThrow(() => checkCodexSchemas(schemas));
  schemas["v2/ThreadQueueDeleteResponse.json"].properties.deleted.type = "string";
  assert.throws(() => checkCodexSchemas(schemas), /ThreadQueueDeleteResponse/);
  schemas["v2/ThreadQueueDeleteResponse.json"].properties.deleted.type = "boolean";
  schemas["v2/TurnSteerResponse.json"].required = [];
  assert.throws(() => checkCodexSchemas(schemas), /TurnSteerResponse/);
});
