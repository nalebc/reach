import { presetPolicy, validatePresetInvitation } from "../../server/agent-presets.mjs";

// A current, explicitly accepted Full control invitation for isolated unit
// fixtures. Migration tests deliberately seed the older unmarked policy.
export const approvedFullPolicy = (roots = []) => presetPolicy(validatePresetInvitation({
  name: "Trusted fixture", preset: "full", fullControlVersion: 1, ttlSeconds: 600,
}), roots);
