// Readiness for reopening the interface, not an authorization check. Require
// the complete document and its boot entry, rather than any nonempty body.
export function interfaceDocument(html: string) {
  if (!/<\/body\s*>/i.test(html) || !/<\/html\s*>/i.test(html)) return false;
  const page = new DOMParser().parseFromString(html, "text/html");
  return !!page.querySelector("#root, #start") &&
    [...page.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].some(script =>
      /^\/(?:assets\/[^/?#]+\.js|src\/(?:boot|start)\.ts|src\/funnel-agent-entry\.tsx)(?:[?#].*)?$/.test(script.getAttribute("src") || ""));
}
