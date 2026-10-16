export function agentRequestTimeout(route: string, method?: string): number;
export const AGENT_JSON_RESPONSE_BYTES: number;
export const AGENT_SCREEN_RESPONSE_BYTES: number;
export const AGENT_MCP_IMAGE_RESPONSE_BYTES: number;
export function agentJsonResponseLimit(route: string, method?: string, body?: unknown, status?: number): number;
export function validateAgentJsonResponse<T>(route: string, method: string, body: unknown, result: T): T;
export function agentErrorDetails(error: unknown): {
  error: string;
  status?: number;
  kind?: string;
  holder?: string;
  retryInMs?: number;
  helperReason?: "timeout" | "process_exit" | "process_error" | "stdin_error" | "write_error" | "invalid_reply" | "oversized_reply" | "unexpected_reply" | "stopped";
  helperOperation?: "rules" | "catalog" | "shot" | "front" | "act" | "open" | "unknown";
  helperDispatch?: "completion_unknown" | "not_dispatched";
};
export function agentRequestError(
  status: number | undefined,
  body: unknown,
): Error & {
  status?: number;
  kind?: string;
  holder?: string;
  retryInMs?: number;
  helperReason?: "timeout" | "process_exit" | "process_error" | "stdin_error" | "write_error" | "invalid_reply" | "oversized_reply" | "unexpected_reply" | "stopped";
  helperOperation?: "rules" | "catalog" | "shot" | "front" | "act" | "open" | "unknown";
  helperDispatch?: "completion_unknown" | "not_dispatched";
  body: Record<string, unknown>;
};
