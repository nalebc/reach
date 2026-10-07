/** A tiny stage with actual contact heights; coordinates are SVG units. */
export type Point = { x: number; y: number };
export type Move = {
  kind: "walk" | "crouch" | "jump" | "land" | "hang" | "pull" | "wave" | "rest";
  from: Point;
  to: Point;
  seconds: number;
};
export const GRAVITY = 900;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

export function position(move: Move, progress: number): Point {
  const t = Math.max(0, Math.min(1, progress));
  if (move.kind === "jump") {
    const time = t * move.seconds;
    const velocity =
      (move.to.y - move.from.y - 0.5 * GRAVITY * move.seconds ** 2) /
      move.seconds;
    return {
      x: mix(move.from.x, move.to.x, t),
      y: move.from.y + velocity * time + 0.5 * GRAVITY * time ** 2,
    };
  }
  const p = move.kind === "pull" ? smooth(t) : t;
  return {
    x: mix(move.from.x, move.to.x, p),
    y: mix(move.from.y, move.to.y, p),
  };
}

/** Solve a bent two-bone limb, retaining segment lengths even at full reach. */
export function joint(
  start: Point,
  target: Point,
  upper: number,
  lower: number,
  bend = 1,
) {
  const dx = target.x - start.x,
    dy = target.y - start.y;
  const actual = Math.hypot(dx, dy);
  const length = Math.max(
    Math.abs(upper - lower) + 0.001,
    Math.min(upper + lower - 0.001, actual),
  );
  const angle = Math.atan2(dy, dx);
  const spread = Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        (upper ** 2 + length ** 2 - lower ** 2) / (2 * upper * length),
      ),
    ),
  );
  return {
    x: start.x + Math.cos(angle + bend * spread) * upper,
    y: start.y + Math.sin(angle + bend * spread) * upper,
  };
}

/** During stance the foot moves back at exactly the body's speed: no skating. */
export function walkingFoot(
  distance: number,
  offset: number,
  direction = 1,
): Point {
  const phase = (((distance / 14 + offset) % 1) + 1) % 1;
  if (phase < 0.5) return { x: (3.5 - phase * 14) * direction, y: 0 };
  const swing = (phase - 0.5) * 2;
  return {
    x: (-3.5 + 7 * smooth(swing)) * direction,
    y: -4 * Math.sin(Math.PI * swing),
  };
}

export function itinerary(
  variant: number,
  start: Point = { x: 78, y: 210 },
): Move[] {
  const plan: Move[] = [];
  let at = start;
  const add = (kind: Move["kind"], to: Point, seconds: number) => {
    plan.push({ kind, from: { ...at }, to, seconds });
    at = to;
  };
  const hold = (kind: Move["kind"], seconds: number) =>
    add(kind, { ...at }, seconds);
  const walk = (x: number) =>
    add("walk", { x, y: at.y }, Math.max(0.4, Math.abs(x - at.x) / 34));
  const leap = (x: number, y: number, seconds: number, grab = false) => {
    hold("crouch", 0.24);
    add("jump", { x, y }, seconds);
    hold(grab ? "hang" : "land", grab ? 0.3 : 0.24);
  };
  walk(112);
  leap(170, 175, 0.58);
  if (variant !== 1) {
    walk(183);
    // Hands catch the lid at y=32 while the feet hang below it.
    leap(143, 68, 0.6, true);
    add("pull", { x: 148, y: 32 }, 1.05);
    hold("land", 0.22);
    walk(variant === 2 ? 264 : 224);
    hold("wave", 1.7);
    leap(282, 175, 0.72);
  } else {
    walk(232);
    hold("wave", 1.5);
    leap(272, 175, 0.45);
  }
  leap(337, 210, 0.5);
  hold("wave", 0.9);
  walk(78);
  hold("wave", 1.5);
  return plan;
}
