import { ReactNode, useEffect, useRef, useState } from "react";
import { Link2, ShieldCheck, Smartphone, RefreshCw } from "lucide-react";
import { Peer, normalizeUrl } from "./api";
import { isNative } from "./native";
import { ErrorLine } from "./ui";
import { homeOrigin } from "./home-origin";

type Method = {
  method: "tailscale" | "pairing";
  eligible: boolean;
  login?: string;
};
type Pending = {
  id: string;
  secret: string;
  expiresAt: number;
  verification: string;
};
async function call(
  url: string,
  route: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(url + route, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(Error(value.error || "Could not connect."), {
      status: response.status,
    });
  return value;
}
function readPending(key: string): Pending | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(key) || "null");
    return p?.expiresAt > Date.now() &&
      typeof p.id === "string" &&
      typeof p.secret === "string"
      ? p
      : null;
  } catch {
    return null;
  }
}
export default function ConnectForm({
  initialUrl,
  onPaired,
  legacy,
  name,
}: {
  initialUrl?: string;
  onPaired: (peer: Peer) => void;
  legacy: (url: string) => ReactNode;
  name: string;
}) {
  const [url, setUrl] = useState(
    initialUrl || (isNative ? "" : homeOrigin()),
  );
  const [method, setMethod] = useState<Method | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [fallback, setFallback] = useState(false);
  const onDone = useRef(onPaired);
  onDone.current = onPaired;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setMethod(null);
    setPending(null);
    setError("");
    setBusy(false);
    setFallback(false);
    controller.current?.abort();
    const timer = setTimeout(async () => {
      if (!url) return;
      try {
        const origin = normalizeUrl(url);
        const result = await call(
          origin,
          "/api/auth/method",
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setMethod(result);
        if (result.method === "tailscale" && result.eligible)
          setPending(readPending(`reach.pending:${origin}`));
      } catch (e) {
        if (abort.signal.aborted) return;
        if ((e as { status?: number }).status === 404)
          setMethod({ method: "pairing", eligible: false });
        else
          setError(
            "Connect Tailscale on this phone, using the same account as your computer. Keep Reach running, then try again.",
          );
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
      controller.current?.abort();
    };
  }, [url, retry]);
  useEffect(() => {
    if (!pending || !method?.eligible) return;
    const abort = new AbortController();
    const origin = normalizeUrl(url),
      key = `reach.pending:${origin}`;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (abort.signal.aborted) return;
      if (pending.expiresAt <= Date.now()) {
        sessionStorage.removeItem(key);
        setPending(null);
        setError("The request expired. Tap Connect to request approval again.");
        return;
      }
      try {
        const result = await call(
          origin,
          `/api/auth/requests/${pending.id}`,
          { secret: pending.secret },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (result.status === "approved") {
          onDone.current({
            ...result.device,
            url: origin,
            token: result.token,
          });
          sessionStorage.removeItem(key);
          return;
        }
        if (result.status === "denied") {
          sessionStorage.removeItem(key);
          setPending(null);
          setError("This computer declined the connection.");
          return;
        }
        setError("");
      } catch (e) {
        if (abort.signal.aborted) return;
        if ([401, 403, 404].includes((e as { status?: number }).status || 0)) {
          sessionStorage.removeItem(key);
          setPending(null);
          setError((e as Error).message);
          return;
        }
        setError(
          "Connection interrupted. Reconnecting to your pending request…",
        );
      }
      timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pending, method?.eligible, url]);
  if (method?.method === "pairing" || fallback) return <>{legacy(url)}</>;
  return (
    <div className="connect-flow">
      {(isNative || initialUrl) && (
        <label>
          Computer address
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-computer.tailnet.ts.net:8443"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
      )}
      {pending ? (
        <div className="connection-approval" role="status" aria-live="polite">
          <ShieldCheck size={28} />
          <h3>Approve on your computer</h3>
          <p>Match this request in Reach’s terminal.</p>
          <strong className="approval-code">{pending.verification}</strong>
          <p>
            Running in the background? Open a terminal on your computer and run{" "}
            <code>./reach approve</code>.
          </p>
          <span className="form-note">
            Waiting for approval · expires in 5 minutes
          </span>
        </div>
      ) : (
        <>
          <p className="form-note">
            {method?.eligible ? (
              <>
                Signed in through Tailscale as <strong>{method.login}</strong>.
                Approve this browser once on your computer.
              </>
            ) : (
              "Your private connection, with your Tailscale account."
            )}
          </p>
          <button
            className="button primary full"
            disabled={busy || !method?.eligible}
            onClick={async () => {
              const abort = new AbortController();
              controller.current = abort;
              setBusy(true);
              setError("");
              try {
                const origin = normalizeUrl(url);
                const request = await call(
                  origin,
                  "/api/auth/requests",
                  { name },
                  abort.signal,
                );
                if (abort.signal.aborted) return;
                sessionStorage.setItem(
                  `reach.pending:${origin}`,
                  JSON.stringify(request),
                );
                setPending(request);
              } catch (e) {
                if (!abort.signal.aborted) setError((e as Error).message);
              } finally {
                if (!abort.signal.aborted) setBusy(false);
              }
            }}
          >
            <Link2 size={17} />
            {busy
              ? "Requesting access…"
              : !method && url && !error
                ? "Checking connection…"
                : "Connect with Tailscale"}
          </button>
          {(error || (method && !method.eligible)) && (
            <div className="tailscale-help">
              <Smartphone size={22} />
              <h3>Connect your phone first</h3>
              <ol>
                <li>
                  <a
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install Tailscale
                  </a>{" "}
                  on this phone.
                </li>
                <li>
                  Sign in with the same account as your computer and turn it on.
                </li>
                <li>Return here and reconnect.</li>
              </ol>
              <p>
                On iPhone, enable MagicDNS hostname matching in Tailscale’s VPN
                On Demand settings to reconnect automatically.
              </p>
              <button
                className="button full"
                onClick={() => setRetry((n) => n + 1)}
              >
                <RefreshCw size={16} />
                Check connection
              </button>
            </div>
          )}
        </>
      )}
      <ErrorLine error={error} />
      {method?.eligible && !pending && (
        <button className="text-button" onClick={() => setFallback(true)}>
          Use a pairing code instead
        </button>
      )}
    </div>
  );
}
