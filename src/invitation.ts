// Machine-share invitations, not dashboard or tailnet-membership links.
export function tailscaleShareUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" &&
      url.hostname === "login.tailscale.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/admin\/invite\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}
