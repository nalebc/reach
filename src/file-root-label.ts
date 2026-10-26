import type { Root } from "./api";

// The computer names the account's home folder "Home" (server/file-roots.mjs,
// and the new-chat folder picker finds it by that name), but the phone's tab
// bar has a Home tab too: two "Home"s on one screen. So Files shows it as the
// computer's own file browser does, by the folder's own name ("sam"),
// beside a house: Finder's sidebar on a Mac, the account folder's name in
// File Explorer on a PC. One rule for both, read from the root, never from
// the platform.
export const isHomeRoot = (root?: Pick<Root, "name">) => root?.name === "Home";

export function rootLabel(root?: Pick<Root, "name" | "path">) {
  if (!root) return "Shared folder";
  if (!isHomeRoot(root)) return root.name || "Shared folder";
  // "/Users/sam", "C:\Users\sam\": the last part, either separator.
  const own = (root.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  // No path to read (or the folder really is called "Home"): still not the tab's word alone.
  return own && own.toLowerCase() !== "home" ? own : "Home folder";
}
