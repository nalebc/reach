import type { Peer } from "./api";

// The Gateway's health, a pill on the status line; opens logs and fixes.
export function ClawHealthPill(_: { peer: Peer; refresh?: number; onChanged?: () => void }) {
  return null;
}
