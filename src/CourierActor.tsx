import { useEffect, useRef, useState } from "react";
import {
  itinerary,
  joint,
  position,
  walkingFoot,
  type Move,
  type Point,
} from "./courier-physics";

/** Articulated pixel character. One lightweight frame loop; React never renders per frame. */
export default function CourierActor({
  playing,
  greeting = false,
  connecting = false,
}: {
  playing: boolean;
  greeting?: boolean;
  connecting?: boolean;
}) {
  const root = useRef<SVGGElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(root.current.ownerSVGElement || root.current);
    return () => observer.disconnect();
  }, []);
  const clock = useRef({
    elapsed: 0,
    index: 0,
    variant: 0,
    plan: itinerary(0),
  });
  useEffect(() => {
    const element = root.current;
    if (!element || !playing || !visible) return;
    const body = element.querySelector<SVGGElement>(".actor-body")!;
    const shadow = element.querySelector<SVGEllipseElement>(".actor-shadow")!;
    const legs = [...element.querySelectorAll<SVGPathElement>(".actor-leg")];
    const arms = [...element.querySelectorAll<SVGPathElement>(".actor-arm")];
    const eyes = element.querySelector<SVGGElement>(".actor-eyes")!;
    let frame = 0,
      last = 0,
      paint = 0;
    const limb = (start: Point, end: Point, size: number, bend: number) => {
      const reach = Math.hypot(end.x - start.x, end.y - start.y);
      if (reach > size * 2 - 0.001) {
        const scale = (size * 2 - 0.001) / reach;
        end = {
          x: start.x + (end.x - start.x) * scale,
          y: start.y + (end.y - start.y) * scale,
        };
      }
      const knee = joint(start, end, size, size, bend);
      return `M${start.x} ${start.y}L${knee.x} ${knee.y}L${end.x} ${end.y}`;
    };
    const draw = (move: Move, t: number) => {
      const at = position(move, t),
        facing = move.to.x < move.from.x ? -1 : 1;
      const walking = move.kind === "walk",
        jumping = move.kind === "jump";
      const hanging =
        move.kind === "hang" || (jumping && move.to.y === 68 && t > 0.62);
      const pulling = move.kind === "pull";
      const dip =
        move.kind === "crouch"
          ? 3.5 * t
          : move.kind === "land"
            ? 3.5 * Math.sin(Math.PI * t)
            : 0;
      const distance = Math.abs(at.x - move.from.x);
      const bob = walking
        ? -Math.abs(Math.sin((distance / 14) * Math.PI * 2)) * 0.7
        : 0;
      const hipY = -9 + dip + bob;
      const lean =
        move.kind === "crouch"
          ? 12 * t
          : walking
            ? facing * 4
            : pulling
              ? -10 * Math.sin(t * Math.PI)
              : jumping
                ? -7
                : 0;
      element.setAttribute("transform", `translate(${at.x} ${at.y})`);
      element.setAttribute("data-action", move.kind);
      body.setAttribute(
        "transform",
        `translate(0 ${dip + bob}) rotate(${lean} 0 -9)`,
      );
      eyes.setAttribute("transform", `translate(${facing * 0.8} 0)`);
      for (let i = 0; i < 2; i++) {
        const foot = walking
          ? walkingFoot(distance, i * 0.5, facing)
          : { x: i ? 4 : -4, y: 0 };
        if (walking) foot.x += i ? 3 : -3;
        if (jumping) {
          foot.x = i ? 6 : -6;
          foot.y = -3.5 * Math.sin(Math.PI * t);
        }
        if (hanging) {
          foot.x = i ? 5 : -3;
          foot.y = i ? -1 : -4;
        }
        if (pulling) {
          foot.x = i ? 7 : -5;
          foot.y = i ? -4 * Math.sin(Math.PI * t) : 0;
        }
        legs[i].setAttribute(
          "d",
          limb({ x: i ? 4 : -4, y: hipY }, foot, 6.5, i ? -1 : 1),
        );
        const shoulder = { x: i ? 8 : -8, y: -20 + dip + bob };
        let hand = {
          x:
            (i ? 11 : -11) +
            (walking
              ? Math.sin((distance / 14) * Math.PI * 2 + i * Math.PI) * 4
              : 0),
          y: -11 + dip,
        };
        if (hanging || (pulling && t < 0.75))
          hand = { x: (i ? 153 : 132) - at.x, y: 32 - at.y };
        else if (jumping) hand = { x: i ? 14 : -14, y: -27 };
        else if (move.kind === "wave" && i === 1)
          hand = { x: 14 + Math.sin(t * Math.PI * 8) * 3, y: -34 };
        else if (move.kind === "crouch") hand = { x: i ? 10 : -10, y: -6 };
        if (connecting && i === 1) hand = { x: 14, y: -16 };
        arms[i].setAttribute("d", limb(shoulder, hand, 9, i ? -1 : 1));
      }
      const height = jumping
        ? Math.max(0, Math.min(move.from.y, move.to.y) - at.y)
        : 0;
      shadow.setAttribute("rx", String(Math.max(3, 11 - height * 0.035)));
      shadow.setAttribute(
        "opacity",
        hanging || pulling ? "0" : jumping ? ".10" : ".22",
      );
      shadow.setAttribute(
        "cy",
        String(jumping ? Math.max(move.from.y, move.to.y) - at.y + 1 : 1),
      );
    };
    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      const state = clock.current;
      state.elapsed += dt;
      if (now - paint >= 1000 / 30) {
        paint = now;
        if (connecting) {
          const time = state.elapsed;
          const kind = time < 1.35 ? "walk" : time < 1.8 ? "crouch" : "rest";
          draw(
            {
              kind,
              from: { x: 13, y: 43 },
              to: { x: kind === "walk" ? 119 : 13, y: 43 },
              seconds: 1.35,
            },
            kind === "walk"
              ? time / 1.35
              : kind === "crouch"
                ? (time - 1.35) / 0.45
                : 0,
          );
          // The outer group carries the cable toward the port; only joints move here.
          element.setAttribute("transform", "translate(13 43)");
        } else if (greeting) {
          const time = state.elapsed % 14;
          // A rare wave and a tiny grounded hop; the logo is otherwise quiet.
          const kind =
            time < 1.8
              ? "wave"
              : time < 2.04
                ? "crouch"
                : time < 2.49
                  ? "jump"
                  : time < 2.73
                    ? "land"
                    : "rest";
          const start =
            kind === "crouch"
              ? 1.8
              : kind === "jump"
                ? 2.04
                : kind === "land"
                  ? 2.49
                  : 0;
          const duration =
            kind === "jump"
              ? 0.45
              : kind === "crouch" || kind === "land"
                ? 0.24
                : 1.8;
          draw(
            {
              kind,
              from: { x: 20, y: 46 },
              to: { x: 20, y: 46 },
              seconds: duration,
            },
            time > 2.73 ? 0 : (time - start) / duration,
          );
        } else {
          while (state.elapsed >= state.plan[state.index].seconds) {
            state.elapsed -= state.plan[state.index].seconds;
            state.index++;
            if (state.index >= state.plan.length) {
              state.variant =
                (state.variant + 1 + Math.floor(Math.random() * 2)) % 3;
              state.plan = itinerary(state.variant);
              state.index = 0;
            }
          }
          const move = state.plan[state.index];
          draw(move, state.elapsed / move.seconds);
        }
      }
      if (!connecting || state.elapsed < 1.85)
        frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, greeting, connecting, visible]);
  return (
    <g
      ref={root}
      className="courier-actor"
      transform={
        connecting
          ? "translate(13 43)"
          : greeting
            ? "translate(20 46)"
            : "translate(78 210)"
      }
      data-action="rest"
      shapeRendering="crispEdges"
    >
      <ellipse
        className="actor-shadow"
        cy="1"
        rx="11"
        ry="2"
        fill="#050d08"
        opacity=".22"
      />
      <g fill="none" strokeWidth="4" strokeLinejoin="bevel">
        <path className="actor-leg" d="M-4 -9L-7 -4L-4 0" stroke="#a6bea7" />
        <path className="actor-leg" d="M4 -9L7 -4L4 0" stroke="#e0edd6" />
      </g>
      <g className="actor-body">
        <path d="M-17 -28H-12V-12H-17Z" fill="#618c70" />
        <path d="M-7 -21H8V-9H-7Z" fill="#88c7a1" />
        <path d="M-3 -19H4V-16H-3Z" fill="#d1f6d8" />
        <path
          d="M-9 -43H9V-39H13V-25H9V-21H-9V-25H-13V-39H-9Z"
          fill="#b9efd4"
        />
        <path d="M-9 -41H9V-38H-9Z" fill="#e2ffe6" />
        <path d="M-8 -35H8V-27H-8Z" fill="#173a2b" />
        <g className="actor-eyes" fill="#f1f3dd">
          <path d="M-5 -34H-2V-30H-5ZM3 -34H6V-30H3Z" />
        </g>
      </g>
      <g fill="none" strokeWidth="4" strokeLinejoin="bevel">
        <path
          className="actor-arm"
          d="M-8 -23L-12 -17L-11 -11"
          stroke="#8bcca8"
        />
        <path className="actor-arm" d="M8 -23L12 -17L11 -11" stroke="#b9efd4" />
      </g>
    </g>
  );
}
