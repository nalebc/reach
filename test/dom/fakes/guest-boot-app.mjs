import React from "react";
import { guestPeers } from "../../../src/api.ts";
// Only the post-auth workspace is inert. Real main/GuestRoot/GuestAccess and
// the credential-bearing device check decide which peer can reach this point.
export default function App() {
  return React.createElement("main", { "aria-label": "Opened guest workspace" },
    (guestPeers() || []).map(peer => peer.name).join(", "));
}
