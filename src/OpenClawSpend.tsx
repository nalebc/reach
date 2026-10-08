import type { Peer } from "./api";

// Spend on one chat, a pill in its header.
export function ClawChatCost(_: { peer: Peer; sessionKey: string; refresh?: number }) {
  return null;
}
// Spend across OpenClaw, a pill on the status line; opens budget and models.
export function ClawSpendPill(_: { peer: Peer; refresh?: number }) {
  return null;
}
