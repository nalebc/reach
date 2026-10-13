// A skipped/cancelled dependency must never make the branch protection gate
// green. Called after every job, even if a prerequisite failed to start.
import path from "node:path";
import { fileURLToPath } from "node:url";

export function requiredFailures(needs, required) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) throw Error("Missing or malformed prerequisite results.");
  if (!Array.isArray(required) || !required.length || required.some(name => typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name))) throw Error("A required check must name its prerequisites.");
  return required.filter(name => needs[name]?.result !== "success");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.REACH_CI_NEEDS) throw Error("Missing prerequisite results: REACH_CI_NEEDS.");
  const needs = JSON.parse(process.env.REACH_CI_NEEDS);
  const required = process.argv.slice(2);
  const failed = requiredFailures(needs, required);
  if (failed.length) {
    console.error(`Required jobs did not succeed: ${failed.join(", ")}`);
    process.exitCode = 1;
  } else console.log(`All ${required.length} required jobs succeeded.`);
}
