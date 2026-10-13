import { ReactNode, useEffect, useRef, useState } from "react";
import {
  Link2,
  ScanFace,
  ShieldCheck,
  Smartphone,
  RefreshCw,
} from "lucide-react";
import {
  Peer,
  activeKey,
  normalizeUrl,
  readPeers,
  savePeers,
  upsertPeer,
} from "./api";
import { isNative } from "./native";
import { storageBlocked } from "./storage-fallback";
import { tailscaleAppLink } from "./connection";
import { ErrorLine } from "./ui";
import { homeOrigin } from "./home-origin";
import { hasTicket, saveTicket, startFresh, takeTicket } from "./face-start";
import {
  createWithFaceId,
  deviceLabel,
  faceIdError,
  faceIdReady,
  sameComputer,
  signWithFaceId,
  type FaceOptions,
} from "./passkeys";
import "./connect-steps.css";

type Method = {
  method: "tailscale" | "pairing";
  eligible: boolean;
  login?: string;
  // This browser signed in with Face ID here before (its access ended).
  faceJoin?: boolean;
};
type Pending = {
  id: string;
  secret: string;
  expiresAt: number;
  verification: string;
  // This computer has Face ID set up: it can approve this request.
  passkey?: boolean;
};
async function call(
  url: string,
  route: string,
  body?: unknown,
  signal?: AbortSignal,
  token?: string,
) {
  const response = await fetch(url + route, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A page that isn't Reach's (a proxy's "Not found.") is not JSON.
  const value = await response.json().catch(() => ({
    error: response.ok ? "This address didn't answer like Reach." : "",
  }));
  if (!response.ok || value.error === "This address didn't answer like Reach.")
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
  // Face ID: options fetched ahead (Safari wants it straight from the tap).
  const [faceOptions, setFaceOptions] = useState<FaceOptions | null>(null);
  const [faceNote, setFaceNote] = useState("");
  const [faceAvailable, setFaceAvailable] = useState(false);
  useEffect(() => {
    void faceIdReady().then(setFaceAvailable);
  }, []);
  // Face ID up, or its answer on its way: no new challenge meanwhile (the
  // computer keeps one per request; a new one replaces the one being
  // answered, src/face-options.ts).
  const faceBusy = useRef(false);
  // The offer's tries: each failed one fetches fresh options.
  const [offerTry, setOfferTry] = useState(0);
  // A fresh browser asks its computer at once (no second "Connect" tap).
  const autoAsked = useRef(false);
  // Approved, and offered Face ID for this phone's other browsers next time.
  const [offer, setOffer] = useState<{
    peer: Peer;
    options: FaceOptions | null;
  } | null>(null);
  const onDone = useRef(onPaired);
  onDone.current = onPaired;
  // Just signed in with Face ID (src/start.ts): its one-time ticket makes
  // this browser yours here at once, with no request to approve. Used once,
  // even where React runs this twice.
  const [joining, setJoining] = useState(hasTicket);
  const redeemed = useRef(false);
  useEffect(() => {
    if (redeemed.current) return;
    redeemed.current = true;
    const t = takeTicket();
    if (!t) return setJoining(false);
    call(t.origin, "/api/auth/face-join", { ticket: t.ticket, name }).then(
      (result) =>
        onDone.current({ ...result.device, url: t.origin, token: result.token }),
      (e) => {
        // No answer from the computer (no HTTP status): the ticket wasn't
        // used, so keep it for another try.
        if (!(e as { status?: number }).status) saveTicket(t.ticket, t.origin);
        setJoining(false);
        setError((e as Error).message);
      },
    );
  }, []);
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
    // The address may be mid-edit while a request waits: an address that
    // doesn't parse yet just pauses the wait instead of throwing.
    let origin: string;
    try {
      origin = normalizeUrl(url);
    } catch {
      return;
    }
    const abort = new AbortController();
    const key = `reach.pending:${origin}`;
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
          const peer = { ...result.device, url: origin, token: result.token };
          sessionStorage.removeItem(key);
          // Signed in from the browser, no Face ID on this computer yet:
          // offer it, so this phone's other browsers skip this wait.
          let dismissed = false;
          try {
            dismissed = !!localStorage.getItem(`reach.faceid-offer:${origin}`);
          } catch {}
          if (
            !pending.passkey &&
            !dismissed &&
            document.documentElement.dataset.connection === "browser" &&
            sameComputer(origin) &&
            (await faceIdReady())
          ) {
            // Saved first: leaving the offer (locking the phone, a reload)
            // never loses the approval.
            try {
              savePeers(upsertPeer(readPeers(), { ...peer, pairedAt: Date.now() }));
              localStorage.setItem(activeKey(), peer.id);
            } catch {}
            if (!abort.signal.aborted) setOffer({ peer, options: null });
            return;
          }
          onDone.current(peer);
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
  const requestAccess = async () => {
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
      sessionStorage.setItem(`reach.pending:${origin}`, JSON.stringify(request));
      setPending(request);
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  // Just signed in, nothing connected yet, on this page's own computer:
  // asking is the only thing to do here, so it happens by itself. (Adding
  // another computer, or a typed address, still waits for the tap.)
  useEffect(() => {
    if (
      autoAsked.current ||
      isNative ||
      fallback ||
      pending ||
      busy ||
      error ||
      method?.method !== "tailscale" ||
      !method.eligible ||
      readPeers().length > 0
    )
      return;
    try {
      if (normalizeUrl(url) !== normalizeUrl(homeOrigin())) return;
    } catch {
      return;
    }
    autoAsked.current = true;
    void requestAccess();
  }, [method, pending, busy, error, fallback, url]);
  // While a request waits: Face ID options, renewed before they expire.
  useEffect(() => {
    if (!pending?.passkey || !sameComputer(url)) return;
    const origin = normalizeUrl(url),
      p = pending;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (!(await faceIdReady())) return;
      if (faceBusy.current) {
        if (live) timer = setTimeout(load, 5000);
        return;
      }
      try {
        const options = await call(
          origin,
          `/api/auth/requests/${p.id}/passkey/options`,
          { secret: p.secret },
        );
        if (live) setFaceOptions(options);
      } catch {
        if (live) setFaceOptions(null);
      }
      if (live) timer = setTimeout(load, 100000);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
      setFaceOptions(null);
    };
  }, [pending?.id, url]);
  const useFaceId = () => {
    if (!pending || !faceOptions) return;
    const origin = normalizeUrl(url),
      p = pending,
      options = faceOptions;
    setFaceNote("");
    setFaceOptions(null);
    faceBusy.current = true;
    // Straight from the tap. The usual poll then picks up the approval.
    signWithFaceId(options)
      .then((credential) =>
        call(origin, `/api/auth/requests/${p.id}/passkey`, {
          secret: p.secret,
          credential,
        }),
      )
      .then(() => {
        faceBusy.current = false;
        setFaceNote("Approved with Face ID. Connecting…");
      })
      .catch((e) => {
        faceBusy.current = false;
        setFaceNote(faceIdError(e));
        call(origin, `/api/auth/requests/${p.id}/passkey/options`, {
          secret: p.secret,
        }).then(setFaceOptions, () => {});
      });
  };
  // The offer: its options, fetched with the new credential.
  useEffect(() => {
    if (!offer || offer.options) return;
    let live = true;
    call(
      offer.peer.url,
      "/api/auth/passkeys/options",
      {},
      undefined,
      offer.peer.token,
    ).then(
      (options) => live && setOffer((o) => (o ? { ...o, options } : o)),
      (e) => live && setFaceNote((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [offer?.peer.token, offerTry]);
  const finishOffer = (later: boolean) => {
    if (!offer) return;
    if (later)
      try {
        localStorage.setItem(`reach.faceid-offer:${offer.peer.url}`, "later");
      } catch {}
    onDone.current(offer.peer);
  };
  const addFaceId = () => {
    if (!offer?.options) return;
    const { peer, options } = offer;
    setFaceNote("");
    setOffer({ peer, options: null });
    createWithFaceId(options)
      .then((credential) =>
        call(
          peer.url,
          "/api/auth/passkeys",
          { credential, label: deviceLabel() },
          undefined,
          peer.token,
        ),
      )
      .then(() => onDone.current(peer))
      .catch((e) => {
        setFaceNote(faceIdError(e));
        // Fresh options for another try (none while Face ID was up: a new
        // challenge would have replaced the one being answered).
        setOffer({ peer, options: null });
        setOfferTry((n) => n + 1);
      });
  };
  if (joining)
    return (
      <div className="connect-flow">
        <div className="connection-approval" role="status" aria-live="polite">
          <ScanFace size={30} />
          <h3>Signing you in…</h3>
        </div>
      </div>
    );
  // A browser that signed in with Face ID here before, whose access ended:
  // it signs in with Face ID again (the start page, as a new browser).
  if (method?.faceJoin && !pending)
    return (
      <div className="connect-flow">
        <div className="connection-approval" role="status" aria-live="polite">
          <ScanFace size={30} />
          <button className="button primary full" onClick={startFresh}>
            Continue with Face ID
          </button>
          <p className="form-note">Signs this browser in again.</p>
        </div>
        <ErrorLine error={error} />
      </div>
    );
  if (offer)
    return (
      <div className="connect-flow">
        <div className="connection-approval" role="status" aria-live="polite">
          <ShieldCheck size={28} />
          <h3>Approved</h3>
          <p>
            Next time, this phone’s other browsers can use Face ID instead of
            waiting for your computer.
          </p>
          <button
            className="button primary full"
            disabled={!offer.options}
            onClick={addFaceId}
          >
            Use Face ID next time
          </button>
          <button className="text-button" onClick={() => finishOffer(true)}>
            Not now
          </button>
        </div>
        <ErrorLine error={faceNote} />
      </div>
    );
  if (method?.method === "pairing" || fallback) return <>{legacy(url)}</>;
  // Signed in from the browser: this is the second of two steps.
  const browserSignIn =
    document.documentElement.dataset.connection === "browser";
  return (
    <div className="connect-flow">
      {browserSignIn && (
        <p className="connect-step">Step 2 of 2 · Connect to Reach</p>
      )}
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
          {pending.passkey && faceAvailable && sameComputer(url) ? (
            <>
              <ScanFace size={30} />
              <button
                className="button primary full"
                disabled={!faceOptions}
                onClick={useFaceId}
              >
                Continue with Face ID
              </button>
              {faceNote && <p className="form-note">{faceNote}</p>}
              <p className="form-note">
                No Face ID? Type <strong>{pending.verification}</strong> in
                Reach on your computer.
              </p>
            </>
          ) : (
            <>
              <ShieldCheck size={28} />
              <h3>Approve on your computer</h3>
              <p>Type this code in Reach on your computer:</p>
              <strong className="approval-code">{pending.verification}</strong>
              {faceNote && <p className="form-note">{faceNote}</p>}
              <span className="form-note">
                Reach in the background? Run <code>./reach approve</code> there.
              </span>
            </>
          )}
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
          {storageBlocked() && (
            <p className="form-note" role="note">
              This browser blocks website data, so Reach can't remember it:
              you'll approve it again next time.
            </p>
          )}
          <button
            className="button primary full"
            disabled={busy || !method?.eligible}
            onClick={() => void requestAccess()}
          >
            <Link2 size={17} />
            {busy
              ? "Asking your computer…"
              : !method && url && !error
                ? "Checking connection…"
                : "Connect to this computer"}
          </button>
          {(error || (method && !method.eligible)) && (
            <div className="tailscale-help">
              <Smartphone size={22} />
              <h3>Connect your phone first</h3>
              <ol>
                <li>
                  <a
                    href={tailscaleAppLink()}
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
