import { useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { post, request, type Peer } from "./api";
import { OpenSetup } from "./OpenClawSetup";
import { clawBase } from "./OpenClawControls";
import "./openclaw-skills.css";

type Missing = { bins: string[]; env: string[]; config: string[]; os: string[] };
type Job = { status: "running" | "done" | "failed"; flagged?: boolean; message?: string };
type Skill = {
  name: string;
  key: string;
  emoji: string;
  source: string;
  bundled: boolean;
  state: "ready" | "setup" | "off";
  blocked: boolean;
  missing: Missing;
  install: { id: string; kind: string; label: string }[];
  keyName?: string;
  installing?: Job;
};
type Skills = {
  supported: boolean;
  skills?: Skill[];
  canToggle?: boolean;
  canInstall?: boolean;
  canSetup?: boolean;
  busy?: boolean;
};
type Check = {
  check: string;
  name: string;
  emoji: string;
  source: string;
  bundled: boolean;
  publisher: string;
  kind: string;
  package: string;
  packageFrom: string;
  command: string;
  scripts: string[];
  access: { bins: string[]; env: string[]; config: string[] };
  warnings: ("notBundled" | "script" | "internet" | "unknownPublisher")[];
  level: "calm" | "strong";
};
const SOURCE: Record<string, string> = {
  bundled: "Bundled",
  managed: "Managed",
  workspace: "Workspace",
  clawhub: "ClawHub",
  extra: "Extra",
  personal: "Personal",
  project: "Project",
  other: "Other",
};
const WARNING = {
  notBundled: "Not bundled",
  script: "Runs a script",
  internet: "Downloads from the internet",
  unknownPublisher: "Unknown publisher",
};
const GROUPS = [
  ["ready", "Ready"],
  ["setup", "Needs setup"],
  ["off", "Off"],
] as const;

// Skills, grouped by readiness and checked before they install.
export function ClawSkills({ peer, query, refresh }: { peer: Peer; query: string; refresh: number }) {
  const [data, setData] = useState<Skills | null>(null);
  const [error, setError] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState<{ name: string; install: string } | null>(null);
  const running = !!data?.skills?.some((s) => s.installing?.status === "running");
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      request<Skills>(peer, `${clawBase}/skills`, { signal: abort.signal })
        .then((next) => {
          setData(next);
          setError("");
          // While an install runs, look again until it's done.
          if (next.skills?.some((s) => s.installing?.status === "running")) timer = setTimeout(load, 3000);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError((e as Error).message);
        });
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [peer.id, peer.url, peer.token, refresh, revision]);
  if (data && !data.supported) return null;
  const q = query.trim().toLowerCase();
  const skills = (data?.skills || []).filter((s) => !q || s.name.toLowerCase().includes(q));
  const toggle = async (skill: Skill) => {
    if (busy) return;
    setBusy(skill.key);
    setProblem("");
    try {
      await post(peer, `${clawBase}/skills/enable`, { key: skill.key, enabled: skill.state === "off" });
      setRevision((n) => n + 1);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="claw-panel claw-skills" aria-label="OpenClaw skills">
      <div className="claw-panel-heading">
        <h2>Skills</h2>
      </div>
      {(error || problem) && (
        <p className="claw-error" role="alert">
          {error || problem}
        </p>
      )}
      {!data && !error && (
        <p className="claw-note" role="status">
          <Loader2 size={14} className="spin" />
          Loading skills…
        </p>
      )}
      {data && !skills.length && <p className="claw-empty">{q ? "No matches." : "No skills."}</p>}
      {GROUPS.map(([state, title]) => {
        const group = skills.filter((s) => s.state === state);
        if (!group.length) return null;
        return (
          <div className="claw-skill-group" key={state} role="group" aria-label={title}>
            <h3>
              {title} <span>{group.length}</span>
            </h3>
            <div className="claw-skill-rows">
              {group.map((skill) => {
                const needs = skill.missing.config.length > 0;
                const job = skill.installing;
                return (
                  <div className="claw-skill" key={skill.name}>
                    <span className="claw-skill-emoji" aria-hidden="true">
                      {skill.emoji || "🧩"}
                    </span>
                    <div className="claw-skill-main">
                      <strong>{skill.name}</strong>
                      <div className="claw-skill-pills">
                        <span className={`claw-skill-pill source ${skill.bundled ? "" : "outside"}`}>
                          {SOURCE[skill.source] || "Other"}
                        </span>
                        {skill.state !== "off" &&
                          skill.missing.bins.map((b) => (
                            <span className="claw-skill-pill missing" key={`b:${b}`} title="Missing program">
                              {b}
                            </span>
                          ))}
                        {skill.state !== "off" &&
                          skill.missing.env.map((e) => (
                            <span className="claw-skill-pill missing" key={`e:${e}`} title="Missing key">
                              {e}
                            </span>
                          ))}
                        {skill.state !== "off" &&
                          skill.missing.config.map((c) => (
                            <span className="claw-skill-pill missing" key={`c:${c}`} title="Missing setting">
                              {c}
                            </span>
                          ))}
                        {skill.state !== "off" && skill.missing.os.length > 0 && (
                          <span className="claw-skill-pill missing">Not for this Mac</span>
                        )}
                        {skill.blocked && <span className="claw-skill-pill missing">Blocked</span>}
                      </div>
                      {job && (
                        <p className={`claw-skill-job ${job.status}`} role="status">
                          {job.status === "running" ? (
                            <>
                              <Loader2 size={12} className="spin" /> Installing…
                            </>
                          ) : job.status === "done" ? (
                            job.flagged ? "Installed · OpenClaw flagged its code" : "Installed"
                          ) : (
                            job.message || "Install failed"
                          )}
                        </p>
                      )}
                      {skill.state === "setup" && skill.keyName && data?.canToggle && (
                        <KeyField peer={peer} skill={skill} onSaved={() => setRevision((n) => n + 1)} />
                      )}
                      {skill.state === "setup" && data?.canSetup && skill.missing.env.some((name) => name !== skill.keyName) && (
                        <SkillValues peer={peer} skill={skill} onSaved={() => setRevision((n) => n + 1)} />
                      )}
                      {skill.state === "setup" && (
                        <div className="claw-skill-actions">
                          {data?.canInstall && skill.missing.bins.length > 0 && skill.install.length > 0 && job?.status !== "running" &&
                            skill.install.map((option) => (
                              <button
                                key={option.id}
                                className="claw-skill-chip"
                                disabled={running || !!data?.busy}
                                aria-label={`Install ${skill.name}${skill.install.length > 1 ? ` with ${option.kind}` : ""}`}
                                onClick={() => setChecking({ name: skill.name, install: option.id })}
                              >
                                {skill.install.length > 1 ? `Install · ${option.kind}` : "Install"}
                              </button>
                            ))}
                          {needs && data?.canSetup && <OpenSetup peer={peer} section="skills">Guided skill setup</OpenSetup>}
                        </div>
                      )}
                    </div>
                    {data?.canToggle && !skill.blocked && (
                      <button
                        role="switch"
                        aria-checked={skill.state !== "off"}
                        aria-label={skill.name}
                        className={`claw-skill-switch ${skill.state !== "off" ? "on" : ""}`}
                        disabled={!!busy}
                        onClick={() => void toggle(skill)}
                      >
                        <span />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {checking && (
        <SafetyCheck
          peer={peer}
          name={checking.name}
          install={checking.install}
          onClose={() => setChecking(null)}
          onStarted={() => {
            setChecking(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

// Write-only: the key goes to OpenClaw and is never shown again.
function KeyField({ peer, skill, envName, onSaved }: { peer: Peer; skill: Skill; envName?: string; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <form
      className="claw-skill-key"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !value.trim()) return;
        setBusy(true);
        setProblem("");
        try {
          if (envName) await post(peer, `${clawBase}/skills/setup`, { key: skill.key, env: { [envName]: value } });
          else await post(peer, `${clawBase}/skills/key`, { key: skill.key, apiKey: value });
          setValue("");
          onSaved();
        } catch (err) {
          setProblem((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label={`${skill.name} ${envName || skill.keyName}`}
        placeholder={envName || skill.keyName}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="claw-skill-chip" disabled={busy || !value.trim()}>
        {busy ? <Loader2 size={12} className="spin" /> : null}
        Save
      </button>
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

function SkillValues({ peer, skill, onSaved }: { peer: Peer; skill: Skill; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const names = skill.missing.env.filter((name) => name !== skill.keyName);
  return <form className="claw-settings" aria-label={`Set up ${skill.name}`} onSubmit={async (e) => {
    e.preventDefault();
    if (busy || !names.every((name) => values[name]?.trim())) return;
    setBusy(true);
    setProblem("");
    try {
      await post(peer, `${clawBase}/skills/setup`, { key: skill.key, env: Object.fromEntries(names.map((name) => [name, values[name]])) });
      setValues({});
      onSaved();
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); }
  }}>
    {names.map((name) => <label key={name}>{name}<input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false}
      aria-label={`${skill.name} ${name}`} value={values[name] || ""} disabled={busy} maxLength={4096}
      onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} /></label>)}
    <p className="claw-note">Saved to OpenClaw on your computer. Existing values are never shown here.</p>
    <button type="submit" className="claw-skill-chip" disabled={busy || !names.every((name) => values[name]?.trim())}>
      {busy && <Loader2 size={12} className="spin" />}Save settings
    </button>
    {problem && <p className="claw-error" role="alert">{problem}</p>}
  </form>;
}

// What will run and what the skill can reach; installs on a second tap.
function SafetyCheck({
  peer,
  name,
  install,
  onClose,
  onStarted,
}: {
  peer: Peer;
  name: string;
  install: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void request<Check>(peer, `${clawBase}/skills/check?${new URLSearchParams({ name, install })}`, { signal: abort.signal })
      .then(setCheck)
      .catch((e) => {
        if (!abort.signal.aborted) setError((e as Error).message);
      });
    return () => abort.abort();
  }, [peer.id, peer.url, peer.token, name, install]);
  const strong = check?.level !== "calm";
  const access = check ? [...check.access.bins, ...check.access.env, ...check.access.config] : [];
  return (
    <div className="claw-skill-sheet-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className={`claw-skill-sheet ${check ? check.level : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Safety check"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="claw-skill-sheet-head">
          {check && (strong ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />)}
          <strong>
            {check?.emoji ? `${check.emoji} ` : ""}
            {name}
          </strong>
        </div>
        {error && (
          <p className="claw-error" role="alert">
            {error}
          </p>
        )}
        {!check && !error && (
          <p className="claw-note" role="status">
            <Loader2 size={14} className="spin" /> Checking…
          </p>
        )}
        {check && (
          <>
            {check.warnings.length > 0 && (
              <div className="claw-skill-pills warnings" aria-label="Warnings">
                {check.warnings.map((w) => (
                  <span key={w} className={`claw-skill-pill warn ${w}`}>
                    {WARNING[w]}
                  </span>
                ))}
              </div>
            )}
            <dl className="claw-skill-facts">
              <dt>Skill by</dt>
              <dd>{check.publisher}</dd>
              <dt>Source</dt>
              <dd>{SOURCE[check.source] || "Other"}</dd>
              <dt>Package</dt>
              <dd>
                {check.package}
                <small>{check.packageFrom}</small>
              </dd>
              <dt>Runs</dt>
              <dd>
                <code>{check.command}</code>
              </dd>
              {check.scripts.length > 0 && (
                <>
                  <dt>Scripts</dt>
                  <dd>
                    {check.scripts.map((s) => (
                      <code key={s}>{s}</code>
                    ))}
                  </dd>
                </>
              )}
              {access.length > 0 && (
                <>
                  <dt>Uses</dt>
                  <dd className="claw-skill-pills">
                    {access.map((a) => (
                      <span key={a} className="claw-skill-pill">
                        {a}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </>
        )}
        <div className="claw-skill-sheet-actions">
          <button className="claw-secondary" disabled={busy} onClick={sure ? () => setSure(false) : onClose}>
            {sure ? "Back" : "Cancel"}
          </button>
          {check &&
            (sure ? (
              <button
                className={strong ? "claw-secondary claw-skill-danger" : "claw-primary"}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await post(peer, `${clawBase}/skills/install`, {
                      name,
                      installId: install,
                      check: check.check,
                      confirmed: true,
                    });
                    onStarted();
                  } catch (e) {
                    setError((e as Error).message);
                    setSure(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 size={14} className="spin" /> : null}
                {strong ? "Install anyway" : "Yes, install"}
              </button>
            ) : (
              <button className={strong ? "claw-secondary" : "claw-primary"} onClick={() => setSure(true)}>
                Install…
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
