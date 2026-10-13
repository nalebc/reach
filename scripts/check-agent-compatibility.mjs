#!/usr/bin/env node
// Account-free release canary: CLI surface plus protocol; never a model turn.
import { createAgentProbe } from "../server/agent-sessions/compatibility.mjs";
import { protocolCanary } from "./agent-protocol-canary.mjs";
const [agent, executable = agent] = process.argv.slice(2);
if (!["claude", "codex", "openclaw"].includes(agent)) {
  console.error(
    "Usage: node scripts/check-agent-compatibility.mjs <claude|codex|openclaw> [executable]",
  );
  process.exitCode = 2;
} else if (agent === "openclaw") {
  // A throwaway Gateway of its own (openclaw-canary.mjs), not this computer's.
  const { openClawCanary } = await import("./openclaw-canary.mjs");
  const result = await openClawCanary(executable);
  console.log(JSON.stringify({ agent, ...result }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
} else {
  const result = await createAgentProbe()(agent, executable);
  if (result.status === "available") {
    // Twice before it counts: a CLI's first start on a fresh runner (Claude
    // Code unpacking itself) can miss the time a second one makes (Oct 12,
    // PR 25). A contract that changed fails both times, and says how.
    let failure = null;
    for (let attempt = 1; attempt <= 2 && !result.protocol; attempt++)
      try { result.protocol = await protocolCanary(agent, executable); }
      catch (error) { failure = error; }
    if (!result.protocol) {
      result.status = "incompatible";
      result.reason = `Protocol canary failed: ${failure?.message || "no answer"} Inspect the installed CLI contract before release.`;
    }
  }
  console.log(JSON.stringify({ agent, ...result }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
}
