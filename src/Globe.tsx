import { useEffect, useRef } from "react";

// A rotating dotted globe with light arcs travelling between devices.
const LIME = [185, 245, 104];
const DOTS = (() => {
  const points: { x: number; y: number; z: number; land: boolean }[] = [];
  const n = 1700;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const x = Math.cos(theta) * r,
      z = Math.sin(theta) * r;
    const lat = Math.asin(y),
      lon = Math.atan2(z, x);
    // Smooth pseudo-continents: brighter "land", fainter "ocean".
    const land =
      Math.sin(lon * 2.1 + 0.6) * Math.cos(lat * 2.6) +
        0.55 * Math.sin(lon * 4.7 + lat * 3.1) +
        0.35 * Math.cos(lat * 7.3 - lon * 1.4) >
      0.35;
    points.push({ x, y, z, land });
  }
  return points;
})();
const fromLatLon = (lat: number, lon: number) => {
  const a = (lat * Math.PI) / 180,
    b = (lon * Math.PI) / 180;
  return { x: Math.cos(a) * Math.cos(b), y: Math.sin(a), z: Math.cos(a) * Math.sin(b) };
};
const PLACES = [
  fromLatLon(37, -100),
  fromLatLon(48, 8),
  fromLatLon(35, 135),
  fromLatLon(-25, 140),
  fromLatLon(-15, -55),
];
const ARCS: [number, number][] = [
  [0, 1],
  [1, 2],
  [0, 4],
  [2, 3],
];

export function Globe({
  size = 260,
  arcs = true,
  speed = 1,
  className = "",
}: {
  size?: number;
  arcs?: boolean;
  speed?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const R = size * 0.4,
      cx = size / 2,
      cy = size / 2,
      tilt = 0.38;
    let frame = 0,
      angle = 0.8,
      last = performance.now();
    const project = (p: { x: number; y: number; z: number }) => {
      const x1 = p.x * Math.cos(angle) + p.z * Math.sin(angle);
      const z1 = -p.x * Math.sin(angle) + p.z * Math.cos(angle);
      const y2 = p.y * Math.cos(tilt) - z1 * Math.sin(tilt);
      const z2 = p.y * Math.sin(tilt) + z1 * Math.cos(tilt);
      return { x: cx + x1 * R, y: cy - y2 * R, z: z2 };
    };
    const draw = (now: number) => {
      const dt = Math.min(now - last, 64);
      last = now;
      if (!reduced) angle += dt * 0.00018 * speed;
      ctx.clearRect(0, 0, size, size);
      const halo = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.35);
      halo.addColorStop(0, "rgba(185,245,104,0.10)");
      halo.addColorStop(1, "rgba(185,245,104,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
      body.addColorStop(0, "rgba(46,64,40,0.55)");
      body.addColorStop(1, "rgba(16,24,18,0.25)");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      for (const d of DOTS) {
        const p = project(d);
        const front = p.z > 0;
        const alpha = front ? (d.land ? 0.35 + 0.6 * p.z : 0.08 + 0.12 * p.z) : d.land ? 0.07 : 0.025;
        ctx.fillStyle = `rgba(${LIME[0]},${LIME[1]},${LIME[2]},${alpha})`;
        const s = (d.land ? 1.7 : 1.05) * (front ? 0.75 + 0.5 * p.z : 0.6) * (size / 260);
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
      if (arcs) {
        ARCS.forEach(([from, to], i) => {
          const a = PLACES[from],
            b = PLACES[to];
          const steps = 48;
          const pts = [];
          for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const mx = a.x + (b.x - a.x) * t,
              my = a.y + (b.y - a.y) * t,
              mz = a.z + (b.z - a.z) * t;
            const len = Math.hypot(mx, my, mz) || 1;
            const lift = 1 + 0.22 * Math.sin(Math.PI * t);
            pts.push(project({ x: (mx / len) * lift, y: (my / len) * lift, z: (mz / len) * lift }));
          }
          const head = ((now / 1600 + i * 0.27) % 1.4) / 1.4;
          for (let k = 1; k < pts.length; k++) {
            const t = k / steps;
            const visible = pts[k].z > -0.15;
            if (!visible) continue;
            const glow = Math.max(0, 1 - Math.abs(t - head) * 5);
            ctx.strokeStyle = `rgba(${LIME[0]},${LIME[1]},${LIME[2]},${0.12 + 0.75 * glow})`;
            ctx.lineWidth = (0.8 + 1.6 * glow) * (size / 260);
            ctx.beginPath();
            ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
            ctx.lineTo(pts[k].x, pts[k].y);
            ctx.stroke();
          }
        });
        PLACES.forEach((place, i) => {
          const p = project(place);
          if (p.z <= 0) return;
          const pulse = (now / 1400 + i * 0.2) % 1;
          ctx.strokeStyle = `rgba(${LIME[0]},${LIME[1]},${LIME[2]},${0.6 * (1 - pulse)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (3 + pulse * 9) * (size / 260), 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = "#d8ffa8";
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.2 * (size / 260), 0, Math.PI * 2);
          ctx.fill();
        });
      }
      const rim = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.02);
      rim.addColorStop(0, "rgba(185,245,104,0)");
      rim.addColorStop(1, "rgba(185,245,104,0.22)");
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
      ctx.fill();
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size, arcs, speed]);
  return (
    <canvas
      ref={ref}
      className={`globe ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
