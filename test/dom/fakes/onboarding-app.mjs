import React from "react";
import ConnectForm from "../../../src/ConnectForm.tsx";

// Only the workspace after connecting is replaced. The real main entry,
// ConnectForm, browser transport and server handle sign-in and approval.
export default function App() {
  return React.createElement(ConnectForm, {
    name: "New phone",
    onPaired: peer => globalThis.__onboardingPaired(peer),
    legacy: () => React.createElement("p", null, "Legacy pairing"),
  });
}
