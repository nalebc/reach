import type { Device } from "./api";
export type CodexStatus = {
  state: "checking" | "ready" | "missing" | "signin" | "unavailable";
};

export function workspaceCapabilities(
  device: Device | null,
  codex?: CodexStatus,
) {
  const allowed = (scope: string) =>
    !!device && (!device.access || device.access.scopes.includes(scope));
  const owner = allowed("admin");
  const desktop = !!device && ["darwin", "win32"].includes(device.platform);
  const screenSupported =
    desktop &&
    allowed("screen") &&
    device?.capabilities.screenSupported !== false;
  const files =
    !!device?.capabilities.files && (allowed("files") || allowed("files:read"));
  return {
    owner,
    files,
    writeFiles: files && (allowed("files") || allowed("files:write")),
    terminal: !!device?.capabilities.terminal && allowed("terminal"),
    apps: desktop && !!device?.capabilities.apps && allowed("apps"),
    shortcuts:
      owner && desktop && !!device?.capabilities.apps && allowed("apps"),
    desktopTerminals:
      owner &&
      device?.platform === "darwin" &&
      !!device?.capabilities.terminal &&
      allowed("terminal"),
    screen: screenSupported && !!device?.capabilities.screen,
    screenSetup: screenSupported && owner,
    codex:
      !!device?.capabilities.codex &&
      allowed("codex") &&
      codex?.state === "ready",
    codexSetup: allowed("codex"),
    agents: owner,
    jobs: allowed("exec"),
    activity: owner,
    settings: owner,
    invite: owner,
  };
}
export type WorkspaceCapabilities = ReturnType<typeof workspaceCapabilities>;
export function pageAccessible(page: string, features: WorkspaceCapabilities) {
  if (page === "overview") return true;
  if (page === "chat") return features.codex;
  if (page === "terminal") return features.terminal;
  return (
    ["files", "apps", "screen", "agents", "settings", "invite"].includes(
      page,
    ) && !!features[page as keyof WorkspaceCapabilities]
  );
}
