// Who's listed in Agents & people, and who of them may use this computer
// now. One reading for the list (PeopleHub) and Home's Access card, so the
// card never counts someone the list has put under Ended.

// What /api/clients says about each one, and what /api/browser/agents says
// about each browser agent (it alone knows one that idle-ended or was
// stopped while its end date is still ahead).
export type AccessClient = { id: string; kind?: string; status?: string; expiresAt?: number; mascot?: number };
export type AccessSession = { id: string; status?: string; expiresAt?: number };

// A browser agent still going: not past its end, and not stopped, denied or
// idle-ended (as the Mac says).
export const activeSession = (agent: { expiresAt?: number; status?: string }, now: number) =>
  (agent.expiresAt || 0) > now &&
  (!agent.status ||
    ["invited", "pending", "approved", "accepted"].includes(agent.status));

// Its status, from the Mac's agent sessions first.
export const statusIn = (c: AccessClient, sessions: AccessSession[]) =>
  sessions.find((s) => s.id === c.id)?.status ?? c.status;

// Listed: agents and people not past their end and not stopped. A browser
// agent goes by its session; the rest by their own record.
export function listedAccess<C extends AccessClient>(clients: C[], sessions: AccessSession[], now: number) {
  const live = (c: C) => {
    const s = sessions.find((x) => x.id === c.id);
    return s ? activeSession(s, now) : (c.expiresAt || 0) > now && c.status !== "revoked";
  };
  return {
    agents: clients.filter((c) => c.kind === "agent" && live(c)),
    people: clients.filter((c) => c.kind === "guest" && live(c)),
    ended: sessions.filter((s) => !activeSession(s, now)).length,
  };
}

// Of those listed, in now: joined. An invitation not opened yet, a request waiting
// for you, one denied or lapsed is listed, but has no access yet. Anything
// else unknown counts as no access.
export const hasAccessNow = (c: AccessClient, sessions: AccessSession[]) => {
  const status = statusIn(c, sessions);
  return !status || status === "accepted";
};

// Whose access a device here now uses, for its face. Presence names the
// device, not the access, so it's matched by the access's kind and end (and
// its name, if two share them). Unsure: no one, so never a wrong face.
export const accessOf = <C extends AccessClient & { name?: string }>(
  grants: { kind: string; expiresAt: number }[] | undefined,
  clients: C[],
  name?: string,
) => {
  for (const g of grants || []) {
    const kind = g.kind === "agent" ? "agent" : g.kind === "invited" ? "guest" : "";
    let found = clients.filter((x) => kind && x.kind === kind && x.expiresAt === g.expiresAt);
    if (found.length > 1) found = found.filter((x) => x.name === name);
    if (found.length === 1) return found[0];
  }
  return undefined;
};
