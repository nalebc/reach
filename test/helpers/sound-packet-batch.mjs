import { createHash } from "node:crypto";

// Test-only controlled delivery of unchanged native PCM. Seven real 20ms
// packets leave together on absolute 140ms deadlines. This models a batched
// route, not a physical network. No PCM is retained in the numeric report.
export function nativePacketBatches(handlers, {
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  maxPending = 56,
} = {}) {
  const queue = [], events = [], violations = new Set();
  const receivedHash = createHash("sha256"), deliveredHash = createHash("sha256");
  let active = false, closed = false, ended = false, timer, origin, next = 1, waiting = false;
  let received = 0, delivered = 0, peakPending = 0, batches = 0, flushed = 0, underfilled = 0, ignoredAfterClose = 0;
  const call = (name, receiver, args) => handlers[name] == null ? undefined : Reflect.apply(handlers[name], receiver, args);
  const hash = (digest, packet) => {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(packet.sequence, 0);
    header.writeUInt32LE(packet.args[1].rate, 4);
    header.writeUInt32LE(packet.args[1].channels, 8);
    header.writeUInt32LE(packet.args[0].length, 12);
    digest.update(header).update(Buffer.from(packet.args[0].buffer, packet.args[0].byteOffset, packet.args[0].byteLength));
  };
  const forward = packet => {
    if (packet.sequence !== delivered + 1) violations.add("delivery-order");
    delivered++;
    hash(deliveredHash, packet);
    return call("onSamples", packet.receiver, packet.args);
  };
  const cancel = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const finish = () => {
    active = false; waiting = false; cancel();
    while (queue.length) { flushed++; forward(queue.shift()); }
  };
  const close = () => { finish(); closed = true; };
  const schedule = () => {
    if (!active || timer !== undefined || waiting) return;
    timer = setTimer(tick, Math.max(0, origin + next * 140 - now()));
    timer?.unref?.();
  };
  const tick = () => {
    timer = undefined;
    if (!active) return;
    if (queue.length < 7) { underfilled++; waiting = true; return; }
    const first = queue[0].sequence, dueMs = origin + next * 140;
    for (let i = 0; i < 7; i++) forward(queue.shift());
    batches++;
    if (events.length === 64) events.shift();
    events.push({ batch: next, dueMs, deliveredAtMs: now(), firstSequence: first, packets: 7, pending: queue.length });
    next++; schedule();
  };
  return {
    handlers: {
      onInfo(...args) { return call("onInfo", this, args); },
      onSamples(...args) {
        if (closed) { ignoredAfterClose++; return; }
        const packet = { sequence: ++received, receiver: this, args };
        hash(receivedHash, packet);
        if (!active) return forward(packet);
        if (args[0].length / args[1].channels !== args[1].rate / 50) {
          violations.add("not-a-20ms-native-packet"); finish(); return forward(packet);
        }
        if (queue.length === maxPending) {
          violations.add("pending-limit"); finish(); return forward(packet);
        }
        queue.push(packet); peakPending = Math.max(peakPending, queue.length);
        if (waiting && queue.length >= 7) { waiting = false; tick(); }
      },
      onEnd(...args) {
        if (ended) return;
        ended = true; close(); return call("onEnd", this, args);
      },
    },
    start() {
      if (active || closed || origin !== undefined) throw Error("Native packet batching can start only once.");
      origin = now(); active = true; schedule();
    },
    finish, close,
    snapshot() {
      return {
        mode: "controlled-native-packet-delivery", packetsPerBatch: 7, packetMs: 20, cadenceMs: 140,
        originMs: origin ?? null, received, delivered, pending: queue.length, peakPending, maxPending,
        batches, flushedOutsideBatch: flushed, underfilledDeadlines: underfilled,
        timerPending: timer !== undefined, active, closed, ignoredAfterClose,
        receivedSHA256: receivedHash.copy().digest("hex"), deliveredSHA256: deliveredHash.copy().digest("hex"),
        violations: [...violations], retainedBatchEvents: events.map(event => ({ ...event })),
        overwrittenBatchEvents: Math.max(0, batches - events.length),
      };
    },
  };
}
