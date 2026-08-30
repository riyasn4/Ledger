/* =========================================================================
   DRIVE SYNC — keeps your data in a private file in your own Google Drive
   (in the special "app data" area — you won't see it browsing Drive
   normally) so it can travel between your devices.

   Strategy: every local save is pushed up to Drive after a short pause.
   On app open, sign-in, or "Sync now", we compare timestamps and the
   newer copy (local vs Drive) wins and overwrites the other.
   ========================================================================= */

const DriveSync = (function(){
  const FILE_NAME = 'ledger-data.json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const LS_SIGNED_IN = 'driveSync_signedIn';
  const LS_FILE_ID = 'driveSync_fileId';
  const LS_LAST_SYNC = 'driveSync_lastSync';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let fileId = localStorage.getItem(LS_FILE_ID) || null;
  let pushTimer = null;
  let status = { state: 'unconfigured', message: 'Not set up yet', lastSync: localStorage.getItem(LS_LAST_SYNC) };
  let listeners = [];

  function setStatus(state, message){
    status = { state, message, lastSync: localStorage.getItem(LS_LAST_SYNC) };
    listeners.forEach(fn=>fn(status));
  }
  function onStatusChange(fn){ listeners.push(fn); }
  function getStatus(){ return status; }
  function isConfigured(){ return typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.indexOf('PASTE_YOUR') === -1; }
  function isSignedIn(){ return localStorage.getItem(LS_SIGNED_IN) === '1'; }

  function waitForGis(cb, tries){
    tries = tries || 0;
    if(window.google && google.accounts && google.accounts.oauth2){ cb(); return; }
    if(tries > 40){ setStatus('error', 'Could not load Google sign-in'); return; }
    setTimeout(()=>waitForGis(cb, tries+1), 250);
  }

  function init(){
    if(!isConfigured()){ setStatus('unconfigured', 'Not set up yet'); return; }
    waitForGis(()=>{
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: onTokenResponse
      });
      setStatus('signed-out', 'Not signed in');
      if(isSignedIn()){
        setStatus('syncing', 'Reconnecting…');
        tokenClient.requestAccessToken({ prompt: '' }); // silent
      }
    });
  }

  function onTokenResponse(resp){
    if(resp.error){
      setStatus('error', 'Sign-in needs your attention — tap Sign in again');
      return;
    }
    accessToken = resp.access_token;
    tokenExpiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
    localStorage.setItem(LS_SIGNED_IN, '1');
    setStatus('syncing', 'Syncing…');
    ensureFile().then(reconcile).catch(err=>{
      console.warn(err);
      setStatus('error', 'Could not reach Google Drive');
    });
  }

  function signIn(){
    if(!isConfigured()){ toast('Drive sync isn\'t set up yet — see More → Sync setup'); return; }
    waitForGis(()=> tokenClient.requestAccessToken({ prompt: 'consent' }));
  }

  function signOut(){
    if(accessToken){ google.accounts.oauth2.revoke(accessToken, ()=>{}); }
    accessToken = null;
    localStorage.removeItem(LS_SIGNED_IN);
    localStorage.removeItem(LS_FILE_ID);
    localStorage.removeItem(LS_LAST_SYNC);
    fileId = null;
    setStatus('signed-out', 'Not signed in');
  }

  function authHeader(){ return { 'Authorization': 'Bearer ' + accessToken }; }

  function ensureFreshToken(){
    return new Promise((resolve, reject)=>{
      if(accessToken && Date.now() < tokenExpiresAt - 30000){ resolve(); return; }
      if(!tokenClient){ reject(new Error('no token client')); return; }
      const prevCb = tokenClient.callback;
      tokenClient.callback = (resp)=>{
        tokenClient.callback = prevCb;
        if(resp.error){ reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
        resolve();
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  async function ensureFile(){
    if(fileId) return fileId;
    const searchUrl = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,modifiedTime)&q=' + encodeURIComponent(`name='${FILE_NAME}'`);
    const res = await fetch(searchUrl, { headers: authHeader() });
    const json = await res.json();
    if(json.files && json.files.length){
      fileId = json.files[0].id;
      localStorage.setItem(LS_FILE_ID, fileId);
      return fileId;
    }
    // create it with current local data
    const boundary = 'ledgerboundary';
    const metadata = { name: FILE_NAME, parents: ['appDataFolder'] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(Store.data)}\r\n--${boundary}--`;
    const createRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': `multipart/related; boundary=${boundary}` }, authHeader()),
      body
    });
    const createJson = await createRes.json();
    fileId = createJson.id;
    localStorage.setItem(LS_FILE_ID, fileId);
    return fileId;
  }

  async function fetchRemote(){
    await ensureFreshToken();
    const id = await ensureFile();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: authHeader() });
    if(!res.ok) return null;
    try{ return await res.json(); }catch(e){ return null; }
  }

  async function pushLocal(){
    await ensureFreshToken();
    const id = await ensureFile();
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
      body: JSON.stringify(Store.data)
    });
    const now = new Date().toISOString();
    localStorage.setItem(LS_LAST_SYNC, now);
    setStatus('idle', 'Synced');
  }

  // Compares local vs remote timestamps; newer one wins and overwrites the other.
  async function reconcile(){
    try{
      setStatus('syncing', 'Syncing…');
      const remote = await fetchRemote();
      const localUpdated = (Store.data.meta && Store.data.meta.updatedAt) || 0;
      const remoteUpdated = (remote && remote.meta && remote.meta.updatedAt) || 0;
      if(remote && remoteUpdated > localUpdated){
        Store.data = remote;
        Store.save({ skipSync:true, skipTimestamp:true });
        toast('Pulled the latest data from Google Drive');
        if(typeof render === 'function') render();
      } else if(localUpdated > remoteUpdated){
        await pushLocal();
      } else {
        localStorage.setItem(LS_LAST_SYNC, new Date().toISOString());
      }
      setStatus('idle', 'Synced');
    }catch(err){
      console.warn(err);
      setStatus('error', 'Could not sync — check your connection');
    }
  }

  function scheduleSync(){
    if(!isSignedIn() || !isConfigured()) return;
    clearTimeout(pushTimer);
    setStatus('pending', 'Waiting to sync…');
    pushTimer = setTimeout(()=>{
      pushLocal().catch(err=>{ console.warn(err); setStatus('error', 'Could not sync — check your connection'); });
    }, 2500);
  }

  function syncNow(){
    if(!isSignedIn()){ toast('Sign in to Google first'); return; }
    reconcile();
  }

  return { init, signIn, signOut, syncNow, scheduleSync, onStatusChange, getStatus, isConfigured, isSignedIn };
})();

document.addEventListener('DOMContentLoaded', ()=> DriveSync.init());
