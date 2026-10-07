// One row per device in your access list: browsers on the same phone (same
// Tailscale device, or approved as the same device) are one device.
export type AccessRecord = {
  id: string;
  kind?: string;
  expiresAt?: number;
  deviceGroup?: string;
  tailscale?: { userId: string; nodeId: string };
};
export function groupDevices<T extends AccessRecord>(
  clients: T[],
): (T & { ids: string[] })[] {
  const groups = new Map<string, T & { ids: string[] }>();
  for (const c of clients) {
    const device = c.deviceGroup || c.tailscale?.nodeId;
    const key =
      c.kind === "device" && device
        ? `device:${c.tailscale?.userId}:${device}`
        : `client:${c.id}`;
    const old = groups.get(key);
    if (!old) groups.set(key, { ...c, ids: [c.id] });
    else {
      old.ids.push(c.id);
      if ((c.expiresAt || 0) > (old.expiresAt || 0)) old.expiresAt = c.expiresAt;
    }
  }
  return [...groups.values()];
}
