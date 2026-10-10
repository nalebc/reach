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

function delay(signal: AbortSignal, ms = 2000) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
// Over: an unknown or revoked link, declined, or ended. Only these clear this
// browser's credentials and send the agent back to the owner.
const final = (e: unknown) => [401, 403, 410].includes((e as { status?: number })?.status || 0);
// In use in another browser, where the link was opened: the agent may take it back.
const elsewhere = (e: unknown) => (e as { status?: number })?.status === 423;
// The computer or the network for a moment: tried again by itself.
const passing = (e: unknown) =>
  typeof (e as { status?: number })?.status === "number" ||
  e instanceof TypeError ||
  (e as Error)?.name === "TimeoutError";

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
  // The access is over: why, in the computer's words.
  const [closed, setClosed] = useState<{ title: string; message: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [moved, setMoved] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // What the next run does first: reconnect after refused requests, or take
  // the access back from another browser (the agent chose Use it here).
  const next = useRef<"" | "recover" | "take">("");
  const failedToken = useRef<string | undefined>(undefined);
  // Leave (a one-time session): this browser's credentials go.
  const end = useCallback(() => {
    void agent.forget(current.current).catch(() => {});
    setState(null);
    setEnded(true);
    setError("");
  }, [agent]);
  // The workspace's requests were refused even after reconnecting: find out
  // why, and keep going whenever the access still exists.
  const lost = useCallback(() => {
    failedToken.current = current.current?.session?.peer.token;
    next.current = "recover";
    setRecovering(true);
    setAttempt((n) => n + 1);
  }, []);
  const useHere = () => {
    next.current = "take";
    setMoved(false);
    setBusy(true);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    if (ended || closed) return;
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    const update = (value: FunnelState) => {
      current.current = value;
      if (live()) setState(value);
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    const how = next.current;
    next.current = "";
    void (async () => {
      try {
        let value = await agent.prepare(invitation);
        // Save a usable non-extractable identity before removing the link.
        if (location.hash) history.replaceState(null, "", location.pathname);
        update(value);
        if (how === "take") value = await agent.takeBack(value);
        else if (how === "recover") value = await agent.reconnect(value, failedToken.current);
        else if (!value.session && !value.receipt) value = await agent.claim(value);
        update(value);
        if (live()) setBusy(false);
        let wait = 2000;
        while (live() && !value.session) {
          try {
            value = value.receipt ? await agent.status(value) : await agent.claim(value);
            update(value);
            if (live()) setError("");
            wait = 2000;
          } catch (e) {
            if (final(e) || elsewhere(e)) throw e;
            if (live()) setError("Connection interrupted. Trying again…");
            wait = Math.min(wait * 2, 15000);
          }
          if (!value.session) await delay(controller.signal, wait);
        }
        if (live()) {
          setRecovering(false);
          setMoved(false);
          setError("");
        }
      } catch (e) {
        if (!live()) return;
        if (elsewhere(e)) {
          setMoved(true);
          setRecovering(false);
          setError("");
          return;
        }
        if (final(e)) {
          await agent.forget(current.current).catch(() => {});
          if (!live()) return;
          const declined = (e as { status?: number }).status === 403;
          setClosed({
            title: declined ? "Connection declined" : "Access ended",
            message: (e as Error).message,
          });
          current.current = null;
          setState(null);
          setRecovering(false);
          setError("");
          return;
        }
        if (passing(e)) {
          // The access is still there: try again in a moment, the same way.
          setError(how === "recover" || recovering ? "Reconnecting…" : "Connection interrupted. Trying again…");
          retry = setTimeout(() => {
            if (how) next.current = how;
            setAttempt((n) => n + 1);
          }, 5000);
          return;
        }
        setError(
          (e as Error).message ||
            "The connection could not open. Open the link again.",
        );
        setState(null);
      } finally {
        if (live()) setBusy(false);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [agent, invitation, ended, closed, attempt]);

  if (state?.session && !ended && !closed && !moved && !recovering)
    return (
      <>
        <GuestBar
          session={{
            peers: [state.session.peer],
            expiresAt: state.session.expiresAt,
          }}
          always={state.standing === true}
          onEnd={end}
          onLost={lost}
        />
        <BrowserWorkspace peer={state.session.peer} onEnd={lost} />
      </>
    );

  const receipt = state?.receipt;
  // Approved before: this browser is getting its access, nothing to compare.
  const resuming = !!receipt && (receipt.moved === true || receipt.refreshed === true);
  const name = receipt?.device.name || state?.session?.peer.name || "the computer";
  const [title, text] = closed
    ? [closed.title, closed.message]
    : ended
      ? ["You left", "This browser no longer holds the access. While it lasts, open your Reach link again to come back."]
      : moved
        ? ["In use in another browser", `Your access to ${name} is in use in another browser, where your link was opened. Use it here to move it back to this browser; the other one is disconnected.`]
        : recovering || resuming
          ? ["Reconnecting…", `Your access to ${name} is still yours. This page is reconnecting by itself; nothing to approve.`]
          : receipt
            ? ["Ask the owner to approve", `Show this code to the owner of ${receipt.device.name}. They can compare it in Reach and approve your connection.`]
            : busy
              ? ["Opening your invitation…", "Preparing a secure connection for this browser."]
              : error
                ? ["Connection unavailable", "Open the Reach link the computer’s owner sent you. Access is available only after they approve."]
                : ["A window into their computer", "Open the Reach link the computer’s owner sent you. Access is available only after they approve."];
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
        <h1>{title}</h1>
        <p>{text}</p>
        {moved && (
          <button className="funnel-agent-use-here" onClick={useHere}>
            Use it here
          </button>
        )}
        {receipt && !resuming && !moved && !closed && (
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
        {receipt && !resuming && !moved && !closed && (
          <ol className="funnel-agent-steps" aria-label="What happens next">
            <li>The owner compares this code in Reach.</li>
            <li>When they approve, this page opens your workspace by itself.</li>
            <li>Keep this tab open. You don’t need to click anything.</li>
          </ol>
        )}
        {error && !closed && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!ended && !closed && (
          <p className="funnel-agent-footnote">
            Only the owner’s selected resources become available. Access lasts
            until their deadline or until they end it; your link brings you back
            in this browser meanwhile, or in another once the owner matches its
            code. You cannot invite others or grant access.
          </p>
        )}
      </section>
    </main>
  );
}
