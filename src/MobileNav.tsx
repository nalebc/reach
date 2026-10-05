import type { CSSProperties, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
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
  const index = items.findIndex((item) => item.id === current);
  const tab = index >= 0 ? index : items.length;
  return (
    <nav
      className="mobile-nav"
      aria-label="Main navigation"
      data-tab={tab}
      style={{ "--tab": tab, "--tabs": items.length + 1 } as CSSProperties}
    >
      {items.map((item) => (
        <button
          className={current === item.id ? "active" : ""}
          aria-label={item.label}
          aria-current={current === item.id ? "page" : undefined}
          key={item.id}
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
        <MoreHorizontal size={20} />
        <span>More</span>
      </button>
    </nav>
  );
}
