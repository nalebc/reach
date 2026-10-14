import { memo } from "react";
import { mascotFor, mascotRects } from "./mascots";
import "./mascot.css";

// The face of an agent or person you invited (mascots.ts): the one drawn for
// it, the same wherever it shows. It fills what holds it, round or rounded,
// and takes that shape.
export const Mascot = memo(function Mascot({ id, drawn }: { id: string; drawn?: number }) {
  const mascot = mascotFor(id, drawn);
  return (
    <svg className="mascot" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      <rect width="16" height="16" fill={mascot.bg} />
      {mascotRects(mascot).map((r) => (
        <rect key={`${r.x}.${r.y}`} x={r.x} y={r.y} width={r.w} height="1" fill={r.fill} />
      ))}
    </svg>
  );
});
