import { Clock, ShieldCheck, Bot } from "lucide-react";
import type { ConnectedDevice } from "./useFleetConnections";
export default function DeviceAccessBadge({
  access,
  now = Date.now(),
}: {
  access?: ConnectedDevice["access"];
  now?: number;
}) {
  if (!Array.isArray(access) || !access.length)
    return <span className="device-access unknown">Access unknown</span>;
  const kinds = [...new Set(access.map((a) => a.kind))];
  return (
    <span className="device-access-badges">
      {kinds.map((kind) => {
        const grants = access.filter((a) => a.kind === kind);
        const expiresAt = Math.min(...grants.map((a) => a.expiresAt));
        const remaining = Math.max(0, Math.ceil((expiresAt - now) / 60000));
        const duration =
          remaining >= 60
            ? `${Math.floor(remaining / 60)}h ${remaining % 60}m`
            : `${remaining}m`;
        return (
          <span
            key={kind}
            className={`device-access ${kind}`}
            title={
              kind === "paired"
                ? "Regular paired device. Sign-in credentials may need renewal."
                : `Access ends ${new Date(expiresAt).toLocaleString()}`
            }
          >
            {kind === "paired" ? (
              <ShieldCheck size={11} />
            ) : kind === "agent" ? (
              <Bot size={11} />
            ) : (
              <Clock size={11} />
            )}
            {kind === "paired"
              ? "Paired device"
              : kind === "invited"
                ? `Invited · ${remaining ? `${duration} left` : "expired"}`
                : `Agent · ${remaining ? `${duration} left` : "expired"}`}
          </span>
        );
      })}
    </span>
  );
}
