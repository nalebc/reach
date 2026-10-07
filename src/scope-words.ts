// What a credential's access means, in words for people (Settings, the
// access-request sheet, Home's "needs you" card).
export const scopeLabel = (s: string) =>
  ({
    admin: "Full access",
    "files:read": "Read files",
    "files:write": "Write files",
    files: "Files",
    exec: "Run commands",
    terminal: "Terminals",
    apps: "Open apps",
    codex: "Codex",
    screen: "Screen",
    "apps:drive": "Use apps",
  })[s] || s;

// Access that lets it act as you on the computer (commands, any app).
export const actsAsYou = (scopes: string[]) =>
  scopes.some((s) => ["exec", "terminal", "screen", "apps:drive"].includes(s));

// One line for an agent asking for access: what it gets, and a warning when
// that lets it act as you.
export const requestWords = (scopes: string[]) => {
  const words = scopes
    .filter((s) => s !== "device")
    .map(scopeLabel)
    .join(" · ");
  return actsAsYou(scopes)
    ? `${words}. It can act as you on this computer.`
    : words;
};
