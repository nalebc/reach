import { useEffect, useMemo, useRef, useState } from "react";
import { request, sameComputer, type Peer } from "./api";
import type { FleetConnection, FleetConnections } from "./useFleetConnections";

// The All page across every computer this phone is paired with
// (docs/ACROSS_AGENTS.md, ChatHub.tsx). Each computer is asked on its own, all
// at once, with its own credentials: a computer's token only ever goes to that
// computer's address (request()). One that's away or says no is named, never
// waited for: the others show as they answer.

// Why a computer's chats aren't on the page (yet): still asking; it didn't
// answer; it wants this phone paired again; this phone isn't one of its
// owner's devices (chats are for those only); its Reach is older than this.
export type Absence = "asking" | "offline" | "access" | "owner" | "older";
export type Answer<T> = { value?: T; absence?: Absence; message?: string };

// The computers the page covers: the one connected first, then the phone's
// other paired computers. A browser agent's link (Funnel) isn't a computer of
// yours: chats answer the owner's own devices only.
export function chatComputers(here: Peer, paired: Peer[] = []) {
  const list = [here];
  for (const p of paired)
    if (p.transport !== "funnel" && !list.some((c) => sameComputer(c, p))) list.push(p);
  return list;
}

// A failed request, for the computer that failed it. (A computer that hasn't
// linked this page's address fails before it can say so: as if it didn't
// answer.)
export const absenceOf = (e: unknown): Absence => {
  const status = (e as { status?: number })?.status;
  return status === 401 ? "access" : status === 403 ? "owner" : status === 404 ? "older" : "offline";
};

// A computer's live connection (useFleetConnections) is a hint, never a
// requirement: a page can be read while that connection is still trying.
export const presence = (c?: FleetConnection) => c?.state || "";
// Its chat list's revision, when its live connection says it.
export function listRevision(c?: FleetConnection) {
  try {
    const value = c?.changes ? JSON.parse(c.changes).sessions : undefined;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

// What each computer answers at its path (null: not asked), asked while the
// page shows and every `everyMs`, never twice at a time. `nudge`: asked again
// at once when what it returns for a computer changes (its live connection
// back, its chat list changed). `versioned`: a list the computer can say is
// unchanged (`known=`, as /api/sessions does), which then costs a few bytes.
export function useEveryComputer<T>(
  computers: Peer[],
  pathOf: (p: Peer) => string | null,
  everyMs: number,
  {
    connections,
    nudge,
    versioned = false,
  }: { connections?: FleetConnections; nudge?: (p: Peer) => string; versioned?: boolean } = {},
): Record<string, Answer<T>> {
  const [answers, setAnswers] = useState<Record<string, Answer<T>>>({});
  const held = useRef(answers);
  held.current = answers;
  // A computer that turned this phone away on its live connection isn't asked.
  const plan = computers.map((p) => ({ p, path: connections?.[p.id]?.state === "denied" ? null : pathOf(p) }));
  const key = JSON.stringify(plan.map(({ p, path }) => [p.id, p.url, p.token, path]));
  const askOne = useRef<(id: string) => void>(() => {});
  // It said no (401, 403, 404): not asked again while it has these credentials.
  const refused = useRef(new Set<string>());
  const credentials = (p: Peer) => `${p.id}\n${p.url}\n${p.token}`;
  useEffect(() => {
    let live = true;
    const busy = new Set<string>();
    const failures: Record<string, number> = {};
    const versions: Record<string, string> = {};
    const retries = new Set<ReturnType<typeof setTimeout>>();
    const ask = ({ p, path }: (typeof plan)[number]) => {
      if (!live || !path || document.hidden || busy.has(p.id) || refused.current.has(credentials(p))) return;
      busy.add(p.id);
      const known = versions[p.id] ? `${path.includes("?") ? "&" : "?"}known=${encodeURIComponent(versions[p.id])}` : "";
      request<T & { unchanged?: boolean; version?: string }>(p, path + known)
        .then(
          (r) => {
            if (!live) return;
            failures[p.id] = 0;
            if (r?.unchanged) return;
            if (versioned && typeof r?.version === "string") versions[p.id] = r.version;
            setAnswers((old) => ({ ...old, [p.id]: { value: r } }));
          },
          (e) => {
            if (!live) return;
            delete versions[p.id];
            const absence = absenceOf(e);
            if (absence !== "offline") refused.current.add(credentials(p));
            // A blip (the phone waking, the network changing) changes nothing
            // shown: asked again in a moment, and said only if it lasts.
            else if (held.current[p.id]?.value !== undefined && (failures[p.id] = (failures[p.id] || 0) + 1) < 2) {
              const retry = setTimeout(() => (retries.delete(retry), ask({ p, path })), 2000);
              retries.add(retry);
              return;
            }
            setAnswers((old) => ({ ...old, [p.id]: { absence, message: (e as Error)?.message || "" } }));
          },
        )
        .finally(() => busy.delete(p.id));
    };
    const askAll = () => plan.forEach(ask);
    askOne.current = (id) => {
      const one = plan.find((x) => x.p.id === id);
      if (one) ask(one);
    };
    askAll();
    const timer = setInterval(askAll, everyMs);
    const shown = () => !document.hidden && askAll();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("online", shown);
    return () => {
      live = false;
      askOne.current = () => {};
      clearInterval(timer);
      retries.forEach(clearTimeout);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("online", shown);
    };
  }, [key, everyMs, versioned]);
  const nudges = computers.map((p) => `${p.id}=${nudge?.(p) ?? ""}`).join("\n");
  const nudged = useRef<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const p of computers) {
      next[p.id] = nudge?.(p) ?? "";
      if (!(p.id in nudged.current) || nudged.current[p.id] === next[p.id]) continue;
      // Its live connection let this phone in: what it refused before (this
      // phone not yet approved there, say) may be allowed now.
      if (connections?.[p.id]?.state === "connected") refused.current.delete(credentials(p));
      askOne.current(p.id);
    }
    nudged.current = next;
  }, [nudges]);
  // Not answered yet: what its live connection says, when it says something.
  const states = computers.map((p) => connections?.[p.id]?.state || "").join(" ");
  return useMemo(
    () =>
      Object.fromEntries(
        computers.map((p): [string, Answer<T>] => {
          const state = connections?.[p.id]?.state;
          if (state === "denied") return [p.id, { absence: "access" }];
          const answer = answers[p.id];
          if (answer && (answer.value !== undefined || answer.absence)) return [p.id, answer];
          return [p.id, { absence: state === "disconnected" ? "offline" : "asking" }];
        }),
      ),
    [answers, key, states],
  );
}

// Each computer asked once for `path` (after `delayMs` without a change, as
// for a search while you type), each answer shown as it comes. `waiting`: the
// computers that haven't answered yet.
export function useAskEveryComputer<T>(computers: Peer[], path: string | null, delayMs = 0) {
  const [state, setState] = useState<{ path: string; answers: Record<string, Answer<T>>; waiting: string[] } | null>(null);
  const key = JSON.stringify(computers.map((p) => [p.id, p.url, p.token]));
  useEffect(() => {
    if (!path) {
      setState(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setState({ path, answers: {}, waiting: computers.map((p) => p.id) });
      const answered = (id: string, answer: Answer<T>) =>
        live &&
        setState((old) =>
          old?.path === path ? { path, answers: { ...old.answers, [id]: answer }, waiting: old.waiting.filter((w) => w !== id) } : old,
        );
      for (const p of computers)
        request<T>(p, path).then(
          (value) => answered(p.id, { value }),
          (e) => answered(p.id, { absence: absenceOf(e), message: (e as Error)?.message || "" }),
        );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, key, delayMs]);
  return state?.path === path ? state : null;
}

// "Studio and Office" (more than four: "your 5 computers").
export const computerNames = (names: string[]) =>
  names.length > 4
    ? `your ${names.length} computers`
    : names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names[0] || "";

// The computers whose chats aren't on the page, and why, in a sentence each.
export function sayAbsent(absent: { name: string; absence: Absence }[]) {
  const said: string[] = [];
  for (const absence of ["asking", "offline", "access", "owner", "older"] as const) {
    const names = absent.filter((a) => a.absence === absence).map((a) => a.name);
    if (!names.length) continue;
    const one = names.length === 1;
    const who = computerNames(names);
    said.push(
      absence === "asking"
        ? `Asking ${who}…`
        : absence === "offline"
          ? `${who} didn’t answer.`
          : absence === "access"
            ? `${who} need${one ? "s" : ""} this phone paired again.`
            : absence === "owner"
              ? `${who} ${one ? "doesn’t" : "don’t"} share ${one ? "its" : "their"} chats with this phone.`
              : `${who} need${one ? "s" : ""} a newer Reach for this.`,
    );
  }
  return said.join(" ");
}
