// Recovery changes the query to force a document fetch even at a fragment.
// Once code loads, restore the bookmarked address without another navigation.
const url = new URL(location.href);
if (url.searchParams.has("reach-reconnect")) {
  url.searchParams.delete("reach-reconnect");
  history.replaceState(history.state, "", url.href);
}
export {};
