export type BrowserAccess = {
  name: string;
  expiresAt: number;
  roots: { name: string; path: string; index: number }[];
  terminals: { id: string; name: string }[];
  screen: "off" | "view" | "scroll" | "ask";
  commandRequests?: boolean;
  restrictedTerminal?: boolean;
  terminalApproval?: boolean;
  scriptApproval?: boolean;
};
export type BrowserTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  approvalRequired?: boolean;
};
export function browserToolsFor(access?: Partial<BrowserAccess>): BrowserTool[];
export function browserToolRequest(name: string, args: unknown, access: BrowserAccess): {
  route: string;
  method: "GET" | "POST" | "DELETE";
  response: "json" | "image";
  body?: unknown;
};
