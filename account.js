/* Household Helper: family accounts, invites, roles and sync.
   Loaded after family.js (uses people, me, person, PALETTE, renderPeople and friends).

   How it works:
   - Each person has their own login (email + password) and belongs to one family.
   - The first person starts the family and becomes its owner. They invite others with a 6-character code.
   - Roles: owner and adults can change everything; kids can see everything, tick chores and use shopping lists.
   - Everything is kept on the phone first and copied to the family's shared space, so the app works offline.
   - The database only lets members of a family read or change that family's data (row-level security). */
const SB_URL = "https://vfmsgeuxugojifzmpaaa.supabase.co";
const SB_KEY = "sb_publishable_ZxfhRmfgbfdSrdXGB14pzw__w1SnLc0"; // publishable key: safe to ship in the page
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, "");
const ROLE_NAMES = {owner: "Owner", adult: "Adult", kid: "Kid"};
const kidCanWrite = p => /^(done|shop)\//.test(p);

function toast(text, ms = 4000){
  const old = document.getElementById("hhToast"); if (old) old.remove();
  const bar = document.createElement("div"); bar.id = "hhToast"; bar.className = "updatebar"; bar.setAttribute("role", "status");
  bar.innerHTML = `<span>${esc(text)}</span>`;
  document.body.appendChild(bar); setTimeout(() => bar.remove(), ms);
}
function friendlyError(err){
  const m = String((err && (err.message || err.error_description)) || err || "");
  if (!navigator.onLine) return "You're offline. Connect to the internet and try again.";
  if (/invalid login/i.test(m)) return "That email and password don't match. Check them and try again.";
  if (/already registered|already been registered/i.test(m)) return "There's already a login with that email. Use Sign in instead.";
  if (/invite_not_found/.test(m)) return "That code isn't right or has run out. Check it, or ask for a new one.";
  if (/already_in_family/.test(m)) return "This login is already part of a family.";
  if (/not_allowed/.test(m)) return "Only the family's owner or an adult can do that.";
  if (/too_many_invites/.test(m)) return "There are already 20 invite codes waiting. Cancel some first.";
  if (/owner_delete_family/.test(m)) return "As the family's owner, use Delete our family instead.";
  if (/password.*(short|least|characters)/i.test(m)) return "Use a password of at least 8 characters.";
  if (/weak/i.test(m)) return "That password is too easy to guess. Try a longer one.";
  if (/rate limit|too many/i.test(m)) return "Too many tries. Wait a few minutes and try again.";
  if (/invalid.*email|email.*invalid/i.test(m)) return "That email address doesn't look right.";
  return m || "Something went wrong. Try again.";
}

/* ---------- Sync with the family's shared space ---------- */
const Cloud = (() => {
  let sb = null, user = null, fam = null, channel = null, flushTimer = null, flushing = false, lastPull = 0, starting = null, revertTimer = null;
  let state = "off"; // off | syncing | on | offline | error | full | nofamily
  let recovery = false;
  const listeners = new Set();
  const ls = {
    get(k){ try{ return localStorage.getItem(k); }catch{ return null; } },
    set(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch{} }
  };
  let pending = {}; try{ pending = JSON.parse(ls.get("hh-pending") || "{}") || {}; }catch{ pending = {}; }
  const savePending = () => ls.set("hh-pending", JSON.stringify(pending));
  const notify = () => listeners.forEach(f => { try{ f(); }catch(e){ console.error(e); } });
  const setState = s => { state = s; notify(); };

  function client(){
    if (!sb && window.supabase && db) sb = window.supabase.createClient(SB_URL, SB_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "hh-auth"}});
    return sb;
  }

  if (db) localDb._onWrite((path, data) => {
    if (!user || !fam) return;
    if (fam.role === "kid" && !kidCanWrite(path)){
      // Kids can't change this: put it back the way the family has it
      toast("Kids can tick chores and add to shopping lists. Ask an adult to change anything else.");
      clearTimeout(revertTimer); revertTimer = setTimeout(() => pull().catch(() => {}), 300);
      return;
    }
    pending[path] = {d: data, at: Date.now()}; savePending();
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 400);
  });

  async function loadFamily(){
    const {data, error} = await sb.from("members").select("household_id, role, name, households(name)").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    fam = data ? {id: data.household_id, role: data.role, myName: data.name, name: (data.households && data.households.name) || ""} : null;
    document.body.classList.toggle("kidmode", !!fam && fam.role === "kid");
    return fam;
  }

  async function pullAll(){
    const out = {}; const size = 1000;
    for (let from = 0; ; from += size){
      const {data, error} = await sb.from("docs").select("path,data").eq("household_id", fam.id).order("path").range(from, from + size - 1);
      if (error) throw error;
      data.forEach(r => out[r.path] = r.data);
      if (data.length < size) break;
    }
    return out;
  }

  async function flush(){
    if (!user || !fam || flushing) return;
    const snap = {...pending}; const paths = Object.keys(snap);
    if (!paths.length){ if (!["offline", "full"].includes(state)) setState("on"); return; }
    if (!navigator.onLine){ setState("offline"); return; }
    flushing = true; setState("syncing");
    const done = list => { list.forEach(p => { if (pending[p] && pending[p].at === snap[p].at) delete pending[p]; }); savePending(); };
    try{
      const ups = paths.filter(p => snap[p].d != null).map(p => ({household_id: fam.id, path: p, data: snap[p].d}));
      const dels = paths.filter(p => snap[p].d == null);
      for (let i = 0; i < ups.length; i += 200){
        const part = ups.slice(i, i + 200);
        const {error} = await sb.from("docs").upsert(part, {onConflict: "household_id,path"});
        if (error) throw error;
        done(part.map(r => r.path));
      }
      for (let i = 0; i < dels.length; i += 100){
        const part = dels.slice(i, i + 100);
        const {error} = await sb.from("docs").delete().eq("household_id", fam.id).in("path", part);
        if (error) throw error;
        done(part);
      }
      setState("on");
    }catch(err){
      const m = String((err && err.message) || "");
      if (/storage_full/.test(m)){ setState("full"); }
      else if (err && (err.code === "42501" || /row-level security/i.test(m))){
        // Not allowed (for example a kid's change, or the family changed): drop it and show the family's version
        paths.forEach(p => delete pending[p]); savePending(); pull().catch(() => {}); setState("on");
      } else {
        setState(navigator.onLine ? "error" : "offline");
        clearTimeout(flushTimer); flushTimer = setTimeout(flush, 15000);
      }
    }finally{
      flushing = false;
      if (Object.keys(pending).length && state === "on"){ clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); }
    }
  }

  // Bring this phone up to date with the family, keeping changes not yet sent
  async function pull(){
    if (!user || !fam || !navigator.onLine) return;
    lastPull = Date.now();
    const cloud = await pullAll();
    const local = localDb._export(); const changes = [];
    Object.keys(local).forEach(k => { if (!(k in cloud) && !pending[k]) changes.push([k, null]); });
    Object.keys(cloud).forEach(k => { if (!pending[k] && JSON.stringify(cloud[k]) !== JSON.stringify(local[k])) changes.push([k, cloud[k]]); });
    if (changes.length) localDb._apply(changes);
  }

  async function doStart(){
    if (!db || !user) return;
    setState("syncing");
    try{
      if (!await loadFamily()){ stopSync(); setState("nofamily"); return; }
      const prev = ls.get("hh-cloud-family");
      const cloud = await pullAll();
      if (prev && prev !== fam.id){
        // This phone last held another family's data: show this family's instead
        pending = {}; savePending(); localDb._replace(cloud);
      } else if (prev === fam.id){
        await pull();
      } else {
        // First time on this phone: anything saved here that the family doesn't have yet is added to the family
        const local = localDb._export(); const merged = {...cloud};
        if (fam.role !== "kid") Object.keys(local).forEach(k => { if (!(k in cloud)){ merged[k] = local[k]; pending[k] = {d: local[k], at: Date.now()}; } });
        savePending(); localDb._replace(merged);
      }
      ls.set("hh-cloud-family", fam.id);
      subscribe();
      await flush();
      if (!Object.keys(pending).length && state !== "full") setState("on");
      setTimeout(linkMe, 50);
    }catch(err){
      setState(navigator.onLine ? "error" : "offline");
    }
  }
  function start(u){
    user = u;
    starting = (starting || Promise.resolve()).then(doStart).finally(() => { starting = null; });
    return starting;
  }

  function subscribe(){
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("docs-" + fam.id)
      .on("postgres_changes", {event: "*", schema: "public", table: "docs", filter: "household_id=eq." + fam.id}, payload => {
        if (payload.eventType === "DELETE"){
          const p = payload.old && payload.old.path; if (p && !pending[p] && p in localDb._export()) localDb._apply([[p, null]]);
        } else {
          const r = payload.new; if (!r || !r.path || pending[r.path]) return;
          if (JSON.stringify(localDb._export()[r.path]) !== JSON.stringify(r.data)) localDb._apply([[r.path, r.data]]);
        }
      })
      .subscribe();
  }
  function stopSync(){ if (channel && sb){ sb.removeChannel(channel); channel = null; } }

  // Take the family's data off this phone (it stays safe with the family)
  function clearPhone(){
    pending = {}; savePending(); ls.set("hh-cloud-family", null);
    localDb._replace({});
  }

  async function init(){
    const c = client(); if (!c) return;
    c.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY"){ recovery = true; setView("family"); }
      const u = session && session.user;
      if (u && (!user || user.id !== u.id)) setTimeout(() => start(u), 0);
      if (!u && user){ stopSync(); user = null; fam = null; document.body.classList.remove("kidmode"); setState("off"); }
      // Token refreshes and password changes don't need a redraw (it would wipe messages on screen)
      if (["SIGNED_IN", "SIGNED_OUT", "PASSWORD_RECOVERY", "INITIAL_SESSION"].includes(event)) notify();
    });
    const {data} = await c.auth.getSession();
    if (data && data.session && !user) start(data.session.user);
  }

  // Check membership when coming back: someone may have been removed, or a role changed
  async function resync(){
    if (!user) return;
    try{
      const before = fam;
      await loadFamily();
      if (before && !fam){ stopSync(); clearPhone(); toast("You're no longer part of that family. Ask for a new invite code to join again.", 7000); setState("nofamily"); return; }
      if (!before && fam){ start(user); return; }
      if (!fam) return;
      await pull(); await flush();
      notify();
    }catch{ setState(navigator.onLine ? "error" : "offline"); }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastPull > 5000) resync(); });
  window.addEventListener("online", resync);
  window.addEventListener("offline", () => { if (user) setState("offline"); });
  setInterval(() => { if (user && document.visibilityState === "visible") resync(); }, 120000);

  const rpc = async (fn, args) => { const {data, error} = await client().rpc(fn, args || {}); if (error) throw error; return data; };
  const redirect = () => APP_URL;
  async function afterAuth(session){
    if (!session) throw new Error("Couldn't sign in. Try again.");
    user = session.user;
  }
  return {
    init, onChange: f => listeners.add(f), resync,
    get user(){ return user; }, get fam(){ return fam; }, get state(){ return state; }, get recovery(){ return recovery; },
    get canEdit(){ return !!fam && fam.role !== "kid"; },
    available: () => !!client(),
    checkInvite: code => rpc("check_invite", {p_code: code}),
    async signUpNew({name, family, email, password}){
      const {data, error} = await client().auth.signUp({email, password, options: {data: {name}, emailRedirectTo: redirect()}});
      if (error) throw error;
      if (!data.session) return "confirm";
      await afterAuth(data.session);
      await rpc("create_household", {p_family: family, p_name: name});
      await start(user);
      return "ok";
    },
    async signUpJoin({code, name, email, password}){
      if (!await rpc("check_invite", {p_code: code})) throw new Error("invite_not_found");
      const {data, error} = await client().auth.signUp({email, password, options: {data: {name}, emailRedirectTo: redirect()}});
      if (error) throw error;
      if (!data.session) return "confirm";
      await afterAuth(data.session);
      await rpc("join_household", {p_code: code, p_name: name});
      await start(user);
      return "ok";
    },
    async signIn(email, password){
      const {data, error} = await client().auth.signInWithPassword({email, password});
      if (error) throw error;
      await afterAuth(data.session); await start(user);
    },
    async createFamily(family, name){ await rpc("create_household", {p_family: family, p_name: name}); await start(user); },
    async joinFamily(code, name){ await rpc("join_household", {p_code: code, p_name: name}); await start(user); },
    async members(){ const {data, error} = await client().from("members").select("user_id, role, name, created_at").order("created_at"); if (error) throw error; return data; },
    async invites(){ const {data, error} = await client().from("invites").select("code, role, expires_at").gt("expires_at", new Date().toISOString()).order("created_at", {ascending: false}); if (error) throw error; return data; },
    createInvite: role => rpc("create_invite", {p_role: role}),
    async cancelInvite(code){ const {error} = await client().from("invites").delete().eq("code", code); if (error) throw error; },
    removeMember: uid => rpc("remove_member", {p_user: uid}),
    setRole: (uid, role) => rpc("set_member_role", {p_user: uid, p_role: role}),
    async renameFamily(n){ await rpc("rename_household", {p_name: n}); await loadFamily(); notify(); },
    async renameMe(n){ await rpc("rename_me", {p_name: n}); await loadFamily(); notify(); },
    async changePassword(p){ const {error} = await client().auth.updateUser({password: p}); if (error) throw error; if (recovery){ recovery = false; notify(); } },
    async reset(email){ const {error} = await client().auth.resetPasswordForEmail(email, {redirectTo: redirect()}); if (error) throw error; },
    async signOut(){
      await flush().catch(() => {});
      stopSync(); clearPhone();
      user = null; fam = null; document.body.classList.remove("kidmode"); setState("off");
      try{ await client().auth.signOut({scope: "local"}); }catch{}
    },
    async deleteMyLogin(){ await rpc("delete_my_login"); stopSync(); clearPhone(); user = null; fam = null; try{ await client().auth.signOut({scope: "local"}); }catch{} setState("off"); },
    async deleteFamily(){ await rpc("delete_household"); stopSync(); clearPhone(); user = null; fam = null; try{ await client().auth.signOut({scope: "local"}); }catch{} setState("off"); }
  };
})();

// Match this login to a name on the family list, so "my" list, chore credit and so on just work
async function linkMe(){
  if (!Cloud.fam || !db) return;
  const uid = Cloud.user.id, myName = Cloud.fam.myName || "";
  let p = people.find(x => x.userId === uid) || people.find(x => !x.userId && x.name.trim().toLowerCase() === myName.trim().toLowerCase());
  if (p && !p.userId && Cloud.canEdit){ await db.collection("people").doc(p.id).set({...p, id: undefined, userId: uid}); }
  if (!p && Cloud.canEdit && myName){ const r = await db.collection("people").add({name: myName, userId: uid, color: PALETTE[people.length % PALETTE.length], created: Date.now()}); p = {id: r.id}; }
  if (p && me !== p.id){ me = p.id; try{ localStorage.setItem("hh-me", me); }catch{} renderAccount(); }
}

/* ---------- Account bar ---------- */
function stateText(){
  const u = Cloud.user, f = Cloud.fam;
  if (!u) return {dot: "", text: canSave() ? "Saved on this phone only. Sign in to share with your family." : "This browser can't save. Open the app in Safari or Chrome."};
  if (!f) return {dot: "wait", text: "Signed in. Join or start a family to share."};
  const fam = `${f.name} family · ${f.myName}${f.role === "kid" ? " (kid)" : ""}`;
  return {
    on: {dot: "on", text: `${fam} · up to date`}, syncing: {dot: "wait", text: `${fam} · saving…`},
    offline: {dot: "wait", text: `${fam} · offline. Changes are saved here and will sync when you're back online.`},
    error: {dot: "wait", text: `${fam} · couldn't sync just now. It will keep trying.`},
    full: {dot: "wait", text: `${fam} · the family's storage is full. Remove old items to keep syncing.`}
  }[Cloud.state] || {dot: "wait", text: fam};
}
function renderAcctBar(){
  const st = stateText();
  document.getElementById("acctBar").innerHTML = `<span class="who"><span class="sdot ${st.dot}"></span><span>${esc(st.text)}</span></span>${Cloud.user ? "" : canSave() && Cloud.available() ? '<button class="btn sm" data-view="family" data-authgo="start">Sign in or sign up</button>' : ""}`;
}

/* ---------- Family tab: sign up, sign in, family, logins, invites, your login ---------- */
let authMode = "start", pendingJoinCode = "";
const field = (id, label, attrs = "", hint = "") => `<label>${label}${hint ? ` <span class="tip">${hint}</span>` : ""}<input id="${id}" ${attrs}></label>`;
const pw = (id, label = "Password", hint = "(at least 8 characters)", ac = "new-password") => field(id, label, `type="password" minlength="${ac === "current-password" ? 6 : 8}" autocomplete="${ac}" required`, hint);
const privacyLink = '<p class="tip">By signing up you agree to how your data is kept, explained in the <button type="button" class="linkbtn" data-showprivacy="1">privacy notice</button>.</p>';

function renderAccount(){
  const el = document.getElementById("acctBody"); if (!el) return;
  const u = Cloud.user, f = Cloud.fam;
  document.getElementById("loginsPanel").hidden = !f;
  document.getElementById("invitePanel").hidden = !f || f.role === "kid";
  document.getElementById("myLoginPanel").hidden = !u;
  const howto = document.getElementById("howto");
  if (howto.dataset.auto !== "0") howto.open = !u; // open for newcomers, tucked away once signed in

  if (!canSave()){ el.innerHTML = `<h3>Share with your family</h3><p class="tip">This browser isn't letting the app save. Open it in Safari or Chrome, not a private window.</p>`; return; }
  if (!Cloud.available()){ el.innerHTML = `<h3>Share with your family</h3><p class="tip">Connect to the internet once to set up family sharing.</p>`; return; }

  if (u && Cloud.recovery){
    el.innerHTML = `<h3>Choose a new password</h3><form class="authform" id="newPassForm">${pw("np-pass", "New password")}<div class="row"><button class="btn" type="submit">Save password</button><span class="tip" id="authMsg"></span></div></form>`;
    return;
  }
  if (u && !f){
    el.innerHTML = `<h3>Welcome!</h3>
      <p class="tip">You're signed in as <strong>${esc(u.email)}</strong>, but not part of a family yet.</p>
      <div class="choices two">
        <form class="authform choicebox" id="joinCodeForm"><h4>Join my family</h4><p class="tip">Use the invite code someone in your family gave you.</p>
          ${field("jc-code", "Invite code", `maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="e.g. K7M2QX" required value="${esc(pendingJoinCode)}"`)}
          <p class="tip" id="jc-check"></p>
          ${field("jc-name", "Your name", 'maxlength="30" autocomplete="given-name" required')}
          <button class="btn" type="submit">Join</button></form>
        <form class="authform choicebox" id="newFamForm"><h4>Start a new family</h4><p class="tip">If you're the first in your household.</p>
          ${field("nf-family", "Family name", 'maxlength="40" placeholder="e.g. Smith" required')}
          ${field("nf-name", "Your name", 'maxlength="30" autocomplete="given-name" required')}
          <button class="btn" type="submit">Start family</button></form>
      </div>
      <p class="tip" id="authMsg"></p>`;
    return;
  }
  if (u && f){
    const canEdit = f.role !== "kid";
    el.innerHTML = `<h3>${esc(f.name)} family</h3>
      <p class="tip">You're signed in as <strong>${esc(f.myName)}</strong> (${esc(u.email)}) · ${ROLE_NAMES[f.role]}. ${f.role === "kid" ? "You can see everything, tick off chores and add to shopping lists." : "You can change everything and invite people."}</p>
      ${canEdit ? `<form class="inlineform" id="famRenameForm"><label>Family name<input id="fr-name" maxlength="40" value="${esc(f.name)}"></label><button class="btn ghost sm" type="submit">Save</button></form>` : ""}
      <label class="authform"><span>Who's using this phone?</span><select id="meSel">${meOptions()}</select></label>
      <p class="tip">Matched to your login automatically. Used for your own shopping list and chore stars.</p>`;
    return;
  }
  // Signed out
  const back = '<p class="tip"><button type="button" class="linkbtn" data-authgo="start">← Back</button></p>';
  if (authMode === "start"){
    el.innerHTML = `<h3>Share with your family</h3>
      <p class="tip">Everyone gets their own login and sees the same plan, calendar, chores, pantry and lists. Pick one:</p>
      <div class="choices">
        <button class="choice" data-authgo="new"><b>Start a new family</b><span>I'm the first in my household to sign up.</span></button>
        <button class="choice" data-authgo="join"><b>Join my family</b><span>Someone gave me an invite code.</span></button>
        <button class="choice" data-authgo="signin"><b>Sign in</b><span>I already have a login, for example on a new phone.</span></button>
      </div>`;
    return;
  }
  if (authMode === "new"){
    el.innerHTML = `<h3>Start a new family</h3>
      <p class="tip">You'll be the family's owner. Once you're in, you can invite everyone else with a code.</p>
      <form class="authform" id="signupNewForm">
        ${field("sn-name", "Your name", 'maxlength="30" autocomplete="given-name" required placeholder="e.g. Sam"')}
        ${field("sn-family", "Family name", 'maxlength="40" required placeholder="e.g. Smith"', "(shown as \"Smith family\")")}
        ${field("sn-email", "Email", 'type="email" autocomplete="username" required')}
        ${pw("sn-pass")}
        <div class="row"><button class="btn" type="submit" id="authBtn">Create my family</button><span class="tip" id="authMsg"></span></div>
        ${privacyLink}
      </form>${back}`;
    return;
  }
  if (authMode === "join"){
    el.innerHTML = `<h3>Join my family</h3>
      <p class="tip">Type the invite code from someone in your family, then make your own login.</p>
      <form class="authform" id="signupJoinForm">
        ${field("sj-code", "Invite code", `maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="e.g. K7M2QX" required value="${esc(pendingJoinCode)}"`)}
        <p class="tip" id="sj-check"></p>
        ${field("sj-name", "Your name", 'maxlength="30" autocomplete="given-name" required')}
        ${field("sj-email", "Email", 'type="email" autocomplete="username" required')}
        ${pw("sj-pass")}
        <div class="row"><button class="btn" type="submit" id="authBtn">Join family</button><span class="tip" id="authMsg"></span></div>
        ${privacyLink}
      </form>
      <p class="tip">Already have a login? <button type="button" class="linkbtn" data-authgo="signin">Sign in</button>, then enter the code.</p>${back}`;
    if (pendingJoinCode) checkCode("sj");
    return;
  }
  if (authMode === "reset"){
    el.innerHTML = `<h3>Reset your password</h3><p class="tip">We'll email you a link to choose a new password.</p>
      <form class="authform" id="resetForm">${field("rs-email", "Email", 'type="email" autocomplete="username" required')}
      <div class="row"><button class="btn" type="submit" id="authBtn">Send reset link</button><span class="tip" id="authMsg"></span></div></form>
      <p class="tip">No email after a few minutes? Check your junk folder, or ask the family's owner for help.</p>${back}`;
    return;
  }
  el.innerHTML = `<h3>Sign in</h3><p class="tip">Use your own email and password.</p>
    <form class="authform" id="signinForm">
      ${field("si-email", "Email", 'type="email" autocomplete="username" required')}
      ${pw("si-pass", "Password", "", "current-password")}
      <div class="row"><button class="btn" type="submit" id="authBtn">Sign in</button><span class="tip" id="authMsg"></span></div>
    </form>
    <p class="tip"><button type="button" class="linkbtn" data-authgo="reset">Forgot your password?</button></p>${back}`;
}
const meOptions = () => `<option value="">Not set</option>` + people.map(p => `<option value="${esc(p.id)}"${p.id === me ? " selected" : ""}>${esc(p.name)}</option>`).join("");

let codeTimer = null;
function checkCode(prefix){
  const input = document.getElementById(prefix + "-code"), out = document.getElementById(prefix + "-check");
  if (!input || !out) return;
  const code = input.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  clearTimeout(codeTimer);
  if (code.length < 6){ out.textContent = ""; out.className = "tip"; return; }
  out.textContent = "Checking…"; out.className = "tip";
  codeTimer = setTimeout(async () => {
    try{
      const name = await Cloud.checkInvite(code);
      out.textContent = name ? `✓ You're joining the ${name} family.` : "That code isn't right or has run out. Check it, or ask for a new one.";
      out.className = name ? "tip okmsg" : "tip badmsg";
    }catch{ out.textContent = navigator.onLine ? "" : "You're offline."; }
  }, 350);
}

/* Who can sign in, and invites */
async function renderLogins(){
  const box = document.getElementById("loginsBody"); const f = Cloud.fam;
  if (!box || !f) return;
  let list = [];
  try{ list = await Cloud.members(); }catch{ box.innerHTML = '<p class="tip">Couldn\'t load the family list. Check your connection.</p>'; return; }
  const uid = Cloud.user && Cloud.user.id;
  box.innerHTML = list.map(m => {
    const self = m.user_id === uid; const owner = m.role === "owner";
    const onList = people.some(p => p.userId === m.user_id || p.name.trim().toLowerCase() === m.name.trim().toLowerCase());
    const roleCtl = f.role === "owner" && !self && !owner
      ? `<select data-setrole="${esc(m.user_id)}" aria-label="Role for ${esc(m.name)}"><option value="adult"${m.role === "adult" ? " selected" : ""}>Adult</option><option value="kid"${m.role === "kid" ? " selected" : ""}>Kid</option></select>`
      : `<span class="chip">${ROLE_NAMES[m.role]}</span>`;
    return `<div class="lrow"><div class="lm"><b>${esc(m.name)}${self ? " (you)" : ""}</b>
        ${!onList && f.role !== "kid" ? `<button class="linkbtn" data-addperson="${esc(m.user_id)}" data-name="${esc(m.name)}">Add to "Everyone in the house"</button>` : ""}</div>
      ${roleCtl}${f.role !== "kid" && !self && !owner ? `<button class="linkbtn" data-rmmember="${esc(m.user_id)}" data-name="${esc(m.name)}">Remove</button>` : ""}</div>`;
  }).join("");
  if (f.role !== "kid") renderInvites();
}
let inviteRole = "adult";
async function renderInvites(){
  const box = document.getElementById("inviteList"); if (!box) return;
  document.querySelectorAll("[data-invrole]").forEach(b => b.setAttribute("aria-pressed", b.dataset.invrole === inviteRole));
  let list = [];
  try{ list = await Cloud.invites(); }catch{ return; }
  box.innerHTML = list.length ? `<div class="mlab" style="margin-top:12px">Codes waiting to be used</div>` + list.map(i => `<div class="lrow"><div class="lm"><b class="code sm">${esc(i.code)}</b> <span class="chip">${ROLE_NAMES[i.role]}</span><small>Works until ${esc(fmtLocal(Date.parse(i.expires_at)))}</small></div>
      <button class="linkbtn" data-shareinv="${esc(i.code)}" data-role="${esc(i.role)}" data-exp="${esc(i.expires_at)}">Share</button><button class="linkbtn" data-cancelinv="${esc(i.code)}">Cancel</button></div>`).join("") : "";
}
function inviteText(code, exp){
  return `Join our family on Household Helper!\n\n1. Open this link on your phone: ${APP_URL}?join=${code}\n   (iPhone: open it in Safari, tap Share, then Add to Home Screen. Android: open it in Chrome and tap Install app.)\n2. Open the app, go to Family & sign in and tap "Join my family". The code is already filled in.\n3. Type your name, your email and a password.\n\nInvite code: ${code}\nIt works until ${fmtLocal(Date.parse(exp))}.`;
}
async function shareInvite(code, exp){
  const text = inviteText(code, exp); const msg = document.getElementById("inviteMsg");
  if (navigator.share){ try{ await navigator.share({title: "Join our family on Household Helper", text}); return; }catch(e){ if (e && e.name === "AbortError") return; } }
  try{ await navigator.clipboard.writeText(text); msg.textContent = "Invite copied. Paste it into a message to send it."; }
  catch{ msg.textContent = `Send them this code: ${code}`; }
}

/* ---------- Clicks, forms and changes ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
  if (d.authgo){ authMode = d.authgo; renderAccount(); const first = document.querySelector("#acctBody input"); if (first && d.authgo !== "start") first.focus(); }
  if (d.showprivacy){ const p = document.getElementById("privacy"); p.open = true; p.scrollIntoView({block: "start"}); }
  if (d.invrole){ inviteRole = d.invrole; renderInvites(); document.getElementById("inviteRoleHelp").textContent = inviteRole === "kid" ? "Kids can see everything, tick off chores and add to shopping lists, but can't change other things." : "Adults can change everything and invite others."; }
  if (b.id === "makeInvite"){
    const msg = document.getElementById("inviteMsg"); b.disabled = true; msg.textContent = "Making a code…";
    try{
      const code = await Cloud.createInvite(inviteRole); const exp = new Date(Date.now() + 7 * DAY_MS).toISOString();
      document.getElementById("inviteNew").innerHTML = `<div class="codebox"><span class="mlab">${ROLE_NAMES[inviteRole]} invite code</span><b class="code">${esc(code)}</b><small>Works for 7 days, for as many people as you like.</small>
        <div class="row"><button class="btn" data-shareinv="${esc(code)}" data-exp="${esc(exp)}">Share invite</button></div></div>`;
      msg.textContent = ""; renderInvites();
    }catch(err){ msg.textContent = friendlyError(err); }
    b.disabled = false;
  }
  if (d.shareinv) shareInvite(d.shareinv, d.exp);
  if (d.cancelinv){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Tap again to cancel"; return; }
    try{ await Cloud.cancelInvite(d.cancelinv); renderInvites(); }catch(err){ toast(friendlyError(err)); }
  }
  if (d.rmmember){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = `Tap again to remove ${d.name}`; return; }
    try{ await Cloud.removeMember(d.rmmember); toast(`${d.name} can no longer sign in to this family.`); renderLogins(); }catch(err){ toast(friendlyError(err)); }
  }
  if (d.addperson && db){
    await db.collection("people").add({name: d.name, userId: d.addperson, color: PALETTE[people.length % PALETTE.length], created: Date.now()});
    renderLogins();
  }
  if (b.id === "signOut"){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Tap again to sign out of this phone"; return; }
    b.disabled = true; await Cloud.signOut(); authMode = "start"; renderAll(); renderAccount(); toast("Signed out. Your family's data is still safe in your account.");
  }
});

document.addEventListener("input", e => {
  if (e.target.id === "sj-code") checkCode("sj");
  if (e.target.id === "jc-code") checkCode("jc");
});

document.addEventListener("submit", async e => {
  const f = e.target; const id = f.id;
  const handled = ["signupNewForm", "signupJoinForm", "signinForm", "resetForm", "newPassForm", "joinCodeForm", "newFamForm", "famRenameForm", "myNameForm", "passForm", "deleteForm"];
  if (!handled.includes(id)) return;
  e.preventDefault();
  const v = x => ((document.getElementById(x) || {}).value || "").trim();
  const msg = f.querySelector(".tip[id$='Msg']") || document.getElementById("authMsg") || {set textContent(x){ toast(x); }};
  const btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
  let keep = false; // true when a message must stay on screen
  try{
    if (id === "signupNewForm"){
      msg.textContent = "Setting up your family…";
      const r = await Cloud.signUpNew({name: v("sn-name"), family: v("sn-family"), email: v("sn-email"), password: document.getElementById("sn-pass").value});
      if (r === "confirm"){ msg.textContent = "Check your email for a link to confirm your login, then come back and sign in."; keep = true; }
      else { toast(`Welcome to Household Helper! Next, add everyone in your house, then invite them.`, 6000); authMode = "start"; }
    }
    if (id === "signupJoinForm"){
      msg.textContent = "Joining…";
      const r = await Cloud.signUpJoin({code: v("sj-code"), name: v("sj-name"), email: v("sj-email"), password: document.getElementById("sj-pass").value});
      if (r === "confirm"){ msg.textContent = "Check your email for a link to confirm your login, then sign in and enter the code."; keep = true; }
      else { pendingJoinCode = ""; toast(`You're in! Welcome to the ${Cloud.fam ? Cloud.fam.name + " family" : "family"}.`, 6000); authMode = "start"; }
    }
    if (id === "signinForm"){ msg.textContent = "Signing in…"; await Cloud.signIn(v("si-email"), document.getElementById("si-pass").value); authMode = "start"; toast("Signed in."); }
    if (id === "resetForm"){ await Cloud.reset(v("rs-email")); msg.textContent = "If that email has a login, a reset link is on its way."; keep = true; }
    if (id === "newPassForm"){ await Cloud.changePassword(document.getElementById("np-pass").value); toast("Password saved."); }
    if (id === "joinCodeForm"){ msg.textContent = "Joining…"; await Cloud.joinFamily(v("jc-code"), v("jc-name")); pendingJoinCode = ""; toast(`You're in! Welcome to the ${Cloud.fam ? Cloud.fam.name + " family" : "family"}.`, 6000); }
    if (id === "newFamForm"){ msg.textContent = "Setting up…"; await Cloud.createFamily(v("nf-family"), v("nf-name")); toast("Your family is set up. Next, add everyone in your house, then invite them.", 6000); }
    if (id === "famRenameForm"){ await Cloud.renameFamily(v("fr-name")); toast("Family name saved."); }
    if (id === "myNameForm"){ await Cloud.renameMe(v("mn-name")); toast("Name saved."); }
    if (id === "passForm"){
      const a = document.getElementById("cp-pass").value, c = document.getElementById("cp-pass2").value;
      if (a !== c){ msg.textContent = "The two passwords don't match."; keep = true; }
      else { await Cloud.changePassword(a); f.reset(); msg.textContent = "Password changed. Use the new one next time you sign in."; keep = true; }
    }
    if (id === "deleteForm"){
      if (v("del-confirm").toUpperCase() !== "DELETE"){ msg.textContent = 'Type DELETE in capitals to confirm.'; keep = true; }
      else {
        const owner = Cloud.fam && Cloud.fam.role === "owner";
        msg.textContent = "Deleting…";
        if (owner) await Cloud.deleteFamily(); else await Cloud.deleteMyLogin();
        authMode = "start"; renderAll(); toast(owner ? "Your family, its data and every login in it have been deleted." : "Your login has been deleted.", 7000);
      }
    }
  }catch(err){ msg.textContent = friendlyError(err); keep = true; }
  if (btn && document.contains(btn)) btn.disabled = false;
  // Redraw only after something changed, so messages stay on screen
  if (!keep){ renderAccount(); renderMyLogin(); renderLogins(); }
});

document.addEventListener("change", async e => {
  const c = e.target;
  if (c.dataset && c.dataset.setrole){
    try{ await Cloud.setRole(c.dataset.setrole, c.value); toast("Role changed."); }catch(err){ toast(friendlyError(err)); renderLogins(); }
  }
});

/* Your login: name, password, sign out, delete */
function renderMyLogin(){
  const el = document.getElementById("myLoginBody"); if (!el) return;
  const u = Cloud.user, f = Cloud.fam; if (!u) { el.innerHTML = ""; return; }
  const owner = f && f.role === "owner";
  el.innerHTML = `
    ${f ? `<form class="inlineform" id="myNameForm"><label>Your name<input id="mn-name" maxlength="30" value="${esc(f.myName)}"></label><button class="btn ghost sm" type="submit">Save</button><span class="tip" id="myNameMsg"></span></form>` : ""}
    <details class="sub-d"><summary>Change password</summary>
      <form class="authform" id="passForm">${pw("cp-pass", "New password")}${pw("cp-pass2", "Type it again", "")}
      <div class="row"><button class="btn" type="submit">Change password</button><span class="tip" id="passMsg"></span></div></form></details>
    <div class="row" style="margin-top:10px"><button class="btn ghost" id="signOut">Sign out of this phone</button></div>
    <p class="tip">Signing out takes the family's data off this phone. It stays safe in your family's account.</p>
    <details class="sub-d danger-d"><summary>${owner ? "Delete our family" : "Delete my login"}</summary>
      <p class="tip">${owner
        ? "This permanently deletes the family, everything it has saved (plans, calendar, chores, pantry, lists, recipes) and every family member's login. It can't be undone. Back up first if you might want anything later."
        : f ? "This permanently deletes your login and removes you from the family. The family's plans and lists stay for everyone else." : "This permanently deletes your login."}</p>
      <form class="authform" id="deleteForm">${field("del-confirm", "Type DELETE to confirm", 'autocomplete="off" autocapitalize="characters"')}
      <div class="row"><button class="btn danger" type="submit">${owner ? "Delete our family for good" : "Delete my login for good"}</button><span class="tip" id="deleteMsg"></span></div></form>
    </details>`;
}

/* ---------- Start up ---------- */
(() => {
  // ?join=CODE from an invite link: open the join screen with the code filled in
  try{
    const params = new URLSearchParams(location.search); const code = params.get("join");
    if (code){ pendingJoinCode = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12); authMode = "join"; history.replaceState(null, "", location.pathname + location.hash);
      document.getElementById("howto").dataset.auto = "0";
      setTimeout(() => { setView("family"); renderAccount(); document.getElementById("acctPanel").scrollIntoView({block: "start"}); }, 0); }
  }catch{}
  // Don't redraw a panel while someone is typing in it
  const typingIn = id => { const a = document.activeElement; return !!(a && a.closest && a.closest("#" + id) && a.matches("input, textarea, select")); };
  const refresh = () => {
    renderAcctBar();
    if (!typingIn("acctBody")) renderAccount();
    if (!typingIn("myLoginBody")) renderMyLogin();
    renderLogins(); renderPeople();
  };
  // Opening the Family tab shows the latest list of logins and invites
  document.addEventListener("click", e => { const t = e.target.closest("[data-view='family']"); if (t && Cloud.fam) renderLogins(); });
  Cloud.onChange(refresh);
  document.getElementById("howto").querySelector("summary").addEventListener("click", () => { document.getElementById("howto").dataset.auto = "0"; });
  refresh();
  Cloud.init().catch(() => {});
})();
