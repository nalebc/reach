import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const run = promisify(execFile);

// Archives Files opens with one tap. The system tar (bsdtar on macOS and
// Windows 10+) reads all of them, and by default refuses absolute paths, "..",
// and writing through links, so nothing lands outside the new folder.
const suffixes = [".tar.gz", ".tar.bz2", ".tar.xz", ".zip", ".tar", ".tgz"];
export const archiveBase = (name) => {
  const lower = name.toLowerCase();
  const suffix = suffixes.find(
    (s) => lower.endsWith(s) && lower.length > s.length,
  );
  return suffix ? name.slice(0, -suffix.length) : null;
};

// "Photos", then "Photos 2", "Photos 3"… like Finder and the Files app.
async function freeName(dir, base) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    try {
      await fsp.lstat(path.join(dir, name));
    } catch (e) {
      if (e.code === "ENOENT") return name;
      throw e;
    }
  }
  throw Object.assign(new Error("Too many items with this name."), {
    status: 409,
  });
}

// Extracts next to the archive. One folder inside comes out as itself;
// anything else goes in a folder named after the archive. Returns its name.
export async function extractArchive(
  file,
  { tar = "tar", timeoutMs = 10 * 60_000 } = {},
) {
  const dir = path.dirname(file);
  const base = archiveBase(path.basename(file));
  if (!base)
    throw Object.assign(
      new Error("Only zip and tar archives can be opened here."),
      { status: 415 },
    );
  const staging = path.join(
    dir,
    `.reach-unzip-${crypto.randomBytes(6).toString("hex")}`,
  );
  await fsp.mkdir(staging);
  try {
    try {
      await run(
        tar,
        [
          "-xf",
          file,
          "-C",
          staging,
          "--exclude",
          "__MACOSX",
          "--exclude",
          "._*",
        ],
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
    } catch (e) {
      const detail = String(e.stderr || "")
        .trim()
        .split("\n")
        .at(-1);
      throw Object.assign(
        new Error(
          detail
            ? `Couldn’t open this archive: ${detail}`
            : "Couldn’t open this archive.",
        ),
        {
          status: 422,
        },
      );
    }
    const inside = (await fsp.readdir(staging)).filter(
      (n) => n !== ".DS_Store",
    );
    const single =
      inside.length === 1 &&
      (await fsp.lstat(path.join(staging, inside[0]))).isDirectory();
    const name = await freeName(dir, single ? inside[0] : base);
    await fsp.rename(
      single ? path.join(staging, inside[0]) : staging,
      path.join(dir, name),
    );
    return name;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}
