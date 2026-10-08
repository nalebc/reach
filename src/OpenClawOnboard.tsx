import type { Peer } from "./api";

// No OpenClaw (or no model) on this computer: install and set it up here.
export function ClawOnboard(_: { peer: Peer; onDone: () => void }) {
  return null;
}
// Add a model provider's key (OpenRouter, Anthropic, OpenAI…) from the phone.
export function ClawAddProvider(_: { peer: Peer; provider?: string; onDone?: () => void; onCancel?: () => void }) {
  return null;
}
