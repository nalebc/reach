import { useEffect, useState } from "react";
import { ScanFace } from "lucide-react";
import { post, request, type Peer } from "./api";
import {
  createWithFaceId,
  deviceLabel,
  faceIdError,
  faceIdReady,
  sameComputer,
  type FaceOptions,
} from "./passkeys";
import "./faceid.css";

// Face ID for new browsers of yours: what's set up on this computer, add this
// phone's, or remove one (a phone you lost, say). Shown only to your own
// approved devices; others get nothing here.
type Key = { id: string; label: string; createdAt: string; usedAt?: string };
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

export function FaceIdSettings({ peer }: { peer: Peer }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [ready, setReady] = useState(false);
  const [options, setOptions] = useState<FaceOptions | null>(null);
  const [note, setNote] = useState("");
  const here = sameComputer(peer.url);
  const load = () =>
    request<{ passkeys: Key[] }>(peer, "/api/auth/passkeys").then(
      (r) => setKeys(r.passkeys || []),
      () => setKeys(null),
    );
  useEffect(() => {
    void load();
    void faceIdReady().then(setReady);
  }, [peer.url, peer.token]);
  // Fetched before the tap: Safari only shows Face ID straight from one.
  useEffect(() => {
    if (!ready || !here || options || keys === null) return;
    let live = true;
    post(peer, "/api/auth/passkeys/options", {}).then(
      (o) => live && setOptions(o),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ready, here, options, keys === null]);
  if (keys === null) return null;
  const add = () => {
    if (!options) return;
    const o = options;
    setOptions(null);
    setNote("");
    createWithFaceId(o)
      .then((credential) =>
        post(peer, "/api/auth/passkeys", { credential, label: deviceLabel() }),
      )
      .then(load, (e) => setNote(faceIdError(e)));
  };
  const remove = async (key: Key) => {
    if (
      !confirm(
        `Remove ${key.label}’s Face ID? New browsers will need approval on this computer again.`,
      )
    )
      return;
    try {
      await request(peer, `/api/auth/passkeys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
    } catch (e) {
      setNote((e as Error).message);
    }
    void load();
  };
  return (
    <section className="panel settings-panel faceid" aria-label="Face ID">
      <h2>Face ID for new browsers</h2>
      <p>Approve a new browser of yours with Face ID, not at this computer.</p>
      {keys.map((k) => (
        <div className="faceid-row" key={k.id}>
          <ScanFace size={18} />
          <span>
            <strong>{k.label}</strong>
            <small>
              {k.usedAt
                ? `Last used ${day(k.usedAt)}`
                : `Added ${day(k.createdAt)}`}
            </small>
          </span>
          <button
            className="text-button"
            aria-label={`Remove ${k.label}`}
            onClick={() => void remove(k)}
          >
            Remove
          </button>
        </div>
      ))}
      {ready && here && (
        <button className="button full" disabled={!options} onClick={add}>
          <ScanFace size={17} />
          {keys.length ? "Add this phone’s Face ID too" : "Use Face ID"}
        </button>
      )}
      {note && <p className="form-note">{note}</p>}
    </section>
  );
}
