import fs from "node:fs";
import path from "node:path";

// `reach import <folder>`: bring the paired phones and settings of another
// Reach folder (a source checkout) into this one's state, so switching to the
// installed `reach` doesn't mean pairing again. Copies only what identifies
// this computer and its people; never paths, logs, locks, background-mode
// records or caches, which belong to where they were made.
const settings = ["preferences.json", "agent-policy.json"];
const data = [
  "clients.json",
  "device.json",
  "chats.json",
  "settings.json",
  "device-requests",
];

export function importState(from, to) {
  const source = fs.existsSync(path.join(from, ".reach"))
    ? path.join(from, ".reach")
    : from;
  if (path.resolve(source) === path.resolve(to))
    throw Error("That is this Reach's own settings folder.");
  if (
    !fs.existsSync(path.join(source, "preferences.json")) &&
    !fs.existsSync(path.join(source, "quick", "clients.json"))
  )
    throw Error(`No Reach settings were found in ${from}.`);
  if (
    fs.existsSync(path.join(to, "preferences.json")) ||
    fs.existsSync(path.join(to, "quick", "clients.json"))
  )
    throw Error(
      `${to} already has Reach settings, so nothing was copied. To replace them, stop Reach, rename that folder (for example to ${path.basename(to)}.old), then run the import again.`,
    );
  const copied = [];
  const copy = (file, target) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(file))
        copy(path.join(file, name), path.join(target, name));
    } else if (stat.isFile()) {
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
    }
  };
  fs.mkdirSync(path.join(to, "quick"), { recursive: true, mode: 0o700 });
  fs.chmodSync(to, 0o700);
  fs.chmodSync(path.join(to, "quick"), 0o700);
  for (const name of settings)
    if (fs.existsSync(path.join(source, name))) {
      copy(path.join(source, name), path.join(to, name));
      copied.push(name);
    }
  for (const name of data)
    if (fs.existsSync(path.join(source, "quick", name))) {
      copy(path.join(source, "quick", name), path.join(to, "quick", name));
      copied.push(`quick/${name}`);
    }
  return copied;
}
