// The choices exactly as the agent offered them, in plain words (the chat's
// prompt cards and the Needs-you strip say them the same way).
export const DECISIONS: Record<string, string> = {
  accept: "Yes",
  acceptForSession: "Yes, for this session",
  acceptWithExecpolicyAmendment: "Yes, always allow this",
  decline: "No",
  cancel: "No, and stop",
  allowAlways: "Yes, and don't ask again",
  approved: "Yes",
  approved_for_session: "Yes, for this session",
  abort: "No, and stop",
  allow: "Allow",
  deny: "Deny",
};
// Claude Code's permission dialog words it its own way.
export const CLAUDE_DECISIONS: Record<string, string> = { allow: "Yes", allowAlways: "Yes, and don't ask again", deny: "No" };
