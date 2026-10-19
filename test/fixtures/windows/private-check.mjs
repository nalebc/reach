// Reach's private folders made and checked as a standard user, for the
// real-Windows peer check test only (test/windows-tailscaled-peer.test.mjs,
// case 11; docs/parity/D-public-door.md §4.5).
//
//   node private-check.mjs <out.json> <state folder> <data folder> <code folder>
//
// Writes { ok: true } or { ok: false, reason } to <out.json>.
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateFolders } from "../../../server/windows-private-folder.mjs";

const [out, state, data, code] = process.argv.slice(2);
try {
  const result = await ensurePrivateFolders({ protect: [state, data], check: [code], nativeDir: path.join(state, "native") });
  await result.dispose?.();
  fs.writeFileSync(out, JSON.stringify(result.ok ? { ok: true } : { ok: false, reason: result.reason }));
} catch (error) {
  fs.writeFileSync(out, JSON.stringify({ ok: false, reason: `private-check: ${error.message}` }));
}
