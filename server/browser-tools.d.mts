export type BrowserAccess = {
  name: string;
  expiresAt: number;
  roots: { name: string; path: string; index: number }[];
  terminals: { id: string; name: string }[];
  screen: "off" | "view" | "scroll" | "ask" | "apps" | boolean;
  // Preset sessions (server/agent-presets.mjs).
  preset?: "full" | "apps" | "files" | "readonly";
  presetName?: string;
  control?: boolean;
  open?: boolean;
  shell?: boolean;
  write?: boolean;
  apps?: { id: string; name?: string; bundleId?: string }[];
  hidden?: { id: string; name?: string }[];
  savedTools?: { id: string; name: string; tool?: string; stepCount: number; inputs: string[]; apps: string[] }[];
  savedToolHint?: string;
  browserTools?: { protocol: string; browsers: ("Chrome" | "Safari")[]; hint?: string; tools: DeterministicTool[] };
  commandRequests?: boolean;
  restrictedTerminal?: boolean;
  terminalApproval?: boolean;
  scriptApproval?: boolean;
};
export type DeterministicTool = { protocol: string; id: string; title: string; description: string; origins: string[]; inputs: Record<string, { type: "string" | "handle" | "file"; label: string; maxLength?: number; enum?: string[]; default?: string; required?: boolean }>; steps: Record<string, unknown>[]; builtIn?: boolean };
export type BrowserTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  approvalRequired?: boolean;
};
export function browserToolsFor(access?: Partial<BrowserAccess>): BrowserTool[];
export const SAVED_TOOLS_HINT: string;
export function savedToolName(item: { id: string; name: string }): string;
export function deterministicToolName(item: { id: string }): string;
export function browserToolRequest(name: string, args: unknown, access: BrowserAccess): {
  route: string;
  method: "GET" | "POST" | "DELETE";
  response: "json" | "image";
  body?: unknown;
};
