import crypto from 'node:crypto';
import { fail, isPlainRecord, hasReviewControls } from './core.mjs';
import { protectBrowserApp, protectedBrowserAppReason, isolatedControlReason } from './browser-protected-apps.mjs';

const fingerprint = (client) => JSON.stringify([client.id, client.expiresAt, client.policy, client.scopes, client.tailscale]);
const clean = (text) => String(text || '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 180);
const visibleRequest = ({ fingerprint: ignored, identity: hidden, ...request }) => structuredClone(request);
// Every target and additional grant is scoped to the invitation UUID and its
// complete current permissions. No agent-controlled PID/window identity is used.
export function createBrowserAppAccess({ native, verifyClient, screenAvailable, persistRestriction = () => { throw fail(503, "App restrictions cannot be saved. End the invitation instead."); }, notify = () => {}, record = () => {}, now = Date.now }) {
  const sessions = new Map(), requests = new Map(), rates = new Map();
  let closed = false, catalogCache = null, catalogUntil = 0, catalogFlight = null;
  const grantChanges = new Set();
  const stopTargets = (state) => {
    if (!state) return;
    state.targets.clear();
    for (const operation of state.operations) operation.abort();
    state.operations.clear();
  };
  const changeGrant = async (clientId, apply) => {
    if (grantChanges.has(clientId)) throw fail(409, 'Another app permission change is in progress. Refresh and try again.');
    grantChanges.add(clientId);
    try { return await apply(); } finally { grantChanges.delete(clientId); }
  };
  const clientNow = (client) => {
    const latest = verifyClient(client?.id);
    if (closed || !screenAvailable() || !latest || latest.id !== client?.id || latest.kind !== 'agent' || !Number.isFinite(latest.expiresAt) || latest.expiresAt <= now() || latest.policy?.browser !== true || latest.policy.screen !== 'apps' || !latest.scopes?.includes('browser:read')) throw fail(403, 'This app session has ended or was paused.');
    if (fingerprint(latest) !== fingerprint(client)) throw fail(403, 'App access changed. Refresh this session.');
    return latest;
  };
  const session = (client) => {
    clientNow(client);
    const fp = fingerprint(client);
    let state = sessions.get(client.id);
    if (!state || state.fingerprint !== fp) {
      stopTargets(state);
      state = { fingerprint:fp, extra:new Map(), targets:new Map(), operations:new Set(), busy:false };
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
    // Existing control grants reduce to viewing; their stored mode can never
    // re-enable host input when a previous invitation reconnects.
    return value?.identity === app.identity && ['view','control'].includes(value?.mode) ? 'view' : 'hidden';
  };
  const sweep = () => {
    for (const [id,state] of sessions) {
      const current = verifyClient(id);
      if (!current || !Number.isFinite(current.expiresAt) || current.expiresAt <= now() || fingerprint(current) !== state.fingerprint) { stopTargets(state); sessions.delete(id); }
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
    if (grantChanges.has(client?.id)) throw fail(409,'App permissions are changing. Refresh before continuing.');
    authorize(); const state = session(client), item = state.targets.get(id);
    if (!item || item.expiresAt <= now()) throw fail(409,'This app window changed. Refresh it before continuing.');
    const app = { id: item.appId, identity: item.identity, bundleId: item.bundleId, name: item.appName, protected: false };
    authorize(); clientNow(client);
    const mode = app && grant(client,state,app);
    if (!app || app.identity !== item.identity || mode === 'hidden' || (control && mode !== 'control')) throw fail(403,'This app is not shared with that permission.');
    if (session(client) !== state) throw fail(403,'This app session changed.');
    return {state,item};
  };
  const operation = (client,state,item,id,control,authorize) => {
    const controller = new AbortController();
    state.operations.add(controller);
    const check = () => {
      authorize();clientNow(client);
      const app = {id:item.appId,identity:item.identity,bundleId:item.bundleId,name:item.appName};
      const mode = grant(client,state,app);
      if(controller.signal.aborted || grantChanges.has(client.id) || session(client)!==state || state.targets.get(id)!==item || item.expiresAt<=now() || mode==='hidden' || (control && mode!=='control'))
        throw fail(403,control?'App control ended.':'App view ended.');
    };
    return {check,signal:controller.signal,finish:()=>state.operations.delete(controller)};
  };
  return {
    controlAvailable:false,
    controlReason:isolatedControlReason,
    async options(authorize) { return catalog(authorize); },
    async validateChoices(choices,authorize) {
      catalogUntil = 0;
      const apps = await catalog(authorize);
      return choices.map((choice) => {
        const app = apps.find((app) => app.id === choice.id);
        if (!app || app.protected) throw fail(403,'Choose an available app that can be shared.');
        if (choice.mode !== 'view') throw fail(403,isolatedControlReason);
        return {id:app.id,mode:choice.mode,identity:app.identity};
      });
    },
    async list(client,authorize) {
      sweep(); const state = session(client), apps = await catalog(authorize); authorize(); clientNow(client);
      return {controlAvailable:false,controlReason:isolatedControlReason,apps:apps.map((app) => ({id:app.id,name:app.name,mode:grant(client,state,app),protected:!!app.protected,...(app.reason?{reason:clean(app.reason)}:{})})), requests:this.listClient(client)};
    },
    async windows(client,appId,authorize) {
      rate(client,'windows',120);
      if(grantChanges.has(client?.id))throw fail(409,'App permissions are changing. Refresh before continuing.');
      const state = session(client), apps = await catalog(authorize), app = apps.find((app) => app.id === appId);
      authorize();clientNow(client);
      if (!app || grant(client,state,app) === 'hidden') throw fail(403,'Ask the owner to share this app first.');
      const result = await native.windows(app.id,authorize,app.identity);
      authorize();clientNow(client);
      if (grantChanges.has(client.id) || session(client)!==state || grant(client,state,app)==='hidden') throw fail(403,'App access changed.');
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
      const pending=operation(client,state,item,id,false,authorize);
      let result;
      try { pending.check();result=await native.capture(item,pending.check,pending.signal);pending.check(); }
      finally { pending.finish(); }
      if(typeof result.jpeg!=='string'||result.jpeg.length>12*1024*1024)throw fail(503,'The app image could not be verified.');
      const buffer=Buffer.from(result.jpeg,'base64');
      if(buffer.length<2||buffer.length>8*1024*1024)throw fail(503,'The app image is unavailable.');
      return buffer;
    },
    async input(client,id,input,authorize) {
      // AX targeting restricts direct input, not the network, IPC, scripts or
      // launches a native app may perform as the owner. No general host input
      // is available until an isolated or app-specific adapter enforces those
      // effects. This is a fixed server policy, never an invitation flag.
      throw fail(403,isolatedControlReason);
    },
    async request(client,input,authorize) {
      session(client);sweep();
      if(!isPlainRecord(input)||Object.keys(input).some((key)=>!['appId','mode','reason'].includes(key))||typeof input.appId!=='string'||!['view','control'].includes(input.mode)||typeof(input.reason??'')!=='string'||(input.reason||'').length>500||hasReviewControls(input.reason||''))throw fail(400,'Choose the app and access to request.');
      if(input.mode!=='view')throw fail(403,isolatedControlReason);
      const apps=await catalog(authorize),app=apps.find((app)=>app.id===input.appId);authorize();clientNow(client);
      if(!app||app.protected)throw fail(403,'This app cannot be shared with agents.');
      const duplicate=[...requests.values()].find((r)=>r.clientId===client.id&&r.status==='pending'&&r.action.appId===app.id&&r.action.mode===input.mode);if(duplicate)return visibleRequest(duplicate);
      rate(client,'requests',6);
      if([...requests.values()].filter((r)=>r.status==='pending').length>=30)throw fail(429,'Wait for an existing app request to be answered.');
      const item={id:crypto.randomUUID(),clientId:client.id,name:clean(client.name),action:{type:'app-access',appId:app.id,appName:app.name,mode:input.mode},identity:app.identity,fingerprint:fingerprint(client),reason:input.reason||'',status:'pending',createdAt:now(),expiresAt:Math.min(now()+300000,client.expiresAt),sessionExpiresAt:client.expiresAt};
      requests.set(item.id,item);
      Promise.resolve(notify({title:`${app.name} · Access request`,body:`${clean(client.name)} wants to view this app. Review access on your computer’s Home page.`,icon:'agent',url:`/?page=overview&needs=${encodeURIComponent(`browser:${item.id}`)}`,actions:[{action:'open',title:'Review access'}],category:'access',tag:`browser-app-${item.id}`})).catch(()=>{});
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
      // Validate the requested reduction first, then stop native work before
      // persistence. An invalid request for another app must not retire this
      // app's current window tokens.
      stopTargets(state);
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
      if(item.action.mode!=='view')throw fail(403,isolatedControlReason);
      catalogUntil=0;
      const apps=await catalog(authorizeOwner);authorizeOwner();sweep();
      if(item.status!=='pending')throw fail(409,'This app request has ended.');
      let latest=verifyClient(item.clientId);clientNow(latest);if(fingerprint(latest)!==item.fingerprint)throw fail(403,'The invitation changed.');
      const app=apps.find((a)=>a.id===item.action.appId);
      if(!app||app.protected||app.identity!==item.identity)throw fail(409,'The app changed. Ask for a new request.');
      let state=session(latest);
      stopTargets(state);
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
    cancelClient(clientId){const state=sessions.get(clientId);stopTargets(state);sessions.delete(clientId);for(const item of requests.values())if(item.clientId===clientId&&item.status==='pending')item.status='revoked';},
    clear(){for(const state of sessions.values())stopTargets(state);sessions.clear();for(const item of requests.values())if(item.status==='pending')item.status='revoked';},
    close(){closed=true;this.clear();},
  };
}
