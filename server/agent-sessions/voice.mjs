// A voice memo recorded in a chat's composer, as words. The agents take text
// and pictures, not sound, so a memo becomes words on this Mac (on-device,
// scripts/native/transcribe.swift) and goes back to the composer to read
// over before sending. When that can't happen (an older macOS, Windows, a
// format the Mac can't read), the recording is kept as a file to attach:
// a memo is never lost.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { desktopBinary } from "../desktop-native.mjs";
import { fail } from "../core.mjs";

const run = promisify(execFile);
// Shared across instances and users, including helper preparation. Native
// speech work can last three minutes; reject excess work without queueing it.
const MAX_TRANSCRIPTIONS = 2;
let transcriptions = 0;
// Only fixed helper diagnostics may cross into a chat response. Other stderr
// can contain filenames, URLs or speech framework exception details.
const KNOWN_PROBLEMS = new Set([
  "Transcribing needs macOS 26 or later.",
  "This Mac has no speech model for this language.",
  "This recording's format can't be read on the Mac.",
]);
const TRANSCRIPTION_PROBLEM = "This Mac couldn't transcribe the memo. Keep the recording attached, or try again on macOS 26 or later.";
const LOCALE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,3}$/;

// What the recording is, from its first bytes (the name and type a phone
// sends can't be trusted to match).
export function audioKind(head) {
  const text = (start, end) => head.subarray(start, end).toString("latin1");
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "wav";
  if (text(4, 8) === "ftyp") return "m4a";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (text(0, 4) === "OggS") return "ogg";
  if (text(0, 4) === "caff") return "caf";
  if (text(0, 4) === "FORM" && /^AIF[FC]$/.test(text(8, 12))) return "aiff";
  if (text(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "mp3";
  return null;
}

// The recording's file name, with the extension its bytes say; no spaces,
// as agents read "@path" up to the first one.
export const memoName = (kind, now = new Date()) =>
  `voice-memo-${now.toISOString().slice(0, 16).replace(/[T:]/g, "-")}.${kind}`;

export function createVoice({ config, platform = process.platform, binary = (signal) => desktopBinary(config, "transcribe", { signal }), exec = run } = {}) {
  return {
    // { text } with the words, or { problem } saying why there are none.
    async transcribe(file, { locale, authorize = () => {} } = {}) {
      authorize();
      if (platform !== "darwin") return { problem: "Voice memos turn into words on a Mac." };
      if (transcriptions >= MAX_TRANSCRIPTIONS)
        throw fail(429, "Two voice memos are already transcribing. Try again when one finishes.");
      transcriptions++;
      try {
        let helper;
        try {
          helper = await binary();
        } catch {
          return { problem: "This Mac couldn't prepare voice transcription. Install Apple Command Line Tools." };
        }
        // Compilation can take time. Do not start native work after the request
        // has expired, disconnected or been revoked; never turn this into a
        // fallback attachment by swallowing the authority refusal.
        authorize();
        const args = [file, ...(typeof locale === "string" && LOCALE.test(locale) ? [locale] : [])];
        let stdout;
        try {
          // The first memo in a language downloads its model: give it time.
          ({ stdout } = await exec(helper, args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }));
        } catch (error) {
          authorize();
          const said = String(error?.stderr || "").trim().split("\n").pop();
          return { problem: error?.killed
            ? "Transcribing took too long. Keep the recording attached or try a shorter memo."
            : KNOWN_PROBLEMS.has(said) ? said : TRANSCRIPTION_PROBLEM };
        }
        authorize();
        try {
          const out = JSON.parse(String(stdout).trim().split("\n").pop() || "{}");
          const text = typeof out.text === "string" ? out.text.trim() : "";
          return text ? { text } : { problem: "No words were heard in that memo." };
        } catch {
          return { problem: TRANSCRIPTION_PROBLEM };
        }
      } finally {
        transcriptions--;
      }
    },
  };
}

export function readHead(file, size = 16) {
  const head = Buffer.alloc(size);
  const fd = fs.openSync(file, "r");
  try {
    return head.subarray(0, fs.readSync(fd, head, 0, size, 0));
  } finally {
    fs.closeSync(fd);
  }
}
