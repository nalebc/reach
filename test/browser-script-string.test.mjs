import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { scriptString } from "./helpers/script-string.mjs";

test("browser fixture literals retain data without closing a script or injecting code", () => {
  for (const value of ["ordinary text", "</script><script>globalThis.injected = true</script>",
    '\"; globalThis.injected = true; //', "quote\" slash\\ newline\n", "line\u2028paragraph\u2029end"]) {
    const literal = scriptString(value), context = {};
    assert.doesNotMatch(literal, /[<>\u2028\u2029]/);
    assert.equal(vm.runInNewContext(literal, context), value);
    assert.equal(context.injected, undefined);
  }
});
