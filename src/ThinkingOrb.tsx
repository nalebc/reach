import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { MotionContext } from "./motion";
export type OrbState = "idle" | "working" | "connecting" | "waiting";
// Latitude rings keep the quiet sphere structured, like the reference's dotted globe.
const particles = Array.from({ length: 11 }, (_, row) => {
  const theta = ((row + 1) * Math.PI) / 12,
    count = Math.max(5, Math.round(Math.sin(theta) * 28));
  return Array.from({ length: count }, (_, col) => {
    const phi = (col * Math.PI * 2) / count;
    return {
      x: Math.sin(theta) * Math.cos(phi),
      y: Math.cos(theta),
      z: Math.sin(theta) * Math.sin(phi),
      phase: phi + theta * 2,
    };
  });
}).flat();
const ThinkingOrb = memo(function ThinkingOrb({
  state = "idle",
  size = 48,
  className = "",
}: {
  state?: OrbState;
  size?: number;
  className?: string;
}) {
  const root = useRef<HTMLSpanElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    phase = useRef(0);
  const [inView, setInView] = useState(false);
  const motion = useContext(MotionContext);
  useEffect(() => {
    if (!root.current || !("IntersectionObserver" in window)) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setInView(entry.isIntersecting),
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const animate = inView && motion.enabled && !motion.reduced && !motion.hidden;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d", { alpha: true });
    if (!ctx) return;
    const dots =
      size < 65 ? particles.filter((_, i) => i % 2 === 0) : particles;
    let frame = 0,
      last = 0,
      dimension = size,
      dpr = 1;
    const draw = () => {
      const t = phase.current,
        radius = dimension * 0.405,
        center = dimension / 2;
      ctx.clearRect(0, 0, dimension, dimension);
      const ry = t * 0.78,
        rx = -0.28 + Math.sin(t * 0.7) * 0.3;
      const points = dots
        .map((p, index) => {
          const wave =
            state === "working"
              ? 1 + Math.sin(p.phase * 3 + t * 2.6) * 0.17
              : state === "connecting"
                ? 1 + Math.sin(p.phase * 4 + t * 2) * 0.22
                : 1 + Math.sin(p.phase * 2 + t * 1.8) * 0.07;
          const breath = 0.94 + Math.sin(t * 1.9) * 0.055;
          let x = p.x * wave * breath,
            y = (p.y * wave + Math.sin(p.phase + t * 1.4) * 0.045) * breath,
            z = p.z * wave * breath;
          if (state === "waiting") {
            const a = (index / dots.length) * Math.PI * 2;
            x = Math.cos(a);
            y = Math.sin(a);
            z = p.z * 0.12;
          }
          const rotatedX = x * Math.cos(ry) + z * Math.sin(ry),
            rotatedZ = -x * Math.sin(ry) + z * Math.cos(ry);
          const rotatedY = y * Math.cos(rx) - rotatedZ * Math.sin(rx),
            depth = y * Math.sin(rx) + rotatedZ * Math.cos(rx);
          const perspective = 3.5 / (3.5 - depth * 0.28);
          return {
            x: center + rotatedX * radius * perspective,
            y: center + rotatedY * radius * perspective,
            depth,
          };
        })
        .sort((a, b) => a.depth - b.depth);
      for (const p of points) {
        const light = Math.max(0, Math.min(1, (p.depth + 1.3) / 2.6));
        ctx.fillStyle = `rgba(242,246,244,${0.22 + light * 0.78})`;
        ctx.beginPath();
        ctx.arc(
          p.x,
          p.y,
          Math.max(0.65, dimension / 100) * (0.7 + light * 0.55),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    };
    const resize = () => {
      dimension = el.clientWidth || size;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.round(dimension * dpr);
      el.height = Math.round(dimension * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    const tick = (now: number) => {
      if (!last) last = now;
      if (now - last >= 1000 / 30 - 0.5) {
        phase.current +=
          (Math.min(now - last, 100) / 1000) *
          (state === "working"
            ? 1.5
            : state === "connecting"
              ? 1.2
              : state === "waiting"
                ? 0.65
                : 1);
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    if (animate) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [animate, state, size]);
  return (
    <span
      ref={root}
      className={`thinking-orb particle-orb orb-${state} ${animate ? "" : "orb-sleeping"} ${className}`}
      style={{ "--orb-size": `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      <canvas className="orb-particles" ref={canvas} />
    </span>
  );
});
export default ThinkingOrb;
