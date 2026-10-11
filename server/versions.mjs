// Semantic versions: reading one strictly, and their order. Used for the
// coding agents' updates (agent-updates.mjs) and Reach's own (reach-updates.mjs).

// Semantic versions only ("2.1.295", "0.162.0-alpha.2"), whole and short.
const SEMVER = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function parseVersion(text) {
  if (typeof text !== "string" || text.length > 100) return null;
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : [];
  // Numeric identifiers with leading zeros aren't semver: not guessed at.
  if (pre.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre, text: text.trim().replace(/^v/, "") };
}
// -1, 0 or 1; null when either isn't a version. A prerelease comes before
// its release (0.162.0-alpha.2 < 0.162.0); numeric parts compare as numbers
// (alpha.10 > alpha.2); build metadata is ignored.
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
