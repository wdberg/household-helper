/* Household Helper: family account, calendar, cooking roster, chores and shopping lists.
   Loaded after the main script in index.html, so it can use db, dayPlan, esc and the other helpers there. */

/* ---------- Family account and sync ----------
   Each family signs up once with an email and password, and everyone in the family signs in with it.
   Everything the app saves is kept on the phone first, then copied to that family's account,
   so it still works offline. The database only lets an account read and change its own rows. */
const SB_URL = "https://vfmsgeuxugojifzmpaaa.supabase.co";
const SB_KEY = "sb_publishable_ZxfhRmfgbfdSrdXGB14pzw__w1SnLc0"; // publishable key: safe to ship in the page

const Cloud = (() => {
  let sb = null, user = null, channel = null, flushTimer = null, flushing = false, lastPull = 0;
  let state = "off"; // off | syncing | on | offline | error
  const listeners = new Set();
  const ls = {
    get(k){ try{ return localStorage.getItem(k); }catch{ return null; } },
    set(k, v){ try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); }catch{} }
  };
  let pending = {}; try{ pending = JSON.parse(ls.get("hh-pending") || "{}") || {}; }catch{ pending = {}; }
  const savePending = () => ls.set("hh-pending", JSON.stringify(pending));
  const setState = s => { state = s; listeners.forEach(f => f()); };

  function client(){
    if (!sb && window.supabase && db) sb = window.supabase.createClient(SB_URL, SB_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "hh-auth"}});
    return sb;
  }

  if (db) localDb._onWrite((path, data) => {
    if (!user) return;
    pending[path] = {d: data, at: Date.now()}; savePending();
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 400);
  });

  async function pullAll(){
    const out = {}; const size = 1000;
    for (let from = 0; ; from += size){
      const {data, error} = await sb.from("docs").select("path,data").order("path").range(from, from + size - 1);
      if (error) throw error;
      data.forEach(r => out[r.path] = r.data);
      if (data.length < size) break;
    }
    return out;
  }

  async function flush(){
    if (!user || flushing) return;
    const snap = {...pending}; const paths = Object.keys(snap);
    if (!paths.length){ if (state !== "offline") setState("on"); return; }
    if (!navigator.onLine){ setState("offline"); return; }
    flushing = true; setState("syncing");
    try{
      const ups = paths.filter(p => snap[p].d != null).map(p => ({household_id: user.id, path: p, data: snap[p].d}));
      const dels = paths.filter(p => snap[p].d == null);
      for (let i = 0; i < ups.length; i += 200){
        const {error} = await sb.from("docs").upsert(ups.slice(i, i + 200), {onConflict: "household_id,path"});
        if (error) throw error;
      }
      for (let i = 0; i < dels.length; i += 100){
        const {error} = await sb.from("docs").delete().in("path", dels.slice(i, i + 100));
        if (error) throw error;
      }
      paths.forEach(p => { if (pending[p] === snap[p] || (pending[p] && pending[p].at === snap[p].at)) delete pending[p]; });
      savePending();
      setState("on");
    }catch(err){
      setState(navigator.onLine ? "error" : "offline");
      clearTimeout(flushTimer); flushTimer = setTimeout(flush, 15000);
    }finally{
      flushing = false;
      if (Object.keys(pending).length && state === "on"){ clearTimeout(flushTimer); flushTimer = setTimeout(flush, 300); }
    }
  }

  // Bring this phone up to date with the family account, keeping changes not yet sent
  async function pull(){
    if (!user || !navigator.onLine) return;
    lastPull = Date.now();
    const cloud = await pullAll();
    const local = localDb._export(); const changes = [];
    Object.keys(local).forEach(k => { if (!(k in cloud) && !pending[k]) changes.push([k, null]); });
    Object.keys(cloud).forEach(k => { if (!pending[k] && JSON.stringify(cloud[k]) !== JSON.stringify(local[k])) changes.push([k, cloud[k]]); });
    if (changes.length) localDb._apply(changes);
  }

  async function start(u){
    if (!db) return;
    user = u; setState("syncing");
    try{
      const prev = ls.get("hh-cloud-user");
      const cloud = await pullAll();
      if (prev && prev !== u.id){
        // This phone last held another family's data: show this family's instead
        pending = {}; savePending(); localDb._replace(cloud);
      } else if (prev === u.id){
        await pull();
      } else {
        // First sign-in on this phone: anything saved here that the family doesn't have yet is added to the family
        const local = localDb._export(); const merged = {...cloud};
        Object.keys(local).forEach(k => { if (!(k in cloud)){ merged[k] = local[k]; pending[k] = {d: local[k], at: Date.now()}; } });
        savePending(); localDb._replace(merged);
      }
      ls.set("hh-cloud-user", u.id);
      subscribe();
      await flush();
      if (!Object.keys(pending).length) setState("on");
    }catch(err){
      setState(navigator.onLine ? "error" : "offline");
    }
  }

  function subscribe(){
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("docs-" + user.id)
      .on("postgres_changes", {event: "*", schema: "public", table: "docs", filter: "household_id=eq." + user.id}, payload => {
        if (payload.eventType === "DELETE"){
          const p = payload.old && payload.old.path; if (p && !pending[p] && p in localDb._export()) localDb._apply([[p, null]]);
        } else {
          const r = payload.new; if (!r || !r.path || pending[r.path]) return;
          if (JSON.stringify(localDb._export()[r.path]) !== JSON.stringify(r.data)) localDb._apply([[r.path, r.data]]);
        }
      })
      .subscribe();
  }

  function stop(){
    if (channel && sb){ sb.removeChannel(channel); channel = null; }
    user = null; setState("off");
  }

  async function init(){
    const c = client(); if (!c) return;
    c.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY"){ recovery = true; setView("family"); listeners.forEach(f => f()); }
      const u = session && session.user;
      if (u && (!user || user.id !== u.id)) setTimeout(() => start(u), 0);
      if (!u && user) stop();
      listeners.forEach(f => f());
    });
    const {data} = await c.auth.getSession();
    if (data && data.session && !user) start(data.session.user);
  }
  let recovery = false;

  const resync = () => { if (user){ pull().then(flush).catch(() => setState(navigator.onLine ? "error" : "offline")); } };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastPull > 5000) resync(); });
  window.addEventListener("online", resync);
  window.addEventListener("offline", () => { if (user) setState("offline"); });
  setInterval(() => { if (user && document.visibilityState === "visible") resync(); }, 120000);

  const redirect = () => location.href.split("#")[0].split("?")[0];
  return {
    init, onChange: f => listeners.add(f),
    get user(){ return user; }, get state(){ return state; }, get pendingCount(){ return Object.keys(pending).length; },
    get recovery(){ return recovery; },
    available: () => !!client(),
    family: () => (user && user.user_metadata && user.user_metadata.family) || "",
    async signUp(email, password, family){
      const {data, error} = await client().auth.signUp({email, password, options: {data: {family}, emailRedirectTo: redirect()}});
      if (error) throw error;
      return !!data.session;
    },
    async signIn(email, password){
      const {error} = await client().auth.signInWithPassword({email, password});
      if (error) throw error;
    },
    async reset(email){
      const {error} = await client().auth.resetPasswordForEmail(email, {redirectTo: redirect()});
      if (error) throw error;
    },
    async newPassword(password){
      const {error} = await client().auth.updateUser({password});
      if (error) throw error;
      recovery = false;
    },
    async signOut(){
      await flush().catch(() => {});
      stop();
      // Take the family's data off this phone; it stays safe in the family account
      pending = {}; savePending(); ls.set("hh-cloud-user", null);
      localDb._replace({});
      try{ await client().auth.signOut({scope: "local"}); }catch{}
    }
  };
})();

/* ---------- Family data ---------- */
const PALETTE = ["#2f7a45", "#1d5f8a", "#b0477a", "#9a5b00", "#6b4fa3", "#a3392b", "#2b8a8a", "#6a7f2a"];
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
let people = [], cooks = {weekly: {}, dates: {}}, chores = [], doneByDate = {}, shopItems = [], events = [];
let calMode = "week", calWeek = 0, calMonth = 0, calAdding = null;
let me = ""; try{ me = localStorage.getItem("hh-me") || ""; }catch{}

const dkey = t => new Date(t).toISOString().slice(0, 10);
const fromKey = k => parseDay(k);
const dowOf = t => (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
const mondayOf = t => t - dowOf(t) * DAY_MS;
const thisMonday = () => mondayOf(todayUTC);
const person = id => people.find(p => p.id === id);
const pcolor = p => (p && p.color) || PALETTE[Math.max(0, people.indexOf(p)) % PALETTE.length];
const pchip = (p, extra = "") => p ? `<span class="pchip" style="--c:${esc(pcolor(p))}"${extra}><span class="pdot"></span>${esc(p.name)}</span>` : "";
const canSave = () => !!db;
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function cookFor(t){
  const k = dkey(t);
  const id = k in (cooks.dates || {}) ? cooks.dates[k] : (cooks.weekly || {})[DOW[dowOf(t)]];
  return id ? person(id) || null : null;
}
function cookRowHtml(t){
  if (!people.length) return "";
  const p = cookFor(t);
  return `<div class="mrow"><span class="mlab">Cook</span><div class="dinner">${p ? pchip(p) : '<span class="pchip none">Not set</span>'}<button class="linkbtn" data-cookday="${dkey(t)}">Change</button></div></div>`;
}

/* Chores: which ones fall on a day, and who does them */
function choreStart(c){ return fromKey(c.start) ?? (c.created ? Date.UTC(new Date(c.created).getUTCFullYear(), new Date(c.created).getUTCMonth(), new Date(c.created).getUTCDate()) : PLAN_START); }
function choreDue(c, t){
  const st = choreStart(c);
  if (t < st) return false;
  const days = Array.isArray(c.days) && c.days.length ? c.days : [dowOf(st)];
  switch (c.freq){
    case "daily": return true;
    case "weekly": return days.includes(dowOf(t));
    case "fortnightly": return days.includes(dowOf(t)) && Math.round((mondayOf(t) - mondayOf(st)) / (7 * DAY_MS)) % 2 === 0;
    case "monthly": {
      const d = new Date(t), want = new Date(st).getUTCDate();
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === Math.min(want, last);
    }
    case "once": return dkey(t) === dkey(st);
  }
  return false;
}
function choreWho(c, t){
  if (c.who === "rotate"){
    if (!people.length) return null;
    const rot = chores.filter(x => x.who === "rotate");
    const wk = Math.floor((mondayOf(t) - PLAN_START) / (7 * DAY_MS));
    const n = people.length; const i = ((wk + Math.max(0, rot.indexOf(c))) % n + n) % n;
    return people[i];
  }
  return c.who ? person(c.who) || null : null;
}
const choresOn = t => chores.filter(c => choreDue(c, t));
const freqText = c => {
  const days = (Array.isArray(c.days) && c.days.length ? c.days : [dowOf(choreStart(c))]).map(i => DAYS[i][1].slice(0, 3)).join(", ");
  return c.freq === "daily" ? "Every day" : c.freq === "weekly" ? `Weekly · ${days}` : c.freq === "fortnightly" ? `Fortnightly · ${days}` :
    c.freq === "monthly" ? `Monthly · the ${ordinal(new Date(choreStart(c)).getUTCDate())}` : `Once · ${fmtLong(choreStart(c))}`;
};
const ordinal = n => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

const STARTER_CHORES = [
  {name: "Unload the dishwasher", freq: "daily", who: "rotate"},
  {name: "Wipe kitchen benches", freq: "daily", who: ""},
  {name: "Take the bins out", freq: "weekly", days: [2], who: "rotate"},
  {name: "Washing", freq: "weekly", days: [0, 3], who: ""},
  {name: "Vacuum", freq: "weekly", days: [5], who: "rotate"},
  {name: "Clean the bathroom", freq: "weekly", days: [5], who: "rotate"},
  {name: "Water the plants", freq: "weekly", days: [2, 6], who: "rotate"},
  {name: "Change bed sheets", freq: "fortnightly", days: [6], who: ""},
  {name: "Mop the floors", freq: "fortnightly", days: [5], who: "rotate"},
  {name: "Mow the lawn", freq: "fortnightly", days: [6], who: ""},
  {name: "Clean out the fridge", freq: "monthly", who: ""}
];

/* ---------- Account bar and Family tab ---------- */
function stateText(){
  const u = Cloud.user;
  if (!u) return {dot: "", text: canSave() ? "Saved on this phone only. Sign in to share with your family." : "This browser can't save. Open the app in Safari or Chrome."};
  const fam = Cloud.family() ? `${Cloud.family()} family` : u.email;
  const s = Cloud.state;
  if (s === "on") return {dot: "on", text: `${fam} · up to date`};
  if (s === "syncing") return {dot: "wait", text: `${fam} · saving…`};
  if (s === "offline") return {dot: "wait", text: `${fam} · offline. Changes are saved here and will sync when you're back online.`};
  if (s === "error") return {dot: "wait", text: `${fam} · couldn't sync just now. It will keep trying.`};
  return {dot: "wait", text: fam};
}
function renderAcctBar(){
  const st = stateText();
  document.getElementById("acctBar").innerHTML = `<span class="who"><span class="sdot ${st.dot}"></span><span>${esc(st.text)}</span></span>${Cloud.user ? "" : canSave() && Cloud.available() ? '<button class="btn sm" data-view="family">Sign in</button>' : ""}`;
}
let authMode = "signin";
function renderAccount(){
  const el = document.getElementById("acctBody");
  const u = Cloud.user;
  if (Cloud.recovery && u){
    el.innerHTML = `<h3>Choose a new password</h3>
      <form class="authform" id="newPassForm"><label>New password<input id="np-pass" type="password" minlength="8" autocomplete="new-password" required></label>
      <div class="row"><button class="btn" type="submit">Save password</button><span class="tip" id="authMsg"></span></div></form>`;
    return;
  }
  if (u){
    el.innerHTML = `<h3>${esc(Cloud.family() ? Cloud.family() + " family" : "Your family")}</h3>
      <p class="tip">Signed in as <strong>${esc(u.email)}</strong>. Everything you add is shared with everyone signed in to this account, and no one else can see it.</p>
      <p class="tip"><strong>Add another phone:</strong> install the app on it, open this tab and sign in with the same email and password.</p>
      <label class="authform"><span>Who's using this phone?</span><select id="meSel">${meOptions()}</select></label>
      <p class="tip">Used to start your own shopping list and credit "anyone" chores you tick.</p>
      <div class="row"><button class="btn ghost" id="signOut">Sign out of this phone</button><span class="tip" id="authMsg"></span></div>`;
    return;
  }
  if (!canSave()){ el.innerHTML = `<h3>Share with your family</h3><p class="tip">This browser isn't letting the app save. Open it in Safari or Chrome, not a private window.</p>`; return; }
  if (!Cloud.available()){ el.innerHTML = `<h3>Share with your family</h3><p class="tip">Connect to the internet once to set up family sharing.</p>`; return; }
  const up = authMode === "signup", reset = authMode === "reset";
  el.innerHTML = `<h3>${up ? "Create your family account" : reset ? "Reset your password" : "Sign in to your family account"}</h3>
    <p class="tip">${up ? "One account per family. Everyone signs in with the same email and password, and sees the same plan, calendar, chores and lists." : reset ? "We'll email you a link to choose a new password." : "Sign in with the email and password your family uses. What's already on this phone is added to the family account the first time."}</p>
    <form class="authform" id="authForm">
      ${up ? '<label>Family name<input id="a-family" maxlength="40" placeholder="e.g. Smith" required></label>' : ""}
      <label>Email<input id="a-email" type="email" autocomplete="username" required></label>
      ${reset ? "" : `<label>Password${up ? ' <span class="tip">(at least 8 characters)</span>' : ""}<input id="a-pass" type="password" minlength="${up ? 8 : 6}" autocomplete="${up ? "new-password" : "current-password"}" required></label>`}
      <div class="row"><button class="btn" type="submit" id="authBtn">${up ? "Create account" : reset ? "Send reset link" : "Sign in"}</button><span class="tip" id="authMsg"></span></div>
    </form>
    <p class="tip">${up ? '<button class="linkbtn" data-auth="signin">I already have a family account</button>' : reset ? '<button class="linkbtn" data-auth="signin">Back to sign in</button>' : '<button class="linkbtn" data-auth="signup">New here? Create a family account</button> · <button class="linkbtn" data-auth="reset">Forgot password</button>'}</p>`;
}
const meOptions = () => `<option value="">Not set</option>` + people.map(p => `<option value="${esc(p.id)}"${p.id === me ? " selected" : ""}>${esc(p.name)}</option>`).join("");
function renderPeople(){
  document.getElementById("peopleBody").innerHTML = people.length ? people.map(p => `<div class="prow">
      <input type="color" value="${esc(pcolor(p))}" data-pcolor="${esc(p.id)}" aria-label="Colour for ${esc(p.name)}">
      <input type="text" value="${esc(p.name)}" maxlength="30" data-pname="${esc(p.id)}" aria-label="Name">
      <button class="xbtn" data-pdel="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button></div>`).join("")
    : `<p class="empty">No one added yet.</p>`;
  document.getElementById("cookBody").innerHTML = DOW.map((d, i) => `<label>${DAYS[i][1]}<select data-cookweekly="${d}">
      <option value="">Not set</option>${people.map(p => `<option value="${esc(p.id)}"${(cooks.weekly || {})[d] === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>`).join("");
  const meSel = document.getElementById("meSel"); if (meSel) meSel.innerHTML = meOptions();
}

/* ---------- Calendar ---------- */
function dayCard(t){
  const w = Math.floor((t - PLAN_START) / (7 * DAY_MS)); const i = dowOf(t);
  const d = dayPlan(w, i); const k = dkey(t);
  const r = d.dinner ? byId(d.dinner) : null;
  const dinner = d.mode === "leftovers" ? "Leftovers" : r ? r.title : "";
  const cook = cookFor(t);
  const done = doneByDate[k] || {};
  const list = choresOn(t);
  const evs = events.filter(e => e.date === k).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const choreHtml = list.length ? `<ul class="clist">${list.map(c => {
      const who = choreWho(c, t); const isDone = c.id in done; const by = isDone && done[c.id] ? person(done[c.id]) : null;
      return `<li class="${isDone ? "done" : ""}"><label><input type="checkbox" data-chore="${esc(c.id)}" data-date="${k}"${isDone ? " checked" : ""}><span class="cn">${esc(c.name)}</span></label>${pchip(by || who)}</li>`;
    }).join("")}</ul>` : '<span class="tip">No chores</span>';
  const evHtml = evs.map(e => `<div class="evt">${e.time ? `<span class="tm">${esc(e.time)}</span>` : ""}<span class="et">${esc(e.title)}</span>${pchip(person(e.person))}<button class="xbtn" data-evdel="${esc(e.id)}" aria-label="Remove ${esc(e.title)}">✕</button></div>`).join("");
  const adding = calAdding === k;
  const evForm = adding ? `<form class="evform" data-evadd="${k}"><input type="text" name="title" maxlength="80" placeholder="e.g. Soccer training" aria-label="What's on" required><input type="time" name="time" aria-label="Time"><select name="person" aria-label="Who">${'<option value="">Everyone</option>' + people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select><button class="btn sm" type="submit">Add</button><button class="btn ghost sm" type="button" data-evcancel="1">Cancel</button></form>`
    : `<button class="linkbtn" data-evopen="${k}">+ Add to this day</button>`;
  return `<article class="day calday${d.st === "away" ? " away" : ""}${t === todayUTC ? " today" : ""}" id="cal-${k}">
    <div><div class="dn">${DAYS[i][1].slice(0, 3)}</div><div class="dd">${fmt(t)}</div>${d.st === "away" ? '<div class="aw">away</div>' : ""}</div>
    <div class="meals">
      <div class="mrow"><span class="mlab">Cook</span><div class="dinner">${cook ? pchip(cook) : `<span class="pchip none">${people.length ? "Not set" : "Add your family first"}</span>`}${people.length ? `<button class="linkbtn" data-cookday="${k}">Change</button>` : `<button class="linkbtn" data-view="family">Add family</button>`}</div></div>
      ${dinner ? `<div class="mrow"><span class="mlab">Dinner</span><div class="dinner"><span>${esc(dinner)}</span>${r && d.mode !== "leftovers" ? `<button class="linkbtn" data-open="${esc(r.id)}">Recipe</button>` : ""}</div></div>` : ""}
      <div class="mrow"><span class="mlab">Chores</span>${choreHtml}</div>
      <div class="mrow"><span class="mlab">On</span><div>${evHtml}${evForm}</div></div>
    </div></article>`;
}
function calWeekStart(){ return thisMonday() + calWeek * 7 * DAY_MS; }
function renderCalendar(){
  const body = document.getElementById("calBody"); if (!body) return;
  document.querySelectorAll("[data-calmode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.calmode === calMode));
  const hint = document.getElementById("calHint");
  hint.textContent = people.length ? "" : "Add your family on the Family & sign in tab to set cooks, chores and lists for each person.";
  if (calMode === "week"){
    const mon = calWeekStart();
    document.getElementById("calLabel").textContent = `${fmt(mon)} – ${fmt(mon + 6 * DAY_MS)}`;
    document.getElementById("calToday").hidden = calWeek === 0;
    body.innerHTML = `<div class="days">${Array.from({length: 7}, (_, i) => dayCard(mon + i * DAY_MS)).join("")}</div>`;
  } else {
    const now = new Date(todayUTC);
    const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + calMonth, 1);
    const fd = new Date(first); const month = fd.getUTCMonth();
    document.getElementById("calLabel").textContent = fd.toLocaleDateString("en-AU", {month: "long", year: "numeric", timeZone: "UTC"});
    document.getElementById("calToday").hidden = calMonth === 0;
    const start = mondayOf(first);
    const lastDay = Date.UTC(fd.getUTCFullYear(), month + 1, 0);
    const weeks = Math.ceil((lastDay - start + DAY_MS) / (7 * DAY_MS));
    let html = DAYS.map(([, n]) => `<div class="mh">${n.slice(0, 3)}</div>`).join("");
    for (let i = 0; i < weeks * 7; i++){
      const t = start + i * DAY_MS; const k = dkey(t);
      const cook = cookFor(t); const nc = choresOn(t).length; const ne = events.filter(e => e.date === k).length;
      const bits = [nc ? `${nc} chore${nc > 1 ? "s" : ""}` : "", ne ? `${ne} on` : ""].filter(Boolean).join(" · ");
      html += `<button class="mcell${new Date(t).getUTCMonth() !== month ? " other" : ""}${t === todayUTC ? " today" : ""}${status(t) === "away" ? " away" : ""}" data-calgo="${k}" aria-label="${esc(fmtLong(t))}${cook ? ", " + esc(cook.name) + " cooks" : ""}${bits ? ", " + bits : ""}">
        <span class="md">${new Date(t).getUTCDate()}</span>${cook ? `<span class="mk" style="--c:${esc(pcolor(cook))}"><span class="pdot"></span><span>${esc(cook.name)}</span></span>` : ""}${bits ? `<span class="mc">${bits}</span>` : ""}${ne ? '<span class="pdot" style="--c:var(--gf)" aria-hidden="true"></span>' : ""}</button>`;
    }
    body.innerHTML = `<div class="month">${html}</div><p class="tip">Tap a day to open its week.</p>`;
  }
  renderShopLists(); renderStars();
}
function renderStars(){
  const mon = calMode === "week" ? calWeekStart() : thisMonday();
  const count = {};
  for (let i = 0; i < 7; i++){ const d = doneByDate[dkey(mon + i * DAY_MS)] || {}; Object.values(d).forEach(pid => { if (pid) count[pid] = (count[pid] || 0) + 1; }); }
  const el = document.getElementById("calStars");
  el.innerHTML = people.length ? people.map(p => ({p, n: count[p.id] || 0})).sort((a, b) => b.n - a.n)
      .map(({p, n}) => `<span class="star">${pchip(p)}<span class="sc">★ ${n}</span></span>`).join("")
    : '<span class="tip">Add your family to start earning stars.</span>';
}

/* ---------- Shopping lists, one per person ---------- */
function shopWeekKey(){ return dkey(calMode === "week" ? calWeekStart() : thisMonday()); }
function renderShopLists(){
  const wk = shopWeekKey();
  const items = shopItems.filter(x => x.week === wk);
  const lists = [...people.map(p => ({id: p.id, p})), {id: "all", p: null}];
  document.getElementById("calShopCount").textContent = items.length ? `${items.filter(x => !x.done).length} to buy` : "";
  document.getElementById("calShop").innerHTML = lists.map(({id, p}) => {
    const mine = items.filter(x => (x.person || "all") === id).sort((a, b) => (a.done - b.done) || (a.created - b.created));
    return `<div class="slist"><h4>${p ? pchip(p) : '<span class="pchip none">Everyone</span>'}</h4>
      <ul class="clist">${mine.map(x => `<li class="${x.done ? "done" : ""}"><label><input type="checkbox" data-shopdone="${esc(x.id)}"${x.done ? " checked" : ""}><span class="cn">${esc(x.name)}</span></label><button class="xbtn" data-shopdel="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">✕</button></li>`).join("") || '<li class="tip">Nothing yet</li>'}</ul>
      <form data-shopadd="${esc(id)}"><input name="item" maxlength="80" placeholder="Add an item" aria-label="Add to ${esc(p ? p.name : "everyone")}'s list" required><button class="btn sm" type="submit">Add</button></form></div>`;
  }).join("");
}
async function addShop(name, personId, week){
  if (!canSave()) return;
  await db.collection("shop").add({name: name.slice(0, 80), person: personId || "all", week, done: false, created: Date.now()});
}
async function addToMyList(recipeId){
  const r = byId(recipeId); if (!r) return 0;
  const lines = (Array.isArray(r.ingredients) ? r.ingredients : String(r.ingredients || "").split("\n")).map(x => x.trim()).filter(Boolean);
  const wk = dkey(thisMonday()); const who = person(me) ? me : "all";
  for (const l of lines) await addShop(`${l} (${r.title})`, who, wk);
  return lines.length;
}

/* Family lists also appear in the online order list */
const familyShopForWeek = start => shopItems.filter(x => x.week === dkey(start) && !x.done);
{
  const baseCosts = renderCosts, baseText = cartText;
  renderCosts = function(){
    baseCosts();
    const start = weekBasket(weekIdx).start; const items = familyShopForWeek(start);
    if (!items.length) return;
    const html = `<div class="cart-group"><div class="cg-head"><span class="mlab">Family shopping lists</span><span class="cg-sub">not priced</span></div><ul class="cart">${items.map(x => {
      const p = person(x.person);
      return `<li class="cart-item"><span></span><div class="ci-main"><span class="iname">${esc(x.name)}</span><small>${esc(p ? p.name + "'s list" : "Everyone's list")}</small></div><div class="ci-price">–</div><a class="ci-link" href="${searchUrl(x.name.replace(/\s*\(.*?\)\s*/g, " ").replace(/^[\d.,/]+\s*(g|kg|ml|l|tbsp|tsp|cups?|x)?\s*/i, "").trim())}" target="_blank" rel="noopener">Find ↗</a></li>`;
    }).join("")}</ul></div>`;
    const groups = document.querySelector("#cartBody .cart-groups"); if (groups) groups.insertAdjacentHTML("beforeend", html);
  };
  cartText = function(){
    const items = familyShopForWeek(weekBasket(weekIdx).start); const base = baseText();
    return items.length ? base + "\n\nFAMILY SHOPPING LISTS\n" + items.map(x => "- " + x.name).join("\n") : base;
  };
}

/* ---------- Chores tab ---------- */
function renderChoreForm(){
  const who = document.getElementById("ch-who"); const cur = who.value;
  who.innerHTML = `<option value="">Anyone</option><option value="rotate">Take turns (rotates weekly)</option>` + people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  who.value = [...who.options].some(o => o.value === cur) ? cur : "";
  const row = document.getElementById("ch-days-row");
  if (!row.querySelector("input")) row.insertAdjacentHTML("beforeend", DAYS.map(([, n], i) => `<label><input type="checkbox" name="chday" value="${i}">${n.slice(0, 3)}</label>`).join(""));
  const f = document.getElementById("ch-freq").value;
  row.hidden = !(f === "weekly" || f === "fortnightly");
  document.getElementById("ch-date-row").hidden = f === "daily" || f === "weekly";
  document.querySelector("#ch-date-row").firstChild.textContent = f === "once" ? "Date" : "Starting";
}
function renderChores(){
  renderChoreForm();
  const el = document.getElementById("choreList");
  el.innerHTML = chores.length ? chores.map(c => {
    const who = c.who === "rotate" ? '<span class="pchip none">Takes turns</span>' : person(c.who) ? pchip(person(c.who)) : '<span class="pchip none">Anyone</span>';
    return `<div class="chrow"><div class="cm"><b>${esc(c.name)}</b><small>${esc(freqText(c))} ${who}</small></div>
      <div class="acts"><button class="linkbtn" data-choreedit="${esc(c.id)}">Edit</button><button class="linkbtn" data-choredel="${esc(c.id)}">Remove</button></div></div>`;
  }).join("") : `<p class="empty">No chores yet. Add your own above, or tap <strong>Add common chores</strong> to start with a typical list you can edit.</p>`;
}
function resetChoreForm(){
  document.getElementById("choreForm").reset();
  document.getElementById("ch-id").value = "";
  document.getElementById("choreFormTitle").textContent = "Add a chore";
  document.getElementById("choreSave").textContent = "Add chore";
  document.getElementById("choreCancel").hidden = true;
  document.getElementById("ch-date").value = dkey(todayUTC);
  renderChoreForm();
}

/* ---------- Render everything family-related ---------- */
function renderFamily(){
  renderAcctBar(); renderAccount(); renderPeople(); renderCalendar(); renderChores();
}

/* ---------- Events ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
  if (d.auth){ authMode = d.auth; renderAccount(); }
  if (b.id === "signOut"){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Tap again: sign out and remove the family's data from this phone"; return; }
    b.disabled = true; await Cloud.signOut(); renderFamily();
  }
  if (d.calmode){ calMode = d.calmode; renderCalendar(); }
  if (b.id === "calPrev"){ calMode === "week" ? calWeek-- : calMonth--; calAdding = null; renderCalendar(); }
  if (b.id === "calNext"){ calMode === "week" ? calWeek++ : calMonth++; calAdding = null; renderCalendar(); }
  if (b.id === "calToday"){ calWeek = 0; calMonth = 0; renderCalendar(); }
  if (d.calgo){ calMode = "week"; calWeek = Math.round((mondayOf(fromKey(d.calgo)) - thisMonday()) / (7 * DAY_MS)); renderCalendar(); const el = document.getElementById("cal-" + d.calgo); if (el) el.scrollIntoView({block: "center"}); }
  if (d.evopen){ calAdding = d.evopen; renderCalendar(); const f = document.querySelector(`form[data-evadd="${d.evopen}"] input`); if (f) f.focus(); }
  if (d.evcancel){ calAdding = null; renderCalendar(); }
  if (d.evdel && canSave()) await db.collection("events").doc(d.evdel).delete();
  if (d.cookday) cookDialog(d.cookday);
  if (d.cookset !== undefined){
    const k = d.date; const dates = {...(cooks.dates || {})};
    if (d.cookset === "usual") delete dates[k]; else dates[k] = d.cookset;
    cooks = {...cooks, dates}; document.getElementById("dlg").close();
    if (canSave()) await db.doc("settings/cooks").set(cooks);
    renderCalendar(); renderWeek();
  }
  if (d.shopdel && canSave()) await db.collection("shop").doc(d.shopdel).delete();
  if (d.pdel){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Remove?"; return; }
    if (canSave()) await db.collection("people").doc(d.pdel).delete();
  }
  if (d.choredel){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Tap again to remove"; return; }
    if (canSave()) await db.collection("chores").doc(d.choredel).delete();
  }
  if (d.choreedit){
    const c = chores.find(x => x.id === d.choreedit); if (!c) return;
    document.getElementById("ch-id").value = c.id;
    document.getElementById("ch-name").value = c.name;
    renderChoreForm();
    document.getElementById("ch-who").value = c.who || "";
    document.getElementById("ch-freq").value = c.freq;
    document.getElementById("ch-date").value = dkey(choreStart(c));
    document.querySelectorAll('input[name="chday"]').forEach(x => x.checked = (c.days || []).includes(+x.value));
    document.getElementById("choreFormTitle").textContent = "Edit chore";
    document.getElementById("choreSave").textContent = "Save changes";
    document.getElementById("choreCancel").hidden = false;
    renderChoreForm();
    document.getElementById("choreForm").scrollIntoView({block: "center"});
  }
  if (b.id === "choreCancel") resetChoreForm();
  if (b.id === "choreStarter" && canSave()){
    const have = new Set(chores.map(c => c.name.toLowerCase()));
    const add = STARTER_CHORES.filter(c => !have.has(c.name.toLowerCase()));
    const base = Date.now();
    for (const [i, c] of add.entries()) await db.collection("chores").add({...c, days: c.days || [], start: dkey(thisMonday()), created: base + i});
    document.getElementById("choreMsg").textContent = add.length ? `Added ${add.length} chores. Edit or remove any of them below.` : "You already have all of them.";
  }
  if (d.addlist){
    const msg = document.getElementById("addListMsg");
    if (!canSave()){ msg.textContent = "This browser can't save."; return; }
    b.disabled = true;
    const n = await addToMyList(d.addlist);
    const p = person(me);
    msg.innerHTML = `Added ${n} items to ${p ? esc(p.name) + "'s" : "Everyone's"} list for this week. <button class="linkbtn" data-view="calendar" onclick="document.getElementById('dlg').close()">See lists</button>`;
  }
});

function cookDialog(k){
  const t = fromKey(k); const cur = cookFor(t); const usual = (cooks.weekly || {})[DOW[dowOf(t)]];
  document.getElementById("dlgBody").innerHTML = `<h3>Who's cooking ${esc(fmtLong(t))}?</h3>
    <div class="pickmenu">${people.map(p => `<button class="pchip" style="--c:${esc(pcolor(p))}" data-cookset="${esc(p.id)}" data-date="${k}"${cur && cur.id === p.id ? ' aria-pressed="true"' : ""}><span class="pdot"></span>${esc(p.name)}</button>`).join("")}
      <button class="pchip none" data-cookset="" data-date="${k}">No one (eating out, takeaway)</button></div>
    <p class="tip">${usual && person(usual) ? `Usually ${esc(person(usual).name)} on ${DAYS[dowOf(t)][1]}s.` : `No usual cook for ${DAYS[dowOf(t)][1]}s. Set one on the Family &amp; sign in tab.`}</p>
    <div class="row">${k in (cooks.dates || {}) ? `<button class="btn ghost" data-cookset="usual" data-date="${k}">Back to the usual cook</button>` : ""}<button class="btn ghost" id="closeDlg">Close</button></div>`;
  document.getElementById("dlg").showModal();
}

document.addEventListener("submit", async e => {
  const f = e.target;
  if (f.id === "authForm"){
    e.preventDefault();
    const msg = document.getElementById("authMsg"), btn = document.getElementById("authBtn");
    const v = id => (document.getElementById(id) || {}).value || "";
    btn.disabled = true; msg.textContent = "One moment…";
    try{
      if (authMode === "signup"){
        const live = await Cloud.signUp(v("a-email").trim(), v("a-pass"), v("a-family").trim());
        msg.textContent = live ? "Account created. You're signed in." : "Account created. Check your email for a link to confirm it, then come back and sign in.";
        if (!live){ authMode = "signin"; setTimeout(() => { renderAccount(); document.getElementById("authMsg").textContent = "Confirm your email, then sign in here."; document.getElementById("a-email").value = v("a-email") || ""; }, 2500); }
      } else if (authMode === "reset"){
        await Cloud.reset(v("a-email").trim()); msg.textContent = "If that email has an account, a reset link is on its way.";
      } else {
        await Cloud.signIn(v("a-email").trim(), v("a-pass")); msg.textContent = "Signed in.";
      }
    }catch(err){
      const m = String((err && err.message) || "");
      msg.textContent = /invalid login/i.test(m) ? "That email and password don't match. Check them and try again."
        : /not confirmed/i.test(m) ? "This account hasn't been confirmed yet. Use the link in the email we sent."
        : /already registered/i.test(m) ? "There's already an account with that email. Sign in instead."
        : /rate limit/i.test(m) ? "Too many tries. Wait a few minutes and try again."
        : !navigator.onLine ? "You're offline. Connect to the internet and try again."
        : m || "Something went wrong. Try again.";
    }
    btn.disabled = false;
  }
  if (f.id === "newPassForm"){
    e.preventDefault(); const msg = document.getElementById("authMsg");
    try{ await Cloud.newPassword(document.getElementById("np-pass").value); renderAccount(); }
    catch(err){ msg.textContent = (err && err.message) || "Couldn't save the password."; }
  }
  if (f.id === "personForm"){
    e.preventDefault(); if (!canSave()) return;
    const name = document.getElementById("p-name").value.trim(); if (!name) return;
    await db.collection("people").add({name, color: PALETTE[people.length % PALETTE.length], created: Date.now()});
    f.reset(); document.getElementById("peopleMsg").textContent = `Added ${name}.`;
  }
  if (f.dataset.evadd){
    e.preventDefault(); if (!canSave()) return;
    const fd = new FormData(f); const title = String(fd.get("title") || "").trim(); if (!title) return;
    calAdding = null;
    await db.collection("events").add({date: f.dataset.evadd, title, time: String(fd.get("time") || ""), person: String(fd.get("person") || ""), created: Date.now()});
  }
  if (f.dataset.shopadd){
    e.preventDefault();
    const name = String(new FormData(f).get("item") || "").trim(); if (!name) return;
    await addShop(name, f.dataset.shopadd, shopWeekKey());
    const input = document.querySelector(`form[data-shopadd="${f.dataset.shopadd}"] input`); if (input) input.focus();
  }
  if (f.id === "choreForm"){
    e.preventDefault(); if (!canSave()) return;
    const msg = document.getElementById("choreMsg");
    const id = document.getElementById("ch-id").value;
    const freq = document.getElementById("ch-freq").value;
    const days = [...document.querySelectorAll('input[name="chday"]:checked')].map(x => +x.value);
    const start = document.getElementById("ch-date").value || dkey(todayUTC);
    if ((freq === "weekly" || freq === "fortnightly") && !days.length){ msg.textContent = "Pick at least one day."; return; }
    const data = {name: document.getElementById("ch-name").value.trim(), who: document.getElementById("ch-who").value, freq, days,
      start: freq === "weekly" ? dkey(thisMonday()) : freq === "fortnightly" ? (fromKey(start) != null ? start : dkey(thisMonday())) : start};
    if (!data.name){ msg.textContent = "Give the chore a name."; return; }
    try{
      if (id){ const old = chores.find(c => c.id === id) || {}; await db.collection("chores").doc(id).set({...old, ...data, id: undefined, created: old.created || Date.now()}); msg.textContent = `Saved "${data.name}".`; }
      else { await db.collection("chores").add({...data, created: Date.now()}); msg.textContent = `Added "${data.name}". It's on the calendar.`; }
      resetChoreForm();
    }catch{ msg.textContent = "Couldn't save. The phone's storage may be full."; }
  }
});

document.addEventListener("change", async e => {
  const c = e.target; const d = c.dataset || {};
  if (c.id === "ch-freq") renderChoreForm();
  if (c.id === "meSel"){ me = c.value; try{ localStorage.setItem("hh-me", me); }catch{} }
  if (!canSave()) return;
  if (d.chore){
    const k = d.date; const cur = {...(doneByDate[k] || {})};
    if (c.checked){
      const ch = chores.find(x => x.id === d.chore); const who = ch ? choreWho(ch, fromKey(k)) : null;
      cur[d.chore] = who ? who.id : (person(me) ? me : "");
    } else delete cur[d.chore];
    doneByDate = {...doneByDate, [k]: cur};
    if (Object.keys(cur).length) await db.doc("done/" + k).set(cur); else await db.doc("done/" + k).delete();
  }
  if (d.shopdone){ const x = shopItems.find(i => i.id === d.shopdone); if (x) await db.collection("shop").doc(x.id).set({...x, id: undefined, done: c.checked}); }
  if (d.pname){ const p = person(d.pname); const name = c.value.trim(); if (p && name) await db.collection("people").doc(p.id).set({...p, id: undefined, name}); }
  if (d.pcolor){ const p = person(d.pcolor); if (p) await db.collection("people").doc(p.id).set({...p, id: undefined, color: c.value}); }
  if (d.cookweekly){ cooks = {...cooks, weekly: {...(cooks.weekly || {}), [d.cookweekly]: c.value}}; await db.doc("settings/cooks").set(cooks); }
});

/* ---------- Load and keep up to date ---------- */
(() => {
  Cloud.onChange(() => { renderAcctBar(); renderAccount(); });
  renderFamily(); resetChoreForm();
  if (!db) return;
  const isTyping = () => { const a = document.activeElement; return a && a.matches("input[type=text], input:not([type]), textarea") && a.closest("#view-calendar, #view-family"); };
  let pendingRender = null;
  const later = fn => { if (isTyping()){ clearTimeout(pendingRender); pendingRender = setTimeout(() => later(fn), 800); } else fn(); };
  db.collection("people").orderBy("created").onSnapshot(s => {
    people = s.docs.map(x => ({...x.data(), id: x.id}));
    later(() => { renderPeople(); renderCalendar(); renderChores(); renderWeek(); });
  });
  db.doc("settings/cooks").onSnapshot(s => { cooks = s.exists ? {weekly: {}, dates: {}, ...s.data()} : {weekly: {}, dates: {}}; later(() => { renderPeople(); renderCalendar(); renderWeek(); }); });
  db.collection("chores").orderBy("created").onSnapshot(s => { chores = s.docs.map(x => ({...x.data(), id: x.id})); later(() => { renderChores(); renderCalendar(); }); });
  db.collection("done").onSnapshot(s => { doneByDate = {}; s.docs.forEach(x => doneByDate[x.id] = x.data()); later(renderCalendar); });
  db.collection("shop").orderBy("created").onSnapshot(s => { shopItems = s.docs.map(x => ({...x.data(), id: x.id})); later(() => { renderCalendar(); renderCosts(); }); });
  db.collection("events").onSnapshot(s => { events = s.docs.map(x => ({...x.data(), id: x.id})); later(renderCalendar); });
  Cloud.init().catch(() => {});
})();
