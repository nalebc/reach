// Test-only timing metadata. The same collector runs beside the real helper
// and in the browser; it never retains audio, socket addresses or errors.
const FIELDS = {
  "helper-info": ["rate", "channels"],
  "helper-packet": ["rate", "channels", "frames", "sequence"],
  "helper-end": [],
  "socket-packet": ["rate", "channels", "frames", "sequence", "bytes", "quiet", "audioTime", "audioFrame"],
  "worklet-post": ["rate", "frames", "audioTime", "audioFrame"],
  "worklet-quiet": ["rate", "audioTime", "audioFrame"],
  "worklet-late": ["rate", "targetMs", "audioTime", "audioFrame"],
  "clock-sample": ["rate", "level", "sample", "audioTime", "audioFrame"],
};
const LIMIT = 512;
const SAMPLE_LIMIT = 40;

export function createToneTiming({ now = () => performance.now(), wall = () => Date.now() } = {}) {
  const started = now();
  const streams = Object.fromEntries(Object.keys(FIELDS).map((kind) => [kind, {
    count: 0, maxGapMs: 0, maxGapAtMs: 0, lastAtMs: 0, events: [],
  }]));
  const samples = [];
  let sampleCount = 0;
  const record = (kind, values = {}) => {
    if (!Object.hasOwn(FIELDS, kind)) return;
    const tMs = now() - started, wallMs = wall();
    if (!Number.isFinite(tMs) || !Number.isFinite(wallMs)) return;
    const event = { tMs, wallMs };
    for (const field of FIELDS[kind]) {
      const value = values[field];
      if (Number.isFinite(value)) event[field] = value;
    }
    const stream = streams[kind];
    const gap = stream.count ? Math.max(0, tMs - stream.lastAtMs) : 0;
    if (gap > stream.maxGapMs) {
      stream.maxGapMs = gap;
      stream.maxGapAtMs = tMs;
    }
    stream.lastAtMs = tMs;
    stream.events[stream.count % LIMIT] = event;
    stream.count++;
    return { ...event };
  };
  return {
    record,
    sample(level, clock = {}) {
      const event = record("clock-sample", { ...clock, level, sample: sampleCount++ });
      if (event) {
        if (samples.length === SAMPLE_LIMIT) samples.shift();
        samples.push(event);
      }
      return level;
    },
    snapshot() {
      return {
        streams: Object.fromEntries(Object.entries(streams).map(([kind, stream]) => {
          const offset = stream.count > LIMIT ? stream.count % LIMIT : 0;
          const events = [...stream.events.slice(offset), ...stream.events.slice(0, offset)];
          return [kind, {
            count: stream.count,
            overwritten: Math.max(0, stream.count - LIMIT),
            maxGapMs: stream.maxGapMs,
            maxGapAtMs: stream.maxGapAtMs,
            events: events.map((event) => ({ ...event })),
          }];
        })),
        sampleCount,
        samples: samples.map((event) => ({ ...event })),
      };
    },
  };
}

// Observation must never turn a passing delivery into a failure. Each native
// call still runs exactly once, with its receiver, arguments and return value.
const observe = (run) => { try { run(); } catch {} };
const deliver = (callback, receiver, args) => callback == null ? undefined : Reflect.apply(callback, receiver, args);

export function observeToneSource(handlers, timing) {
  let sequence = 0;
  return {
    onInfo(...args) {
      observe(() => timing.record("helper-info", args[0]));
      return deliver(handlers.onInfo, this, args);
    },
    onSamples(...args) {
      observe(() => timing.record("helper-packet", {
        rate: args[1]?.rate, channels: args[1]?.channels,
        frames: args[0].length / args[1]?.channels, sequence: ++sequence,
      }));
      return deliver(handlers.onSamples, this, args);
    },
    onEnd(...args) {
      observe(() => timing.record("helper-end"));
      return deliver(handlers.onEnd, this, args);
    },
  };
}

export function observeToneWebSockets(scope, timing, clock = () => ({})) {
  scope.WebSocket = new Proxy(scope.WebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      socket.addEventListener("message", (event) => observe(() => {
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 16) return;
        const data = new DataView(event.data);
        if (data.getUint8(0) !== 1 || data.getUint8(1) !== 1) return;
        timing.record("socket-packet", {
          ...clock(), bytes: data.byteLength,
          channels: data.getUint8(2), quiet: data.getUint8(3) & 1,
          rate: data.getUint32(4, true), sequence: data.getUint32(8, true), frames: data.getUint16(12, true),
        });
      }));
      return socket;
    },
  });
}

export function observeTonePort(port, timing, clock = () => ({})) {
  const post = port.postMessage;
  port.postMessage = function (...args) {
    let kind, values;
    observe(() => {
      if (args[0]?.type === "samples") {
        kind = "worklet-post";
        values = { ...clock(), frames: args[0].samples.length / 2 };
      } else if (args[0]?.type === "quiet") {
        kind = "worklet-quiet";
        values = clock();
      }
    });
    // Capture only the frame count before a successful native post detaches
    // the buffer. Do not copy it, await a promise, change a transfer list or
    // catch a delivery error; the caller sees the native result unchanged.
    const result = Reflect.apply(post, this, args);
    if (kind) observe(() => timing.record(kind, values));
    return result;
  };
  port.addEventListener("message", (event) => observe(() => {
    if (event.data?.type === "late")
      timing.record("worklet-late", { ...clock(), targetMs: event.data.target * 1000 });
  }));
}
