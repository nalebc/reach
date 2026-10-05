import type { ReactNode } from "react";
import type { Peer } from "./api";
import AgentSignIn from "./AgentSignIn";
import { AgentLogo, ClaudeSpark, type AgentLogos } from "./agent-logos";
import type { AgentHealth, AgentName } from "./agent-sessions";

// What an agent needs signed in on the Mac, one row each with its logo, shown
// only when something is missing. Claude: Reach replies through the Claude
// Code CLI, which signs in apart from the Claude app, so both are listed and
// the note says only the CLI matters here. Codex: its app and CLI share one.
export default function AgentAccess({
  peer,
  agent,
  health,
  logos,
  onSignedIn,
}: {
  peer: Peer;
  agent: AgentName;
  health?: AgentHealth;
  logos: AgentLogos;
  onSignedIn: () => void;
}) {
  if (!health?.installed || health.signedIn) return null;
  const signIn = <AgentSignIn peer={peer} agent={agent} onDone={onSignedIn} />;
  return (
    <section className={`access ${agent}`} aria-label="Sign-ins on your Mac">
      {agent === "claude" ? (
        <>
          <Row logo={<ClaudeSpark logos={logos} size={18} />} name="Claude Code CLI" ok={false} action={signIn} />
          {health.app?.installed && (
            <Row
              logo={<AgentLogo agent="claude" name="Claude app" logos={logos} size={22} />}
              name="Claude app"
              ok={health.app.signedIn}
            />
          )}
          <p className="access-note">Reach replies through the CLI, so only the CLI needs signing in.</p>
        </>
      ) : (
        <>
          <Row logo={<AgentLogo agent="codex" logos={logos} size={22} />} name="Codex" ok={false} action={signIn} />
          <p className="access-note">The Codex app and CLI share this sign-in.</p>
        </>
      )}
    </section>
  );
}

function Row({ logo, name, ok, action }: { logo: ReactNode; name: string; ok: boolean; action?: ReactNode }) {
  return (
    <div className="access-row">
      <span className="access-logo">{logo}</span>
      <span className="access-name">{name}</span>
      <span className={`access-state ${ok ? "ok" : "off"}`}>{ok ? "Signed in" : "Not signed in"}</span>
      {action && <div className="access-action">{action}</div>}
    </div>
  );
}
