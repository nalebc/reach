export function agentRequestTimeout(route: string, method?: string): number;
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
