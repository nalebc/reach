import { ExternalLink } from "lucide-react";
import ChatSheet from "./ChatSheet";
import { ComputerIcon } from "./AppIcon";
import "./waiting-computer.css";

// Another of your Reach computers, seen on your Tailscale account but not
// linked with this one. Tapped, it was a passing note about two terminal
// commands; now it opens at its own address (this phone is approved there
// already, or asks there once), and says how to keep both in one list.
export type WaitingComputer = {
  origin: string;
  name: string;
  short?: string;
  linked?: boolean;
};

const shortName = (url: string) => {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
};

export default function WaitingComputerSheet({
  computer,
  here,
  onClose,
}: {
  computer: WaitingComputer;
  here: { name: string; url: string };
  onClose: () => void;
}) {
  const there = computer.short || shortName(computer.origin);
  const back = shortName(here.url);
  return (
    <ChatSheet
      title={computer.name}
      className="waiting-computer"
      leading={<ComputerIcon size="small" />}
      onClose={onClose}
    >
      <p className="waiting-computer-state">
        {computer.linked ? `Linked. Joins ${here.name}'s list when it answers.` : `Not linked to ${here.name} yet.`}
      </p>
      <a
        className="waiting-computer-open"
        href={computer.origin}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>Open {computer.name}</span>
        <ExternalLink size={17} aria-hidden="true" />
      </a>
      {!computer.linked && (
        <section className="waiting-computer-link" aria-label="Keep both here">
          <h3>Keep both here</h3>
          <p>Type in Reach's terminal on each:</p>
          <dl>
            <dt>{here.name}</dt>
            <dd>
              <code>link {there}</code>
            </dd>
            <dt>{computer.name}</dt>
            <dd>
              <code>link {back}</code>
            </dd>
          </dl>
        </section>
      )}
    </ChatSheet>
  );
}
