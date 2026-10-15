// Reach's extension service worker: the fixed page interpreter, the
// transport, and nothing else (docs/parity/G-browser-tools.md).
/* global importScripts, chrome */
importScripts("page-runtime.js", "reach-extension.js");
globalThis.reachExtension
  .create(chrome, { version: chrome.runtime.getManifest().version })
  .start();
