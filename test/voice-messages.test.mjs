import test from "node:test";
import assert from "node:assert/strict";
import { partLabel, partLabels } from "../server/agent-sessions/message-parts.mjs";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { codexItem } from "../server/agent-sessions/codex.mjs";
import { geminiItems } from "../server/agent-sessions/gemini.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { audioKind, createVoice, memoName } from "../server/agent-sessions/voice.mjs";

// Dictation in the Claude and ChatGPT apps arrives as text. A voice note an
// agent took as is (a channel's voice note, Gemini's inline audio) or a PDF
// arrives as a piece of its own; a message of only that vanished from the
// chat, and an odd shape could break the history.
const ID = "11111111-2222-4333-8444-555555555555";
const base = { sessionId: ID, cwd: "/work", entrypoint: "cli" };
const at = (s) => new Date(Date.UTC(2026, 9, 7, 9, 0, s)).toISOString();
const line = (o) => JSON.stringify(o);

test("pieces are named by what they are, in each agent's shape", () => {
  assert.equal(partLabel({ type: "audio", source: { type: "base64", media_type: "audio/m4a", data: "AA==" } }), "Voice message");
  assert.equal(partLabel({ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }), "Voice message");
  assert.equal(partLabel({ inlineData: { mimeType: "audio/ogg", data: "AA==" } }), "Voice message");
  assert.equal(partLabel({ type: "video" }), "Video");
  assert.equal(partLabel({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA==" } }), "PDF");
  assert.equal(partLabel({ type: "document", source: { type: "text", media_type: "text/plain", data: "hi" } }), "Document");
  assert.equal(partLabel({ type: "input_file", filename: "notes.txt" }), "File");
  for (const plain of [{ type: "text", text: "hi" }, { type: "image" }, { type: "localImage", path: "/a.png" }, { type: "skill", name: "x.pdf" }, { type: "tool_use", name: "Read" }, { text: "hi" }, null, "text", 4])
    assert.equal(partLabel(plain), null);
  assert.deepEqual(partLabels("just words"), []);
  assert.deepEqual(partLabels({ type: "audio" }), []);
});

test("Claude Code: a voice note or PDF shows on its message, alone or with words, and odd content never breaks the chat", () => {
  const text = [
    line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: [{ type: "audio", source: { type: "base64", media_type: "audio/mp4", data: "AA==" } }] } }),
    line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at(2), message: { content: [{ type: "text", text: "Heard it." }] } }),
    line({ ...base, type: "user", uuid: "u2", parentUuid: "a1", timestamp: at(3), message: { role: "user", content: [{ type: "text", text: "Read this" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AA==" } }] } }),
    line({ ...base, type: "user", uuid: "u3", parentUuid: "u2", timestamp: at(4), message: { role: "user", content: { type: "audio" } } }),
    line({ ...base, type: "user", uuid: "u4", parentUuid: "u3", timestamp: at(5), message: { role: "user", content: [{ type: "text", text: { not: "a string" } }, { type: "text", text: "Still here" }] } }),
    line({ ...base, type: "attachment", uuid: "q1", parentUuid: "u4", timestamp: at(6), attachment: { type: "queued_command", humanTurn: true, prompt: [{ type: "audio", source: { media_type: "audio/webm" } }] } }),
    line({ ...base, type: "assistant", uuid: "a2", parentUuid: "q1", timestamp: at(7), message: { content: [{ type: "text", text: "Got both." }] } }),
  ].join("\n");
  const { items } = parseClaudeTranscript(text);
  assert.deepEqual(
    items.filter((i) => i.role === "user").map((i) => [i.text, i.attachments || []]),
    [
      ["", ["Voice message"]],
      ["Read this", ["PDF"]],
      ["Still here", []],
      ["", ["Voice message"]],
    ],
  );
  assert.ok(items.every((i) => typeof i.text === "string" && !i.text.includes("[object Object]")));
});

test("Codex: a message of only a voice note is kept and named; content that isn't a list doesn't throw", () => {
  const voice = codexItem({ item: { type: "userMessage", id: "m1", content: [{ type: "input_audio", input_audio: { data: "AA==", format: "wav" } }] }, turnId: "t" });
  assert.equal(voice.text, "");
  assert.deepEqual(voice.attachments, ["Voice message"]);
  const mixed = codexItem({ item: { type: "userMessage", id: "m2", content: [{ type: "text", text: "Fix it" }, { type: "localImage", path: "/a.png" }, { type: "mention", name: "x" }] }, turnId: "t" });
  assert.equal(mixed.text, "Fix it");
  assert.equal(mixed.images, 1);
  assert.equal(mixed.attachments, undefined);
  assert.equal(codexItem({ item: { type: "userMessage", id: "m3", content: { type: "audio" } }, turnId: "t" }), null);
  assert.equal(codexItem({ item: { type: "userMessage", id: "m4", content: "words" }, turnId: "t" }), null);
});

test("Gemini: inline audio is a voice message, pictures still count as pictures", () => {
  const items = geminiItems([
    { id: "u1", type: "user", timestamp: at(1), content: [{ inlineData: { mimeType: "audio/ogg", data: "AA==" } }] },
    { id: "u2", type: "user", timestamp: at(2), content: [{ text: "Look" }, { inlineData: { mimeType: "image/png", data: "AA==" } }] },
  ]);
  assert.deepEqual(items.map((i) => [i.text, i.images || 0, i.attachments || []]), [
    ["", 0, ["Voice message"]],
    ["Look", 1, []],
  ]);
});

// A memo recorded in the composer: its words come back to read over; when it
// can't become words, the reason, so the recording is attached instead.

test("recordings are known by their bytes, not their name", () => {
  const head = (s, pad = 16) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.alloc(pad)]).subarray(0, pad);
  assert.equal(audioKind(head("RIFF\0\0\0\0WAVE")), "wav");
  assert.equal(audioKind(head("\0\0\0\x18ftypM4A ")), "m4a");
  assert.equal(audioKind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), "webm");
  assert.equal(audioKind(head("OggS")), "ogg");
  assert.equal(audioKind(head("ID3")), "mp3");
  assert.equal(audioKind(head("%PDF-1.7")), null);
  assert.equal(audioKind(head("")), null);
  assert.equal(memoName("wav", new Date(Date.UTC(2026, 9, 7, 9, 5))), "voice-memo-2026-10-07-09-05.wav");
});

test("a memo never fails: words, or the reason there are none", async () => {
  const ok = createVoice({ platform: "darwin", binary: async () => "/helper", exec: async (_f, args) => ({ stdout: JSON.stringify({ text: ` hi ${args[1] || ""} ` }) }) });
  assert.deepEqual(await ok.transcribe("/a.wav", { locale: "fr-FR" }), { text: "hi fr-FR" });
  // A locale that isn't one is left out, not passed to the helper.
  assert.deepEqual(await ok.transcribe("/a.wav", { locale: "--evil" }), { text: "hi" });
  const silent = createVoice({ platform: "darwin", binary: async () => "/helper", exec: async () => ({ stdout: '{"text":""}' }) });
  assert.match((await silent.transcribe("/a.wav")).problem, /No words/);
  const old = createVoice({ platform: "darwin", binary: async () => "/helper", exec: async () => { throw Object.assign(new Error("exit 1"), { stderr: "Transcribing needs macOS 26 or later.\n" }); } });
  assert.deepEqual(await old.transcribe("/a.wav"), { problem: "Transcribing needs macOS 26 or later." });
  const slow = createVoice({ platform: "darwin", binary: async () => "/helper", exec: async () => { throw Object.assign(new Error("t"), { killed: true }); } });
  assert.match((await slow.transcribe("/a.wav")).problem, /too long/);
  const noTools = createVoice({ platform: "darwin", binary: async () => { throw new Error("no xcrun"); } });
  assert.match((await noTools.transcribe("/a.wav")).problem, /Command Line Tools/);
  const garbled = createVoice({ platform: "darwin", binary: async () => "/helper", exec: async () => ({ stdout: "not json" }) });
  assert.ok((await garbled.transcribe("/a.wav")).problem);
  assert.match((await createVoice({ platform: "win32" }).transcribe("/a.wav")).problem, /on a Mac/);
});

const macOS = process.platform === "darwin" ? Number(execFileSync("sw_vers", ["-productVersion"]).toString().split(".")[0]) : 0;
test("on this Mac, a spoken memo becomes its words", { skip: (macOS < 26 && "needs macOS 26") || (process.env.CI && "downloads a speech model"), timeout: 300000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-voice-"));
  try {
    const aiff = path.join(dir, "memo.aiff");
    const wav = path.join(dir, "memo");
    execFileSync("say", ["-o", aiff, "Please run the tests"]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    const voice = createVoice({ config: { dataDir: dir } });
    const heard = await voice.transcribe(wav, { locale: "en-US" });
    assert.match(heard.text || heard.problem, /run the tests/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
