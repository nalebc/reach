// Independent pinned harness; never copied into the builder's permitted src.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
try {
  const { total } = await import(pathToFileURL(process.argv[2]).href);
  for (const [a, b, expected] of [[2, 3, 5], [0, 0, 0], [-2, 1, -1], [1.5, 2.5, 4]]) {
    assert.equal(total(a, b), expected, `total(${a}, ${b})`);
  }
  process.stdout.write(JSON.stringify({ cases: 4, passed: true }));
} catch {
  // Keep runtime paths and stack traces out of fixture evidence/reports.
  process.stdout.write(JSON.stringify({ cases: 4, passed: false }));
  process.exitCode = 1;
}
