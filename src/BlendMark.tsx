import { useId } from "react";
import type { AgentLogos } from "./agent-logos";
import "./blend-mark.css";

// One mark for "the AI apps": the big three together, each one recognizable,
// overlapping like friends in a photo. Claude's and Codex's real icons (read
// from the apps on the Mac); Gemini as its app icon looks, its colored star on
// white (no Gemini app on the Mac to read it from). Without an app's icon: its
// colors and a simple stand-in, never an empty circle.
export default function BlendMark({ logos, size = 28 }: { logos: AgentLogos; size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <span className="blend-mark" style={{ width: size, height: size }} aria-hidden="true">
      <span className="bm-one bm-gemini">
        <svg viewBox="0 0 24 24">
          <defs>
            <linearGradient id={`${id}-g`} x1="4" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#1c7dff" />
              <stop offset="0.55" stopColor="#9168c0" />
              <stop offset="1" stopColor="#d96570" />
            </linearGradient>
          </defs>
          <path
            d="M12 3C12.5 7.8 16.2 11.5 21 12C16.2 12.5 12.5 16.2 12 21C11.5 16.2 7.8 12.5 3 12C7.8 11.5 11.5 7.8 12 3Z"
            fill={`url(#${id}-g)`}
          />
        </svg>
      </span>
      <span className="bm-one bm-claude">
        {logos.claude ? (
          <img src={logos.claude} alt="" draggable={false} />
        ) : (
          <svg viewBox="0 0 24 24">
            <path
              d="M12 5V19M5 12H19M7 7L17 17M17 7L7 17"
              stroke="#fff"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
      <span className="bm-one bm-codex">
        {logos.codex ? (
          <img src={logos.codex} alt="" draggable={false} />
        ) : (
          <svg viewBox="0 0 24 24">
            <path
              d="M7 9L10 12L7 15M12 15H17"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </span>
  );
}
