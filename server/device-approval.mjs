import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, loadJson, fail, hash, sameHash, ALL_SCOPES } from "./core.mjs";
import {
  ownerIdentity,
  sameIdentity,
  identityBinding,
} from "./tailscale-auth.mjs";
import { normalizeDeviceKey } from "./funnel-device.mjs";

const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
// "iphone-browser-1.tail.ts.net" -> "iphone-browser"
const baseName = (name) =>
  String(name || "")
    .toLowerCase()
    .split(".")[0]
    .replace(/-\d+$/, "");
// The same phone in another browser counts as one device: the same Tailscale
// device (browsers sharing the Tailscale app), or, signed in from the browser,
// another browser of the same kind on your account ("iphone-browser").
export function sameDevice(auth, request) {
  if (!request?.identity?.userId || !request.identity.nodeId) return {};
  const devices = auth
    .list()
    .filter(
      (c) =>
        c.kind === "device" &&
        c.tailscale?.userId === request.identity.userId &&
        c.expiresAt > Date.now(),
    );
  const twin =
    devices.find((c) => c.tailscale?.nodeId === request.identity.nodeId) ||
    (/-browser$/.test(baseName(request.nodeName))
      ? devices.find(
          (c) =>
            c.nodeName && baseName(c.nodeName) === baseName(request.nodeName),
        )
      : undefined);
  return twin ? { deviceGroup: twin.deviceGroup || twin.tailscale.nodeId } : {};
}
export function approvalStore(dataDir, { now = Date.now } = {}) {
  const dir = path.join(dataDir, "device-requests");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (id) => {
    if (!validId(id)) throw fail(404, "Connection request not found.");
    return path.join(dir, `${id}.json`);
  };
  const list = () => {
    const pending = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const value = loadJson(path.join(dir, name), null);
      if (!value || !(value.expiresAt > now())) {
        fs.rmSync(path.join(dir, name), { force: true });
        fs.rmSync(path.join(dir, name + ".decision"), { force: true });
      } else {
        const decision = loadJson(path.join(dir, name + ".decision"), null);
        pending.push({
          ...value,
          ...(decision
            ? {
                status: decision.decision === "approve" ? "approved" : "denied",
                ...(decision.by ? { approvedBy: decision.by } : {}),
              }
            : {}),
        });
      }
    }
    return pending;
  };
  return {
    list: () => list().map(({ secretHash, token, ...rest }) => rest),
    // `thisComputer`: asked from this computer itself (server/index.mjs), kept
    // so the prompt says so and only the code typed there approves it.
    request(identity, name, owner, { thisComputer = false, funnel = false, deviceKey = null, nodeName } = {}) {
      const normalizedKey = deviceKey ? normalizeDeviceKey(deviceKey.jwk || deviceKey) : null;
      if (funnel) {
        if (!normalizedKey)
          throw fail(400, "A valid device key is required to request access.");
      } else if (!ownerIdentity(identity, owner)) {
        throw fail(
          403,
          "Connect Tailscale using the account configured on this computer.",
        );
      }
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 80 ||
        /[\x00-\x1f\x7f]/.test(name)
      )
        throw fail(400, "Choose a device name (up to 80 characters).");
      const existing = list();
      const sameRequester = (r) =>
        funnel
          ? r.transport === "funnel" && r.deviceKey?.thumbprint === normalizedKey.thumbprint
          : r.transport !== "funnel" && sameIdentity(r.identity, identity);
      if (
        existing.length >= 32 ||
        existing.filter(sameRequester).length >= 3
      )
        throw fail(
          429,
          "A connection request is already waiting. Finish it or wait five minutes.",
        );
      const secret = crypto.randomBytes(32).toString("base64url");
      const request = {
        id: crypto.randomUUID(),
        name: name.trim(),
        ...(funnel
          ? {
              transport: "funnel",
              deviceKey: { jwk: normalizedKey.jwk, thumbprint: normalizedKey.thumbprint },
              login: "",
              nodeName: String(nodeName || "Browser").slice(0, 160),
            }
          : {
              identity: identityBinding(identity),
              login: identity.login,
              nodeName: identity.nodeName,
              ...(normalizedKey
                ? { deviceKey: { jwk: normalizedKey.jwk, thumbprint: normalizedKey.thumbprint } }
                : {}),
            }),
        secretHash: hash(secret),
        expiresAt: now() + 300000,
        status: "pending",
        ...(thisComputer === true && { thisComputer: true }),
      };
      atomicJson(file(request.id), request);
      return {
        id: request.id,
        secret,
        expiresAt: request.expiresAt,
        verification: request.id.slice(0, 8),
      };
    },
    // `by`: the linked computer that approved this device already.
    decide(id, decision, by) {
      if (!["approve", "deny"].includes(decision))
        throw Error("Choose approve or deny.");
      const request = loadJson(file(id), null);
      if (
        !request ||
        request.expiresAt <= now() ||
        request.status !== "pending"
      )
        throw Error("This request is no longer pending.");
      // Decided in this computer's terminal, or, for "approve once", because
      // a linked computer (or this one, for the same device) approved it
      // already. No HTTP endpoint lets anyone approve directly.
      fs.writeFileSync(
        file(id) + ".decision",
        JSON.stringify({
          decision,
          secretHash: request.secretHash,
          ...(typeof by === "string" ? { by: by.slice(0, 80) } : {}),
        }),
        { flag: "wx", mode: 0o600 },
      );
    },
    // A request still waiting, asked about by the browser that made it (its
    // secret, from the same Tailscale device or Funnel key). Changes nothing.
    pending(id, secret, identity, owner, { keyThumbprint } = {}) {
      const r = validId(id) ? loadJson(file(id), null) : null;
      const isFunnel = r?.transport === "funnel";
      const identityOk = isFunnel
        ? typeof keyThumbprint === "string" && r.deviceKey?.thumbprint === keyThumbprint
        : ownerIdentity(identity, owner) && sameIdentity(r?.identity, identity);
      if (
        !identityOk ||
        !r ||
        r.id !== id ||
        !(r.expiresAt > now()) ||
        r.status !== "pending" ||
        typeof secret !== "string" ||
        secret.length > 100 ||
        !sameHash(hash(secret), r.secretHash) ||
        fs.existsSync(file(id) + ".decision")
      )
        throw fail(
          403,
          "This connection request expired or belongs to another device.",
        );
      return { id: r.id, name: r.name, ...(r.thisComputer === true && { thisComputer: true }) };
    },
    poll(id, secret, identity, owner, auth, { keyThumbprint } = {}) {
      const r = loadJson(file(id), null);
      const isFunnel = r?.transport === "funnel";
      const identityOk = isFunnel
        ? typeof keyThumbprint === "string" && r.deviceKey?.thumbprint === keyThumbprint
        : ownerIdentity(identity, owner) && sameIdentity(r?.identity, identity);
      if (
        !identityOk ||
        !r ||
        r.id !== id ||
        !(r.expiresAt > now()) ||
        typeof secret !== "string" ||
        secret.length > 100 ||
        !sameHash(hash(secret), r.secretHash)
      )
        throw fail(
          403,
          "This connection request expired or belongs to another device.",
        );
      if (r.status === "issuing")
        throw fail(401, "Approval was interrupted. Request approval again.");
      // Bind subsequent writes to this server-issued record, after checking
      // its exact ID, claimant secret and Tailscale/Funnel identity above.
      const recordFile = file(r.id);
      const decision = loadJson(recordFile + ".decision", null);
      if (decision?.secretHash === r.secretHash && r.status === "pending") {
        r.status = decision.decision === "approve" ? "approved" : "denied";
        if (r.status === "approved") {
          // A crash between the credential and receipt writes must not mint
          // another credential on retry. Interruptions fail closed for reapproval.
          atomicJson(recordFile, { ...r, status: "issuing" });
          const issued = auth.issue(r.name, ALL_SCOPES, "device", {
            ...(isFunnel ? {} : { tailscale: r.identity, ...sameDevice(auth, r) }),
            ...(r.deviceKey ? { deviceKey: r.deviceKey } : {}),
            nodeName: r.nodeName,
            ...(r.thisComputer === true ? { thisComputer: true } : {}),
          });
          r.token = issued.token;
        }
        atomicJson(recordFile, r);
      }
      const stillValid = isFunnel
        ? auth.verifyDeviceFunnel?.(r.token, keyThumbprint)
        : auth.verify(r.token, identity);
      if (r.status === "approved" && !stillValid)
        throw fail(401, "Device access was revoked. Request approval again.");
      // Retries return the same credential until the request expires; a dropped
      // response never creates a second client. Expired private receipts are cleaned by the host.
      return {
        status: r.status,
        ...(r.status === "approved" ? { token: r.token } : {}),
      };
    },
  };
}
