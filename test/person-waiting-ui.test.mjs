import test from "node:test";
import assert from "node:assert/strict";
import {startDom,settle} from "./dom/harness.mjs";
test("a transient network error keeps an invited person waiting and polling", async () => {
 let calls=0;
 const dom=await startDom({mobile:true,routes:{"/api/device":()=>{
  calls++;
  if(calls===2) throw Error("temporary network failure");
  if(calls>=3) return {name:"Fixture", access:{kind:"guest", scopes:["screen"]}};
  return new Response(JSON.stringify({error:"Waiting for owner",waiting:true}),{status:403});
 }}});
 let view;
 try {
  const {WaitForOwner}=await dom.load("/src/guest-session.tsx");
  view=await dom.render(dom.React.createElement(WaitForOwner,{peer:{id:"fixture",url:"https://fixture.test",token:"synthetic",name:"Fixture",platform:"darwin"}},dom.React.createElement("p",{},"Workspace opened")));
  await dom.waitFor(()=>view.container.textContent.includes("Waiting for the owner"));
  await dom.waitFor(()=>calls>=2,5000);
  await settle(50);
  assert.equal(view.container.textContent.includes("Workspace opened"),false,"a retryable network failure is not owner approval");
  await dom.waitFor(()=>view.container.textContent.includes("Workspace opened"),5000);
  assert.ok(calls>=3, "approval is collected automatically after reconnect");
 } finally {await view?.unmount();await dom.close();}
});
