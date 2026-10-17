// Keep the production start entry, saved peers and transport router real.
// The workspace import records its environment without opening app sockets.
import { activeKey, compactPeers, readPeers } from "../../../src/api";
import { homeOrigin } from "../../../src/home-origin";
import { privateWay, tailnetNode } from "../../../src/tailnet-transport";

const state = globalThis.__reachStartTest;
state.boots.push({
  url: location.href,
  origin: homeOrigin(),
  way: privateWay(),
  peers: readPeers(),
  selected: compactPeers(readPeers()).find(peer => peer.id === localStorage.getItem(activeKey())),
  node: tailnetNode(),
});
document.getElementById("root").textContent = "Workspace opened";
