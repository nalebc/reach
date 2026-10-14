import assert from "node:assert/strict";

export const nativeFiles = process.platform === "darwin";
export const unavailableFiles = process.platform === "win32"
  ? /Reach couldn't prepare its command sandbox on this Windows PC \(its private folder isn't ready\)/
  : /Protected agent file access is unavailable on this computer/;

// Real helper integration: unsupported hosts must fail closed, not silently use
// a pathname-based fallback. Keep auth/approval checks running on every host.
export function expectFileResponse(result, verify) {
  assert.equal(result.status, nativeFiles ? 200 : 503, JSON.stringify(result.body));
  if (nativeFiles) verify(result.body);
  else {
    assert.match(result.body.error, unavailableFiles);
    assert.equal(result.body.text, undefined);
    assert.equal(result.body.items, undefined);
  }
}

export function expectFileExecution(result, verify = () => {}) {
  assert.equal(result.status, nativeFiles ? "executed" : "failed", JSON.stringify(result));
  if (nativeFiles) verify(result);
  else {
    assert.match(result.error, unavailableFiles);
    assert.equal(result.output, undefined);
  }
}
