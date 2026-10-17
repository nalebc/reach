import metadata from "../package.json" with { type: "json" };

// The package this process loaded, even if an update replaces its files.
// esbuild embeds the JSON in the standalone agent and records it as an input.
// This release version is separate from an agent runtime's SHA-256.
export const REACH_VERSION = metadata.version;
