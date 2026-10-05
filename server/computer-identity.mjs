import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import crypto from "node:crypto";
const exec = promisify(execFile);

export function identityDigest(value, platform) {
  const normalized = value?.trim().toLowerCase();
  if (
    !normalized ||
    !/^[a-f0-9-]{16,64}$/.test(normalized) ||
    /^0[-0]*$/.test(normalized)
  )
    return null;
  // Never expose the OS identifier itself. This identifier is not an auth secret.
  return crypto
    .createHash("sha256")
    .update(`reach:computer:v1:${platform}:${normalized}`)
    .digest("hex");
}

let lookup;
export function computerIdentity() {
  if (!lookup)
    lookup = (async () => {
      try {
        const options = {
          timeout: 5000,
          maxBuffer: 256 * 1024,
          windowsHide: true,
        };
        if (process.platform === "darwin") {
          const { stdout } = await exec(
            "/usr/sbin/ioreg",
            ["-rd1", "-c", "IOPlatformExpertDevice"],
            options,
          );
          return identityDigest(
            /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1],
            "darwin",
          );
        }
        if (process.platform === "win32") {
          const { stdout } = await exec(
            "reg.exe",
            [
              "query",
              "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
              "/v",
              "MachineGuid",
              "/reg:64",
            ],
            options,
          );
          return identityDigest(
            /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1],
            "win32",
          );
        }
        if (process.platform === "linux")
          return identityDigest(
            await fs.readFile("/etc/machine-id", "utf8"),
            "linux",
          );
      } catch {
        /* Keep the existing installation identity if OS identity is unavailable. */
      }
      return null;
    })();
  return lookup;
}
