// Which builds of Reach's browser extension Reach accepts (docs/parity/G-browser-tools.md).
// The stores assign their own ids when the owner creates the listings: until
// then they're empty, setup says the extension isn't in that store yet, and
// only the repo build (browser-extension/, its fixed "key", loaded unpacked)
// can connect, after the owner allows it in Reach.
export const EXTENSION_STORES = Object.freeze({
  Chrome: Object.freeze({ id: "", url: "" }),
  Edge: Object.freeze({ id: "", url: "" }),
});
// The id Chrome and Edge give browser-extension/ from its manifest's "key".
export const REPO_EXTENSION_ID = "bicgdiemnpdmnomkmclcfclbahpablbj";
export const NATIVE_HOST = "com.reach.browser_tools";

const ID = /^[a-p]{32}$/;
export const extensionIds = (stores = EXTENSION_STORES) =>
  [...new Set([...Object.values(stores).map((store) => store.id), REPO_EXTENSION_ID].filter((id) => ID.test(id)))];
export const extensionOrigin = (id) => `chrome-extension://${id}/`;
