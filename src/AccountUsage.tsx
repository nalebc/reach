import type { AgentHealth } from './agent-sessions';
import { resetTime } from './agent-sessions';

export function AccountUsage({ health }: { health?: AgentHealth }) {
  const usage = health?.usage;
  if (!health?.signedIn) return null;
  const windows = usage?.windows || [];
  const fullest = windows.reduce<(typeof windows)[number] | undefined>((best, w) => !best || w.usedPercent > best.usedPercent ? w : best, undefined);
  const warning = usage?.available && windows.some(w => ['warning', 'critical'].includes(w.severity));
  const money = (v?: { amount_minor: number; currency: string; exponent: number } | null) => v ? new Intl.NumberFormat(undefined, { style: 'currency', currency: v.currency }).format(v.amount_minor / 10 ** v.exponent) : '';
  return <details className={`as-account-usage ${warning ? 'warning' : ''}`}>
    <summary className="as-usage-summary">Usage <span>{usage?.available && fullest ? `${Math.round(fullest.usedPercent)}% used · ${fullest.label}` : 'Unavailable'}</span></summary>
    <div className="as-usage-windows">
      {!usage?.available && <p>{usage?.error || `${health.name || health.agent} does not report account usage to Reach yet.`}</p>}
      {windows.map(w => <div key={w.id} className="as-usage-window">
        <div><strong>{w.label}</strong><span>{Math.round(w.usedPercent)}% used{!usage?.available ? ' (last reading)' : ''}</span></div>
        <progress max={100} value={Math.min(100, w.usedPercent)} aria-label={`${w.label} usage`} />
        {w.resetsAt && <small>Resets {resetTime(w.resetsAt)}</small>}
        {usage?.available && ['warning', 'critical'].includes(w.severity) && <p role="status">{w.usedPercent >= 100 ? 'Limit reached' : `${Math.max(0, Math.round(100 - w.usedPercent))}% remaining`}</p>}
      </div>)}
      {usage?.credits && <p>{usage.credits.unlimited ? 'Unlimited credits' : `Credits: ${usage.credits.balance ?? 'Unavailable'}`}</p>}
      {usage?.spend && <p>Usage credits {usage.spend.enabled ? 'on' : 'off'}{usage.spend.used && usage.spend.limit ? ` · ${money(usage.spend.used)} / ${money(usage.spend.limit)}` : ''}</p>}
      {usage?.updatedAt && <small>Updated {new Date(usage.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>}
      {usage?.available && ['claude','codex'].includes(health.agent) && <a href={health.agent === 'claude' ? 'https://claude.ai/settings/usage' : 'https://chatgpt.com/codex/settings/usage'} target="_blank" rel="noopener noreferrer">Account usage settings</a>}
    </div>
  </details>;
}
