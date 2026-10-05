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
  // `admin`: uses the computer like you (you, or an invitation with full
  // access). `owner`: you, managing access. Invited people never manage it.
  const admin = allowed("admin");
  const owner = admin && device?.access?.kind !== "guest";
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
    apps:
      desktop &&
      !!device?.capabilities.apps &&
      (allowed("apps") || allowed("apps:open")),
    shortcuts:
      admin && desktop && !!device?.capabilities.apps && allowed("apps"),
    desktopTerminals:
      admin &&
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
  // Transcripts of every AI session: the owner only (server: admin scope).
  if (page === "sessions") return features.owner;
  if (page === "terminal") return features.terminal;
  return (
    ["files", "apps", "screen", "agents", "settings", "invite"].includes(
      page,
    ) && !!features[page as keyof WorkspaceCapabilities]
  );
}

// What More lists: the pages not in the phone's bottom bar, in order. Codex
// keeps its row, waiting, while the computer checks it, so the list doesn't
// jump when the answer comes.
export function morePlaces(
  pages: string[],
  bar: string[],
  features: WorkspaceCapabilities,
  codex?: CodexStatus,
) {
  const waiting = (id: string) => id === "chat" && codex?.state === "checking";
  const places = pages.filter(
    (id) => !bar.includes(id) && (pageAccessible(id, features) || waiting(id)),
  );
  return { places, pending: places.filter(waiting) };
}
