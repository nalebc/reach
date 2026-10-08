import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, loadJson, fail, hash } from "./core.mjs";
import { addGuestRules } from "./tailnet-policy.mjs";

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
// The policy lines for your tailnet: the guest tag, and a rule that lets
// guest devices reach Reach's port on your computers and nothing else.
export function guestPolicy({ addresses, port }) {
  return {
    tagOwners: { [GUEST_TAG]: ["autogroup:admin"] },
    grants: [{ src: [GUEST_TAG], dst: addresses, ip: [`tcp:${port}`] }],
  };
}
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
  // Your own new browsers that signed in with Face ID (server/face-join.mjs):
  // rf-<this computer>-<id>, kept apart from guests'.
  const facePrefix = `rf-${hash(String(self)).slice(0, 4)}-`;
  const faceName = new RegExp(`^${facePrefix}[a-z0-9]{10}(?:-\\d+)?$`);
  const shortName = (d) =>
    String(d?.hostname || d?.name || "")
      .toLowerCase()
      .split(".")[0];
  const newId = () =>
    Array.from(
      crypto.randomBytes(10),
      (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
    ).join("");
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

  async function call(method, route, body, creds, authorize = () => {}) {
    authorize();
    const access = await token(creds);
    // Token refresh is asynchronous; authority may have ended while waiting.
    authorize();
    const response = await request(`${api}/api/v2${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
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

  const createKey = (expirySeconds, description, creds, authorize) =>
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
      authorize,
    );

  // Check new credentials for real: get a token, list devices, make and
  // delete a short key. Saved only if all of that works.
  async function setup({ clientId, clientSecret, authorize = () => {} }) {
    authorize();
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
    await call("GET", "/tailnet/-/devices", undefined, creds, authorize);
    const probe = await createKey(300, "Reach setup check", creds, authorize);
    if (!probe?.key?.startsWith?.("tskey-auth-"))
      throw fail(
        502,
        "Tailscale didn't return a key. Check the auth_keys scope and tag:reach-guest.",
      );
    // Cleanup of the exact short-lived probe remains allowed after revocation.
    if (probe.id)
      await call(
        "DELETE",
        `/tailnet/-/keys/${encodeURIComponent(probe.id)}`,
        undefined,
        creds,
      ).catch(() => {});
    authorize();
    atomicJson(credentialFile, { version: 1, ...creds });
  }

  // The easy way: one Tailscale API access token, used once and never kept.
  // Reach adds its tag and one grant to your policy (comments and other rules
  // stay; an explicitly approved default wildcard may be narrowed). Tailscale
  // checks the result first; nothing is written if the policy changed meanwhile. Reach then makes its own limited OAuth client (guest keys
  // and guest devices only) and saves just that. `confirm(plan)` sees the
  // exact lines before anything changes.
  async function setupFromAccessToken({
    accessToken,
    addresses,
    port,
    narrowDefaultWildcard = false,
    confirm = async () => true,
    authorize = () => {},
  }) {
    authorize();
    const secret = String(accessToken || "").trim();
    if (!/^tskey-api-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(secret))
      throw fail(
        400,
        "Paste a Tailscale API access token (it starts with tskey-api-).",
      );
    if (!addresses?.length || !Number.isInteger(port))
      throw fail(409, "This computer's Tailscale address isn't known yet.");
    const requestAs = (method, route, { body, type, headers = {} } = {}) =>
      request(`${api}/api/v2${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(body !== undefined
            ? { "Content-Type": type || "application/json" }
            : {}),
          ...headers,
        },
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    // This callback is supplied by the trusted HTTP route, never request data.
    // Every remote step checks it after any preceding asynchronous work.
    const as = (...args) => {
      authorize();
      return requestAs(...args);
    };
    const reason = async (response) => {
      const detail = await response.json().catch(() => ({}));
      return String(detail.message || response.status).slice(0, 300);
    };
    // 1. Your policy, exactly as written.
    const got = await as("GET", "/tailnet/-/acl", {
      headers: { Accept: "application/hujson" },
    });
    if (got.status === 401 || got.status === 403)
      throw fail(
        400,
        "Tailscale didn't accept that token: it may have expired, or your account isn't an admin of this tailnet.",
      );
    if (!got.ok)
      throw fail(
        502,
        `Tailscale couldn't read your policy: ${await reason(got)}`,
      );
    const etag = got.headers?.get?.("etag");
    let plan;
    try {
      plan = addGuestRules(await got.text(), {
        tag: GUEST_TAG,
        addresses,
        port,
        narrowDefaultWildcard,
      });
    } catch (error) {
      throw fail(409, error.message);
    }
    if (plan.allowAll.length)
      throw Object.assign(
        fail(409, `Guest access is not isolated: ${plan.allowAll.join(", ")} may let enrolled guests reach more than Reach. Narrow those Tailscale rules to your members (for example autogroup:member), or restrict the guest tag to this computer’s Reach port before enabling invite links. Reach did not change your policy or create a key.`),
        { canNarrowDefault: plan.canNarrowDefault },
      );
    if (plan.added.length) {
      if (typeof etag !== "string" || !etag.trim() || etag.trim() === "*")
        throw fail(409, "Tailscale did not return a policy version (ETag). Nothing was changed; try again.");
      // 2. Tailscale checks the new policy (and your tests) first.
      const check = await as("POST", "/tailnet/-/acl/validate", {
        body: plan.text,
        type: "application/hujson",
      });
      const verdict = check.ok ? (await check.text()).trim() : "";
      const problem = !check.ok
        ? await reason(check)
        : verdict && JSON.parse(verdict).message;
      if (problem)
        throw fail(
          409,
          `Tailscale wouldn't accept the change, so nothing was changed: ${String(problem).slice(0, 300)}`,
        );
      authorize();
      if (!(await confirm(plan)))
        throw fail(409, "Cancelled. Your Tailscale policy wasn't changed.");
      // 3. Written only if nobody changed the policy meanwhile.
      const put = await as("POST", "/tailnet/-/acl", {
        body: plan.text,
        type: "application/hujson",
        headers: { "If-Match": etag },
      });
      if (put.status === 412)
        throw fail(
          409,
          "Your Tailscale policy changed while Reach was adding its rules. Nothing was changed; try again.",
        );
      if (!put.ok)
        throw fail(
          502,
          `Tailscale didn't save the policy: ${await reason(put)}`,
        );
    }
    // 4. Reach's own key: makes guest keys, removes guest devices. Nothing else.
    const made = await as("POST", "/tailnet/-/keys", {
      body: {
        keyType: "client",
        description: "Reach invite links",
        scopes: ["auth_keys", "devices:core"],
        tags: [GUEST_TAG],
      },
    });
    if (!made.ok)
      throw fail(
        502,
        `Tailscale didn't create Reach's key: ${await reason(made)}`,
      );
    const client = await made.json();
    try {
      await setup({ clientId: client.id, clientSecret: client.key, authorize });
    } catch (error) {
      // Cleanup is permitted even when the initiating owner was revoked.
      // Only the exact client just created by this request can be removed.
      await requestAs(
        "DELETE",
        `/tailnet/-/keys/${encodeURIComponent(client.id)}`,
      ).catch(() => {});
      throw error;
    }
    return { added: plan.added, allowAll: plan.allowAll };
  }

  // A key for one invitation; the guest's device will be named `hostname`.
  async function createInvite({ ttlSeconds, keySeconds, clientIds = [], authorize = () => {} }) {
    authorize();
    const id = newId();
    const expiresAt = now() + ttlSeconds * 1000;
    const created = await createKey(
      Math.max(300, Math.min(keySeconds ?? ttlSeconds, 90 * 86400)),
      `Reach guest ${id}`,
      undefined,
      authorize,
    );
    try {
      if (!created?.key) throw fail(502, "Tailscale didn't return a key.");
      authorize();
      saveRecords([
        ...records().filter((r) => r.expiresAt > now() - 86400000),
        { id, expiresAt, clientIds, keyId: created.id || "" },
      ]);
      return { key: created.key, hostname: `${prefix}${id}`, expiresAt };
    } catch (error) {
      // This exact newly minted key must not survive a cancelled issuance.
      // Cleanup is allowed after the initiating owner's access has ended.
      if (created?.id)
        await call("DELETE", `/tailnet/-/keys/${encodeURIComponent(created.id)}`).catch(() => {});
      throw error;
    }
  }

  // Revoking a guest on this computer ends its invite here: its device goes.
  async function revokeClient(clientId) {
    const list = records();
    const ending = list.filter((r) => r.clientIds?.includes(clientId));
    if (!ending.length) return 0;
    // Ended now (kept as known, so its device goes without the grace period).
    saveRecords(
      list.map((r) =>
        r.clientIds?.includes(clientId) ? { ...r, expiresAt: 0 } : r,
      ),
    );
    // A link not opened yet must not let anyone in afterwards: its unused
    // key goes too (a used one is already spent).
    for (const r of ending)
      if (r.keyId)
        await call(
          "DELETE",
          `/tailnet/-/keys/${encodeURIComponent(r.keyId)}`,
        ).catch(() => {});
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
      const name = shortName(d);
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

  // A key for one new browser of yours that just passed Face ID: it joins as
  // a limited device (the guest tag: Reach's port only), used within minutes.
  async function createFaceKey() {
    const id = newId();
    const created = await createKey(600, `Reach Face ID sign-in ${id}`);
    if (!created?.key) throw fail(502, "Tailscale didn't return a key.");
    return { key: created.key, hostname: `${facePrefix}${id}` };
  }
  // Face ID browsers whose access here ended (removed, expired, or never
  // finished signing in) leave your tailnet. `live`: node IDs still yours.
  async function reconcileFace(live) {
    if (!credentials()) return 0;
    const { devices = [] } = (await call("GET", "/tailnet/-/devices")) || {};
    let removed = 0;
    for (const d of devices) {
      const name = shortName(d);
      if (
        !Array.isArray(d?.tags) ||
        !d.tags.includes(GUEST_TAG) ||
        !faceName.test(name) ||
        live.has(d.nodeId)
      )
        continue;
      // Still signing in: its ticket lasts ten minutes.
      if (now() - (Date.parse(d.created || "") || 0) < 15 * 60000) continue;
      await call("DELETE", `/device/${encodeURIComponent(d.nodeId || d.id)}`);
      removed++;
      log(`Removed ${name} from your tailnet (its Face ID sign-in ended).`);
    }
    return removed;
  }

  return {
    configured: () => !!credentials(),
    setup,
    setupFromAccessToken,
    createInvite,
    revokeClient,
    reconcile,
    createFaceKey,
    reconcileFace,
    isFaceDevice: (nodeName) => faceName.test(shortName({ name: nodeName })),
    prefix,
    GUEST_TAG,
  };
}
