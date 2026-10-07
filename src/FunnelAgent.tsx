import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, LockKeyhole } from "lucide-react";
import BrowserWorkspace from "./BrowserWorkspace";
import { GuestBar } from "./guest-session";
import {
  browserFunnelAgent,
  type FunnelAgentClient,
  type FunnelState,
} from "./funnel-agent";
import "./agent-admissions.css";
import "./funnel-agent.css";

function delay(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export default function FunnelAgent({
  client,
}: {
  client?: FunnelAgentClient;
}) {
  const agent = client || browserFunnelAgent();
  const [invitation] = useState(
    () =>
      new URLSearchParams(location.hash.slice(1)).get("invite") || undefined,
  );
  const [state, setState] = useState<FunnelState | null>(null);
  const current = useRef<FunnelState | null>(null);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(true);
  const end = useCallback(() => {
    void agent.forget(current.current).catch(() => {});
    setState(null);
    setEnded(true);
    setError("");
  }, [agent]);

  useEffect(() => {
    if (ended) return;
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    const update = (value: FunnelState) => {
      current.current = value;
      if (live()) setState(value);
    };
    void (async () => {
      try {
        let value = await agent.prepare(invitation);
        // Save a usable non-extractable identity before removing the link.
        if (location.hash) history.replaceState(null, "", location.pathname);
        update(value);
        if (!value.session && !value.receipt) value = await agent.claim(value);
        update(value);
        if (live()) setBusy(false);
        while (live() && !value.session && value.receipt) {
          if (value.receipt.expiresAt <= Date.now()) {
            await agent.forget(value);
            throw Error(
              "This connection request expired. Ask the owner for a new invitation.",
            );
          }
          try {
            value = await agent.status(value);
            update(value);
            if (live()) setError("");
          } catch (e) {
            const status = (e as { status?: number }).status;
            if (status && [401, 403, 404, 409, 410].includes(status)) throw e;
            if (live())
              setError(
                "Connection interrupted. Retrying while your approval request is still valid…",
              );
          }
          if (!value.session) await delay(controller.signal);
        }
      } catch (e) {
        if (
          [401, 403, 404, 409, 410].includes(
            (e as { status?: number }).status || 0,
          ) &&
          current.current
        )
          await agent.forget(current.current).catch(() => {});
        if (live()) {
          setError(
            (e as Error).message ||
              "The connection could not open. Ask the owner for a new invitation.",
          );
          setState(null);
        }
      } finally {
        if (live()) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [agent, invitation, ended]);

  if (state?.session && !ended)
    return (
      <>
        <GuestBar
          session={{
            peers: [state.session.peer],
            expiresAt: state.session.expiresAt,
          }}
          onEnd={end}
        />
        <BrowserWorkspace peer={state.session.peer} onEnd={end} />
      </>
    );

  const receipt = state?.receipt;
  return (
    <main className="funnel-agent-page">
      <header className="funnel-agent-brand">
        <Bot size={22} /> REACH <span>for AI browsers</span>
      </header>
      <section className="funnel-agent-connect" aria-live="polite">
        <div className="funnel-agent-lock">
          <LockKeyhole size={24} />
        </div>
        <p className="funnel-agent-eyebrow">
          Temporary connection through Tailscale
        </p>
        <h1>
          {ended
            ? "Access ended"
            : receipt
              ? "Ask the owner to approve"
              : busy
                ? "Opening your invitation…"
                : error
                  ? "Connection unavailable"
                  : "A window into their computer"}
        </h1>
        <p>
          {ended
            ? "This browser’s credentials have been removed. Ask the owner for a new invitation to reconnect."
            : receipt
              ? `Show this code to the owner of ${receipt.device.name}. They can compare it in Reach and approve your connection.`
              : busy
                ? "Preparing a secure connection for this browser."
                : "Open a fresh invitation from the computer’s owner. Access is available only after they approve."}
        </p>
        {receipt && (
          <div className="agent-admission-waiting">
            <output
              className="agent-verification-code"
              aria-label="Verification code"
            >
              {receipt.verificationCode.slice(0, 3)}{" "}
              {receipt.verificationCode.slice(3)}
            </output>
            <strong className="funnel-agent-waiting">
              <span aria-hidden="true" /> Waiting for approval
            </strong>
            <small>
              Request expires{" "}
              {new Date(receipt.expiresAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
              . Keep this tab open.
            </small>
          </div>
        )}
        {receipt && (
          <ol className="funnel-agent-steps" aria-label="What happens next">
            <li>The owner compares this code in Reach.</li>
            <li>When they approve, this page opens your workspace by itself.</li>
            <li>Keep this tab open. You don’t need to click anything.</li>
          </ol>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!ended && (
          <p className="funnel-agent-footnote">
            Only the owner’s selected resources become available. Access ends at
            their deadline or after 2 minutes without contact from this browser.
            You cannot invite others or grant access.
          </p>
        )}
      </section>
    </main>
  );
}
