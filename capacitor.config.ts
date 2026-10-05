import type { CapacitorConfig } from "@capacitor/cli";

// The native shell loads the companion's own interface from its private Tailscale
// address, so pairing, cookies-free bearer auth, and WebSockets stay same-origin.
const url = process.env.REACH_APP_URL;
if (!url) throw new Error("Set REACH_APP_URL to the companion's https://….ts.net:8443 address.");

const config: CapacitorConfig = {
  appId: process.env.REACH_APP_ID || "com.example.reach",
  appName: "Reach",
  webDir: "dist",
  server: { url, cleartext: false },
  ios: { contentInset: "never", backgroundColor: "#101512" },
};

export default config;
