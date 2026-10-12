import { useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import "./sub-page.css";

// A page pushed in place from a chevron row (Agents & people: Ended,
// Shortcuts, Services, one ended agent): a back chevron with the page's one
// action across from it, then the title, as Notifications looks on a phone.
// Back is the browser's (history.back), so the on-screen chevron, a swipe in
// Safari and Android's back are one path.
export default function SubPage({
  title,
  backLabel,
  onBack,
  action,
  children,
}: {
  /** Without it the page brings its own <h1> (a hero, say). */
  title?: string;
  backLabel: string;
  onBack: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const page = useRef<HTMLElement>(null);
  // The page's title takes focus on arrival, without scrolling.
  useEffect(() => {
    page.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="sub-page" ref={page} aria-label={title}>
      <div className="sub-page-bar">
        <button type="button" className="sub-page-back" aria-label={backLabel} onClick={onBack}>
          <ChevronLeft size={26} />
        </button>
        {action}
      </div>
      {title && <h1 tabIndex={-1}>{title}</h1>}
      {children}
    </section>
  );
}
