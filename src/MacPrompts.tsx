import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import type { MacPrompt } from "./agent-sessions";
import "./mac-prompts.css";

// A dialog from macOS itself (a privacy prompt, a security warning, a password
// request), drawn as macOS draws it: its icon, its message in bold, the rest,
// and its buttons. It is answered at the Mac: these grant privacy access,
// which macOS leaves to a person there, so its buttons can't be pressed here.
// compact: one slim line (where other things come first, like Chat); a tap
// opens the dialog.
export default function MacPromptCard({
  prompt,
  logos,
  compact = false,
}: {
  prompt: MacPrompt;
  logos: AgentLogos;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(!compact);
  const [message = prompt.title, ...rest] = prompt.lines?.length ? prompt.lines : [prompt.title];
  const info = prompt.lines?.length ? rest.join(" ") : prompt.detail;
  if (!open)
    return (
      <button className={`mac-prompt-row ${prompt.kind}`} aria-expanded={false} onClick={() => setOpen(true)}>
        <AgentLogo agent="macos" name="macOS" logos={logos} size={24} />
        <span>
          <strong>Your Mac is asking</strong>
          <small>{message}</small>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
    );
  return (
    <section className={`mac-prompt ${prompt.kind}`} aria-label="Your Mac is asking">
      <header>
        <AgentLogo agent="macos" name="macOS" logos={logos} size={16} />
        <strong>Your Mac is asking</strong>
      </header>
      {!prompt.lines?.length && prompt.image ? (
        // Only its picture (macOS didn't expose its text): the dialog itself.
        <img className="mac-prompt-image" src={prompt.image} alt="" />
      ) : (
        <div className="mac-dialog">
          <AgentLogo agent="macos" name="macOS" logos={logos} size={52} />
          <p className="mac-dialog-message">{message}</p>
          {info && <p className="mac-dialog-info">{info}</p>}
          {!!prompt.buttons?.length && (
            <div className="mac-dialog-buttons" aria-hidden="true">
              {prompt.buttons.map((b) => (
                <span key={b} className={b === prompt.default ? "default" : ""}>
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="mac-prompt-note">Answer it on your Mac.</p>
    </section>
  );
}
