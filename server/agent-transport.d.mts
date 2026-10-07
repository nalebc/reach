export function agentRequestTimeout(route: string, method?: string): number;
export function agentErrorDetails(error: unknown): {
  error: string;
  status?: number;
  kind?: string;
  holder?: string;
  retryInMs?: number;
};
export function agentRequestError(
  status: number | undefined,
  body: unknown,
): Error & {
  status?: number;
  kind?: string;
  holder?: string;
  retryInMs?: number;
  body: Record<string, unknown>;
};
