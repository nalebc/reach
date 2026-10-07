import crypto from "node:crypto";

// Short-lived download links, so a browser can hand a large file to its own
// download manager (progress, background, resume) without the app holding it
// in memory. A link names one file, expires in minutes, lives only in this
// process's memory, and remembers just the hash of the credential that asked
// for it: every use re-checks that credential and the device behind it.
export function createLinks({ ttl = 10 * 60 * 1000, max = 500 } = {}) {
  const links = new Map();
  const sweep = setInterval(() => {
    for (const [token, link] of links)
      if (link.expires <= Date.now()) links.delete(token);
  }, 60 * 1000);
  sweep.unref();
  return {
    issue(details) {
      if (links.size >= max) links.delete(links.keys().next().value);
      const token = crypto.randomBytes(32).toString("base64url");
      links.set(token, { ...details, expires: Date.now() + ttl });
      return token;
    },
    find(token) {
      const link = typeof token === "string" ? links.get(token) : undefined;
      if (!link) return null;
      if (link.expires <= Date.now()) {
        links.delete(token);
        return null;
      }
      return link;
    },
  };
}
