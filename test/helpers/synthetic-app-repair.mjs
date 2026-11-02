import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evidenceHash } from '../../server/agent-sessions/result-evidence.mjs';
import { outcomeWorkflow } from './outcome-workflow.mjs';

const exec = promisify(execFile);
export const appFixture = fileURLToPath(new URL('../fixtures/outcome-app/', import.meta.url));
export const brokenTotal = fs.readFileSync(path.join(appFixture, 'src/total.mjs'), 'utf8');
export const repairedTotal = brokenTotal.replace('return a - b;', 'return a + b;');
export const outcomeTuple = o => Object.fromEntries(['contractRevision', 'contractDigest', 'resultRevision', 'resultDigest', 'evidenceRevision', 'evidenceDigest'].map(k => [k, o[k]]));
export const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Real temporary files and a bounded Node subprocess, simulated agents and
// runner trust assertions. Copies/hash checks are NOT an OS sandbox against
// another process running as this user. Never install this as a production runner.
export function syntheticAppRepair(t, options = {}) {
  const h = outcomeWorkflow(t, options);
  const build = path.join(h.dir, 'build'), review = path.join(h.dir, 'review');
  fs.cpSync(appFixture, build, { recursive: true });
  fs.mkdirSync(review);
  const candidates = new Map(), logs = new Map(), executed = [];
  const faults = { check: '', capture: '', checkGate: null, verifyGate: null };
  const harness = path.join(appFixture, 'check.mjs');
  const harnessDigest = evidenceHash(fs.readFileSync(harness, 'utf8'));
  const definition = { executable: 'node', args: ['check.mjs', '<candidate>/src/total.mjs'], cwd: '.', environment: [], outputBytes: 4096 };
  // Include the harness bytes in the approved definition; executable invocation
  // below resolves fixed fixture paths rather than any provider-supplied command.
  definition.args.push(harnessDigest);
  h.contract.checks[0].definitionDigest = evidenceHash(definition);
  h.workflows.putOutcome(h.w.id, h.command('pin-synthetic-harness', { contract: h.contract }));
  const manifest = directory => {
    const entries = [];
    const visit = relative => {
      for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
        const file = relative ? `${relative}/${name}` : name, stat = fs.lstatSync(path.join(directory, file));
        if (stat.isSymbolicLink()) throw Error('Synthetic snapshot contains an unsupported link');
        if (stat.isDirectory()) visit(file);
        else entries.push([file, fs.readFileSync(path.join(directory, file), 'utf8')]);
      }
    };
    visit(''); return Object.fromEntries(entries);
  };
  const original = manifest(build);
  async function check(check, candidateDigest, directory, kind) {
    if (faults.checkGate && kind === 'check') await faults.checkGate.promise;
    let exitCode = 0, stdout;
    try { ({ stdout } = await exec(process.execPath, [harness, path.join(directory, 'src/total.mjs'), harnessDigest], { timeout: 5000, maxBuffer: 4096, windowsHide: true })); }
    catch (error) { if (!Number.isSafeInteger(error.code)) throw Error('Synthetic checker disposition unknown'); exitCode = error.code; stdout = error.stdout; }
    const logDigest = evidenceHash(stdout);
    logs.set(logDigest, stdout);
    const receipt = { checkId: check.id, profileDigest: check.definitionDigest, candidateDigest, source: 'independent_runner', status: exitCode === 0 ? 'passed' : 'failed', exitCode, complete: true, sideEffectsKnown: true, logDigest };
    executed.push({ kind, receipt: structuredClone(receipt) });
    if (kind === 'check') {
      if (faults.check === 'missing') delete receipt.exitCode;
      if (faults.check === 'truncated') receipt.complete = false;
      if (faults.check === 'stale') receipt.candidateDigest = evidenceHash('previous candidate');
    }
    return receipt;
  }
  Object.assign(h.runner, {
    async prepare() { h.calls.push('prepare'); return { profiles: [{ id: 'unit', profileId: h.contract.checks[0].profileId, definition, definitionDigest: evidenceHash(definition) }], buildCwd: build, reviewCwd: review, isolation: 'TEST ONLY: copied snapshots; no OS security boundary' }; },
    async baseline({ check: c }) { h.calls.push('baseline'); return check(c, evidenceHash(manifest(build)), build, 'baseline'); },
    async capture({ cycle }) {
      h.calls.push(`capture-${cycle}`);
      const files = manifest(build), digest = evidenceHash(files), directory = path.join(review, `candidate-${cycle}`);
      fs.mkdirSync(directory); fs.cpSync(build, directory, { recursive: true });
      candidates.set(digest, { directory, files });
      const changed = new Set([...Object.keys(original), ...Object.keys(files)]);
      const scopeVerified = [...changed].every(file => files[file] === original[file] || file.startsWith('src/'));
      const result = { digest, manifestDigest: evidenceHash(files), artifactKinds: ['source_snapshot', 'diff'], sealed: true, scopeVerified, sideEffectsKnown: true, isolationVerified: true, historyComplete: true };
      if (faults.capture === 'concurrent') result.sideEffectsKnown = false;
      return result;
    },
    async check({ check: c, candidate, cycle }) { h.calls.push(`check-${cycle}`); return check(c, candidate.digest, candidates.get(candidate.digest).directory, 'check'); },
    async verify({ candidate, bundles }) {
      h.calls.push('verify'); if (faults.verifyGate) await faults.verifyGate.promise;
      return evidenceHash(fs.readFileSync(harness, 'utf8')) === harnessDigest &&
        candidates.has(candidate.digest) && evidenceHash(manifest(candidates.get(candidate.digest).directory)) === candidate.digest &&
        bundles.every(b => candidates.has(b.candidate.digest) && evidenceHash(manifest(candidates.get(b.candidate.digest).directory)) === b.candidate.digest) &&
        executed.every(v => logs.has(v.receipt.logDigest) && evidenceHash(logs.get(v.receipt.logDigest)) === v.receipt.logDigest);
    },
  });
  return Object.assign(h, { build, review, candidates, logs, executed, faults,
    write(source = repairedTotal) { fs.writeFileSync(path.join(build, 'src/total.mjs'), source); },
    async finishBuild({ fixed = true, text = 'Fixed; all checks passed.' } = {}) {
      const task = h.workflows.get(h.w.id).tasks.find(t => t.state === 'working'); assert.equal(task.kind, 'build');
      if (fixed) this.write();
      const chat = h.chats.get(task.chat.id);
      chat.items.push({ id: `change-${chat.id}`, role: 'tool', kind: 'file-change', turnId: chat.turnId, text: 'src/total.mjs', status: 'completed', detail: fixed ? '-return a - b;\n+return a + b;' : 'No change' });
      await h.end(text); await h.pump();
    },
    async finishReview() { await h.end('{"status":"clear","findings":[]}'); await h.pump(); },
    async ready() { await h.run(); await h.pump(); await this.finishBuild(); await this.finishReview(); assert.equal(h.get().phase, 'ready'); },
  });
}
