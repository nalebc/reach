import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import "./mobile-nav.css";

export type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  // Sessions waiting for an answer.
  badge?: number;
};

// The phone's bottom bar: a floating glass capsule, the page you're on in a
// soft pill that glides between tabs. A page that lives under More lights More.
export default function MobileNav({
  items,
  current,
  moreOpen,
  onNavigate,
  onMore,
}: {
  items: NavItem[];
  current: string;
  moreOpen: boolean;
  onNavigate: (id: string) => void;
  onMore: () => void;
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
  const index = items.findIndex((item) => item.id === current);
  const tab = index >= 0 ? index : items.length;
  return (
    <nav
      className="mobile-nav"
      aria-label="Main navigation"
      data-tab={tab}
      style={{ "--tab": tab, "--tabs": items.length + 1 } as CSSProperties}
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
        const available = held.id === null ||
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
          if (held.id === null) onMore();
          else onNavigate(held.id);
        }
      }}
    >
      {items.map((item) => (
        <button
          className={current === item.id ? "active" : ""}
          aria-label={item.label}
          aria-current={current === item.id ? "page" : undefined}
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
      <button
        className={tab === items.length ? "active" : ""}
        aria-label="More workspace options"
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        <Ellipsis size={20} />
        <span>More</span>
      </button>
    </nav>
  );
}
