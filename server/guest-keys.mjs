import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, loadJson, fail, hash } from "./core.mjs";

// Invite keys: each invitation carries a one-time Tailscale key, so the guest
// just opens the link: their browser joins your tailnet as a tag:reach-guest
// device, no Tailscale account or app needed. Reach removes that device when
// the invitation ends or is revoked (and checks again on start and every few
// minutes, in case Reach was off at that moment).
//
// Needs a Tailscale OAuth client limited to tag:reach-guest, with the
// `auth_keys` and `devices:core` scopes, saved by `./reach invites` (mode
// 0600, never sent to any phone or browser).

export const GUEST_TAG = "tag:reach-guest";
const API = "https://api.tailscale.com";
const ID = /^[a-z0-9]{10}$/;

export function createGuestKeys({
  dataDir,
  self, // this computer's Tailscale node ID: names its guests' devices
  request = fetch,
  now = Date.now,
  api = API,
  log = () => {},
}) {
  const credentialFile = path.join(dataDir, "tailscale-oauth.json");
  const recordFile = path.join(dataDir, "guest-keys.json");
  // Guest devices are named rg-<this computer>-<invite>: only ours are removed.
  const prefix = `rg-${hash(String(self)).slice(0, 4)}-`;
  let cached = null;

  const credentials = () => {
    const c = loadJson(credentialFile, null);
    return typeof c?.clientId === "string" &&
      typeof c.clientSecret === "string" &&
      c.clientSecret.startsWith("tskey-client-")
      ? c
      : null;
  };
  const records = () => {
    const value = loadJson(recordFile, null);
    return Array.isArray(value?.invites)
      ? value.invites.filter(
          (r) => ID.test(r?.id) && Number.isFinite(r.expiresAt),
        )
      : [];
  };
  const saveRecords = (invites) =>
    atomicJson(recordFile, { version: 1, invites });

  async function token(creds = credentials()) {
    if (!creds)
      throw fail(
        409,
        "Set up invite keys first: run ./reach invites on this computer.",
      );
    if (cached && cached.clientId === creds.clientId && cached.until > now())
      return cached.token;
    const response = await request(`${api}/api/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: "client_credentials",
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw fail(
        502,
        "Tailscale didn't accept the OAuth client. Check its ID and secret.",
      );
    const body = await response.json();
    cached = {
      clientId: creds.clientId,
      token: body.access_token,
      until:
        now() + Math.max(60, (Number(body.expires_in) || 3600) - 120) * 1000,
    };
    return cached.token;
  }

  async function call(method, route, body, creds) {
    const response = await request(`${api}/api/v2${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token(creds)}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw fail(
        502,
        `Tailscale refused ${method} ${route.split("?")[0]}: ${String(detail.message || response.status).slice(0, 200)}`,
      );
    }
    return response.status === 204 ? null : response.json().catch(() => null);
  }

  const createKey = (expirySeconds, description, creds) =>
    call(
      "POST",
      "/tailnet/-/keys",
      {
        capabilities: {
          devices: {
            create: {
              reusable: false,
              // Lasting, not ephemeral: Safari may pause the page for a long
              // time, and a used single-use key can't sign in again.
              ephemeral: false,
              preauthorized: true,
              tags: [GUEST_TAG],
            },
          },
        },
        expirySeconds,
        description,
      },
      creds,
    );

  // Check new credentials for real: get a token, list devices, make and
  // delete a short key. Saved only if all of that works.
  async function setup({ clientId, clientSecret }) {
    const creds = {
      clientId: String(clientId || "").trim(),
      clientSecret: String(clientSecret || "").trim(),
    };
    if (!creds.clientId || !creds.clientSecret.startsWith("tskey-client-"))
      throw fail(
        400,
        "Paste the OAuth client ID and its secret (it starts with tskey-client-).",
      );
    cached = null;
    await call("GET", "/tailnet/-/devices", undefined, creds);
    const probe = await createKey(300, "Reach setup check", creds);
    if (!probe?.key?.startsWith?.("tskey-auth-"))
      throw fail(
        502,
        "Tailscale didn't return a key. Check the auth_keys scope and tag:reach-guest.",
      );
    if (probe.id)
      await call(
        "DELETE",
        `/tailnet/-/keys/${encodeURIComponent(probe.id)}`,
        undefined,
        creds,
      ).catch(() => {});
    atomicJson(credentialFile, { version: 1, ...creds });
  }

  // A key for one invitation; the guest's device will be named `hostname`.
  async function createInvite({ ttlSeconds, clientIds = [] }) {
    const id = Array.from(
      crypto.randomBytes(10),
      (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
    ).join("");
    const expiresAt = now() + ttlSeconds * 1000;
    const created = await createKey(
      Math.max(300, Math.min(ttlSeconds, 90 * 86400)),
      `Reach guest ${id}`,
    );
    if (!created?.key) throw fail(502, "Tailscale didn't return a key.");
    saveRecords([
      ...records().filter((r) => r.expiresAt > now() - 86400000),
      { id, expiresAt, clientIds, keyId: created.id || "" },
    ]);
    return { key: created.key, hostname: `${prefix}${id}`, expiresAt };
  }

  // Revoking a guest on this computer ends its invite here: its device goes.
  async function revokeClient(clientId) {
    const list = records();
    if (!list.some((r) => r.clientIds?.includes(clientId))) return 0;
    // Ended now (kept as known, so its device goes without the grace period).
    saveRecords(
      list.map((r) =>
        r.clientIds?.includes(clientId) ? { ...r, expiresAt: 0 } : r,
      ),
    );
    return reconcile();
  }

  // Remove our guest devices whose invitation ended (or is unknown here).
  // A device a few minutes old may still be redeeming its invitation.
  async function reconcile() {
    if (!credentials()) return 0;
    const live = new Map(
      records()
        .filter((r) => r.expiresAt > now())
        .map((r) => [r.id, r]),
    );
    const { devices = [] } = (await call("GET", "/tailnet/-/devices")) || {};
    let removed = 0;
    for (const d of devices) {
      const name = String(d?.hostname || d?.name || "")
        .toLowerCase()
        .split(".")[0];
      if (
        !Array.isArray(d?.tags) ||
        !d.tags.includes(GUEST_TAG) ||
        !name.startsWith(prefix)
      )
        continue;
      // Tailscale adds -1, -2… to repeated names.
      const inviteId = name.slice(prefix.length).replace(/-\d+$/, "");
      if (live.has(inviteId)) continue;
      const known = records().some((r) => r.id === inviteId);
      const created = Date.parse(d.created || "") || 0;
      if (!known && now() - created < 10 * 60000) continue;
      await call("DELETE", `/device/${encodeURIComponent(d.nodeId || d.id)}`);
      removed++;
      log(`Removed guest device ${name} from your tailnet (invitation ended).`);
    }
    return removed;
  }

  return {
    configured: () => !!credentials(),
    setup,
    createInvite,
    revokeClient,
    reconcile,
    prefix,
    GUEST_TAG,
  };
}
