import type { ReactNode } from "react";
import { BrandCourier } from "./ReachIdentity";
import "./chat-companion.css";

// A quiet bit of Reach's identity, shared by the chat home views. The mascot
// is decorative; provider logos and health indicators keep their own meaning.
export function ChatCompanion({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="chat-companion">
      <span className="chat-companion-art" aria-hidden="true">
        <BrandCourier />
        <i />
        <i />
        <i />
      </span>
      <div className="chat-companion-copy">
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}
