// This fixed interpreter is the only JavaScript sent to a browser. Definitions
// supply data and selectors, never source code. Keep this function self-contained.
export function toolPageOperation(request) {
  const fail = (code, message) => {
    throw Object.assign(Error(message), { code });
  };
  const normalized = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  const here = new URL(location.href);
  if (
    request.op === "bind" &&
    (document.readyState === "loading" || location.href === "about:blank")
  )
    return JSON.stringify({
      error: "The requested page is still loading.",
      code: "loading",
    });
  if (!request.origins.includes(here.origin))
    return JSON.stringify({
      error: "The page left the tool's allowed websites.",
      code: "wrong_site",
    });
  if (
    request.op === "bind" &&
    request.expectedURL &&
    location.href !== request.expectedURL
  )
    return JSON.stringify({
      error: "The requested document has not arrived.",
      code: "loading",
    });
  if (
    (request.protectedTitles || []).some((word) =>
      document.title.toLowerCase().includes(word),
    )
  )
    return JSON.stringify({
      error: "This browser page is protected.",
      code: "protected",
    });
  try {
    const secure = (element) =>
      element.closest?.(
        "input[type=password], [autocomplete=current-password], [autocomplete=new-password], [autocomplete=one-time-code]",
      );
    const visible = (element) => {
      if (secure(element)) return false;
      for (let at = element; at && at.nodeType === 1; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (
          at.hidden ||
          at.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          return false;
      }
      return !!element.getClientRects().length;
    };
    // Walmart keeps the purchase-history URL for its signed-out tracking form.
    // Match its visible sign-in panel, not the account menu or a hidden template.
    if (
      here.hostname === "www.walmart.com" &&
      /^\/orders(?:\/|$)/.test(here.pathname) &&
      [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].some(
        (element) =>
          visible(element) &&
          normalized(element.textContent) ===
            "Sign in to do more with your account",
      ) &&
      [...document.querySelectorAll('button,[role="button"]')].some(
        (element) =>
          visible(element) &&
          normalized(
            element.getAttribute("aria-label") || element.textContent,
          ) === "Sign in or create account",
      )
    )
      return JSON.stringify({
        error:
          "The owner needs to sign in to Walmart in this browser, then run the tool again.",
        code: "login_required",
      });
    const key = "__reach_tool_protocol_v1__";
    let state = globalThis[key];
    if (request.op === "bind") {
      if (!state)
        Object.defineProperty(globalThis, key, {
          value: {
            document: request.document,
            refs: new Map(),
            effects: new Map(),
            downloads: new Map(),
          },
          configurable: true,
        });
      return JSON.stringify({
        document: globalThis[key].document,
        url: location.href,
      });
    }
    if (!state || state.document !== request.document)
      fail("stale", "The page changed. Obtain a new handle before continuing.");
    if (document.readyState === "loading")
      fail("loading", "The page is still loading.");
    const root = request.root ? state.refs.get(request.root) : document;
    if (!root || (root !== document && !root.isConnected))
      fail("stale", "The selected item is no longer on this page.");
    const label = (element) =>
      normalized(
        element.getAttribute("aria-label") ||
          element.getAttribute("download") ||
          element.innerText ||
          element.textContent,
      );
    const read = (element) => {
      if (secure(element))
        fail("protected", "Password and sign-in-code fields are unavailable.");
      return String(
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
          ? element.value
          : element.getAttribute("download") ||
              element.innerText ||
              element.textContent ||
              "",
      ).slice(0, 50000);
    };
    const roles = {
      button:
        'button, [role="button"], input[type="button"], input[type="submit"]',
      link: 'a[href], [role="link"]',
      textbox:
        'input:not([type=password]):not([type=file]):not([type=hidden]), textarea, [role="textbox"]',
      heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
      dialog: '[role="dialog"],dialog',
      row: '[role="row"],tr',
      main: 'main,[role="main"]',
      status: '[role="status"]',
      table: 'table,[role="table"],[role="grid"]',
      file: 'input[type="file"]',
    };
    const elements = (target, from = root, allowFile = false) => {
      const scope = target.scope === "page" ? document : from;
      const selector = target.css || roles[target.role];
      let found;
      try {
        found =
          selector === ":scope" && scope.nodeType === 1
            ? [scope]
            : [...scope.querySelectorAll(selector)];
      } catch {
        fail("invalid_selector", "The declared selector is invalid.");
      }
      const matches = found.filter(
        (element) =>
          (!target.role || element.matches(roles[target.role])) &&
          ((allowFile && element.matches("input[type=file]")) ||
            visible(element)) &&
          (target.name === undefined ||
            label(element) === normalized(target.name)) &&
          (target.text === undefined ||
            normalized(read(element)).includes(normalized(target.text))) &&
          (target.equals === undefined ||
            read(element) === String(target.equals)),
      );
      return target.identity
        ? matches.filter((element) => {
            const identity = elements(target.identity, element);
            if (identity.length > 1)
              fail(
                "ambiguous",
                "The target identity is ambiguous. No action was taken.",
              );
            return identity.length === 1;
          })
        : matches;
    };
    const one = (target, allowFile = false) => {
      const found = elements(target, root, allowFile);
      if (found.length > 1)
        fail(
          "ambiguous",
          "More than one element matches. No action was taken.",
        );
      if (!found.length)
        fail(
          "missing",
          "The expected element is missing. No action was taken.",
        );
      if (secure(found[0]))
        fail("protected", "Password and sign-in-code fields are unavailable.");
      return found[0];
    };
    const effect = (work) => {
      if (state.effects.has(request.command))
        fail(
          "uncertain",
          "This command was already attempted. Inspect the page; it will not be repeated.",
        );
      if (state.effects.size >= 512)
        fail(
          "limit",
          "This page has reached its command limit. Reload it before another task.",
        );
      state.effects.set(request.command, "attempted");
      try {
        const result = work();
        state.effects.set(request.command, "completed");
        return result;
      } catch (error) {
        error.uncertain = true;
        throw error;
      }
    };
    let result;
    if (request.op === "use") {
      for (const [key, target] of Object.entries(request.fields || {})) {
        const matches = elements(target);
        if (
          matches.length !== 1 ||
          read(matches[0]).slice(0, 1000) !== request.expectedFields[key]
        )
          fail(
            "stale",
            "The selected item's identity changed. Search again before continuing.",
          );
      }
      result = { url: location.href };
    } else if (request.op === "assert_absent") {
      if (elements(request.target).length)
        fail(
          "unexpected",
          "An existing dialog or target must be resolved before continuing.",
        );
      result = { verified: true };
    } else if (request.op === "assert" || request.op === "wait") {
      one(request.target);
      result = { verified: true };
    } else if (request.op === "read" || request.op === "pdf") {
      result = { text: read(one(request.target)), url: location.href };
    } else if (request.op === "collect") {
      const rows = elements(request.target);
      if (!rows.length) {
        if (!request.empty)
          fail(
            "missing",
            "Neither results nor a declared empty state were found.",
          );
        one(request.empty);
      }
      const all = rows.filter(
        (element) =>
          !request.filter ||
          normalized(read(element))
            .toLowerCase()
            .includes(normalized(request.filter).toLowerCase()),
      );
      if (state.refs.size + Math.min(all.length, 30) > 512)
        fail(
          "limit",
          "Too many item handles on this page. Reload before another search.",
        );
      result = {
        coverage: "visible_page",
        more: all.length > 30,
        items: all.slice(0, 30).map((element) => {
          const fields = {};
          for (const [key, target] of Object.entries(request.fields)) {
            const matches = elements(target, element);
            if (matches.length !== 1)
              fail(
                matches.length ? "ambiguous" : "unsupported",
                `The ${key} field does not match this tool version.`,
              );
            fields[key] = read(matches[0]).slice(0, 1000);
          }
          const ref = crypto.randomUUID();
          state.refs.set(ref, element);
          return { ...fields, pageRef: ref };
        }),
      };
    } else if (request.op === "fill") {
      const element = one(request.target);
      if (
        element.disabled ||
        element.readOnly ||
        !(element.matches("input,textarea") || element.isContentEditable)
      )
        fail("unsupported", "The target is not an editable field.");
      result = effect(() => {
        element.focus();
        if (element.isContentEditable) element.textContent = request.value;
        else {
          const prototype =
            element.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(
            element,
            request.value,
          );
        }
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: request.value,
          }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
        if (
          (element.isContentEditable ? element.textContent : element.value) !==
          request.value
        )
          fail(
            "verification",
            "The field did not retain the exact supplied value.",
          );
        return { verified: true };
      });
    } else if (request.op === "click") {
      const element = one(request.target);
      if (element.disabled || element.getAttribute("aria-disabled") === "true")
        fail("disabled", "The expected control is disabled.");
      const link = element.closest("a[href]");
      if (
        link &&
        (!request.origins.includes(new URL(link.href).origin) ||
          (link.target && link.target !== "_self"))
      )
        fail(
          "wrong_site",
          "This control would open a different website or tab.",
        );
      result = effect(() => {
        const nextUrl = link?.href || null;
        element.click();
        return { applied: true, nextUrl };
      });
    } else if (request.op === "attach") {
      const element = one(request.target, true);
      if (!element.matches('input[type="file"]') || element.disabled)
        fail("unsupported", "The target is not a file input.");
      result = effect(() => {
        const bytes = Uint8Array.from(atob(request.file.data), (c) =>
          c.charCodeAt(0),
        );
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([bytes], request.file.name, { type: request.file.mime }),
        );
        element.files = transfer.files;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        if (
          element.files.length !== 1 ||
          element.files[0].name !== request.file.name ||
          element.files[0].size !== bytes.length
        )
          fail(
            "verification",
            "The browser did not accept the exact attachment.",
          );
        return { verified: true };
      });
    } else if (request.op === "download") {
      const element = one(request.target),
        link = element.closest("a[href]");
      if (!link || !request.origins.includes(new URL(link.href).origin))
        fail(
          "unsupported",
          "No downloadable link on an allowed website was found.",
        );
      result = effect(() => {
        const job = {
          state: "running",
          name: link.getAttribute("download") || "attachment",
          mime: "",
          data: "",
        };
        state.downloads.set(request.command, job);
        fetch(link.href, { credentials: "include", redirect: "error" })
          .then(async (response) => {
            if (!response.ok)
              throw Error("The browser could not download this attachment.");
            const length = Number(response.headers.get("content-length"));
            if (length > request.maxBytes)
              throw Error("The attachment exceeds the file limit.");
            const chunks = [],
              reader = response.body.getReader();
            let size = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > request.maxBytes) {
                await reader.cancel();
                throw Error("The attachment exceeds the file limit.");
              }
              chunks.push(value);
            }
            const bytes = new Uint8Array(size);
            let at = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, at);
              at += chunk.length;
            }
            let binary = "";
            for (let index = 0; index < bytes.length; index += 32768)
              binary += String.fromCharCode(
                ...bytes.subarray(index, index + 32768),
              );
            job.data = btoa(binary);
            job.mime =
              response.headers.get("content-type")?.split(";")[0] ||
              "application/octet-stream";
            job.state = "completed";
          })
          .catch((error) => {
            job.state = "failed";
            job.error = String(error.message).slice(0, 300);
          });
        return { started: true };
      });
    } else if (request.op === "download_status") {
      const job = state.downloads.get(request.download);
      if (!job) fail("stale", "The download state was lost.");
      result = {
        state: job.state,
        name: job.name,
        mime: job.mime,
        failure: job.error,
        length: job.data.length,
      };
    } else if (request.op === "download_chunk") {
      const job = state.downloads.get(request.download);
      if (!job || job.state !== "completed")
        fail("stale", "The completed download is unavailable.");
      result = {
        data: job.data.slice(request.offset, request.offset + 262144),
      };
      if (request.offset + 262144 >= job.data.length)
        state.downloads.delete(request.download);
    } else fail("invalid", "Unknown page operation.");
    return JSON.stringify({
      ...result,
      document: state.document,
      url: location.href,
    });
  } catch (error) {
    return JSON.stringify({
      error: String(error.message).slice(0, 300),
      code: error.code || "unsupported",
      ...(error.uncertain ? { uncertain: true } : {}),
    });
  }
}
