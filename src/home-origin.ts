// The computer this page belongs to. Normally the page's own address; when
// the public start page boots the app in a browser signed in to the tailnet,
// it is the computer's private address instead. Kept on globalThis so every
// bundle chunk sees the same value.
const KEY = "__reachHomeOrigin";
type Holder = { [KEY]?: string };
export const setHomeOrigin = (origin: string) => {
  (globalThis as Holder)[KEY] = origin;
};
export const homeOrigin = (): string =>
  (globalThis as Holder)[KEY] || location.origin;
