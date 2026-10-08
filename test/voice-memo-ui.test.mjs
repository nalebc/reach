import test from 'node:test';
import assert from 'node:assert/strict';
import { startDom, settle } from './dom/harness.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t) {
  const dom = await startDom();
  const { useVoiceMemo } = await dom.load('/src/voice-memo.ts');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  const permissions = [], recorders = [], memos = [], problems = [];
  let failStart = false;
  Object.defineProperty(dom.window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => {
    const pending = deferred(); permissions.push(pending); return pending.promise;
  } } });
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    start() { if (failStart) throw Error('Synthetic recorder start failure'); this.state = 'recording'; this.started = true; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['synthetic memo'], { type: this.mimeType }) });
      this.finished = Promise.resolve().then(() => this.onstop?.());
    }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, writable: true, value: Recorder });
  let api;
  function Voice() {
    api = useVoiceMemo(async memo => { memos.push(memo); }, message => problems.push(message));
    return dom.React.createElement('span', null, api.state);
  }
  const view = await dom.render(dom.React.createElement(dom.React.StrictMode, null, dom.React.createElement(Voice)));
  t.after(async () => {
    for (const rec of recorders) if (rec.state === 'recording') rec.stop();
    await Promise.all(recorders.map(rec => rec.finished));
    await dom.close();
    if (saved) Object.defineProperty(globalThis, 'MediaRecorder', saved);
    else delete globalThis.MediaRecorder;
  });
  const stream = () => { const track = { stops: 0, stop() { this.stops++; } }; return { track, getTracks: () => [track] }; };
  return { dom, view, permissions, recorders, memos, problems, stream, failStart: value => { failStart = value; }, api: () => api };
}

test('leaving a chat while microphone permission is pending stops the granted stream without starting a recorder', async t => {
  const f = await fixture(t);
  const pending = f.api().start();
  assert.equal(f.permissions.length, 1);
  await f.view.unmount();
  const stream = f.stream(); f.permissions[0].resolve(stream);
  await pending;
  assert.equal(stream.track.stops, 1);
  assert.equal(f.recorders.length, 0);
  assert.deepEqual(f.memos, []);
  assert.deepEqual(f.problems, []);
});

test('repeated record taps during permission prompt share one attempt and a successful memo stops its stream', async t => {
  const f = await fixture(t);
  const first = f.api().start();
  const second = f.api().start();
  assert.equal(f.permissions.length, 1);
  const stream = f.stream(); f.permissions[0].resolve(stream);
  await Promise.all([first, second]);
  await settle();
  assert.equal(f.recorders.length, 1);
  assert.equal(f.recorders[0].started, true);
  f.api().stop();
  await f.recorders[0].finished;
  await settle();
  assert.equal(stream.track.stops, 1);
  assert.equal(f.memos.length, 1);
  assert.equal(f.api().state, 'idle');
  assert.deepEqual(f.problems, []);
});

test('leaving a recording chat stops microphone tracks and never submits the synthetic memo', async t => {
  const f = await fixture(t);
  const pending = f.api().start();
  const stream = f.stream(); f.permissions[0].resolve(stream);
  await pending;
  await f.view.unmount();
  await f.recorders[0].finished;
  assert.equal(stream.track.stops, 1);
  assert.deepEqual(f.memos, []);
});


test('a recorder that cannot start releases its stream and allows a fresh attempt', async t => {
  const f = await fixture(t);
  f.failStart(true);
  const pending = f.api().start();
  const stream = f.stream(); f.permissions[0].resolve(stream);
  await pending;
  assert.equal(stream.track.stops, 1);
  assert.equal(f.api().state, 'idle');
  assert.deepEqual(f.memos, []);
  assert.equal(f.problems.length, 1);
  assert.match(f.problems[0], /couldn't start/);
  f.failStart(false);
  const retry = f.api().start();
  assert.equal(f.permissions.length, 2);
  const second = f.stream(); f.permissions[1].resolve(second);
  await retry;
  assert.equal(f.recorders[1].started, true);
  f.api().cancel();
  await f.recorders[1].finished;
  assert.equal(second.track.stops, 1);
  assert.deepEqual(f.memos, []);
});
