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
    try { result.protocol = await protocolCanary(agent, executable); }
    catch (error) { result.status = "incompatible"; result.reason = "Protocol canary failed. Inspect the installed CLI contract before release."; }
  }
  console.log(JSON.stringify({ agent, ...result }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
}
