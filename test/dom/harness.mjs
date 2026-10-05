import path from "node:path";
import { format } from "node:util";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

// Renders the real interface components in Node for regression tests: jsdom
// is the page, Vite compiles the TSX the same way the app build does.
// `fakes` swaps chosen source modules (the live video stream, the input
// socket…) for stand-ins, keyed by repo path: { "src/x.ts": "test/dom/fakes/x.mjs" }.
// `routes` answers the computer's HTTP API: { "/api/screen/control": () => ({…}) }.
// Each gets the request's init and its URL (for query strings).
// Every console.error (React's warnings included) and every jsdom error lands
// in `errors`, so a test can require that rendering stayed clean.
const root = fileURLToPath(new URL("../..", import.meta.url));

export const settle = (ms = 20) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function startDom({
  mobile = true,
  fakes = {},
  routes = {},
} = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://reach.test/",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  // A phone's coarse pointer and narrow screen, or a desktop's.
  window.matchMedia = (media) => ({
    matches: mobile,
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  window.scrollTo = () => {};
  // jsdom can't draw; behave like a browser whose canvas can't be read back.
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.HTMLCanvasElement.prototype.toDataURL = () => "data:,";
  window.HTMLElement.prototype.scrollIntoView = () => {};
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  window.ResizeObserver ??= Observer;
  window.IntersectionObserver ??= Observer;

  // Expose the page as globals before React loads: react-dom decides at
  // import time whether it runs in a browser.
  const saved = new Map();
  const define = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  };
  for (const name of Object.getOwnPropertyNames(window))
    if (!(name in globalThis) && !name.startsWith("_"))
      define(name, window[name]);
  for (const name of ["window", "self", "navigator", "Event", "CustomEvent"])
    define(name, name === "window" || name === "self" ? window : window[name]);
  define("fetch", async (url, init = {}) => {
    const href = new URL(url, window.location.href);
    const route = href.pathname;
    const body = (await routes[route]?.(init, href)) ?? {};
    // A route can answer with its own status (a 409, say).
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const consoleError = console.error;
  console.error = (...args) => errors.push(format(...args));

  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    // Faked packages go through the plugin below instead of loading as-is.
    ssr: { noExternal: Object.keys(fakes).filter((k) => !/^(src|test)\//.test(k)) },
    plugins: [
      {
        name: "reach-test-fakes",
        enforce: "pre",
        async resolveId(source, importer, options) {
          if (!importer) return;
          const resolved = await this.resolve(source, importer, {
            ...options,
            skipSelf: true,
          });
          // By file, or by package name for packages Vite loads as-is.
          const fake =
            fakes[source] ||
            (resolved && fakes[path.relative(root, resolved.id).split(path.sep).join("/")]);
          return fake ? path.join(root, fake).split(path.sep).join("/") : undefined;
        },
      },
    ],
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const mounted = new Set();

  return {
    window,
    document: window.document,
    errors,
    React,
    // A module as the app sees it: "/src/Screen.tsx".
    load: (file) => vite.ssrLoadModule(file),
    async render(element) {
      const container = window.document.createElement("div");
      window.document.body.append(container);
      const reactRoot = createRoot(container);
      reactRoot.render(element);
      const view = {
        container,
        unmount: async () => {
          mounted.delete(view);
          reactRoot.unmount();
          container.remove();
          await settle();
        },
      };
      mounted.add(view);
      await settle();
      return view;
    },
    async waitFor(check, timeout = 2000) {
      const end = Date.now() + timeout;
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() > end) throw Error(`Timed out waiting for ${check}`);
        await settle(10);
      }
    },
    async close() {
      for (const view of mounted) await view.unmount();
      await vite.close();
      window.close();
      console.error = consoleError;
      for (const [name, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    },
  };
}

// What a browser does for one keystroke or paste into a text field: a
// cancellable beforeinput, then the new value and an input event. React only
// notices a value set through the prototype's setter.
export async function typeInto(field, text) {
  const { InputEvent } = field.ownerDocument.defaultView;
  const before = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: text,
    bubbles: true,
    cancelable: true,
  });
  if (field.dispatchEvent(before)) {
    setValue(field, field.value + text);
    field.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertText",
        data: text,
        bubbles: true,
      }),
    );
  }
  await settle();
}

// The keyboard rewriting the field at once, as autocorrect or a suggestion does.
export async function replaceText(field, text) {
  const { InputEvent } = field.ownerDocument.defaultView;
  setValue(field, text);
  field.dispatchEvent(
    new InputEvent("input", {
      inputType: "insertReplacementText",
      bubbles: true,
    }),
  );
  await settle();
}

// Backspace on the phone keyboard: keydown, then (unless handled) the
// browser deletes the last character itself.
export async function backspace(field) {
  const { InputEvent } = field.ownerDocument.defaultView;
  if (await press(field, "Backspace")) {
    const before = new InputEvent("beforeinput", {
      inputType: "deleteContentBackward",
      bubbles: true,
      cancelable: true,
    });
    if (field.dispatchEvent(before) && field.value) {
      setValue(field, [...field.value].slice(0, -1).join(""));
      field.dispatchEvent(
        new InputEvent("input", {
          inputType: "deleteContentBackward",
          bubbles: true,
        }),
      );
    }
  }
  await settle();
}

// Returns false when the page handled the key (preventDefault).
export async function press(field, key, modifiers = {}) {
  const { KeyboardEvent } = field.ownerDocument.defaultView;
  const handled = !field.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }),
  );
  await settle();
  return !handled;
}

function setValue(field, value) {
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field),
    "value",
  ).set.call(field, value);
}
