import { useEffect, useState } from "react";
import { ChevronRight, CircleCheck, Fingerprint, ScanFace } from "lucide-react";
import { post, request, type Peer } from "./api";
import { computerWord } from "./pause";
import { useFaceOptions, type FaceTake } from "./face-options";
import {
  createWithFaceId,
  deviceLabel,
  faceIdError,
  faceIdReady,
  sameComputer,
  unlockWords,
  type FaceOptions,
} from "./passkeys";
import "./faceid.css";

// Settings → Face ID, in this device's own words (Touch ID, fingerprint or
// face unlock, Windows Hello…): a passkey on this computer. With one, a new
// browser of yours (another browser on this phone, a new phone with your
// passkeys) signs in with it instead of a code at the computer, and Agents &
// people can require it to approve agents. Lists what's set up here, each
// with a check and when it was added or last used; adds this device's;
// removes one (a phone you lost, say). Only your own approved devices see
// it; others get nothing here. Every tap shows something: the device's own
// sheet, or one line saying why not.
type Key = { id: string; label: string; createdAt: string; usedAt?: string };
type Line = { text: string; tone?: "bad" | "good" };
const dayStart = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  return days === 0
    ? "today"
    : days === 1
      ? "yesterday"
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

export function FaceIdSettings({ peer }: { peer: Peer }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [ready, setReady] = useState(false);
  const [line, setLine] = useState<Line | null>(null);
  const here = sameComputer(peer.url);
  const said = unlockWords();
  const computer = computerWord(peer.platform);
  const load = () =>
    request<{ passkeys: Key[] }>(peer, "/api/auth/passkeys").then(
      (r) => setKeys(r.passkeys || []),
      () => setKeys(null),
    );
  useEffect(() => {
    void load();
    void faceIdReady().then(setReady);
  }, [peer.url, peer.token]);
  const face = useFaceOptions(
    ready && here && keys !== null
      ? () => post<FaceOptions>(peer, "/api/auth/passkeys/options", {})
      : null,
    `${peer.url} ${peer.token}`,
  );
  if (keys === null) return null;
  const why = (t: Exclude<FaceTake, { options: FaceOptions }>): Line =>
    t.wait === "failed"
      ? {
          text: `${said.Word} can't be added right now: ${t.error} Asking again; tap once more in a moment.`,
          tone: "bad",
        }
      : {
          text: {
            loading: `Getting ${said.word} ready. Tap again in a moment.`,
            renewed: "Renewed after a while on this page. Tap again.",
            busy: "Adding… one moment.",
          }[t.wait],
        };
  const add = () => {
    // The device's sheet straight from the tap (Safari shows it from a tap
    // only), with options fetched before it.
    const got = face.take();
    if (!("options" in got)) return setLine(why(got));
    setLine({ text: `Waiting for ${said.word}…` });
    createWithFaceId(got.options)
      .then((credential) =>
        post(peer, "/api/auth/passkeys", { credential, label: deviceLabel() }),
      )
      .then(
        async () => {
          await load();
          setLine({
            text: `Added. New browsers of yours can sign in with ${said.word} now.`,
            tone: "good",
          });
        },
        (e) => setLine({ text: faceIdError(e, said), tone: "bad" }),
      )
      .finally(face.done);
  };
  const remove = async (key: Key) => {
    if (
      !confirm(
        `Remove ${key.label}’s passkey? A new browser it would have signed in will need approval at your ${computer} again.`,
      )
    )
      return;
    setLine(null);
    try {
      await request(peer, `/api/auth/passkeys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
    } catch (e) {
      setLine({ text: (e as Error).message, tone: "bad" });
    }
    void load();
  };
  // Nothing to show or add here: no section at all.
  if (!keys.length && !(ready && here)) return null;
  const Icon = /Face ID/.test(said.word) ? ScanFace : Fingerprint;
  const shown: Line | null =
    line ||
    (face.error
      ? { text: `${said.Word} can't be added right now: ${face.error}`, tone: "bad" }
      : null);
  return (
    <section className="faceid" aria-label={said.title}>
      <h2 className="gs-title">{said.title}</h2>
      <div className="gs-group">
        {keys.map((k) => (
          <div className="gs-row" key={k.id}>
            <CircleCheck className="faceid-on" size={21} aria-label="On" />
            <span className="gs-label">
              {k.label}
              <small>
                {k.usedAt ? `Last used ${when(k.usedAt)}` : `Added ${when(k.createdAt)}`}
              </small>
            </span>
            <button
              className="gs-text-button"
              aria-label={`Remove ${k.label}`}
              onClick={() => void remove(k)}
            >
              Remove
            </button>
          </div>
        ))}
        {ready && here && (
          <button className="gs-row" onClick={add}>
            <Icon size={21} />
            <span className="gs-label">
              {keys.length
                ? `Add ${said.word} on this ${said.device}`
                : `Use ${said.word}`}
            </span>
            <ChevronRight className="gs-chevron" size={18} />
          </button>
        )}
      </div>
      {shown && (
        <p
          className={`gs-foot faceid-line${shown.tone ? ` ${shown.tone}` : ""}`}
          role={shown.tone === "bad" ? "alert" : "status"}
        >
          {shown.text}
        </p>
      )}
      <p className="gs-foot">
        A new browser of yours (another browser on this {said.device}, or a new
        one with your passkeys) signs in with {said.word} instead of a code at
        your {computer}. Agents &amp; people can require it to approve agents.
      </p>
    </section>
  );
}
