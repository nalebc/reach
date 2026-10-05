import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { post, request, type Peer } from "./api";
import { agentLabel, type AgentName } from "./agent-sessions";

type SignInView = {
  agent?: AgentName;
  state: "idle" | "starting" | "link" | "checking" | "done" | "failed" | "cancelled";
  url: string | null;
  code: string | null;
  error: string | null;
};

// Signs an agent in on the Mac from the phone. The sign-in page opens here;
// Claude's page shows a code that goes back to the Mac's login, Codex finishes
// by itself once its one-time code is entered. Expands inline, no popup.
export default function AgentSignIn({
  peer,
  agent,
  onDone,
}: {
  peer: Peer;
  agent: AgentName;
  onDone: () => void;
}) {
  const [view, setView] = useState<SignInView | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = useRef(onDone);
  done.current = onDone;
  const active = !!view && ["starting", "link", "checking"].includes(view.state);
  // Follow it while it runs: Codex finishes on its own, Claude after the code.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      request<SignInView>(peer, `/api/sessions/sign-in?agent=${agent}`).then(setView, () => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [active, peer.url, peer.token, agent]);
  useEffect(() => {
    if (view?.state === "done") done.current();
  }, [view?.state]);
  const act = async (work: () => Promise<SignInView>) => {
    setBusy(true);
    setError("");
    try {
      setView(await work());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = () => act(() => post<SignInView>(peer, "/api/sessions/sign-in", { agent }));
  const name = agentLabel(agent);

  if (!view || view.state === "idle" || view.state === "cancelled")
    return (
      <span className="sign-in">
        <button className="sign-in-start" disabled={busy} onClick={() => void start()}>
          {busy && <Loader2 size={13} className="spin" />} Sign in
        </button>
        {error && <small className="bad">{error}</small>}
      </span>
    );
  return (
    <div className="sign-in" role="group" aria-label={`Sign ${name} in`}>
      {view.state === "starting" && (
        <p>
          <Loader2 size={13} className="spin" /> Starting sign-in on your Mac…
        </p>
      )}
      {view.state === "link" && view.url && (
        <ol>
          <li>
            <a className="sign-in-open" href={view.url} target="_blank" rel="noopener noreferrer">
              Open the sign-in page <ExternalLink size={13} />
            </a>
          </li>
          {agent === "claude" ? (
            <li>
              <span>Paste the code it shows</span>
              <span className="sign-in-code">
                <input
                  value={code}
                  placeholder="Code"
                  aria-label="Sign-in code"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  disabled={busy || !code.trim()}
                  onClick={() =>
                    void act(() => post<SignInView>(peer, "/api/sessions/sign-in/code", { agent, code })).then(() =>
                      setCode(""),
                    )
                  }
                >
                  Continue
                </button>
              </span>
            </li>
          ) : (
            <li>
              <span>Enter this code there</span> <code className="sign-in-device">{view.code}</code>
            </li>
          )}
        </ol>
      )}
      {view.state === "link" && agent === "codex" && (
        <p>
          <Loader2 size={13} className="spin" /> Waiting for you to finish…
        </p>
      )}
      {view.state === "checking" && (
        <p>
          <Loader2 size={13} className="spin" /> Signing in…
        </p>
      )}
      {view.state === "done" && <p>{name} is signed in on your Mac.</p>}
      {view.state === "failed" && (
        <p className="bad">
          {view.error || "Sign-in didn't finish."}{" "}
          <button className="sign-in-start" disabled={busy} onClick={() => void start()}>
            Try again
          </button>
        </p>
      )}
      {error && <p className="bad">{error}</p>}
      {active && (
        <button
          className="sign-in-cancel"
          onClick={() =>
            void act(() => request<SignInView>(peer, `/api/sessions/sign-in?agent=${agent}`, { method: "DELETE" }))
          }
        >
          Cancel
        </button>
      )}
    </div>
  );
}
