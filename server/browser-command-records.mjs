// One log record for each command, including commands skipped in a batch.
export function browserCommandRecords(request) {
  if (["terminal", "terminal-change", "terminal-script"].includes(request?.action?.type)) return [request];
  if (request?.action?.type !== "batch") return [];
  return request.action.actions.flatMap((action, index) => {
    if (action.type !== "terminal") return [];
    const step = request.steps?.[index];
    const active = ["pending", "executing"].includes(request.status);
    const status = ["executed", "failed"].includes(step?.status) ? step.status
      : step?.status === "executing" && active ? "executing"
      : active ? "pending" : request.status;
    return [{
      id: `${request.id}:${index}`, clientId: request.clientId, name: request.name,
      action, reason: request.reason, status, createdAt: request.createdAt,
      expiresAt: request.expiresAt, approval: request.approval || "owner",
      ...(step?.folder !== undefined ? { folder: step.folder } : {}),
      ...(step?.output !== undefined ? { output: step.output } : {}),
      ...(step?.directory !== undefined ? { directory: step.directory } : {}),
      ...(step?.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
      ...(step?.error || (!active && request.error) ? { error: step?.error || request.error } : {}),
    }];
  });
}

export async function saveBrowserCommandRecords(log, request) {
  for (const record of browserCommandRecords(request)) await log.append(record);
}
