import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { post, type Peer } from "./api";

// Once per tailnet, so invited people and agents need nothing (no Tailscale
// account, nothing to install). At rest it's one slim line. Opened, it's one
// step: paste a Tailscale access token, and your computer adds Reach's rules
// to your Tailscale policy and makes its own limited key (the token is used
// once, never kept). Doing it by hand stays one tap away.
const ACCESS_CONTROLS = "https://login.tailscale.com/admin/acls";
const TRUST_CREDENTIALS =
  "https://console.tailscale.com/admin/settings/trust-credentials";
const ACCESS_TOKENS = "https://login.tailscale.com/admin/settings/keys";

export type SetupResult = { added?: string[]; allowAll?: boolean };

export function InviteLinksSetup({
  peer,
  policy,
  open,
  onOpen,
  onClose,
  onDone,
}: {
  peer: Peer;
  policy: unknown;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDone: (result: SetupResult) => void;
}) {
  const [manual, setManual] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canNarrowDefault, setCanNarrowDefault] = useState(false);
  if (!open)
    return (
      <button type="button" className="ivt-setup-line" onClick={onOpen}>
        <span>Guests need a one-time setup</span>
        <strong>
          Set up <ChevronRight size={14} />
        </strong>
      </button>
    );
  if (manual)
    return (
      <ManualSetup
        peer={peer}
        policy={policy}
        onClose={onClose}
        onEasy={() => setManual(false)}
        onDone={onDone}
      />
    );
  const connect = async (narrowDefaultWildcard = false) => {
    setBusy(true);
    setError("");
    setCanNarrowDefault(false);
    try {
      const result = await post<SetupResult>(peer, "/api/guests/keys", {
        accessToken: token.trim(),
        ...(narrowDefaultWildcard ? { narrowDefaultWildcard: true } : {}),
      });
      setToken("");
      onDone(result || {});
    } catch (e) {
      setError((e as Error).message);
      setCanNarrowDefault(
        (e as Error & { body?: { canNarrowDefault?: boolean } }).body
          ?.canNarrowDefault === true,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ivt-setup" aria-label="Set up invite links">
      <header>
        <strong>Invite links</strong>
        <button
          type="button"
          className="ivt-icon"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <p>
        Paste a Tailscale access token. Your computer adds Reach’s rules to your
        Tailscale policy and makes its own key. The token is used once, never
        kept.
      </p>
      <div className="ivt-setup-do fields">
        <a
          className="ivt-primary small"
          href={ACCESS_TOKENS}
          target="_blank"
          rel="noreferrer"
        >
          Get a token
        </a>
        <input
          className="ivt-field"
          aria-label="Access token"
          placeholder="tskey-api-…"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          type="button"
          className="ivt-primary small"
          disabled={busy || !/^tskey-api-/.test(token.trim())}
          onClick={() => void connect()}
        >
          {busy ? "Setting up…" : "Connect"}
        </button>
      </div>
      <small className="ivt-quiet">
        In Tailscale: Generate access token. One day is enough.
      </small>
      {error &&
        (canNarrowDefault ? (
          <div className="ivt-policy-fix" role="alert">
            <strong>One Tailscale rule needs to change</strong>
            <p>
              Your default all-access rule also covers new guests. Reach can
              limit that rule’s source from <code>*</code> to{" "}
              <code>autogroup:member</code>, then add the Reach-only guest rule.
            </p>
            <p>
              This may remove access that tagged devices or people using shared
              devices currently get from the all-access rule.
            </p>
            <button
              type="button"
              className="ivt-primary small"
              disabled={busy}
              onClick={() => void connect(true)}
            >
              Limit rule and connect
            </button>
            <a href={ACCESS_CONTROLS} target="_blank" rel="noreferrer">
              Review my Tailscale policy instead
            </a>
          </div>
        ) : (
          <p className="ivt-error" role="alert">
            {error}
          </p>
        ))}
      <footer>
        <button
          type="button"
          className="ivt-text"
          onClick={() => {
            setError("");
            setManual(true);
          }}
        >
          Do it by hand instead
        </button>
      </footer>
    </section>
  );
}

// By hand: add the tag, create Reach's key, paste it. One step at a time.
function ManualSetup({
  peer,
  policy,
  onClose,
  onEasy,
  onDone,
}: {
  peer: Peer;
  policy: unknown;
  onClose: () => void;
  onEasy: () => void;
  onDone: (result: SetupResult) => void;
}) {
  const [step, setStep] = useState(0);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {}
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await post(peer, "/api/guests/keys", {
        clientId: clientId.trim(),
        clientSecret: secret.trim(),
      });
      setSecret("");
      onDone({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const steps = [
    {
      title: "Create a guest tag",
      text: "In Tailscale’s access controls, add the tag reach-guest.",
      action: (
        <>
          <a
            className="ivt-primary small"
            href={ACCESS_CONTROLS}
            target="_blank"
            rel="noreferrer"
          >
            Open Tailscale
          </a>
          {!!policy && (
            <button
              type="button"
              className="ivt-text"
              onClick={() =>
                void copy("rules", JSON.stringify(policy, null, 2))
              }
            >
              {copied === "rules" ? "Copied" : "Copy the rules"}
            </button>
          )}
        </>
      ),
    },
    {
      title: "Create Reach’s key",
      text: "Trust credentials → OAuth: Write for Auth Keys and Devices, Read for Policy File, tag reach-guest.",
      action: (
        <a
          className="ivt-primary small"
          href={TRUST_CREDENTIALS}
          target="_blank"
          rel="noreferrer"
        >
          Open Tailscale
        </a>
      ),
    },
    {
      title: "Paste it here",
      text: "",
      action: (
        <>
          <input
            className="ivt-field"
            aria-label="Client ID"
            placeholder="Client ID"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            className="ivt-field"
            aria-label="Client secret"
            placeholder="Secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <button
            type="button"
            className="ivt-primary small"
            disabled={busy || !clientId.trim() || !secret.trim()}
            onClick={() => void save()}
          >
            {busy ? "Checking…" : "Connect"}
          </button>
        </>
      ),
    },
  ];
  const current = steps[step];
  return (
    <section className="ivt-setup" aria-label="Set up invite links">
      <header>
        <span className="ivt-steps" aria-label={`Step ${step + 1} of 3`}>
          {steps.map((_, i) => (
            <i key={i} className={i <= step ? "on" : ""} />
          ))}
        </span>
        <button
          type="button"
          className="ivt-icon"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <strong>{current.title}</strong>
      {current.text && <p>{current.text}</p>}
      <div className={`ivt-setup-do ${step === 2 ? "fields" : ""}`}>
        {current.action}
      </div>
      {error && <p className="ivt-error">{error}</p>}
      <footer>
        {step > 0 ? (
          <button
            type="button"
            className="ivt-text"
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        ) : (
          <button type="button" className="ivt-text" onClick={onEasy}>
            Use a token instead
          </button>
        )}
        {step < 2 && (
          <button
            type="button"
            className="ivt-text strong"
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        )}
      </footer>
    </section>
  );
}
