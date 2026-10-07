// The computer this page belongs to. Normally the page's own address (with
// one address, also when the start page boots the app in a browser signed in
// to the tailnet); an invited guest's computer, or an older Reach's private
// address, otherwise. Kept on globalThis so every bundle chunk sees the same
// value.
const KEY = "__reachHomeOrigin";
type Holder = { [KEY]?: string };
export const setHomeOrigin = (origin: string) => {
  (globalThis as Holder)[KEY] = origin;
};
export const homeOrigin = (): string =>
  (globalThis as Holder)[KEY] || location.origin;
