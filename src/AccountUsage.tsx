import type { AgentHealth } from './agent-sessions';
import { resetTime } from './agent-sessions';
import { CRITICAL_AT, WARN_AT } from './usage';

const tokenCount = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// One agent's limits, in the Usage sheet (UsageRing.tsx): each window, when
// it resets, credits, and the account's own page.
export function UsageDetails({ health }: { health: AgentHealth }) {
  const usage = health.usage;
  const windows = usage?.windows || [];
  const money = (v?: { amount_minor: number; currency: string; exponent: number } | null) => v ? new Intl.NumberFormat(undefined, { style: 'currency', currency: v.currency }).format(v.amount_minor / 10 ** v.exponent) : '';
  const level = (n: number) => n >= CRITICAL_AT ? 'critical' : n >= WARN_AT ? 'warning' : '';
  return <div className="as-usage-windows">
    {!usage?.available && <p>{usage?.error || `${health.name || health.agent} does not report account usage to Reach yet.`}</p>}
    {windows.map(w => <div key={w.id} className={`as-usage-window ${level(w.usedPercent)}`}>
      <div><strong>{w.label}</strong><span>{Math.round(w.usedPercent)}% used{!usage?.available ? ' (last reading)' : ''}</span></div>
      <progress max={100} value={Math.min(100, w.usedPercent)} aria-label={`${w.label} usage`} />
      {w.resetsAt && <small>Resets {resetTime(w.resetsAt, false)}</small>}
      {usage?.available && w.usedPercent >= WARN_AT && <p role="status">{w.usedPercent >= 100 ? 'Limit reached' : `${Math.max(0, Math.round(100 - w.usedPercent))}% remaining`}</p>}
    </div>)}
    {usage?.credits && <p>{usage.credits.unlimited ? 'Unlimited credits' : `Credits: ${usage.credits.balance ?? 'Unavailable'}`}</p>}
    {usage?.spend && <p>Usage credits {usage.spend.enabled ? 'on' : 'off'}{usage.spend.used && usage.spend.limit ? ` · ${money(usage.spend.used)} / ${money(usage.spend.limit)}` : ''}</p>}
    {!!health.savings?.tokens && <p className="as-usage-saved">Saved ~{tokenCount(health.savings.tokens)} tokens{health.savings.kinds["image-repeat"]?.count ? ` · ${health.savings.kinds["image-repeat"].count} repeated image${health.savings.kinds["image-repeat"].count === 1 ? "" : "s"}` : ""}</p>}
    {usage?.updatedAt && <small>Updated {new Date(usage.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>}
    {usage?.available && ['claude','codex'].includes(health.agent) && <a href={health.agent === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage'} target="_blank" rel="noopener noreferrer">Account usage settings</a>}
  </div>;
}
