export type PairLink = { url: string; code: string; name: string };

// Address-only QRs carry no credential. Keep the legacy pairing link for older hosts.
export function parsePairLink(raw: string): PairLink | null {
  try {
    const link = new URL(raw);
    if (
      link.protocol === "https:" &&
      link.hostname.endsWith(".ts.net") &&
      !link.username &&
      !link.password &&
      link.pathname === "/" &&
      !link.search &&
      !link.hash
    )
      return { url: link.origin, code: "", name: "your computer" };
    const target = (
      link.hostname || link.pathname.replace(/^\/+/, "")
    ).toLowerCase();
    if (link.protocol !== "reach:" || !["pair", "connect"].includes(target))
      return null;
    const code = link.searchParams.get("c") || "";
    const url = new URL(link.searchParams.get("u") || "");
    if (
      (target === "pair" && !/^\d{8}$/.test(code)) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      // Both kinds name a computer on the tailnet: a code sent anywhere else
      // would hand the pairing to whoever made the QR.
      !url.hostname.endsWith(".ts.net")
    )
      return null;
    return {
      url: url.origin,
      code: target === "connect" ? "" : code,
      name: (link.searchParams.get("n") || "your computer").slice(0, 80),
    };
  } catch {
    return null;
  }
}
