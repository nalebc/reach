// A string literal safe for generated browser code, including when the same
// code is embedded in an HTML script element by a synthetic fixture.
export function scriptString(value) {
  if (typeof value !== "string") throw TypeError("A browser script string must be text.");
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g,
    character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
