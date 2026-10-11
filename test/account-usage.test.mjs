import test from 'node:test';
import assert from 'node:assert/strict';
import { codexUsage, claudeUsage, createClaudeAccountUsage } from '../server/agent-sessions/account-usage.mjs';
test('Codex reports each native limit window, credits and reset times', () => {
  const usage = codexUsage({ rateLimits: { planType: 'pro', credits: { balance: '2', unlimited: false } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: 1900000000 }, secondary: { usedPercent: 95, windowDurationMins: 300 } } } }, 10);
  assert.deepEqual(usage.windows.map(w => [w.label,w.usedPercent,w.severity]), [['Weekly',78,'normal'],['5 hours',95,'critical']]);
  assert.equal(usage.windows[0].resetsAt,1900000000000);
  assert.equal(usage.credits.balance,'2');
  assert.equal(codexUsage(null).available,false);
});
test('Claude uses native warning severity and model labels instead of inferred token counts', () => {
  const usage=claudeUsage({limits:[{kind:'session',percent:75,severity:'warning',resets_at:'2030-01-01T00:00:00Z'},{kind:'weekly_scoped',percent:23,severity:'normal',scope:{model:{display_name:'Fable'}}}]});
  assert.equal(usage.windows[0].severity,'warning');assert.equal(usage.windows[1].label,'Fable · weekly');assert.equal(usage.windows[0].usedPercent,75);
});
for (const { platform, home, env, expected } of [
  { platform: 'linux', home: '/home/test', env: {}, expected: '/home/test/.claude/.credentials.json' },
  { platform: 'win32', home: String.raw`C:\Users\test`, env: {}, expected: String.raw`C:\Users\test\.claude\.credentials.json` },
  { platform: 'win32', home: String.raw`C:\Users\test`, env: { CLAUDE_CONFIG_DIR: String.raw`D:\Agent Settings` }, expected: String.raw`D:\Agent Settings\.credentials.json` },
]) test(`Claude usage uses ${platform} credential paths${env.CLAUDE_CONFIG_DIR ? ' with a custom directory' : ''}, caches requests, and never returns credentials`, async()=>{
  let calls=0,time=100000;
  const paths=[];
  const read=createClaudeAccountUsage({platform,home,env,now:()=>time,read:async file=>{paths.push(file);return JSON.stringify({claudeAiOauth:{accessToken:'private-test-token'}})},fetcher:async(url,opts)=>{calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer private-test-token');return {ok:true,json:async()=>({five_hour:{utilization:34,resets_at:'2030-01-01T00:00:00Z'}})}}});
  const first=await read();await read();assert.equal(calls,1);assert.equal(first.windows[0].usedPercent,34);assert.ok(!JSON.stringify(first).includes('private-test-token'));time+=61000;await read();assert.equal(calls,2);
  assert.deepEqual(paths,[expected,expected]);
});
test('usage failures are explicit and cached, with no raw credential error text exposed',async()=>{
  let calls=0;const read=createClaudeAccountUsage({platform:'darwin',env:{USER:'tester'},run:async()=>{calls++;throw new Error('private-token')}});
  const result=await read();await read();assert.equal(calls,1);assert.equal(result.available,false);assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('an expired Claude Code sign-in keeps the last reading and says Claude Code renews it, without a request', async () => {
  let calls = 0, time = 100000;
  const token = { claudeAiOauth: { accessToken: 'private-test-token', expiresAt: 200000 } };
  const read = createClaudeAccountUsage({ platform: 'linux', home: '/home/test', env: {}, now: () => time, read: async () => JSON.stringify(token),
    fetcher: async () => { calls++; return { ok: true, json: async () => ({ limits: [{ kind: 'weekly_all', percent: 100 }, { kind: 'weekly_scoped', percent: 100, scope: { model: { display_name: 'Fable' } } }] }) }; } });
  const first = await read();
  assert.deepEqual(first.windows.map(w => !!w.scoped), [false, true]);
  time = 300000;
  const stale = await read();
  assert.equal(calls, 1);
  assert.equal(stale.available, false);
  assert.match(stale.error, /renews the next time Claude Code runs/);
  assert.equal(stale.windows[0].usedPercent, 100);
});
