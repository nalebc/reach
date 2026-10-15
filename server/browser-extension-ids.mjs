// Which builds of Reach's browser extension Reach accepts (docs/parity/G-browser-tools.md):
// the store listings' only. The stores assign their ids when the owner
// creates the listings; until then they're empty, setup says the extension
// isn't in that store yet, and no extension can connect. The repo build
// (browser-extension/, its fixed "key", loaded unpacked) is accepted only
// where a caller names it on purpose: the tests.
export const EXTENSION_STORES = Object.freeze({
  Chrome: Object.freeze({ id: "", url: "" }),
  Edge: Object.freeze({ id: "", url: "" }),
});
// The id Chrome and Edge give browser-extension/ from its manifest's "key":
// never in the production allowed list (anyone can load an unpacked copy).
export const REPO_EXTENSION_ID = "bicgdiemnpdmnomkmclcfclbahpablbj";
export const NATIVE_HOST = "com.reach.browser_tools";

const ID = /^[a-p]{32}$/;
export const extensionIds = (stores = EXTENSION_STORES) =>
  [...new Set(Object.values(stores).map((store) => store.id).filter((id) => ID.test(id)))];
export const extensionOrigin = (id) => `chrome-extension://${id}/`;
