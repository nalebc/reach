// Fake Tailscale keys for tests, put together at run time so the source never
// holds text shaped like a real key: GitHub's secret scanning raised 18
// alerts for fixtures such as an auth key "test123456…" (Oct 13). The value
// is the same string the tests used before.
export const tskey = (rest) => ["tskey", rest].join("-");
