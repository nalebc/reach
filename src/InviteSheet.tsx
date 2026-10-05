import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Bot,
  Check,
  Copy,
  FolderOpen,
  KeyRound,
  Monitor,
  Share2,
  Terminal,
  X,
} from "lucide-react";
import { Share as NativeShare } from "@capacitor/share";
import { isNative } from "./native";
import { post, request, type Device, type Peer } from "./api";
import { workspaceCapabilities } from "./capabilities";
import { guestLinkUrl } from "./start-flow";
import { tailscaleShareUrl } from "./invitation";
import "./invite-sheet.css";

// Invite someone, as one sentence you complete by tapping its words:
//   Let [Sam] [watch your screen] on [Mac A] for [4 hours].
// Each word opens its choices right below; one link comes out. Every
// computer checks the permissions itself on every request.

type Screen = "off" | "view" | "control";
type Apps = "off" | "all" | "pick";
type Created = { peer: Peer; clientId: string; invitation: string };
type Guest = {
  id: string;
  name: string;
  kind?: string;
  scopes?: string[];
  expiresAt?: number;
  status?: string;
};
type Part = "what" | "where" | "long" | null;
const DURATIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "1 day" },
];
const startOf = (peer: Peer) => `https://${new URL(peer.url).hostname}`;
const homeFolder = (folder: string) =>
  /^\/(Users|home)\/[^/]+\/?$|^[A-Za-z]:\\Users\\[^\\]+\\?$/.test(folder);
const left = (until: number, now: number) => {
  const s = Math.max(0, Math.round((until - now) / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min left`
    : s >= 60
      ? `${Math.ceil(s / 60)} min left`
      : s > 0
        ? `${s} s left`
        : "ended";
};
const list = (items: string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export function InviteSheet({
  peer,
  device,
  peers = [peer],
}: {
  peer: Peer;
  device: Device;
  peers?: Peer[];
}) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState<Part>(null);
  const [minutes, setMinutes] = useState(240);
  const [computers, setComputers] = useState<string[]>([peer.id]);
  const [full, setFull] = useState(false);
  const [files, setFiles] = useState(false);
  const [write, setWrite] = useState(false);
  // Folders are chosen per computer, starting with none: the first one is
  // often the whole home folder.
  const [roots, setRoots] = useState<Record<string, number[]>>({});
  const [screen, setScreen] = useState<Screen>("off");
  const [apps, setApps] = useState<Apps>("off");
  const [appIds, setAppIds] = useState<string[]>([]);
  const [appList, setAppList] = useState<{ id: string; name: string }[]>([]);
  const [appQuery, setAppQuery] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [agents, setAgents] = useState(false);
  const [devices, setDevices] = useState<Record<string, Device>>({
    [peer.id]: device,
  });
  const [keyed, setKeyed] = useState<boolean | null>(null);
  const [made, setMade] = useState<{
    link: string;
    guest: string;
    expiresAt: number;
    created: Created[];
    keyed: boolean;
    summary: string;
  } | null>(null);
  const [share, setShare] = useState("");
  const [onTailnet, setOnTailnet] = useState(false);
  const [guests, setGuests] = useState<Guest[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now);

  const loadGuests = () =>
    request<{ clients: Guest[] }>(peer, "/api/clients")
      .then((r) =>
        setGuests(
          (r.clients || []).filter(
            (c) => c.kind === "guest" && (c.expiresAt || 0) > Date.now(),
          ),
        ),
      )
      .catch(() => {});
  useEffect(() => {
    request<{ configured: boolean }>(peer, "/api/guests/keys")
      .then((r) => setKeyed(!!r.configured))
      .catch(() => setKeyed(false));
    void loadGuests();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(loadGuests, 10000);
    return () => {
      clearInterval(clock);
      clearInterval(refresh);
    };
  }, [peer.url, peer.token]);
  useEffect(() => {
    for (const p of peers)
      if (computers.includes(p.id) && !devices[p.id])
        request<Device>(p, "/api/device")
          .then((d) => setDevices((old) => ({ ...old, [p.id]: d })))
          .catch(() => {});
  }, [computers.join(","), peers.map((p) => p.id).join(",")]);
  useEffect(() => {
    if (apps !== "pick" || appList.length) return;
    request<{ id: string; name: string }[]>(peer, "/api/apps")
      .then((r) => setAppList(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, [apps]);

  const chosen = peers.filter((p) => computers.includes(p.id));
  const screenOk =
    workspaceCapabilities(device).screen ||
    chosen.some(
      (p) => devices[p.id] && workspaceCapabilities(devices[p.id]).screen,
    );
  const folderNames = chosen.flatMap((p) =>
    (devices[p.id]?.roots || [])
      .filter((r) => (roots[p.id] || []).includes(r.id))
      .map((r) => r.name),
  );
  // The words of the sentence.
  const doing = full
    ? ["use everything you can"]
    : [
        ...(files
          ? [
              `${write ? "edit" : "open"} ${folderNames.length ? list(folderNames) : "your files"}`,
            ]
          : []),
        ...(screen === "view" ? ["watch your screen"] : []),
        ...(screen === "control" ? ["control your screen"] : []),
        ...(apps === "all" ? ["watch your apps"] : []),
        ...(apps === "pick"
          ? [
              appIds.length
                ? `watch ${list(appList.filter((a) => appIds.includes(a.id)).map((a) => a.name) || [])}`
                : "watch some apps",
            ]
          : []),
        ...(terminal ? ["use a terminal"] : []),
        ...(agents ? ["use AI sessions"] : []),
      ];
  const duration = DURATIONS.find((d) => d.minutes === minutes)!.label;
  const missing = !name.trim()
    ? "Who is it for?"
    : !chosen.length
      ? "Choose a computer."
      : !doing.length
        ? "Choose what they can do."
        : files && !full && chosen.some((p) => !(roots[p.id] || []).length)
          ? `Choose a folder${chosen.length > 1 ? " on each computer" : ""}.`
          : apps === "pick" && !full && !appIds.length
            ? "Choose at least one app."
            : "";
  const summary = `${name.trim() || "They"} can ${list(doing)}${chosen.length ? ` on ${list(chosen.map((p) => p.name))}` : ""} for ${duration}.`;

  const body = (p: Peer) =>
    full
      ? { full: true }
      : {
          roots: files ? roots[p.id] || [] : [],
          write: files && write,
          screen: screen === "off" ? false : screen,
          ...(apps === "all"
            ? { apps: "all" }
            : apps === "pick"
              ? { apps: appIds }
              : {}),
          terminal,
          agents,
        };
  const cancel = (created: Created[]) =>
    Promise.allSettled(
      created.map((c) =>
        request(c.peer, `/api/clients/${c.clientId}`, { method: "DELETE" }),
      ),
    );
  const create = async () => {
    if (missing || busy) return;
    setBusy(true);
    setError("");
    setOpen(null);
    const created: Created[] = [];
    try {
      // The computer you're on first: it makes the invite key.
      let key: { key: string; hostname: string } | null = null;
      for (const p of [peer, ...chosen.filter((x) => x.id !== peer.id)]) {
        if (!computers.includes(p.id)) continue;
        const grant = await post(p, "/api/guests", {
          name: name.trim(),
          ttlSeconds: minutes * 60,
          ...body(p),
          ...(p.id === peer.id && keyed ? { key: true } : {}),
        });
        created.push({
          peer: p,
          clientId: grant.clientId,
          invitation: grant.invitation,
        });
        if (grant.key) key = { key: grant.key, hostname: grant.hostname };
      }
      setMade({
        link: guestLinkUrl(startOf(peer), {
          key: key?.key || "",
          hostname: key?.hostname || "",
          invites: created.map((c) => ({
            origin: new URL(c.peer.url).origin,
            secret: c.invitation,
          })),
        }),
        guest: name.trim(),
        expiresAt: Date.now() + minutes * 60000,
        created,
        keyed: !!key,
        summary,
      });
      void loadGuests();
    } catch (e) {
      // All or nothing: undo the invitations already made.
      await cancel(created);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shareLink = tailscaleShareUrl(share);
  const ready = !!made && (made.keyed || onTailnet || !!shareLink);
  const message = made
    ? made.keyed || onTailnet
      ? `${made.summary.replace(/^[^ ]+ can/, "You can")}\n${made.link}`
      : [
          made.summary.replace(/^[^ ]+ can/, "You can"),
          "1. Install Tailscale: https://tailscale.com/download",
          `2. Accept my share: ${shareLink}`,
          `3. Open: ${made.link}`,
        ].join("\n")
    : "";
  const send = async () => {
    if (!ready) return;
    try {
      if (isNative) await NativeShare.share({ text: message });
      else if (navigator.share) await navigator.share({ text: message });
      else {
        await navigator.clipboard.writeText(message);
        setNote("Copied");
      }
    } catch (e) {
      if (!/cancel|abort/i.test((e as Error).message || (e as Error).name))
        setNote("Couldn’t open sharing. Copy instead.");
    }
  };
  const copy = async () => {
    if (!ready) return;
    try {
      await navigator.clipboard.writeText(message);
      setNote("Copied");
    } catch {
      setNote("Select the link and copy it.");
    }
  };
  const reset = () => {
    setMade(null);
    setName("");
    setShare("");
    setOnTailnet(false);
    setNote("");
    setError("");
  };

  const word = (part: Exclude<Part, null>, text: string, empty = false) => (
    <button
      type="button"
      className={`invite-word ${empty ? "empty" : ""}`}
      aria-expanded={open === part}
      onClick={() => setOpen(open === part ? null : part)}
    >
      {text}
    </button>
  );
  const chip = (
    on: boolean,
    label: React.ReactNode,
    toggle: () => void,
    key?: string,
  ) => (
    <button
      type="button"
      key={key}
      className={`invite-chip ${on ? "on" : ""}`}
      aria-pressed={on}
      onClick={toggle}
    >
      {label}
    </button>
  );
  const shownApps = useMemo(
    () =>
      appList
        .filter((a) =>
          a.name.toLowerCase().includes(appQuery.trim().toLowerCase()),
        )
        .slice(0, 40),
    [appList, appQuery],
  );

  return (
    <div className="invite-sheet">
      {made ? (
        <section className="invite-made" aria-live="polite">
          <span className="invite-made-check">
            <Check size={20} />
          </span>
          <h2>{made.guest}’s link is ready</h2>
          <p>{made.summary}</p>
          {!made.keyed && !onTailnet && (
            <div className="invite-tailscale">
              <p>
                {made.guest} needs Tailscale to open it. Share this computer
                with them in Tailscale, then paste that link here. (Run{" "}
                <code>./reach invites</code> once to skip this.)
              </p>
              <a
                className="invite-chip"
                href={`https://login.tailscale.com/admin/machines/${device.network?.ips?.find((ip) => ip.startsWith("100.")) || ""}`}
                target="_blank"
                rel="noreferrer"
              >
                Open Tailscale sharing
              </a>
              <input
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Paste Tailscale’s share link"
                value={share}
                onChange={(e) => setShare(e.target.value)}
              />
              <label>
                <input
                  type="checkbox"
                  checked={onTailnet}
                  onChange={(e) => setOnTailnet(e.target.checked)}
                />
                They’re already on my Tailscale
              </label>
            </div>
          )}
          {ready && (
            <>
              <code className="invite-link" title={made.link}>
                {made.link}
              </code>
              <div className="invite-buttons">
                <button className="invite-primary" onClick={send}>
                  <Share2 size={17} /> Share
                </button>
                <button className="invite-secondary" onClick={copy}>
                  <Copy size={17} /> Copy
                </button>
              </div>
            </>
          )}
          <small className="invite-quiet">
            {note ||
              (made.expiresAt > now
                ? `Ends in ${left(made.expiresAt, now).replace(" left", "")}. ${made.keyed ? "Nothing to install for them." : ""}`
                : "This invite has ended.")}
          </small>
          <div className="invite-after">
            <button onClick={reset}>Invite someone else</button>
            <button
              className="danger"
              onClick={async () => {
                if (!confirm(`Cancel ${made.guest}’s invite?`)) return;
                await cancel(made.created);
                reset();
                void loadGuests();
              }}
            >
              Cancel invite
            </button>
          </div>
        </section>
      ) : (
        <section className="invite-compose">
          <p className="invite-sentence">
            Let{" "}
            <input
              className="invite-name"
              aria-label="Their name"
              placeholder="someone"
              maxLength={80}
              value={name}
              size={Math.max(7, name.length + 1)}
              onChange={(e) => setName(e.target.value)}
            />{" "}
            {word(
              "what",
              doing.length ? list(doing) : "do something",
              !doing.length,
            )}
            {peers.length > 1 && (
              <>
                {" "}
                on{" "}
                {word(
                  "where",
                  chosen.length
                    ? list(chosen.map((p) => p.name))
                    : "a computer",
                  !chosen.length,
                )}
              </>
            )}{" "}
            for {word("long", duration)}.
          </p>
          {open === "what" && (
            <div
              className="invite-choices"
              role="group"
              aria-label="What they can do"
            >
              <div className="invite-chips">
                {chip(
                  full,
                  <>
                    <KeyRound size={15} /> Everything
                  </>,
                  () => setFull(!full),
                )}
                {!full && (
                  <>
                    {chip(
                      files,
                      <>
                        <FolderOpen size={15} /> Files
                      </>,
                      () => setFiles(!files),
                    )}
                    {screenOk &&
                      chip(
                        screen !== "off",
                        <>
                          <Monitor size={15} /> Screen
                        </>,
                        () => setScreen(screen === "off" ? "view" : "off"),
                      )}
                    {screenOk &&
                      chip(
                        apps !== "off",
                        <>
                          <AppWindow size={15} /> Apps
                        </>,
                        () => setApps(apps === "off" ? "all" : "off"),
                      )}
                    {chip(
                      terminal,
                      <>
                        <Terminal size={15} /> Terminal
                      </>,
                      () => setTerminal(!terminal),
                    )}
                    {chip(
                      agents,
                      <>
                        <Bot size={15} /> AI sessions
                      </>,
                      () => setAgents(!agents),
                    )}
                  </>
                )}
              </div>
              {full && (
                <small className="invite-quiet">
                  Files, screen and control, apps, terminals and AI sessions:
                  everything except managing your devices or inviting others.
                </small>
              )}
              {!full && files && (
                <div className="invite-detail">
                  <span className="invite-label">Folders</span>
                  {chosen.map((p) => (
                    <div key={p.id} className="invite-detail-row">
                      {chosen.length > 1 && <span>{p.name}</span>}
                      <div className="invite-chips">
                        {(devices[p.id]?.roots || []).map((r) =>
                          chip(
                            (roots[p.id] || []).includes(r.id),
                            r.name,
                            () =>
                              setRoots({
                                ...roots,
                                [p.id]: (roots[p.id] || []).includes(r.id)
                                  ? (roots[p.id] || []).filter(
                                      (id) => id !== r.id,
                                    )
                                  : [...(roots[p.id] || []), r.id],
                              }),
                            `${p.id}:${r.id}`,
                          ),
                        )}
                      </div>
                      {(devices[p.id]?.roots || []).some(
                        (r) =>
                          (roots[p.id] || []).includes(r.id) &&
                          homeFolder(r.path),
                      ) && (
                        <small className="invite-warn">
                          That’s the whole home folder. A narrower one is safer.
                        </small>
                      )}
                    </div>
                  ))}
                  <div className="invite-chips">
                    {chip(!write, "Open only", () => setWrite(false))}
                    {chip(write, "Can edit", () => setWrite(true))}
                  </div>
                </div>
              )}
              {!full && screen !== "off" && (
                <div className="invite-detail">
                  <span className="invite-label">Screen</span>
                  <div className="invite-chips">
                    {chip(screen === "view", "Watch", () => setScreen("view"))}
                    {chip(screen === "control", "Watch and control", () =>
                      setScreen("control"),
                    )}
                  </div>
                  {screen === "control" && (
                    <small className="invite-quiet">
                      They can use your mouse and keyboard. You can take control
                      back at any time.
                    </small>
                  )}
                </div>
              )}
              {!full && apps !== "off" && (
                <div className="invite-detail">
                  <span className="invite-label">Apps</span>
                  <div className="invite-chips">
                    {chip(apps === "all", "All apps", () => setApps("all"))}
                    {chip(apps === "pick", "Only some", () => setApps("pick"))}
                  </div>
                  {apps === "pick" && (
                    <>
                      <input
                        className="invite-search"
                        placeholder="Search apps"
                        value={appQuery}
                        onChange={(e) => setAppQuery(e.target.value)}
                      />
                      <div className="invite-chips">
                        {shownApps.map((a) =>
                          chip(
                            appIds.includes(a.id),
                            a.name,
                            () =>
                              setAppIds(
                                appIds.includes(a.id)
                                  ? appIds.filter((id) => id !== a.id)
                                  : [...appIds, a.id],
                              ),
                            a.id,
                          ),
                        )}
                      </div>
                    </>
                  )}
                  <small className="invite-quiet">
                    Apps are watch-only. To let them type, give screen control.
                  </small>
                </div>
              )}
            </div>
          )}
          {open === "where" && (
            <div className="invite-choices" role="group" aria-label="Computers">
              <div className="invite-chips">
                {peers.map((p) =>
                  chip(
                    computers.includes(p.id),
                    p.name,
                    () =>
                      setComputers(
                        computers.includes(p.id)
                          ? computers.filter((id) => id !== p.id)
                          : [...computers, p.id],
                      ),
                    p.id,
                  ),
                )}
              </div>
            </div>
          )}
          {open === "long" && (
            <div
              className="invite-choices"
              role="radiogroup"
              aria-label="How long"
            >
              <div className="invite-chips">
                {DURATIONS.map((d) =>
                  chip(
                    minutes === d.minutes,
                    d.label,
                    () => {
                      setMinutes(d.minutes);
                      setOpen(null);
                    },
                    String(d.minutes),
                  ),
                )}
              </div>
            </div>
          )}
          {error && <p className="invite-error">{error}</p>}
          <button
            className="invite-primary invite-create"
            disabled={!!missing || busy}
            onClick={create}
          >
            {busy ? "Creating…" : "Create link"}
          </button>
          <small className="invite-quiet">
            {missing ||
              (keyed
                ? "They just open the link. Their access ends on its own."
                : "Their access ends on its own.")}
          </small>
        </section>
      )}
      {guests.length > 0 && (
        <section className="invite-active" aria-label="Active invites">
          <h3>Active invites</h3>
          {guests.map((g) => (
            <div className="invite-guest" key={g.id}>
              <span>
                <strong>{g.name}</strong>
                <small>
                  {g.status === "accepted" ? "Joined" : "Not opened yet"} ·{" "}
                  {left(g.expiresAt || 0, now)}
                </small>
              </span>
              <button
                aria-label={`End ${g.name}’s access`}
                onClick={async () => {
                  if (!confirm(`End ${g.name}’s access now?`)) return;
                  await request(peer, `/api/clients/${g.id}`, {
                    method: "DELETE",
                  }).catch(() => {});
                  void loadGuests();
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
