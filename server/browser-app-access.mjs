import crypto from 'node:crypto';
import { fail, isPlainRecord, hasReviewControls } from './core.mjs';
import { protectBrowserApp, protectedBrowserAppReason } from './browser-protected-apps.mjs';

const fingerprint = (client) => JSON.stringify([client.id, client.expiresAt, client.policy, client.scopes, client.tailscale]);
const clean = (text) => String(text || '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 180);
const visibleRequest = ({ fingerprint: ignored, identity: hidden, ...request }) => structuredClone(request);
const validAction = (action) => {
  if (!isPlainRecord(action)) throw fail(400, 'Choose an app action.');
  const fields = { click:['type','x','y'], text:['type','text'], key:['type','key'], scroll:['type','direction','amount'] };
  if (!fields[action.type] || Object.keys(action).some((key) => !fields[action.type].includes(key))) throw fail(400, 'Unsupported app input.');
  if (action.type === 'click' && (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1)) throw fail(400, 'Click inside the shared window.');
  if (action.type === 'text' && (typeof action.text !== 'string' || !action.text.length || action.text.length > 2000 || /[\x00-\x1f\x7f]/.test(action.text))) throw fail(400, 'Type up to 2,000 characters without control keys.');
  if (action.type === 'key' && !['enter','backspace','tab','escape','left','right','up','down'].includes(action.key)) throw fail(400, 'This key is not available in shared apps.');
  if (action.type === 'scroll' && (!['up','down'].includes(action.direction) || !Number.isInteger(action.amount) || action.amount < 1 || action.amount > 5)) throw fail(400, 'Choose 1 to 5 scroll steps.');
  return Object.freeze(structuredClone(action));
};

// Every target and additional grant is scoped to the invitation UUID and its
// complete current permissions. No agent-controlled PID/window identity is used.
export function createBrowserAppAccess({ native, verifyClient, screenAvailable, persistRestriction = () => { throw fail(503, "App restrictions cannot be saved. End the invitation instead."); }, notify = () => {}, record = () => {}, now = Date.now }) {
  const sessions = new Map(), requests = new Map(), rates = new Map();
  let closed = false, catalogCache = null, catalogUntil = 0, catalogFlight = null;
  const grantChanges = new Set();
  const changeGrant = async (clientId, apply) => {
    if (grantChanges.has(clientId)) throw fail(409, 'Another app permission change is in progress. Refresh and try again.');
    grantChanges.add(clientId);
    try { return await apply(); } finally { grantChanges.delete(clientId); }
  };
  const clientNow = (client) => {
    const latest = verifyClient(client?.id);
    if (closed || !screenAvailable() || !latest || latest.id !== client?.id || latest.kind !== 'agent' || latest.expiresAt <= now() || latest.policy?.browser !== true || latest.policy.screen !== 'apps' || !latest.scopes?.includes('browser:read')) throw fail(403, 'This app session has ended or was paused.');
    if (fingerprint(latest) !== fingerprint(client)) throw fail(403, 'App access changed. Refresh this session.');
    return latest;
  };
  const session = (client) => {
    clientNow(client);
    const fp = fingerprint(client);
    let state = sessions.get(client.id);
    if (!state || state.fingerprint !== fp) {
      state = { fingerprint:fp, extra:new Map(), targets:new Map(), busy:false };
      sessions.set(client.id,state);
    }
    return state;
  };
  const rate = (client, key, max) => {
    const id = `${client.id}:${key}`, recent = (rates.get(id)||[]).filter((time) => time > now()-60000);
    if (recent.length >= max) throw fail(429, 'Please wait before sending more app requests.');
    recent.push(now()); rates.set(id,recent);
  };
  const catalog = async (authorize = () => {}) => {
    authorize();
    if (!catalogCache || catalogUntil <= now()) {
      // Native operations revalidate live signing identity independently of this metadata cache.
      if (!catalogFlight) catalogFlight = native.catalog(() => {}).then((result) => {
        if (!Array.isArray(result?.apps)) throw fail(503,'The app list could not be verified.');
        catalogCache = result.apps.filter((app) => typeof app.id === 'string' && (app.protected || typeof app.identity === 'string')).map((app) => ({...protectBrowserApp(app),name:clean(app.name)}));
        catalogUntil = now()+10000;return catalogCache;
      }).finally(() => { catalogFlight=null; });
      await catalogFlight;
    }
    authorize();
    return structuredClone(catalogCache);
  };
  const grant = (client,state,app) => {
    if (app.protected || protectedBrowserAppReason(app)) return 'hidden';
    const value = state.extra.get(app.id) || client.policy.appAccess?.find((entry) => entry.id === app.id);
    return value?.identity === app.identity && ['view','control'].includes(value?.mode) ? value.mode : 'hidden';
  };
  const sweep = () => {
    for (const [id,state] of sessions) {
      const current = verifyClient(id);
      if (!current || current.expiresAt <= now() || fingerprint(current) !== state.fingerprint) sessions.delete(id);
    }
    for (const item of requests.values()) {
      if (item.status !== 'pending') continue;
      const current = verifyClient(item.clientId);
      if (!current || fingerprint(current) !== item.fingerprint) item.status = 'revoked';
      else if (item.expiresAt <= now() || current.expiresAt <= now()) item.status = 'expired';
    }
    const finished = [...requests.values()].filter((item) => item.status !== 'pending');
    for (const item of finished.slice(0,Math.max(0,finished.length-100))) requests.delete(item.id);
    for (const [key,values] of rates) if (!values.some((v) => v > now()-60000)) rates.delete(key);
  };
  const target = async (client,id,control,authorize) => {
    authorize(); const state = session(client), item = state.targets.get(id);
    if (!item || item.expiresAt <= now()) throw fail(409,'This app window changed. Refresh it before continuing.');
    const app = { id: item.appId, identity: item.identity, bundleId: item.bundleId, name: item.appName, protected: false };
    authorize(); clientNow(client);
    const mode = app && grant(client,state,app);
    if (!app || app.identity !== item.identity || mode === 'hidden' || (control && mode !== 'control')) throw fail(403,'This app is not shared with that permission.');
    if (session(client) !== state) throw fail(403,'This app session changed.');
    return {state,item};
  };
  return {
    async options(authorize) { return catalog(authorize); },
    async validateChoices(choices,authorize) {
      catalogUntil = 0;
      const apps = await catalog(authorize);
      return choices.map((choice) => {
        const app = apps.find((app) => app.id === choice.id);
        if (!app || app.protected) throw fail(403,'Choose an available app that can be shared.');
        return {id:app.id,mode:choice.mode,identity:app.identity};
      });
    },
    async list(client,authorize) {
      sweep(); const state = session(client), apps = await catalog(authorize); authorize(); clientNow(client);
      return {apps:apps.map((app) => ({id:app.id,name:app.name,mode:grant(client,state,app),protected:!!app.protected,...(app.reason?{reason:clean(app.reason)}:{})})), requests:this.listClient(client)};
    },
    async windows(client,appId,authorize) {
      rate(client,'windows',120);
      const state = session(client), apps = await catalog(authorize), app = apps.find((app) => app.id === appId);
      authorize();clientNow(client);
      if (!app || grant(client,state,app) === 'hidden') throw fail(403,'Ask the owner to share this app first.');
      const result = await native.windows(app.id,authorize,app.identity);
      authorize();clientNow(client);
      if (session(client)!==state || grant(client,state,app)==='hidden') throw fail(403,'App access changed.');
      const windows=[];const keep=new Set();
      for (const value of (result.windows||[]).slice(0,30)) {
        if (!Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.pid) || typeof value.instance!=='string' || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width<=0 || value.height<=0) continue;
        const key=JSON.stringify([app.id,app.identity,value.id,value.pid,value.instance,value.width,value.height]);
        let entry=[...state.targets.entries()].find(([,item])=>item.key===key);
        if (!entry) entry=[crypto.randomBytes(24).toString('base64url'),{...value,windowId:value.id,appId:app.id,identity:app.identity,bundleId:app.bundleId,appName:app.name,key}];
        const [id,item]=entry;item.expiresAt=now()+60000;state.targets.set(id,item);keep.add(id);
        windows.push({id,title:clean(value.title)||app.name,width:value.width,height:value.height});
      }
      for(const [id,item] of state.targets)if((item.appId===app.id&&!keep.has(id))||item.expiresAt<=now())state.targets.delete(id);
      return {windows};
    },
    async capture(client,id,authorize) {
      rate(client,'capture',180);
      const {state,item}=await target(client,id,false,authorize);
      const check=()=>{authorize();clientNow(client);if(session(client)!==state||state.targets.get(id)!==item)throw fail(403,'App view ended.');};
      const result=await native.capture(item,check);check();
      if(typeof result.jpeg!=='string'||result.jpeg.length>12*1024*1024)throw fail(503,'The app image could not be verified.');
      const buffer=Buffer.from(result.jpeg,'base64');
      if(buffer.length<2||buffer.length>8*1024*1024)throw fail(503,'The app image is unavailable.');
      return buffer;
    },
    async input(client,id,input,authorize) {
      const action=validAction(input);rate(client,'input',180);
      const {state,item}=await target(client,id,true,authorize);
      if(state.busy)throw fail(409,'Wait for the previous app action.');
      state.busy=true;
      const check=()=>{authorize();clientNow(client);if(session(client)!==state||state.targets.get(id)!==item)throw fail(403,'App control ended.');};
      try {check();const result=await native.input(item,action,check);check();if(result.done!==true)throw fail(409,result.error||result.why||'This control is not supported. Nothing was retried.');record('agent','An agent used a shared app');return {done:true};}
      finally {state.busy=false;}
    },
    async request(client,input,authorize) {
      session(client);sweep();
      if(!isPlainRecord(input)||Object.keys(input).some((key)=>!['appId','mode','reason'].includes(key))||typeof input.appId!=='string'||!['view','control'].includes(input.mode)||typeof(input.reason??'')!=='string'||(input.reason||'').length>500||hasReviewControls(input.reason||''))throw fail(400,'Choose the app and access to request.');
      const apps=await catalog(authorize),app=apps.find((app)=>app.id===input.appId);authorize();clientNow(client);
      if(!app||app.protected)throw fail(403,'This app cannot be shared with agents.');
      const duplicate=[...requests.values()].find((r)=>r.clientId===client.id&&r.status==='pending'&&r.action.appId===app.id&&r.action.mode===input.mode);if(duplicate)return visibleRequest(duplicate);
      rate(client,'requests',6);
      if([...requests.values()].filter((r)=>r.status==='pending').length>=30)throw fail(429,'Wait for an existing app request to be answered.');
      const item={id:crypto.randomUUID(),clientId:client.id,name:clean(client.name),action:{type:'app-access',appId:app.id,appName:app.name,mode:input.mode},identity:app.identity,fingerprint:fingerprint(client),reason:input.reason||'',status:'pending',createdAt:now(),expiresAt:Math.min(now()+300000,client.expiresAt),sessionExpiresAt:client.expiresAt};
      requests.set(item.id,item);
      Promise.resolve(notify({title:'App access requested',body:`${clean(client.name)} wants to ${input.mode==='control'?'use':'view'} ${app.name}.`,category:'access',tag:`browser-app-${client.id}`})).catch(()=>{});
      return visibleRequest(item);
    },
    async ownerAccess(clientId, authorizeOwner) {
      authorizeOwner();const client=verifyClient(clientId);clientNow(client);
      return this.list(client,authorizeOwner);
    },
    async restrict(clientId,input,authorizeOwner) {
      return changeGrant(clientId, async () => {
      authorizeOwner();
      if(!isPlainRecord(input)||Object.keys(input).some((key)=>!['appId','mode'].includes(key))||typeof input.appId!=='string'||!['hidden','view'].includes(input.mode))throw fail(400,'Hide this app or make it view only.');
      const client=verifyClient(clientId),state=session(client),apps=await catalog(authorizeOwner),app=apps.find((a)=>a.id===input.appId);
      authorizeOwner();clientNow(client);
      if(!app||app.protected)throw fail(403,'This app is protected.');
      const current=grant(client,state,app);
      if(input.mode==='view'&&current==='hidden')throw fail(403,'Approve an app request to grant access.');
      // Persist negative permissions before responding. Clearing memory on pause
      // or restart must never resurrect an initially granted control permission.
      await persistRestriction(clientId,app.id,input.mode);
      authorizeOwner();
      const next = session(verifyClient(clientId));
      next.extra = new Map(state.extra);
      next.extra.set(app.id,{id:app.id,identity:app.identity,mode:input.mode});
      state.targets.clear();next.targets.clear();
      // Pending requests cannot restore access after the owner restricts it.
      for(const request of requests.values())if(request.clientId===clientId&&request.action.appId===app.id&&request.status==='pending')request.status='denied';
      record('agent','The owner restricted app access');return this.ownerAccess(clientId,authorizeOwner);
      });
    },
    has(id){return requests.has(id);},
    listOwner(){sweep();return [...requests.values()].filter((r)=>r.status==='pending').map(visibleRequest);},
    listClient(client){session(client);sweep();return [...requests.values()].filter((r)=>r.clientId===client.id).map(visibleRequest);},
    async decide(id,decision,authorizeOwner){
      authorizeOwner();sweep();const item=requests.get(id);
      if(!item)throw fail(404,'This app request was not found.');
      return changeGrant(item.clientId, async () => {
      if(item.status!=='pending')throw fail(409,'This app request has ended.');
      if(!['approve','deny'].includes(decision))throw fail(400,'Allow this app for this session or deny it.');
      const client=verifyClient(item.clientId);clientNow(client);
      if(decision==='deny'){item.status='denied';return visibleRequest(item);}
      catalogUntil=0;
      const apps=await catalog(authorizeOwner);authorizeOwner();sweep();
      if(item.status!=='pending')throw fail(409,'This app request has ended.');
      let latest=verifyClient(item.clientId);clientNow(latest);if(fingerprint(latest)!==item.fingerprint)throw fail(403,'The invitation changed.');
      const app=apps.find((a)=>a.id===item.action.appId);
      if(!app||app.protected||app.identity!==item.identity)throw fail(409,'The app changed. Ask for a new request.');
      let state=session(latest);
      if(item.action.mode==='view'&&grant(latest,state,app)==='control') {
        const previous=state;
        await persistRestriction(latest.id,app.id,'view');authorizeOwner();
        latest=verifyClient(item.clientId);clientNow(latest);state=session(latest);
        state.extra=new Map(previous.extra);previous.targets.clear();
      }
      state.extra.set(app.id,{id:app.id,mode:item.action.mode,identity:app.identity});state.targets.clear();
      item.status='executed';record('agent','The owner allowed app access for one invitation');return visibleRequest(item);
      });
    },
    cancel(client,id){session(client);const item=requests.get(id);if(!item||item.clientId!==client.id)throw fail(404,'This app request was not found.');if(item.status!=='pending')throw fail(409,'This app request has ended.');item.status='cancelled';return visibleRequest(item);},
    clear(){sessions.clear();for(const item of requests.values())if(item.status==='pending')item.status='revoked';},
    close(){closed=true;this.clear();},
  };
}
