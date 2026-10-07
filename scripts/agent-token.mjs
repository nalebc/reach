import { getConfig, createAuth, AGENT_SCOPES } from "../server/core.mjs";
const args = process.argv.slice(2);
const value = (key, fallback) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const name = value("--name", "My agent");
const scopes = value("--scopes", "files").split(",");
if (scopes.some((s) => !AGENT_SCOPES.includes(s)))
  throw Error("Invalid agent scope.");
const issued = createAuth(getConfig(), { rotatePairing: false }).issue(
  name,
  scopes,
  "agent",
);
console.log(
  `Created ${name} with scopes: ${scopes.join(", ")}\n\nREACH_TOKEN=${issued.token}\n\nStore this secret securely. It is only shown once. Revoke it in Reach Settings.`,
);
