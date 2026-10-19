import test from "node:test";
import assert from "node:assert/strict";
import { nativePacketBatches } from "./helpers/sound-packet-batch.mjs";

function fixture(maxPending) {
  let clock = 0, id = 0;
  const timers = new Map(), delivered = [], ended = [];
  const receiver = {}, info = { rate: 48000, channels: 2 };
  const route = nativePacketBatches({
    onSamples(samples, format) { delivered.push({ receiver: this, samples, format }); return samples; },
    onEnd(error) { ended.push({ receiver: this, error }); return error; },
  }, {
    maxPending, now: () => clock,
    setTimer(callback, delay) { const timer = ++id; timers.set(timer, { callback, due: clock + delay }); return timer; },
    clearTimer(timer) { timers.delete(timer); },
  });
  return { route, receiver, info, delivered, ended, timers,
    packet(n) { const samples = new Int16Array(1920).fill(n); route.handlers.onSamples.call(receiver, samples, info); return samples; },
    advance(to) {
      clock = to;
      for (;;) {
        const ready = [...timers].find(([, timer]) => timer.due <= clock);
        if (!ready) break;
        timers.delete(ready[0]); ready[1].callback();
      }
    },
  };
}

test("modeled batch clock preserves real packet objects/order and absolute deadlines", () => {
  const f = fixture();
  const first = f.packet(0);
  assert.equal(f.delivered[0].samples, first, "warmup delivery is unchanged");
  f.route.start();
  const held = Array.from({ length: 7 }, (_, i) => f.packet(i + 1));
  f.advance(139); assert.equal(f.delivered.length, 1);
  f.advance(145); assert.equal(f.delivered.length, 8);
  held.forEach((packet, i) => assert.equal(f.delivered[i + 1].samples, packet));
  for (let i = 0; i < 7; i++) f.packet(i + 8);
  f.advance(279); assert.equal(f.delivered.length, 8);
  f.advance(280); assert.equal(f.delivered.length, 15, "late first timer does not shift the next absolute deadline");
  f.route.finish();
  const s = f.route.snapshot();
  assert.deepEqual(s.retainedBatchEvents.map(e => e.dueMs), [140, 280]);
  assert.equal(s.receivedSHA256, s.deliveredSHA256);
  assert.ok(f.delivered.every(p => p.receiver === f.receiver && p.format === f.info));
  assert.equal(f.timers.size, 0);
});

test("an underfilled modeled deadline waits for native packets without spinning; end flushes once", () => {
  const f = fixture(); f.route.start();
  for (let i = 0; i < 6; i++) f.packet(i);
  f.advance(140); assert.equal(f.delivered.length, 0); assert.equal(f.timers.size, 0);
  f.advance(145); f.packet(6); assert.equal(f.delivered.length, 7);
  f.packet(7); f.packet(8);
  const error = Error("fixture native end");
  assert.equal(f.route.handlers.onEnd.call(f.receiver, error), error);
  f.route.close(); f.advance(1000);
  assert.equal(f.delivered.length, 9); assert.equal(f.ended.length, 1);
  assert.equal(f.ended[0].receiver, f.receiver);
  const s = f.route.snapshot();
  assert.equal(s.pending, 0); assert.equal(s.timerPending, false);
  assert.equal(s.flushedOutsideBatch, 2);
  assert.equal(s.receivedSHA256, s.deliveredSHA256);
});

test("bounded batch overflow fails the fixture without dropping or duplicating native packets", () => {
  const f = fixture(14); f.route.start();
  for (let i = 0; i < 15; i++) f.packet(i);
  f.advance(1000);
  const s = f.route.snapshot();
  assert.deepEqual(s.violations, ["pending-limit"]);
  assert.equal(s.peakPending, 14); assert.equal(s.pending, 0); assert.equal(s.timerPending, false);
  assert.equal(f.delivered.length, 15); assert.equal(s.receivedSHA256, s.deliveredSHA256);
});
