// Account meters, from the same native sources the agents use. Never return credentials.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const percent = n => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : null;
const date = x => typeof x === 'number' ? x * 1000 : (Date.parse(x) || null);
const severity = n => n >= 100 ? 'critical' : n >= 90 ? 'warning' : 'normal';
export function codexUsage(data, now = Date.now()) {
  if (!data) return { available: false, windows: [], error: 'Codex usage is temporarily unavailable.' };
  const snapshots = Object.values(data.rateLimitsByLimitId || {});
  if (!snapshots.length && data.rateLimits) snapshots.push(data.rateLimits);
  const windows = [];
  for (const s of snapshots) for (const [key, w] of [['primary', s.primary], ['secondary', s.secondary]]) {
    if (!w || percent(w.usedPercent) === null) continue;
    const period = w.windowDurationMins === 10080 ? 'Weekly' : w.windowDurationMins === 300 ? '5 hours' : w.windowDurationMins ? `${w.windowDurationMins / 60} hours` : key === 'primary' ? 'Current limit' : 'Additional limit';
    windows.push({ id: `${s.limitId || 'codex'}:${key}`, label: s.limitName ? `${s.limitName} · ${period}` : period, usedPercent: percent(w.usedPercent), resetsAt: date(w.resetsAt), severity: severity(w.usedPercent) });
  }
  return { available: true, windows, updatedAt: now, plan: data.rateLimits?.planType || null,
    credits: data.rateLimits?.credits ? { unlimited: !!data.rateLimits.credits.unlimited, balance: data.rateLimits.credits.balance } : null };
}
export function claudeUsage(data, now = Date.now()) {
  const labels = { session: 'Current session', weekly_all: 'All models · weekly', weekly_scoped: 'Weekly', spend: 'Usage credits' };
  let windows = (data.limits || []).filter(r => percent(r.percent) !== null).map((r, i) => ({
    id: `${r.kind}:${i}`, label: r.scope?.model?.display_name ? `${r.scope.model.display_name} · weekly` : labels[r.kind] || r.group || 'Usage',
    usedPercent: percent(r.percent), resetsAt: date(r.resets_at), severity: r.severity || severity(r.percent),
  }));
  if (!windows.length) windows = Object.entries({ five_hour: 'Current session', seven_day: 'All models · weekly', seven_day_opus: 'Opus · weekly', seven_day_sonnet: 'Sonnet · weekly' })
    .filter(([k]) => percent(data[k]?.utilization) !== null).map(([id, label]) => ({ id, label, usedPercent: data[id].utilization, resetsAt: date(data[id].resets_at), severity: severity(data[id].utilization) }));
  return { available: true, windows, updatedAt: now, ...(data.spend ? { spend: { enabled: data.spend.enabled, used: data.spend.used, limit: data.spend.limit } } : {}) };
}
export function createClaudeAccountUsage({ run = exec, fetcher = fetch, read = fs.readFile, home = os.homedir(), env = process.env, platform = process.platform, now = Date.now } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let cached, pending, checked = 0;
  return async () => {
    if (cached && now() - checked < 60000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || paths.join(home, '.claude');
        let credentials;
        if (platform === 'darwin') {
          const custom = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
          const suffix = custom ? `-${crypto.createHash('sha256').update(custom.normalize('NFC')).digest('hex').slice(0,8)}` : '';
          const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-a', env.USER || os.userInfo().username, '-w', '-s', `Claude Code-credentials${suffix}`], { timeout: 5000, maxBuffer: 1024 * 1024 });
          credentials = JSON.parse(stdout);
        } else credentials = JSON.parse(await read(paths.join(dir, '.credentials.json'), 'utf8'));
        const token = credentials.claudeAiOauth?.accessToken;
        if (!token) throw new Error('unavailable');
        const response = await fetcher('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('unavailable');
        cached = claudeUsage(await response.json(), now());
      } catch {
        cached = { ...(cached || { windows: [] }), available: false, error: 'Claude usage could not be refreshed. Open Claude to check usage or refresh its sign-in.' };
      } finally { checked = now(); pending = null; }
      return cached;
    })();
    return pending;
  };
}
