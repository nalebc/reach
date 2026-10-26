import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import "./mobile-nav.css";

export type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  // Sessions waiting for an answer.
  badge?: number;
};

// Every item opens a destination. Tool pages belong to the Tools section.
export default function MobileNav({
  items,
  current,
  onNavigate,
}: {
  items: NavItem[];
  current: string;
  onNavigate: (id: string) => void;
}) {
  const layout = JSON.stringify(items.map((item) => item.id));
  const press = useRef<{
    pointer: number;
    button: HTMLButtonElement;
    id: string | null;
    layout: string;
    x: number;
    y: number;
    ended: boolean;
    cancelled: boolean;
  } | null>(null);
  const trackMove = (event: PointerEvent<HTMLElement>) => {
    const held = press.current;
    if (held?.pointer === event.pointerId &&
        Math.hypot(event.clientX - held.x, event.clientY - held.y) > 10)
      held.cancelled = true;
  };
  const section =
    current === "overview" || current === "screen" ? current : "tools";
  const tab = Math.max(
    0,
    items.findIndex((item) => item.id === section),
  );
  return (
    <nav
      className="mobile-nav"
      aria-label="Main navigation"
      data-tab={tab}
      style={{ "--tab": tab, "--tabs": items.length } as CSSProperties}
      onPointerDownCapture={(event) => {
        if (!event.isPrimary || event.button !== 0) {
          if (press.current) press.current.cancelled = true;
          return;
        }
        const button = (event.target as Element).closest<HTMLButtonElement>("button");
        if (button?.parentElement !== event.currentTarget) return;
        press.current = {
          pointer: event.pointerId, button, id: button.getAttribute("data-nav-id"),
          layout, x: event.clientX, y: event.clientY, ended: false, cancelled: false,
        };
      }}
      onPointerMoveCapture={trackMove}
      onPointerUpCapture={(event) => {
        trackMove(event);
        if (press.current?.pointer === event.pointerId) press.current.ended = true;
      }}
      onPointerCancelCapture={() => { if (press.current) press.current.cancelled = true; }}
      onClickCapture={(event) => {
        const held = press.current;
        press.current = null;
        // Keyboard/assistive/programmatic clicks have their own explicit
        // target, independent of any old pointer gesture.
        if (!event.detail || !held) return;
        const clicked = (event.target as Element).closest("button");
        const available = held.id !== null &&
          (items.some((item) => item.id === held.id) && event.currentTarget.contains(held.button));
        if (held.cancelled || !held.ended || !available ||
            (held.layout === layout && clicked !== held.button)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (held.layout !== layout) {
          // Chrome can hit-test the compatibility click after touchend. If
          // capabilities arrived meanwhile, keep the pressed action, using
          // current access and handlers instead of the new coordinate target.
          event.preventDefault();
          event.stopPropagation();
          if (held.id !== null) onNavigate(held.id);
        }
      }}
    >
      {items.map((item) => (
        <button
          className={section === item.id ? "active" : ""}
          aria-label={item.label}
          aria-current={section === item.id ? "page" : undefined}
          key={item.id}
          data-nav-id={item.id}
          onClick={() => onNavigate(item.id)}
        >
          {item.icon}
          {!!item.badge && (
            <i className="nav-badge" aria-label={`${item.badge} waiting`}>
              {item.badge}
            </i>
          )}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
