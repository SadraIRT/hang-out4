/* Hangout 4 - Toman + Live Sync + Host Panel */
const LS_USERS='hangout_users', LS_SESSION='hangout_session', LS_DATA='hangout_data_v2';
const COLORS=['#FF9F0A','#2ECC71','#3498DB','#9B59B6','#E74C3C','#1ABC9C','#F39C12','#34495E'];
const HOST_EMAIL = "sadra89.r@gmail.com";
const API_BASE = window.API_BASE || localStorage.getItem('API_BASE') || (location.hostname==='localhost' || location.hostname==='127.0.0.1' ? "" : "https://hangout-api.onrender.com"); // override via window.API_BASE or localStorage for Netlify/Vercel/Cloudflare/GitHub
const WS_BASE = API_BASE ? API_BASE.replace(/^http/,'ws') : "";
let USE_API = true;
let ws = null;
let hangoutsCache = [];
let usersCache = [];

function uid(){return Math.random().toString(36).slice(2,9)}
function nowISO(){return new Date().toISOString()}
function load(k,def){try{return JSON.parse(localStorage.getItem(k))||def}catch{return def}}
function save(k,v){localStorage.setItem(k,JSON.stringify(v))}

// Toman helpers
function formatToman(n){
  if(n==null || isNaN(n)) return '—';
  const sign=n<0?'-':'';
  n=Math.abs(Math.round(n));
  return sign + n.toLocaleString('en-US') + ' تومان';
}
function formatComma(n){ // for inputs display
  const s=String(n).replace(/,/g,'').replace(/\D/g,'');
  if(!s) return '';
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function parseComma(v){
  if(v==null) return 0;
  const s=String(v).replace(/,/g,'').replace(/\D/g,'');
  return parseInt(s||'0',10);
}
function formatRial(n){ return formatToman(n); } // alias for backward compat
function colorFor(name){
  let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))%COLORS.length;
  return COLORS[h];
}
function googleCalendarLink(title, dateStr, timeStr, place){
  try{
    const start = new Date(dateStr+'T'+(timeStr||'19:00')+':00');
    const end = new Date(start.getTime()+2*3600*1000);
    const fmt = d=> d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
    const params=new URLSearchParams({action:'TEMPLATE',text:title,dates:fmt(start)+'/'+fmt(end),details:'Hangout 4 - تومان',location:place||''});
    return 'https://calendar.google.com/calendar/render?'+params.toString();
  }catch{return '#'}
}
function mapsLink(place){ return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(place); }

// API helpers
async function apiFetch(path, opts={}){
  const url = (API_BASE || "") + path;
  const headers = {'Content-Type':'application/json', ...(opts.headers||{})};
  const res = await fetch(url, {...opts, headers});
  if(!res.ok){
    const txt = await res.text();
    throw new Error(txt || res.statusText);
  }
  const ct = res.headers.get('content-type')||'';
  if(ct.includes('application/json')) return res.json();
  return res;
}
async function checkApi(){
  try{
    await apiFetch('/api/health');
    USE_API = true;
    return true;
  }catch{
    USE_API = false;
    return false;
  }
}
async function apiRegister(name,email,pass){
  return apiFetch('/api/register',{method:'POST',body:JSON.stringify({name,email,password:pass})});
}
async function apiLogin(email,pass){
  return apiFetch('/api/login',{method:'POST',body:JSON.stringify({email,password:pass})});
}
async function apiListUsers(){
  return apiFetch('/api/users?requesterId='+(currentUser()?.id||''));
}
async function apiListHangouts(){
  const me=currentUser();
  if(!me) return [];
  try{
    const data = await apiFetch('/api/hangouts?userId='+encodeURIComponent(me.id));
    hangoutsCache = data;
    save(LS_DATA, data); // cache offline
    return data;
  }catch(e){
    console.warn('API hangouts fail, fallback local', e);
    USE_API=false;
    return load(LS_DATA,[]);
  }
}
async function apiCreateHangout(title,desc,members,createdBy){
  if(!USE_API) {
    // fallback local
    const h={id:uid(),title,description:desc,members:[...members],roles:{},status:'planning',createdAt:nowISO(),finalized:null,dates:[],places:[],activities:[],expenses:[],payments:[],comments:[]};
    h.roles[createdBy]='host'; members.forEach(m=>{ if(!h.roles[m]) h.roles[m]='member'; });
    const arr=load(LS_DATA,[]); arr.unshift(h); save(LS_DATA,arr); return h;
  }
  return apiFetch('/api/hangouts',{method:'POST',body:JSON.stringify({title,description:desc,members,createdBy})});
}
async function apiUpdateHangout(hangout){
  if(!USE_API){
    const arr=load(LS_DATA,[]); const idx=arr.findIndex(x=>x.id===hangout.id); if(idx>=0) arr[idx]=hangout; save(LS_DATA,arr); return hangout;
  }
  return apiFetch('/api/hangouts/'+hangout.id,{method:'PUT',body:JSON.stringify(hangout)});
}
async function apiKick(hid, requesterId, targetId){
  if(!USE_API) throw new Error('No API');
  return apiFetch('/api/hangouts/'+hid+'/kick',{method:'POST',body:JSON.stringify({requesterId,targetId})});
}
async function apiAdmin(hid, requesterId, targetId, action){
  return apiFetch('/api/hangouts/'+hid+'/admin',{method:'POST',body:JSON.stringify({requesterId,targetId,action})});
}
async function apiTransferHost(hid, requesterId, targetId){
  return apiFetch('/api/hangouts/'+hid+'/transfer-host',{method:'POST',body:JSON.stringify({requesterId,targetId})});
}
async function apiDeleteHangout(hid, requesterId){
  if(!USE_API){
    let arr=load(LS_DATA,[]).filter(h=>h.id!==hid); save(LS_DATA,arr); return {ok:true};
  }
  return apiFetch('/api/hangouts/'+hid+'?requesterId='+encodeURIComponent(requesterId),{method:'DELETE'});
}

// WebSocket - uses WS_BASE if external API, else same host
function connectWS(){
  const me=currentUser(); if(!me) return;
  if(ws) try{ ws.close(); }catch{}
  if(!USE_API) return;
  let url;
  if(API_BASE){
    url = WS_BASE + '/ws/' + encodeURIComponent(me.id);
  } else {
    const proto = location.protocol==='https:'?'wss:':'ws:';
    const host = location.host;
    if(!host) return; // file:// no ws
    url = proto+'//'+host+'/ws/'+encodeURIComponent(me.id);
  }
  try{
    ws = new WebSocket(url);
    ws.onopen = ()=> { console.log('WS live'); const dot=document.getElementById('liveDot'); if(dot) dot.innerHTML='<span style="width:8px;height:8px;background:var(--success);border-radius:50%;display:inline-block;animation:pulse 1s infinite"></span> Live Sync'; };
    ws.onmessage = (e)=>{
      try{
        const msg=JSON.parse(e.data);
        if(msg.type==='hangout_updated' || msg.type==='hangout_created' || msg.type==='hangouts_changed' || msg.type==='hangout_deleted'){
          refreshData();
        }
      }catch{}
    };
    ws.onclose = ()=> {
      const dot=document.getElementById('liveDot'); if(dot) dot.innerHTML='<span style="width:8px;height:8px;background:var(--danger);border-radius:50%;display:inline-block"></span> Offline';
      if(USE_API) setTimeout(connectWS, 3000);
    };
    ws.onerror = ()=> {};
  }catch(e){ console.warn('WS fail',e); }
}
async function refreshData(){
  await syncFromServer();
  render();
}
async function syncFromServer(){
  if(USE_API){
    try{
      const hangouts = await apiListHangouts();
      hangoutsCache = hangouts;
      const users = await apiListUsers();
      usersCache = users;
      // also sync users to local for fallback
      save(LS_USERS, users);
      // if host, also fetch passwords masked (host-only) in background
      const me = currentUser();
      const isHost = me && (me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase());
      if(isHost){
        try{
          const withPass = await apiFetch('/api/users/with-passwords?requesterId='+encodeURIComponent(me.id));
          usersCache = withPass;
          // do not overwrite LS_USERS with passwords? Keep but local will have them for offline host
          save(LS_USERS, withPass);
        }catch(e){ /* ignore */ }
      }
    }catch(e){ console.warn(e); }
  }
}

// Auth - now with API fallback
function switchAuth(which){
  document.getElementById('loginForm').classList.toggle('hidden', which!=='login');
  document.getElementById('registerForm').classList.toggle('hidden', which!=='register');
  document.getElementById('tabLogin').classList.toggle('active', which==='login');
  document.getElementById('tabRegister').classList.toggle('active', which==='register');
}
async function doRegister(){
  const name=document.getElementById('regName').value.trim();
  const email=document.getElementById('regEmail').value.trim().toLowerCase();
  const pass=document.getElementById('regPass').value;
  if(!name||!email||pass.length<4) return alert('Fill name, valid email, password ≥4');
  // try API first
  await checkApi();
  if(USE_API){
    try{
      const user=await apiRegister(name,email,pass);
      save(LS_SESSION,user); location.reload();
      return;
    }catch(e){
      return alert('Register failed: '+e.message);
    }
  }
  // local fallback
  const users=load(LS_USERS,[]);
  if(users.find(u=>u.email===email)) return alert('Email exists');
  const isHost = email===HOST_EMAIL.toLowerCase();
  const user={id:uid(), name, email, pass, color:colorFor(name), is_host:isHost, createdAt:nowISO()};
  users.push(user); save(LS_USERS,users);
  save(LS_SESSION,user); location.reload();
}
async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim().toLowerCase();
  const pass=document.getElementById('loginPass').value;
  await checkApi();
  if(USE_API){
    try{
      const u=await apiLogin(email,pass);
      save(LS_SESSION,u); location.reload(); return;
    }catch(e){
      // try local fallback as well
      const users=load(LS_USERS,[]);
      const lu=users.find(x=>x.email===email && x.pass===pass);
      if(lu){ save(LS_SESSION,lu); location.reload(); return;}
      return alert('Invalid credentials: '+e.message);
    }
  }
  const users=load(LS_USERS,[]);
  const u=users.find(x=>x.email===email && x.pass===pass);
  if(!u) return alert('Invalid credentials');
  save(LS_SESSION,u); location.reload();
}
async function doGuestLogin(){
  const name = prompt('Enter guest name (e.g., Mina):');
  if(!name || name.trim().length<2) return alert('Name required');
  const clean=name.trim();
  await checkApi();
  if(USE_API){
    try{
      const user=await apiFetch('/api/guest-login',{method:'POST',body:JSON.stringify({name:clean})});
      save(LS_SESSION, user);
      // also cache locally
      const users=load(LS_USERS,[]);
      users.push({id:user.id, name:user.name, email:user.email, pass:'guest', color:user.color, is_guest:true});
      save(LS_USERS, users);
      usersCache=users;
      location.reload();
      return;
    }catch(e){ alert('Guest login failed: '+e.message); return; }
  }
  // offline fallback
  const id='guest_'+uid();
  const email=`guest_${id.slice(6)}@guest.local`;
  const user={id, name:clean, email, pass:'guest', color:colorFor(clean), is_guest:true, is_host:false, createdAt:nowISO()};
  const users=load(LS_USERS,[]);
  users.push(user); save(LS_USERS, users); usersCache=users;
  save(LS_SESSION, user); location.reload();
}
function logout(){ localStorage.removeItem(LS_SESSION); if(ws) ws.close(); location.reload();}
function openForgotModal(){
  document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value.trim();
  document.getElementById('forgotPass').value='';
  document.getElementById('forgotPass2').value='';
  document.getElementById('forgotError').textContent='';
  document.getElementById('modalForgot').classList.remove('hidden');
}
async function doForgot(){
  const email=document.getElementById('forgotEmail').value.trim().toLowerCase();
  const p1=document.getElementById('forgotPass').value;
  const p2=document.getElementById('forgotPass2').value;
  const err=document.getElementById('forgotError');
  err.textContent='';
  if(!email) return err.textContent='Enter email';
  if(p1.length<4) return err.textContent='Password >=4 chars';
  if(p1!==p2) return err.textContent='Passwords do not match';
  await checkApi();
  if(USE_API){
    try{
      await apiFetch('/api/reset-password',{method:'POST',body:JSON.stringify({email,newPassword:p1})});
      closeModal('modalForgot');
      alert('Password reset! Now login with new password.');
      switchAuth('login');
      document.getElementById('loginEmail').value=email;
      return;
    }catch(e){
      return err.textContent='Failed: '+e.message;
    }
  }
  // local fallback
  const users=load(LS_USERS,[]);
  const u=users.find(x=>x.email===email);
  if(!u) return err.textContent='Email not found (local)';
  u.pass=p1;
  save(LS_USERS,users);
  closeModal('modalForgot');
  alert('Password reset (offline)! Login now.');
}
async function hostResetPassword(targetId, targetEmail){
  const newPass=prompt('New password for '+targetEmail+' (min 4 chars):');
  if(!newPass || newPass.length<4) return alert('Cancelled or too short');
  await checkApi();
  const me=currentUser();
  if(USE_API){
    try{
      await apiFetch('/api/reset-password',{method:'POST',body:JSON.stringify({email:targetEmail,newPassword:newPass,requesterId:me.id})});
      alert('Password reset for '+targetEmail);
      await syncFromServer();
      render();
    }catch(e){ alert('Reset failed: '+e.message); }
  } else {
    const users=load(LS_USERS,[]);
    const u=users.find(x=>x.id===targetId || x.email===targetEmail);
    if(!u) return alert('User not found locally');
    u.pass=newPass; save(LS_USERS,users); usersCache=users; alert('Reset (offline)'); render();
  }
}
async function deleteUserCompletely(targetId, targetEmail){
  if(!confirm('Delete user '+targetEmail+' completely?\nWill remove from ALL hangouts but KEEP their expenses as Deleted User.\nThis cannot be undone.')) return;
  const me=currentUser();
  if(targetId===me.id) return alert('Cannot delete yourself');
  await checkApi();
  if(USE_API){
    try{
      await apiFetch('/api/users/'+encodeURIComponent(targetId)+'?requesterId='+encodeURIComponent(me.id),{method:'DELETE'});
      alert('User '+targetEmail+' deleted completely (kept history)');
      await syncFromServer();
      render();
      await refreshHostPanel();
    }catch(e){ alert('Delete failed: '+e.message); }
  } else {
    // offline fallback
    let users=load(LS_USERS,[]);
    users=users.filter(x=>x.id!==targetId);
    save(LS_USERS,users); usersCache=users;
    let hangouts=load(LS_DATA,[]);
    hangouts.forEach(h=>{
      if(h.members.includes(targetId)){
        h.members=h.members.filter(m=>m!==targetId);
        if(h.roles) delete h.roles[targetId];
        [h.dates,h.places,h.activities].forEach(lst=>{
          (lst||[]).forEach(it=>{ if(it.votes) it.votes=it.votes.filter(v=>v!==targetId); });
        });
        if(h.createdBy===targetId && h.members.length) { h.createdBy=h.members[0]; if(h.roles) h.roles[h.members[0]]='host'; }
      }
    });
    hangouts=hangouts.filter(h=>h.members.length>0);
    save(LS_DATA,hangouts); hangoutsCache=hangouts;
    alert('User deleted (offline, kept history)'); render(); refreshHostPanel();
  }
}
function currentUser(){ return load(LS_SESSION,null); }
function allUsers(){
  if(usersCache.length) return usersCache;
  return load(LS_USERS,[]);
}

// Hangouts store - now async
async function getHangoutsAsync(){
  if(USE_API){
    if(hangoutsCache.length) return hangoutsCache;
    return await apiListHangouts();
  }
  return load(LS_DATA,[]);
}
function getHangouts(){ // sync fallback for existing sync code
  if(hangoutsCache.length) return hangoutsCache;
  return load(LS_DATA,[]);
}
async function saveHangoutsAsync(arr){
  hangoutsCache = arr;
  save(LS_DATA,arr);
  // if API, we already save via update calls, but for bulk save we need to push each?
}
function saveHangouts(arr){ save(LS_DATA,arr); hangoutsCache=arr; }
function getHangout(id){ return getHangouts().find(h=>h.id===id); }
async function updateHangoutAsync(id, fn){
  const arr = USE_API ? [...hangoutsCache] : load(LS_DATA,[]);
  const idx=arr.findIndex(h=>h.id===id);
  if(idx<0) return;
  fn(arr[idx]);
  // ensure roles exist
  if(!arr[idx].roles) arr[idx].roles={};
  if(USE_API){
    try{
      const updated = await apiUpdateHangout(arr[idx]);
      hangoutsCache = hangoutsCache.map(h=> h.id===id? updated : h);
      // update cache also from server list to keep consistency
    }catch(e){ alert('Sync failed: '+e.message); }
  } else {
    save(LS_DATA,arr);
  }
  render();
}
function updateHangout(id, fn){
  // synchronous wrapper for places where async not awaited; will try async but also local
  const arr=getHangouts(); const idx=arr.findIndex(h=>h.id===id);
  if(idx<0) return;
  fn(arr[idx]);
  if(USE_API){
    // fire and forget
    apiUpdateHangout(arr[idx]).then(updated=>{
      hangoutsCache = hangoutsCache.map(h=> h.id===id? updated : h);
      render();
    }).catch(e=>{ console.warn(e); save(LS_DATA,arr); render(); });
    // optimistic update
    hangoutsCache = arr;
    render();
  } else {
    saveHangouts(arr); render();
  }
}
async function seedIfEmpty(){
  const arr = USE_API ? hangoutsCache : load(LS_DATA,[]);
  if(arr.length>0) return;
  const me=currentUser(); if(!me) return;
  const users=allUsers();
  let members=[me.id];
  for(const u of users){ if(u.id!==me.id && members.length<10) members.push(u.id); }
  const guestNames=['Mina','Ali','Reza','Sara','Neda','Kian','Arman','Leila','Omid','Zahra'];
  while(members.length<10){
    const name=guestNames[members.length-1];
    const id='guest_'+uid();
    // create guest via API if possible? create local user
    if(USE_API){
      try{
        const g=await apiRegister(name, name.toLowerCase()+'@guest', 'guest');
        members.push(g.id);
      }catch{
        const us=load(LS_USERS,[]); us.push({id,name,email:name.toLowerCase()+'@guest',pass:'',color:colorFor(name)}); save(LS_USERS,us); members.push(id);
      }
    } else {
      const us=load(LS_USERS,[]); us.push({id,name,email:name.toLowerCase()+'@guest',pass:'',color:colorFor(name)}); save(LS_USERS,us); members.push(id);
    }
  }
  const hid=uid();
  const demo={
    id:hid, title:'Friday Cafe & Darband Hike', description:'Chill at cafe then hike - decide date & place',
    createdBy:me.id, members, roles:{}, status:'planning', createdAt:nowISO(),
    finalized:null,
    dates:[
      {id:uid(), date:'2026-09-04', time:'17:00', proposer:me.id, votes:[me.id]},
      {id:uid(), date:'2026-09-05', time:'10:00', proposer:me.id, votes:[]},
    ],
    places:[
      {id:uid(), name:'Cafe Naderi', address:'Valiasr St', proposer:me.id, votes:[me.id]},
      {id:uid(), name:'Darband Trail', address:'Darband, Tehran', proposer:me.id, votes:[]},
    ],
    activities:[
      {id:uid(), name:'Board games', proposer:me.id, votes:[me.id]},
      {id:uid(), name:'Hiking', proposer:me.id, votes:[]},
    ],
    expenses:[
      {id:uid(), desc:'Taxi to cafe', amount:25000, payerId:members[0], date:nowISO(), splitType:'equal', splits: members.map(mid=>({userId:mid, amount: Math.round(25000/members.length)}))},
      {id:uid(), desc:'Dinner', amount:120000, payerId:members[1]||members[0], date:nowISO(), splitType:'equal', splits: members.map(mid=>({userId:mid, amount: Math.round(120000/members.length)}))},
    ],
    payments:[],
    comments:[
      {id:uid(), userId:me.id, text:'Hey team! Vote dates 🗓️ - now in تومان', at:nowISO()},
    ]
  };
  demo.roles[me.id]='host'; members.forEach(m=>{ if(!demo.roles[m]) demo.roles[m]='member'; });
  if(USE_API){
    try{ await apiCreateHangout(demo.title,demo.description,members,me.id); await syncFromServer(); }
    catch{ saveHangouts([demo]); }
  } else {
    saveHangouts([demo]);
  }
}
let currentHangoutId=null;
let tempMembers=[];
let pollContext={type:null, hangoutId:null};

// Navigation
function router(view){
  if(view==='dashboard'){
    currentHangoutId=null;
    document.getElementById('dashboardView').classList.remove('hidden');
    document.getElementById('hangoutView').classList.add('hidden');
  }
  document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('active'));
  const nd=document.getElementById('navDashboard'); if(nd) nd.classList.toggle('active', view==='dashboard');
  render();
}
function openHangout(id){
  currentHangoutId=id;
  document.getElementById('dashboardView').classList.add('hidden');
  document.getElementById('hangoutView').classList.remove('hidden');
  activeTab='plan';
  render();
}
let activeTab='plan';
function setTab(t){ activeTab=t; renderHangout(); }

// Render
async function render(){
  const me=currentUser();
  if(!me){
    document.getElementById('authView').classList.remove('hidden');
    document.getElementById('appView').classList.add('hidden');
    return;
  }
  document.getElementById('authView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  document.getElementById('meName').textContent=me.name;
  document.getElementById('meEmail').textContent=me.email + (me.is_host || me.email===HOST_EMAIL ? ' (Host)' : '');
  const av=document.getElementById('meAvatar'); av.textContent=me.name[0].toUpperCase(); av.style.background=me.color;
  // show host panel button if host
  const hostBtn=document.getElementById('navHost');
  if(hostBtn){
    const isHost = me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase();
    // also check hangout host roles
    hostBtn.classList.toggle('hidden', !isHost && !getHangouts().some(h=> h.roles && h.roles[me.id]==='host'));
    // for global host always show
    if(isHost) hostBtn.classList.remove('hidden');
  }
  await syncFromServer();
  await seedIfEmpty();
  await syncFromServer();
  const hangouts= USE_API ? hangoutsCache : load(LS_DATA,[]);
  const myHangouts = (()=>{
    if(me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase()) return hangouts;
    return hangouts.filter(h=>h.members.includes(me.id));
  })();
  document.getElementById('sidebarStats').innerHTML = `${myHangouts.length} hangouts<br>${hangouts.reduce((a,h)=>a+h.expenses.length,0)} expenses<br>Total: ${formatToman(myHangouts.reduce((a,h)=>a+h.expenses.reduce((s,e)=>s+e.amount,0),0))}<br><span class="subtle">${USE_API?'● Live Sync ON':'○ Offline (local)'} </span>`;
  if(currentHangoutId){
    renderHangout();
  } else {
    renderDashboard();
  }
}
function renderDashboard(){
  const me=currentUser();
  const all = getHangouts();
  const hangouts = (me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase()) ? all : all.filter(h=>h.members.includes(me.id));
  const el=document.getElementById('dashboardView');
  const filter = window._dashFilter || 'all';
  let filtered=hangouts;
  if(filter==='planning') filtered=hangouts.filter(h=>h.status==='planning');
  if(filter==='finalized') filtered=hangouts.filter(h=>h.status==='finalized');
  if(filter==='done') filtered=hangouts.filter(h=>h.status==='done');
  el.innerHTML=`
    <div class="topbar">
      <div><h2 style="font-size:22px">Dashboard</h2></div>
      <div class="flex" style="gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="forceRefresh()">⟳ Sync Now</button>
        <button class="btn btn-primary" onclick="openCreateModal()">+ New Hangout</button>
      </div>
    </div>
    <div class="flex" style="gap:8px;margin-bottom:12px">
      <button class="btn ${filter==='all'?'btn-primary':'btn-ghost'} btn-sm" onclick="setDashFilter('all')">All</button>
      <button class="btn ${filter==='planning'?'btn-primary':'btn-ghost'} btn-sm" onclick="setDashFilter('planning')">Planning</button>
      <button class="btn ${filter==='finalized'?'btn-primary':'btn-ghost'} btn-sm" onclick="setDashFilter('finalized')">Finalized</button>
      <button class="btn ${filter==='done'?'btn-primary':'btn-ghost'} btn-sm" onclick="setDashFilter('done')">Done</button>
    </div>
    <div class="stat-row">
      <div class="stat"><b>${hangouts.length}</b><span>Hangouts</span></div>
      <div class="stat"><b>${formatToman(hangouts.reduce((a,h)=>a+h.expenses.reduce((s,e)=>s+e.amount,0),0))}</b><span>Total spent</span></div>
      <div class="stat"><b>${hangouts.filter(h=>h.status==='planning').length}</b><span>Need vote</span></div>
    </div>
    ${filtered.length===0? `<div class="empty">No hangouts in this filter. Create one for your group!</div>` : `
    <div class="grid hangout-grid">
      ${filtered.map(h=>{
        const usersMap=usersById();
        const membersHtml=h.members.map(mid=>{
          const u=usersMap[mid]; if(!u) return '';
          const role=h.roles? h.roles[mid] : (mid===h.createdBy?'host':'member');
          return `<div class="avatar avatar-xs" style="background:${u.color}" title="${u.name} ${role}">${u.name[0].toUpperCase()}</div>`;
        }).join('');
        const total=h.expenses.reduce((s,e)=>s+e.amount,0);
        const balance=computeNetForHangout(h)[me.id]||0;
        return `<div class="card card-hover" style="cursor:pointer" onclick="openHangout('${h.id}')">
          <div class="flex justify-between"><span class="status status-${h.status==='planning'?'planning':h.status==='finalized'?'finalized':'done'}">${h.status}</span><span class="subtle">${new Date(h.createdAt).toLocaleDateString()}</span></div>
          <div style="font-weight:800;margin:8px 0">${h.title}</div>
          <div class="subtle" style="font-size:13px;margin-bottom:8px">${h.description||'—'}</div>
          <div class="flex">${membersHtml}<span class="subtle" style="margin-left:6px">${h.members.length}/10 members</span></div>
          <div class="divider"></div>
          <div class="flex justify-between"><span class="subtle">${h.expenses.length} expenses · ${formatToman(total)}</span><span class="${balance>=0?'balance-pos':'balance-neg'}" style="font-weight:800;font-size:12px">${balance>=0?'You get '+formatToman(balance):'You owe '+formatToman(-balance)}</span></div>
          ${h.finalized? `<div class="subtle" style="margin-top:6px">📅 ${h.finalized.date} · 📍 ${h.finalized.place}</div>`:''}
        </div>`;
      }).join('')}
    </div>`}
    <div class="card" style="margin-top:14px">
      <div style="font-weight:800;margin-bottom:6px">How splitting works (تومان)</div>
      <div class="subtle">Equal · Custom amounts · Percentages · Shares. Amounts auto-format with commas while typing. Balances in تومان.</div>
      <div class="flex" style="margin-top:10px;gap:8px;flex-wrap:wrap"><span class="badge">Equal</span><span class="badge">Exact تومان</span><span class="badge">% percent</span><span class="badge">Shares 2:1:1</span><span class="badge badge-accent">Min transfers</span><span class="badge">Live Sync</span></div>
    </div>
  `;
}
function setDashFilter(f){ window._dashFilter=f; renderDashboard(); }
function usersById(){
  const map={}; for(const u of allUsers()) map[u.id]=u; return map;
}
function memberName(id){
  const u=usersById()[id]; return u? u.name : 'Guest';
}
function avatarHtml(id, size='sm'){
  const u=usersById()[id]; if(!u) return '';
  const cls = size==='xs'?'avatar-xs': size==='sm'?'avatar-sm':'avatar';
  return `<div class="${'avatar '+cls}" style="background:${u.color}">${u.name[0].toUpperCase()}</div>`;
}
function roleBadge(h, uid){
  const r = h.roles ? h.roles[uid] : (uid===h.createdBy?'host':'member');
  if(r==='host') return '<span class="badge badge-accent">Host</span>';
  if(r==='admin') return '<span class="badge" style="background:rgba(46,204,113,.15);color:var(--success)">Admin</span>';
  return '<span class="badge">member</span>';
}

function renderHangout(){
  const h=getHangout(currentHangoutId);
  if(!h) return router('dashboard');
  const me=currentUser();
  const usersMap=usersById();
  const el=document.getElementById('hangoutView');
  const total=h.expenses.reduce((s,e)=>s+e.amount,0);
  const myRole = h.roles ? h.roles[me.id] : (me.id===h.createdBy?'host':'member');
  const isHostOrAdmin = myRole==='host' || myRole==='admin' || me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase();
  el.innerHTML=`
    <button class="btn btn-ghost btn-sm" onclick="router('dashboard')">← Back to dashboard</button>
    <div class="card" style="margin-top:12px">
      <div class="flex justify-between" style="flex-wrap:wrap;gap:8px">
        <div><div style="font-size:22px;font-weight:900">${h.title}</div><div class="subtle">${h.description||''}</div></div>
        <div class="flex" style="gap:6px">
          <span class="status status-${h.status==='planning'?'planning':h.status==='finalized'?'finalized':'done'}">${h.status}</span>
          <button class="btn btn-ghost btn-sm" onclick="markDone('${h.id}')">${h.status==='done'?'Reopen':'Mark done'}</button>
          ${isHostOrAdmin ? `<button class="btn btn-ghost btn-sm" onclick="deleteHangout('${h.id}')" style="color:var(--danger)">Delete</button>` : ``}
          <button class="btn btn-primary btn-sm" onclick="openHostPanelForHangout('${h.id}')">Manage</button>
        </div>
      </div>
      <div class="flex" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        ${h.members.map(mid=>`<span class="badge" style="display:flex;align-items:center;gap:6px">${avatarHtml(mid,'xs')} ${memberName(mid)}</span>`).join('')}
        ${isHostOrAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openHostPanelForHangout('${h.id}')">Edit members</button>` : ``}
      </div>
      ${h.finalized? `<div style="margin-top:10px;padding:10px;background:rgba(46,204,113,.1);border:1px solid rgba(46,204,113,.3);border-radius:10px">✅ Finalized: <b>${h.finalized.date} ${h.finalized.time||''}</b> · 📍 <a href="${mapsLink(h.finalized.place)}" target="_blank">${h.finalized.place}</a> · 🎯 ${h.finalized.activity||''} <a href="${googleCalendarLink(h.title, h.finalized.date, h.finalized.time, h.finalized.place)}" target="_blank" class="btn btn-primary btn-sm" style="margin-left:8px">Add to Google Calendar</a></div>` : ''}
    </div>
    <div class="tab-bar">
      <button class="${activeTab==='plan'?'active':''}" onclick="setTab('plan')">📅 Plan & Vote</button>
      <button class="${activeTab==='expenses'?'active':''}" onclick="setTab('expenses')">💰 Expenses (${h.expenses.length}) · ${formatToman(total)}</button>
      <button class="${activeTab==='balances'?'active':''}" onclick="setTab('balances')">⚖️ Balances & Settle</button>
      <button class="${activeTab==='chat'?'active':''}" onclick="setTab('chat')">💬 Chat (${h.comments.length})</button>
      ${isHostOrAdmin ? `<button class="${activeTab==='host'?'active':''}" onclick="setTab('host')">Host</button>` : ``}
    </div>
    <div id="tabContent"></div>
  `;
  const tc=document.getElementById('tabContent');
  if(activeTab==='plan') renderPlanTab(h, tc);
  else if(activeTab==='expenses') renderExpensesTab(h, tc);
  else if(activeTab==='balances') renderBalancesTab(h, tc);
  else if(activeTab==='chat') renderChatTab(h, tc);
  else if(activeTab==='host') renderHostTab(h, tc);
}

function renderPlanTab(h, container){
  const me=currentUser();
  function pollList(title, items, type, icon){
    return `<div class="card" style="margin-bottom:12px">
      <div class="flex justify-between"><div style="font-weight:800">${icon} ${title}</div><button class="btn btn-primary btn-sm" onclick="openPoll('${type}')">+ Add</button></div>
      ${items.length===0? `<div class="empty" style="margin-top:10px">No options yet — propose one!</div>` :
        items.map(it=>{
          const isVoted=it.votes.includes(me.id);
          const pct=Math.round(it.votes.length / h.members.length *100);
          const proposerName=memberName(it.proposer);
          let label='';
          if(type==='dates') label=`${it.date} · ${it.time}`;
          if(type==='places') label=`${it.name} — ${it.address||''}`;
          if(type==='activities') label=it.name;
          return `<div class="poll-item ${isVoted?'voted':''}">
            <div style="flex:1">
              <div style="font-weight:700">${label}</div>
              <div class="subtle">by ${proposerName} · ${it.votes.length}/${h.members.length} votes</div>
              <div class="progress" style="margin-top:6px"><i style="width:${pct}%"></i></div>
            </div>
            <div style="text-align:right">
              <div class="vote-row" style="justify-content:flex-end">${it.votes.map(v=>avatarHtml(v,'xs')).join('')}</div>
              <div style="margin-top:6px;display:flex;gap:6px;justify-content:flex-end">
                <button class="btn ${isVoted?'btn-primary':'btn-ghost'} btn-sm" onclick="toggleVote('${h.id}','${type}','${it.id}')">${isVoted?'✓ Voted':'Vote'}</button>
                ${type==='places'? `<a href="${mapsLink(it.name+' '+ (it.address||''))}" target="_blank" class="btn btn-ghost btn-sm">🗺 Map</a>`:''}
                ${type==='dates'? `<a href="${googleCalendarLink(h.title, it.date, it.time, '')}" target="_blank" class="btn btn-ghost btn-sm">📅 Cal</a>`:''}
              </div>
            </div>
          </div>`;
        }).join('')
      }
      <div style="margin-top:10px" class="subtle">Each member can vote for multiple options. Majority wins → finalize below.</div>
    </div>`;
  }
  const topDate = [...h.dates].sort((a,b)=>b.votes.length-a.votes.length)[0];
  const topPlace = [...h.places].sort((a,b)=>b.votes.length-a.votes.length)[0];
  const topAct = [...h.activities].sort((a,b)=>b.votes.length-a.votes.length)[0];
  container.innerHTML=`
    ${pollList('Date poll', h.dates, 'dates', '📅')}
    ${pollList('Location vote', h.places, 'places', '📍')}
    ${pollList('Activity ideas', h.activities, 'activities', '🎯')}
    <div class="card">
      <div style="font-weight:800">Finalize hangout</div>
      <div class="subtle">Pick final choices (or leave empty to use most-voted). This creates Calendar & Map links.</div>
      <div class="row2" style="margin-top:10px">
        <div class="field"><label>Date</label><input id="finDate" type="date" value="${h.finalized?.date || topDate?.date || ''}"><input id="finTime" type="time" value="${h.finalized?.time || topDate?.time || '19:00'}" style="margin-top:6px"></div>
        <div class="field"><label>Place</label><input id="finPlace" placeholder="Cafe Naderi" value="${h.finalized?.place || topPlace?.name || ''}"></div>
      </div>
      <div class="field"><label>Activity</label><input id="finAct" placeholder="Board games" value="${h.finalized?.activity || topAct?.name || ''}"></div>
      <div class="flex justify-between" style="margin-top:8px">
        <span class="subtle">${h.finalized? '✅ Finalized' : 'Not finalized yet'}</span>
        <button class="btn btn-primary" onclick="finalizeHangout()">Finalize → Calendar</button>
      </div>
    </div>
  `;
}
function renderExpensesTab(h, container){
  container.innerHTML=`
    <div class="flex justify-between" style="margin-bottom:10px"><div style="font-weight:800">Expenses (تومان)</div><button class="btn btn-primary" onclick="openExpenseModal()">+ Add expense</button></div>
    ${h.expenses.length===0? `<div class="empty">No expenses yet. Add taxi, food, tickets — split equal or custom. Amounts in تومان with auto-comma.</div>` :
      h.expenses.map(e=>{
        const payer=memberName(e.payerId);
        return `<div class="expense-row">
          <div style="width:44px;height:44px;background:var(--card);border:1px solid var(--border);border-radius:10px;display:grid;place-items:center;font-weight:900;color:var(--accent)">ت</div>
          <div style="flex:1">
            <div style="font-weight:800">${e.desc} <span class="badge" style="margin-left:6px">${e.splitType}</span></div>
            <div class="subtle">Paid by ${payer} · ${new Date(e.date).toLocaleDateString()} · Split among ${e.splits.length}</div>
            <div class="subtle" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${e.splits.map(s=>`<span class="badge">${memberName(s.userId)}: ${formatToman(s.amount)}</span>`).join('')}</div>
          </div>
          <div style="text-align:right"><div style="font-weight:900">${formatToman(e.amount)}</div><button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteExpense('${e.id}')">Remove</button></div>
        </div>`;
      }).join('')
    }
  `;
}
function renderBalancesTab(h, container){
  const net=computeNetForHangout(h);
  const transfers=simplifyDebts(net);
  const total=h.expenses.reduce((s,e)=>s+e.amount,0);
  const sumPaid={}; h.members.forEach(m=>sumPaid[m]=0);
  h.expenses.forEach(e=>{ sumPaid[e.payerId]=(sumPaid[e.payerId]||0)+e.amount; });
  const avg = h.members.length? total / h.members.length : 0;
  container.innerHTML=`
    <div class="stat-row">
      <div class="stat"><b>${formatToman(total)}</b><span>Total spent</span></div>
      <div class="stat"><b>${formatToman(avg)}</b><span>Avg per person</span></div>
      <div class="stat"><b>${h.payments.length}</b><span>Payments recorded</span></div>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:12px">
      ${h.members.map(mid=>{
        const u=usersById()[mid];
        const n=net[mid]||0;
        const paid=sumPaid[mid]||0;
        const owed=paid - n;
        return `<div class="balance-card">
          <div class="flex">${avatarHtml(mid,'sm')}<b>${u?u.name:'?'}</b></div>
          <div class="subtle" style="margin-top:6px">Paid ${formatToman(paid)} · Owed ${formatToman(owed)}</div>
          <div style="font-weight:900;margin-top:4px" class="${n>1?'balance-pos': n<-1?'balance-neg':'balance-zero'}">${n>0? 'Gets '+formatToman(n) : n<0? 'Owes '+formatToman(-n) : 'Settled ✔'}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="flex justify-between"><div style="font-weight:800">Settlement plan (minimal transfers)</div><button class="btn btn-primary btn-sm" onclick="openPaymentModal()">Record payment</button></div>
      ${transfers.length===0? `<div class="empty" style="margin-top:10px">All settled! No transfers needed.</div>` :
        transfers.map(t=>`<div class="transfer"><span>${avatarHtml(t.from)} <b>${memberName(t.from)}</b> → ${avatarHtml(t.to)} <b>${memberName(t.to)}</b></span><b>${formatToman(t.amount)}</b></div>`).join('')
      }
      <div class="subtle" style="margin-top:8px">Algorithm: net = paid − owed, then greedy min-cash-flow (≤9 transfers for 10 people).</div>
    </div>
    ${h.payments.length? `
    <div class="card">
      <div style="font-weight:800;margin-bottom:8px">Payment history</div>
      ${h.payments.map(p=>`<div class="flex justify-between" style="padding:8px 0;border-bottom:1px solid var(--border)"><span>${memberName(p.from)} → ${memberName(p.to)} · ${p.note||''} <span class="subtle">(${new Date(p.date).toLocaleDateString()})</span></span><b>${formatToman(p.amount)}</b></div>`).join('')}
    </div>`:''}
  `;
}
function renderChatTab(h, container){
  container.innerHTML=`
    <div class="card">
      <div style="font-weight:800;margin-bottom:8px">💬 Group chat — plan the hangout</div>
      <div style="max-height:320px;overflow:auto;padding:4px">
        ${h.comments.length===0? `<div class="empty">No messages. Say hi!</div>` : h.comments.map(c=>`
          <div class="comment">
            <div class="flex justify-between"><span class="flex">${avatarHtml(c.userId,'xs')} <b style="font-size:13px">${memberName(c.userId)}</b> <span class="subtle" style="font-size:11px">${new Date(c.at).toLocaleString()}</span></span></div>
            <div style="margin-top:6px">${escapeHtml(c.text)}</div>
          </div>
        `).join('')}
      </div>
      <div class="flex" style="margin-top:10px">
        <input id="chatInput" placeholder="Message to group..." onkeydown="if(event.key==='Enter') sendComment()">
        <button class="btn btn-primary" onclick="sendComment()">Send</button>
      </div>
    </div>
  `;
}
function renderHostTab(h, container){
  const me=currentUser();
  const myRole = h.roles ? h.roles[me.id] : 'member';
  const isHost = myRole==='host' || me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase();
  const isAdmin = myRole==='admin';
  container.innerHTML=`
    <div class="card">
      <div style="font-weight:800">Host Controls for "${h.title}"</div>
      <div class="subtle">Kick members, make admin, transfer host. Live synced.</div>
      <div style="margin-top:12px" class="grid">
        ${h.members.map(mid=>{
          const u=usersById()[mid];
          const role=h.roles ? h.roles[mid] : 'member';
          const canKick = isHost || (isAdmin && role==='member');
          const canMakeAdmin = isHost && role==='member';
          const canRevoke = isHost && role==='admin';
          const canTransfer = isHost && mid!==me.id;
          const realPass = u?.pass || '';
          const passHtml = isHost && realPass ? `<div class="flex" style="gap:4px;margin-top:4px;align-items:center"><span class="badge" style="font-family:monospace"><span class="pass-text" data-hidden="true">••••</span></span><button class="btn btn-ghost btn-sm" style="padding:3px 6px;font-size:10px" onclick="togglePass(this, '${escapeHtml(realPass).replace(/'/g,"\\'")}')">👁 Show</button><button class="btn btn-ghost btn-sm" style="padding:3px 6px;font-size:10px" onclick="copyPass('${escapeHtml(realPass).replace(/'/g,"\\'")}')">Copy</button></div>` : ``;
          return `<div class="flex justify-between" style="padding:10px;background:var(--card2);border:1px solid var(--border);border-radius:10px">
            <div class="flex">${avatarHtml(mid,'sm')}<div><div style="font-weight:700">${u?u.name:'?'} ${mid===me.id?'(You)':''}</div><div class="subtle" style="font-size:11px">${u?u.email:''}</div>${passHtml}</div> ${roleBadge(h,mid)}</div>
            <div class="flex" style="gap:6px;flex-wrap:wrap">
              ${canMakeAdmin ? `<button class="btn btn-ghost btn-sm" onclick="makeAdmin('${mid}')">Make Admin</button>` : ``}
              ${canRevoke ? `<button class="btn btn-ghost btn-sm" onclick="revokeAdmin('${mid}')">Revoke Admin</button>` : ``}
              ${canTransfer ? `<button class="btn btn-ghost btn-sm" onclick="transferHost('${mid}')">Make Host</button>` : ``}
              ${isHost ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent);border-color:var(--accent)" onclick="hostResetPassword('${mid}','${usersById()[mid]?.email||''}')">🔑 Reset PW</button>` : ``}
              ${canKick ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="kickUser('${mid}')">Kick</button>` : ``}
            </div>
          </div>`;
        }).join('')}
      </div>
      ${isHost ? `<div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="openHostPanel()">🌐 Global Host Panel (all hangouts)</button></div>` : ``}
    </div>
  `;
}
function escapeHtml(s){ return s.replace(/[&<>]/g, m=> ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
function togglePass(btn, realPass){
  const container = btn.parentElement.querySelector('.pass-text');
  const isHidden = container.dataset.hidden === 'true';
  if(isHidden){
    container.textContent = realPass;
    container.dataset.hidden = 'false';
    btn.textContent = '🙈 Hide';
  } else {
    container.textContent = '••••';
    container.dataset.hidden = 'true';
    btn.textContent = '👁 Show';
  }
}
function copyPass(text){
  navigator.clipboard.writeText(text).then(()=> alert('Copied: '+text)).catch(()=> prompt('Copy password:', text));
}

// Host Panel Global
async function openHostPanel(){
  const me=currentUser(); if(!me) return;
  document.getElementById('modalHost').classList.remove('hidden');
  await refreshHostPanel();
}
function openHostPanelForHangout(id){
  currentHangoutId=id;
  activeTab='host';
  renderHangout();
}
async function refreshHostPanel(){
  const me=currentUser();
  const isGlobalHost = me.is_host || me.email.toLowerCase()===HOST_EMAIL.toLowerCase();
  const hangouts = getHangouts();
  let users = allUsers();
  // host can see passwords (masked + eye toggle)
  let usersWithPass = null;
  if(isGlobalHost){
    if(USE_API){
      try{ usersWithPass = await apiFetch('/api/users/with-passwords?requesterId='+encodeURIComponent(me.id)); users = usersWithPass; usersCache = usersWithPass; save(LS_USERS, usersWithPass); }catch(e){ console.warn('with-pass fail',e); }
    } else {
      usersWithPass = users; // local already has pass
    }
  }
  const el=document.getElementById('hostContent');
  document.getElementById('hostInfo').textContent = isGlobalHost ? `Global Host: ${me.email} — you can manage all hangouts & users (passwords masked)` : `Host panel — manage your hangouts`;
  el.innerHTML=`
    <div class="card" style="margin-bottom:12px">
      <div style="font-weight:800">All Users (${users.length}) ${isGlobalHost? '<span class="subtle">· masked + 👁 toggle, host-only</span>':''}</div>
      <div class="grid" style="gap:6px;margin-top:8px">
        ${users.map(u=>{
          const realPass = (usersWithPass && usersWithPass.find(x=>x.id===u.id)?.pass) || u.pass || '••••';
          const hasPass = realPass && realPass!=='••••';
          // only host sees pass controls
          const passHtml = isGlobalHost && hasPass ? `<span class="flex" style="gap:4px;align-items:center"><span class="badge" style="font-family:monospace"><span class="pass-text" data-hidden="true">••••</span></span><button class="btn btn-ghost btn-sm" onclick="togglePass(this, '${escapeHtml(realPass).replace(/'/g,"\\'")}')">👁 Show</button><button class="btn btn-ghost btn-sm" onclick="copyPass('${escapeHtml(realPass).replace(/'/g,"\\'")}')">Copy</button></span>` : `<span class="subtle">••••</span>`;
          return `<div class="flex justify-between" style="padding:8px;background:var(--card2);border:1px solid var(--border);border-radius:8px">
          <span class="flex" style="flex-wrap:wrap;gap:6px">${avatarHtml(u.id,'xs')} <b>${u.name}</b> <span class="subtle">${u.email}</span> ${u.is_host? '<span class="badge badge-accent">Host</span>':''} ${isGlobalHost? passHtml : ''}</span>
          <span class="flex" style="gap:6px;flex-shrink:0;flex-wrap:wrap"><span class="subtle">${u.id.slice(0,6)}</span>${isGlobalHost ? `<button class="btn btn-ghost btn-sm" onclick="hostResetPassword('${u.id}','${u.email}')">🔑 Reset</button>` : ``}${isGlobalHost && u.id!==me.id && !u.is_host ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="deleteUserCompletely('${u.id}','${u.email}')">🗑 Delete</button>` : ``}</span>
        </div>`;
        }).join('')}
      </div>
    </div>
    <div class="card">
      <div style="font-weight:800">All Hangouts (${hangouts.length})</div>
      <div class="grid" style="gap:8px;margin-top:8px">
        ${hangouts.map(h=>`
          <div style="padding:10px;background:var(--card2);border:1px solid var(--border);border-radius:10px">
            <div class="flex justify-between"><b>${h.title}</b><span class="badge">${h.members.length}/10</span></div>
            <div class="subtle">${h.members.map(mid=> memberName(mid) + ' ' + (h.roles? h.roles[mid] : '')).join(', ')}</div>
            <div class="flex" style="margin-top:6px;gap:6px">
              <button class="btn btn-ghost btn-sm" onclick="openHangout('${h.id}'); closeModal('modalHost');">Open</button>
              ${isGlobalHost ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteHangout('${h.id}')">Delete Hangout</button>` : ``}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Actions
function openCreateModal(){
  tempMembers=[currentUser().id];
  renderMemberPicker();
  document.getElementById('newTitle').value='';
  document.getElementById('newDesc').value='';
  document.getElementById('customMember').value='';
  document.getElementById('modalCreate').classList.remove('hidden');
}
function renderMemberPicker(){
  const users=allUsers();
  const el=document.getElementById('memberPicker');
  el.innerHTML=users.map(u=>{
    const checked=tempMembers.includes(u.id);
    const isMe=u.id===currentUser().id;
    return `<label class="flex" style="padding:6px 8px;background:var(--card2);border:1px solid var(--border);border-radius:8px;cursor:pointer">
      <input type="checkbox" ${checked?'checked':''} ${isMe?'disabled':''} onchange="toggleMember('${u.id}')" style="width:auto"> ${avatarHtml(u.id,'xs')} ${u.name} <span class="subtle" style="margin-left:auto">${u.email}</span> ${isMe?'<span class="badge badge-accent">You</span>':''}
    </label>`;
  }).join('') + `<div class="subtle">${tempMembers.length}/10 selected</div>`;
}
function toggleMember(id){
  if(tempMembers.includes(id)) tempMembers=tempMembers.filter(x=>x!==id);
  else {
    if(tempMembers.length>=10) return alert('Max 10 members');
    tempMembers.push(id);
  }
  renderMemberPicker();
}
async function addCustomMember(){
  const inp=document.getElementById('customMember');
  const name=inp.value.trim();
  if(!name) return;
  if(tempMembers.length>=10) return alert('Max 10');
  if(USE_API){
    try{
      const g=await apiRegister(name, name.toLowerCase()+'@guest', 'guest');
      usersCache.push(g);
      tempMembers.push(g.id); inp.value=''; renderMemberPicker();
      return;
    }catch(e){ /* fallback */ }
  }
  const id='guest_'+uid();
  const users=load(LS_USERS,[]); users.push({id, name, email:name.toLowerCase()+'@guest', pass:'', color:colorFor(name)}); save(LS_USERS,users);
  tempMembers.push(id); inp.value=''; renderMemberPicker();
}
async function createHangout(){
  const title=document.getElementById('newTitle').value.trim();
  if(!title) return alert('Title required');
  if(tempMembers.length<2) return alert('Invite at least 1 member');
  if(tempMembers.length>10) return alert('Max 10');
  const desc=document.getElementById('newDesc').value.trim();
  const me=currentUser();
  try{
    if(USE_API){
      const h=await apiCreateHangout(title,desc,tempMembers,me.id);
      hangoutsCache.unshift(h);
    } else {
      const h={id:uid(), title, description:desc, createdBy:me.id, members:[...tempMembers], roles:{}, status:'planning', createdAt:nowISO(), finalized:null, dates:[], places:[], activities:[], expenses:[], payments:[], comments:[]};
      h.roles[me.id]='host'; tempMembers.forEach(m=>{ if(!h.roles[m]) h.roles[m]='member'; });
      const arr=getHangouts(); arr.unshift(h); saveHangouts(arr);
      currentHangoutId=h.id;
    }
    closeModal('modalCreate'); 
    // fetch fresh
    await syncFromServer();
    // find created hangout (last created)
    const all=getHangouts();
    const created = all.find(x=> x.title===title && x.createdBy===me.id) || all[0];
    currentHangoutId=created.id; activeTab='plan'; render();
  }catch(e){ alert('Create failed: '+e.message); }
}
function closeModal(id){ document.getElementById(id).classList.add('hidden'); }
function openPoll(type){
  pollContext.type=type;
  const fields=document.getElementById('pollFields');
  document.getElementById('pollTitle').textContent = type==='dates'? 'Add date option' : type==='places'? 'Add location' : 'Add activity';
  if(type==='dates'){
    fields.innerHTML=`<div class="field"><label>Date</label><input id="pollDate" type="date"></div><div class="field"><label>Time</label><input id="pollTime" type="time" value="19:00"></div>`;
  } else if(type==='places'){
    fields.innerHTML=`<div class="field"><label>Place name</label><input id="pollPlaceName" placeholder="Cafe Naderi"></div><div class="field"><label>Address (optional)</label><input id="pollPlaceAddr" placeholder="Valiasr St"><div class="hint">Map link auto-generated.</div></div>`;
  } else {
    fields.innerHTML=`<div class="field"><label>Activity</label><input id="pollActName" placeholder="Hiking, Bowling, Movie..."></div>`;
  }
  document.getElementById('modalPoll').classList.remove('hidden');
}
function savePoll(){
  const type=pollContext.type;
  const h=getHangout(currentHangoutId);
  if(!h) return;
  if(type==='dates'){
    const d=document.getElementById('pollDate').value;
    const t=document.getElementById('pollTime').value||'19:00';
    if(!d) return alert('Pick date');
    const item={id:uid(), date:d, time:t, proposer:currentUser().id, votes:[currentUser().id]};
    updateHangout(currentHangoutId, x=>x.dates.push(item));
  } else if(type==='places'){
    const n=document.getElementById('pollPlaceName').value.trim();
    const a=document.getElementById('pollPlaceAddr').value.trim();
    if(!n) return alert('Name required');
    const item={id:uid(), name:n, address:a, proposer:currentUser().id, votes:[currentUser().id]};
    updateHangout(currentHangoutId, x=>x.places.push(item));
  } else {
    const n=document.getElementById('pollActName').value.trim();
    if(!n) return alert('Name required');
    const item={id:uid(), name:n, proposer:currentUser().id, votes:[currentUser().id]};
    updateHangout(currentHangoutId, x=>x.activities.push(item));
  }
  closeModal('modalPoll');
}
function toggleVote(hangoutId, type, itemId){
  updateHangout(hangoutId, h=>{
    const list = type==='dates'? h.dates : type==='places'? h.places : h.activities;
    const it=list.find(x=>x.id===itemId);
    if(!it) return;
    if(it.votes.includes(currentUser().id)) it.votes=it.votes.filter(v=>v!==currentUser().id);
    else it.votes.push(currentUser().id);
  });
}
function finalizeHangout(){
  const d=document.getElementById('finDate').value;
  const t=document.getElementById('finTime').value;
  const p=document.getElementById('finPlace').value.trim();
  const a=document.getElementById('finAct').value.trim();
  if(!d) return alert('Pick final date');
  updateHangout(currentHangoutId, h=>{
    h.finalized={date:d, time:t, place:p, activity:a};
    h.status='finalized';
  });
}
async function markDone(id){
  const h=getHangout(id);
  updateHangout(id, x=>{ x.status = x.status==='done'? 'finalized':'done'; });
}
async function deleteHangout(id){
  if(!confirm('Delete this hangout?')) return;
  const me=currentUser();
  try{
    await apiDeleteHangout(id, me.id);
    hangoutsCache = hangoutsCache.filter(h=>h.id!==id);
    save(LS_DATA, hangoutsCache);
  }catch(e){
    alert('Delete failed: '+e.message);
    return;
  }
  currentHangoutId=null; render();
}

// Host actions
async function kickUser(targetId){
  if(!confirm('Kick '+memberName(targetId)+' from hangout?')) return;
  const me=currentUser();
  try{
    const updated = await apiKick(currentHangoutId, me.id, targetId);
    // update cache
    const idx=hangoutsCache.findIndex(h=>h.id===currentHangoutId);
    if(idx>=0) hangoutsCache[idx]=updated;
    save(LS_DATA, hangoutsCache);
    render();
  }catch(e){ alert('Kick failed: '+e.message); }
}
async function makeAdmin(targetId){
  const me=currentUser();
  try{
    const updated=await apiAdmin(currentHangoutId, me.id, targetId, 'make');
    const idx=hangoutsCache.findIndex(h=>h.id===currentHangoutId);
    if(idx>=0) hangoutsCache[idx]=updated;
    save(LS_DATA, hangoutsCache);
    render();
  }catch(e){ alert('Make admin failed: '+e.message); }
}
async function revokeAdmin(targetId){
  const me=currentUser();
  try{
    const updated=await apiAdmin(currentHangoutId, me.id, targetId, 'revoke');
    const idx=hangoutsCache.findIndex(h=>h.id===currentHangoutId);
    if(idx>=0) hangoutsCache[idx]=updated;
    save(LS_DATA, hangoutsCache);
    render();
  }catch(e){ alert('Revoke failed: '+e.message); }
}
async function transferHost(targetId){
  if(!confirm('Transfer host to '+memberName(targetId)+' ? You will become admin.')) return;
  const me=currentUser();
  try{
    const updated=await apiTransferHost(currentHangoutId, me.id, targetId);
    const idx=hangoutsCache.findIndex(h=>h.id===currentHangoutId);
    if(idx>=0) hangoutsCache[idx]=updated;
    save(LS_DATA, hangoutsCache);
    render();
  }catch(e){ alert('Transfer failed: '+e.message); }
}

function sendComment(){
  const inp=document.getElementById('chatInput');
  const text=inp.value.trim(); if(!text) return;
  updateHangout(currentHangoutId, h=>{ h.comments.push({id:uid(), userId:currentUser().id, text, at:nowISO()}); });
  inp.value='';
}

// Expenses with comma
function openExpenseModal(){
  const h=getHangout(currentHangoutId);
  const sel=document.getElementById('expPayer');
  sel.innerHTML=h.members.map(mid=>`<option value="${mid}">${memberName(mid)}</option>`).join('');
  sel.value=currentUser().id;
  document.getElementById('expDesc').value='';
  document.getElementById('expAmount').value='';
  document.getElementById('expSplitType').value='equal';
  renderParticipants();
  document.getElementById('expError').textContent='';
  document.getElementById('expCustomArea').innerHTML='';
  document.getElementById('modalExpense').classList.remove('hidden');
  onSplitTypeChange();
  attachCommaListeners();
}
function renderParticipants(){
  const h=getHangout(currentHangoutId);
  const cont=document.getElementById('expParticipants');
  cont.innerHTML=`<div class="field"><label>Participants (split among)</label>
    <div class="grid" style="gap:6px">${h.members.map(mid=>`
      <label class="flex" style="gap:8px"><input type="checkbox" class="part-check" value="${mid}" checked style="width:auto"> ${avatarHtml(mid,'xs')} ${memberName(mid)}</label>
    `).join('')}</div></div>`;
  cont.querySelectorAll('.part-check').forEach(cb=> cb.addEventListener('change', updateCustomAreaValues));
}
function getSelectedParticipants(){
  return Array.from(document.querySelectorAll('.part-check:checked')).map(cb=>cb.value);
}
function onSplitTypeChange(){
  updateCustomAreaValues();
}
function attachCommaListeners(){
  const exp=document.getElementById('expAmount');
  if(exp && !exp._comma){
    exp.addEventListener('input', (e)=>{
      const raw=parseComma(e.target.value);
      const formatted= raw? formatComma(String(raw)) : (e.target.value.replace(/,/g,'').replace(/\D/g,'')? formatComma(e.target.value) : '');
      const pos=exp.selectionStart;
      exp.value=formatted;
      // try keep cursor at end
    });
    exp._comma=true;
  }
  const pay=document.getElementById('payAmount');
  if(pay && !pay._comma){
    pay.addEventListener('input', (e)=>{
      const raw=parseComma(e.target.value);
      const formatted= raw? formatComma(String(raw)) : (e.target.value.replace(/,/g,'').replace(/\D/g,'')? formatComma(e.target.value) : '');
      pay.value=formatted;
    });
    pay._comma=true;
  }
}
function updateCustomAreaValues(){
  const type=document.getElementById('expSplitType').value;
  const amount=parseComma(document.getElementById('expAmount').value)||0;
  const parts=getSelectedParticipants();
  const area=document.getElementById('expCustomArea');
  if(parts.length===0){ area.innerHTML=`<div class="subtle" style="color:var(--danger)">Select at least 1 participant</div>`; return; }
  if(type==='equal'){
    const each = parts.length? Math.floor(amount/parts.length) : 0;
    const rem = amount - each*parts.length;
    area.innerHTML=`<div class="subtle">Equal split: ${parts.map((p,i)=> `${memberName(p)} ${formatToman(each + (i<rem?1:0))}`).join(' · ')}</div>`;
  } else if(type==='exact'){
    area.innerHTML=parts.map(mid=>`
      <div class="field"><label>${memberName(mid)} amount (تومان)</label><input type="text" inputmode="numeric" class="exact-input comma-input" data-user="${mid}" placeholder="0"></div>
    `).join('') + `<div class="subtle">Sum must equal total amount.</div>`;
    area.querySelectorAll('.exact-input').forEach(inp=>{
      inp.addEventListener('input', e=>{
        const raw=parseComma(e.target.value);
        e.target.value= raw? formatComma(String(raw)) : '';
        updateCustomAreaValuesValidate();
      });
    });
  } else if(type==='percent'){
    area.innerHTML=parts.map(mid=>`
      <div class="field"><label>${memberName(mid)} %</label><input type="number" class="percent-input" data-user="${mid}" placeholder="0" max="100"></div>
    `).join('') + `<div class="subtle">Sum must be 100%.</div>`;
  } else if(type==='shares'){
    area.innerHTML=parts.map(mid=>`
      <div class="field"><label>${memberName(mid)} shares</label><input type="number" class="shares-input" data-user="${mid}" placeholder="1" min="0" value="1"></div>
    `).join('') + `<div class="subtle">E.g., 2 means pays double. Split proportionally.</div>`;
  }
}
function updateCustomAreaValuesValidate(){ /* placeholder */ }
document.addEventListener('input', e=>{
  if(e.target.id==='expAmount') updateCustomAreaValues();
});
function saveExpense(){
  const h=getHangout(currentHangoutId);
  const desc=document.getElementById('expDesc').value.trim()||'Expense';
  const amount=parseComma(document.getElementById('expAmount').value);
  const payer=document.getElementById('expPayer').value;
  const type=document.getElementById('expSplitType').value;
  const parts=getSelectedParticipants();
  const err=document.getElementById('expError');
  err.textContent='';
  if(!amount || amount<=0) { err.textContent='Enter valid amount (تومان)'; return; }
  if(parts.length===0) { err.textContent='Pick at least one participant'; return; }
  let splits=[];
  if(type==='equal'){
    const each=Math.floor(amount/parts.length);
    let rem=amount - each*parts.length;
    splits=parts.map((mid,i)=>({userId:mid, amount: each + (i<rem?1:0)}));
  } else if(type==='exact'){
    const inputs=document.querySelectorAll('.exact-input');
    let sum=0;
    inputs.forEach(inp=>{ const v=parseComma(inp.value)||0; sum+=v; splits.push({userId:inp.dataset.user, amount: Math.round(v)}); });
    if(sum!==amount){ err.textContent=`Exact sum ${formatToman(sum)} != total ${formatToman(amount)} (diff ${formatToman(sum-amount)})`; return; }
  } else if(type==='percent'){
    const inputs=document.querySelectorAll('.percent-input');
    let sum=0;
    inputs.forEach(inp=> sum+= parseFloat(inp.value)||0);
    if(Math.abs(sum-100)>0.01){ err.textContent=`Percent sum ${sum}% must be 100%`; return; }
    let acc=0;
    splits=[];
    inputs.forEach((inp, idx)=>{
      const pct=parseFloat(inp.value)||0;
      let amt = Math.round(amount * pct / 100);
      if(idx===inputs.length-1) amt = amount - acc;
      acc+=amt;
      splits.push({userId:inp.dataset.user, amount: amt});
    });
  } else if(type==='shares'){
    const inputs=document.querySelectorAll('.shares-input');
    let totalShares=0;
    inputs.forEach(inp=> totalShares+= parseFloat(inp.value)||0);
    if(totalShares<=0){ err.textContent='Shares must be >0'; return; }
    let acc=0;
    splits=[];
    inputs.forEach((inp, idx)=>{
      const sh=parseFloat(inp.value)||0;
      let amt = Math.round(amount * sh / totalShares);
      if(idx===inputs.length-1) amt = amount - acc;
      acc+=amt;
      splits.push({userId:inp.dataset.user, amount: amt});
    });
  }
  const expense={id:uid(), desc, amount, payerId:payer, date:nowISO(), splitType:type, participants:[...parts], splits};
  updateHangout(currentHangoutId, x=>x.expenses.push(expense));
  closeModal('modalExpense');
}
function deleteExpense(id){
  if(!confirm('Remove expense?')) return;
  updateHangout(currentHangoutId, h=>{ h.expenses=h.expenses.filter(e=>e.id!==id); });
}

// Balances & settlement
function computeNetForHangout(h){
  const net={};
  h.members.forEach(m=> net[m]=0);
  for(const e of h.expenses){
    net[e.payerId]=(net[e.payerId]||0)+e.amount;
    for(const s of e.splits){
      net[s.userId]=(net[s.userId]||0)- s.amount;
    }
  }
  for(const p of h.payments){
    net[p.from]=(net[p.from]||0)+p.amount;
    net[p.to]=(net[p.to]||0)-p.amount;
  }
  for(const k in net) if(Math.abs(net[k])<1) net[k]=0;
  return net;
}
function simplifyDebts(net){
  const creditors=Object.entries(net).filter(([,v])=>v>0).map(([k,v])=>({id:k, amt:v})).sort((a,b)=>b.amt-a.amt);
  const debtors=Object.entries(net).filter(([,v])=>v<0).map(([k,v])=>({id:k, amt:-v})).sort((a,b)=>b.amt-a.amt);
  const transfers=[];
  let i=0,j=0;
  while(i<creditors.length && j<debtors.length){
    const c=creditors[i], d=debtors[j];
    const amt=Math.min(c.amt, d.amt);
    if(amt>0) transfers.push({from:d.id, to:c.id, amount:Math.round(amt)});
    c.amt-=amt; d.amt-=amt;
    if(c.amt<1) i++;
    if(d.amt<1) j++;
  }
  return transfers;
}
function openPaymentModal(){
  const h=getHangout(currentHangoutId);
  const opts=h.members.map(mid=>`<option value="${mid}">${memberName(mid)}</option>`).join('');
  document.getElementById('payFrom').innerHTML=opts;
  document.getElementById('payTo').innerHTML=opts;
  document.getElementById('payAmount').value='';
  document.getElementById('payNote').value='';
  const net=computeNetForHangout(h);
  const tr=simplifyDebts(net)[0];
  if(tr){ document.getElementById('payFrom').value=tr.from; document.getElementById('payTo').value=tr.to; document.getElementById('payAmount').value=formatComma(String(tr.amount)); }
  document.getElementById('modalPayment').classList.remove('hidden');
  attachCommaListeners();
}
function savePayment(){
  const from=document.getElementById('payFrom').value;
  const to=document.getElementById('payTo').value;
  const amt=parseComma(document.getElementById('payAmount').value);
  const note=document.getElementById('payNote').value.trim();
  if(from===to) return alert('From and To must differ');
  if(!amt || amt<=0) return alert('Enter amount');
  updateHangout(currentHangoutId, h=>{ h.payments.push({id:uid(), from, to, amount:Math.round(amt), note, date:nowISO()}); });
  closeModal('modalPayment');
}

// Import/export
function exportData(){
  const data=JSON.stringify({users:allUsers(), hangouts:getHangouts()}, null, 2);
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='hangout4-export.json'; a.click();
  URL.revokeObjectURL(url);
}
function importData(e){
  const file=e.target.files[0]; if(!file) return;
  const r=new FileReader(); r.onload=()=>{
    try{
      const j=JSON.parse(r.result);
      if(j.users) save(LS_USERS,j.users);
      if(j.hangouts){
        // migrate rial to toman if needed: if amounts > 100000 assume rial?
        // we assume toman now, keep as is
        save(LS_DATA,j.hangouts);
        if(USE_API){
          // push to server
          j.hangouts.forEach(h=> apiUpdateHangout(h).catch(()=>{}));
        }
      }
      alert('Imported'); location.reload();
    }catch(err){ alert('Invalid file'); }
  }; r.readAsText(file);
}

// Close modals on bg click
document.querySelectorAll('.modal-bg').forEach(m=>{
  m.addEventListener('click', e=>{ if(e.target===m) m.classList.add('hidden'); });
});

// Init
async function forceRefresh(){
  await syncFromServer();
  render();
  // toast
  const t=document.createElement('div');
  t.textContent='✓ Synced';
  t.style.cssText='position:fixed;bottom:16px;right:16px;background:var(--success);color:#fff;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:800;z-index:99';
  document.body.appendChild(t); setTimeout(()=>t.remove(),1500);
}
window.addEventListener('DOMContentLoaded', async ()=>{
  await checkApi();
  if(USE_API) connectWS();
  // Strong polling: every 3s always sync when API available (ensures ngrok updates even if WS blocked)
  setInterval(async ()=>{
    if(USE_API) {
      try{ await syncFromServer(); render(); }catch(e){}
    }
  }, 3000);
  // Sync on tab visible / focus (when friends switch back to app)
  document.addEventListener('visibilitychange', async ()=>{
    if(!document.hidden && USE_API){ await forceRefresh(); }
  });
  window.addEventListener('focus', async ()=>{ if(USE_API) await forceRefresh(); });
  // Watch for SW updates and auto-reload
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js').then(reg=>{
      reg.addEventListener('updatefound', ()=>{
        const nw = reg.installing;
        nw.addEventListener('statechange', ()=>{
          if(nw.state==='installed' && navigator.serviceWorker.controller){
            if(confirm('New update available — reload to get latest?')) location.reload();
          }
        });
      });
    }).catch(()=>{});
    // listen for controller change
    navigator.serviceWorker.addEventListener('controllerchange', ()=> location.reload());
  }
  render();
});
// Expose forceRefresh for button
window.forceRefresh = forceRefresh;
async function clearCacheAndReload(){
  if('caches' in window){
    const keys = await caches.keys();
    await Promise.all(keys.map(k=>caches.delete(k)));
  }
  if('serviceWorker' in navigator){
    const regs = await navigator.serviceWorker.getRegistrations();
    for(const r of regs) await r.unregister();
  }
  localStorage.removeItem('hangout_data_v2'); // keep, but force sync
  location.reload(true);
}
window.clearCacheAndReload = clearCacheAndReload;

// Expose globals
window.switchAuth=switchAuth; window.doLogin=doLogin; window.doRegister=doRegister; window.doGuestLogin=doGuestLogin; window.logout=logout; window.openForgotModal=openForgotModal; window.doForgot=doForgot; window.hostResetPassword=hostResetPassword;
window.router=router; window.openHangout=openHangout; window.setTab=setTab; window.openCreateModal=openCreateModal;
window.toggleMember=toggleMember; window.addCustomMember=addCustomMember; window.createHangout=createHangout; window.closeModal=closeModal;
window.openPoll=openPoll; window.savePoll=savePoll; window.toggleVote=toggleVote; window.finalizeHangout=finalizeHangout; window.markDone=markDone;
window.deleteHangout=deleteHangout; window.sendComment=sendComment;
window.openExpenseModal=openExpenseModal; window.onSplitTypeChange=onSplitTypeChange; window.saveExpense=saveExpense; window.deleteExpense=deleteExpense;
window.openPaymentModal=openPaymentModal; window.savePayment=savePayment; window.exportData=exportData; window.importData=importData;
window.setDashFilter=setDashFilter;
window.openHostPanel=openHostPanel; window.openHostPanelForHangout=openHostPanelForHangout; window.refreshHostPanel=refreshHostPanel;
window.kickUser=kickUser; window.makeAdmin=makeAdmin; window.revokeAdmin=revokeAdmin; window.transferHost=transferHost; window.togglePass=togglePass; window.copyPass=copyPass; window.deleteUserCompletely=deleteUserCompletely;
