import { useEffect, useRef, useState } from "react";
import { Plug, ShieldCheck } from "lucide-react";
import { request, type Peer } from "./api";
import { usePageVisible } from "./page-visible";
import type { NeedItem } from "./NeedsYou";
import type { ServiceAccess } from "../server/browser-tools.mjs";
import "./service-tools.css";

const until = (value: number) =>
  new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function useServiceAccess(peer: Peer, enabled = true, changes?: string) {
  const visible = usePageVisible();
  const [entries, setEntries] = useState<ServiceAccess[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [revision, setRevision] = useState(0);
  const session = useRef<AbortController | null>(null);
  const pending = useRef(false);
  let fingerprint = "";
  try {
    fingerprint = changes ? JSON.parse(changes).serviceAccess || "" : "";
  } catch {}
  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    pending.current = false;
    setEntries([]);
    setError("");
    setBusy("");
    return () => {
      controller.abort();
    };
  }, [peer.id, peer.url, peer.token, enabled]);
  useEffect(() => {
    if (!enabled || !visible) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await request<{ access: ServiceAccess[] }>(
          peer,
          "/api/agents/services",
          { signal: controller.signal },
        );
        if (!controller.signal.aborted && !pending.current) {
          setEntries(result.access || []);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setEntries([]);
          setError((error as Error).message);
        }
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), fingerprint ? 15000 : 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.id, peer.url, peer.token, enabled, visible, fingerprint, revision]);
  const decide = async (
    entry: ServiceAccess,
    decision: "approve" | "deny" | "revoke",
  ) => {
    const active = session.current;
    if (pending.current || !active || active.signal.aborted) return;
    pending.current = true;
    setBusy(entry.id);
    setError("");
    try {
      const result = await request<ServiceAccess>(
        peer,
        `/api/agents/services/${encodeURIComponent(entry.id)}`,
        {
          method: "POST",
          body: JSON.stringify({ decision }),
          signal: active.signal,
        },
      );
      if (session.current === active && !active.signal.aborted)
        setEntries((old) =>
          old.map((item) => (item.id === result.id ? result : item)),
        );
    } catch (error) {
      if (session.current === active && !active.signal.aborted)
        setError((error as Error).message);
      throw error;
    } finally {
      if (session.current === active && !active.signal.aborted) {
        pending.current = false;
        setBusy("");
        setRevision((r) => r + 1);
      }
    }
  };
  const activeEntries = entries.filter((entry) => entry.expiresAt > Date.now());
  const items: NeedItem[] = enabled
    ? activeEntries
        .filter((entry) => entry.status === "pending")
        .map((entry) => ({
          key: `service:${entry.id}`,
          icon: <Plug size={22} />,
          title: `${entry.agentName} · ${entry.serviceName}`,
          detail: `${entry.permissions.join(", ")} · ${entry.account} · Until ${until(entry.accessExpiresAt)}`,
          body: <p>{entry.reason}</p>,
          actions: [
            {
              label: "Deny",
              completes: true,
              run: () => decide(entry, "deny"),
            },
            {
              label: "Allow for session",
              primary: true,
              completes: true,
              run: () => decide(entry, "approve"),
            },
          ],
        }))
    : [];
  return { entries: activeEntries, items, decide, busy, error };
}

export function ServiceAccessPanel({ peer }: { peer: Peer }) {
  const { entries, decide, busy, error } = useServiceAccess(peer);
  const active = entries.filter((entry) =>
    ["pending", "approved"].includes(entry.status),
  );
  return (
    <section className="service-access" aria-label="Agent service access">
      <h3>
        <ShieldCheck size={17} /> Service access
      </h3>
      <p>
        Services use the agent's allowed browser. Approve them once per session.
        Revoking a service stops these tools; existing browser access is managed
        in Agent Access.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!active.length && !error && (
        <p className="service-muted">
          No services shared. Agents can request Gmail or Walmart from Tools →
          Services.
        </p>
      )}
      {active.map((entry) => (
        <article key={entry.id} className="service-card">
          <strong>
            {entry.agentName} · {entry.serviceName}
          </strong>
          <p>
            {entry.permissions.join(", ")} · {entry.account}
          </p>
          <small>
            Until{" "}
            {until(
              entry.status === "approved"
                ? entry.expiresAt
                : entry.accessExpiresAt,
            )}
          </small>
          {entry.status === "pending" && <p>{entry.reason}</p>}
          <div className="service-actions">
            {entry.status === "pending" ? (
              <>
                <button
                  disabled={!!busy}
                  onClick={() => void decide(entry, "deny").catch(() => {})}
                >
                  Deny
                </button>
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() => void decide(entry, "approve").catch(() => {})}
                >
                  Allow for session
                </button>
              </>
            ) : (
              <button
                disabled={!!busy}
                onClick={() => void decide(entry, "revoke").catch(() => {})}
              >
                Revoke service access
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
