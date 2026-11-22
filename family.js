/* Household Helper: family account, calendar, cooking roster, chores and shopping lists.
   Loaded after the main script in index.html, so it can use db, dayPlan, esc and the other helpers there. */

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

/* Common chores to choose from, grouped by area. Days: 0 = Monday … 6 = Sunday. who: "" anyone, "rotate" take turns */
const WEEKDAYS = [0, 1, 2, 3, 4];
const COMMON_CHORES = [
  ["Kitchen", [
    {name: "Unload the dishwasher", freq: "daily", who: "rotate"},
    {name: "Load the dishwasher", freq: "daily", who: ""},
    {name: "Wash up after dinner", freq: "daily", who: "rotate"},
    {name: "Set the table for dinner", freq: "daily", who: "rotate"},
    {name: "Clear the table", freq: "daily", who: "rotate"},
    {name: "Wipe kitchen benches", freq: "daily", who: ""},
    {name: "Sweep the kitchen floor", freq: "weekly", days: [1, 4], who: "rotate"},
    {name: "Empty the kitchen rubbish", freq: "weekly", days: [1, 4], who: "rotate"},
    {name: "Clean the microwave", freq: "weekly", days: [4], who: ""},
    {name: "Check use-by dates in the fridge", freq: "weekly", days: [6], who: ""},
    {name: "Clean out the fridge", freq: "monthly", who: ""},
    {name: "Clean the oven", freq: "monthly", who: ""}
  ]],
  ["Bathroom", [
    {name: "Clean the toilet", freq: "weekly", days: [5], who: "rotate"},
    {name: "Clean the shower and bath", freq: "weekly", days: [5], who: "rotate"},
    {name: "Wipe the sink and mirror", freq: "weekly", days: [2, 5], who: "rotate"},
    {name: "Mop the bathroom floor", freq: "weekly", days: [5], who: ""},
    {name: "Change the towels", freq: "weekly", days: [6], who: ""},
    {name: "Restock toilet paper and soap", freq: "weekly", days: [0], who: ""}
  ]],
  ["Laundry", [
    {name: "Washing", freq: "weekly", days: [0, 3], who: ""},
    {name: "Hang out the washing", freq: "weekly", days: [0, 3], who: "rotate"},
    {name: "Fold and put away clothes", freq: "weekly", days: [1, 4], who: "rotate"},
    {name: "Ironing", freq: "weekly", days: [6], who: ""},
    {name: "Change bed sheets", freq: "fortnightly", days: [6], who: ""},
    {name: "Wash the bath mats", freq: "monthly", who: ""}
  ]],
  ["Bedrooms & living areas", [
    {name: "Make your bed", freq: "daily", who: ""},
    {name: "Tidy the lounge room", freq: "daily", who: "rotate"},
    {name: "Tidy your bedroom", freq: "weekly", days: [5], who: ""},
    {name: "Vacuum", freq: "weekly", days: [5], who: "rotate"},
    {name: "Dust the furniture", freq: "weekly", days: [3], who: "rotate"},
    {name: "Mop the floors", freq: "fortnightly", days: [5], who: "rotate"},
    {name: "Wipe light switches and door handles", freq: "fortnightly", days: [3], who: ""},
    {name: "Clean the windows", freq: "monthly", who: ""}
  ]],
  ["Outside", [
    {name: "Take the bins out", freq: "weekly", days: [2], who: "rotate"},
    {name: "Bring the bins in", freq: "weekly", days: [3], who: "rotate"},
    {name: "Water the plants", freq: "weekly", days: [2, 6], who: "rotate"},
    {name: "Sweep the patio and paths", freq: "weekly", days: [6], who: "rotate"},
    {name: "Check the pool", freq: "weekly", days: [6], who: ""},
    {name: "Mow the lawn", freq: "fortnightly", days: [6], who: ""},
    {name: "Weed the garden", freq: "fortnightly", days: [6], who: ""},
    {name: "Clean the barbecue", freq: "monthly", who: ""},
    {name: "Wash the car", freq: "fortnightly", days: [6], who: "rotate"}
  ]],
  ["Pets", [
    {name: "Feed the pets", freq: "daily", who: "rotate"},
    {name: "Walk the dog", freq: "daily", who: "rotate"},
    {name: "Clean the litter tray", freq: "daily", who: ""},
    {name: "Refresh the pets' water", freq: "daily", who: "rotate"},
    {name: "Clean the fish tank", freq: "fortnightly", days: [6], who: ""},
    {name: "Wash the dog", freq: "monthly", who: ""}
  ]],
  ["School & kids", [
    {name: "Make school lunches", freq: "weekly", days: [0, 1, 2, 3, 6], who: "rotate"},
    {name: "Pack school bags", freq: "weekly", days: WEEKDAYS, who: ""},
    {name: "Unpack lunchboxes", freq: "weekly", days: WEEKDAYS, who: ""},
    {name: "Homework and reading", freq: "weekly", days: [0, 1, 2, 3], who: ""},
    {name: "Check school notes and the app", freq: "weekly", days: [4], who: ""},
    {name: "Wash sports uniforms", freq: "weekly", days: [5], who: ""}
  ]],
  ["Running the house", [
    {name: "Plan next week's meals", freq: "weekly", days: [6], who: ""},
    {name: "Do the grocery order", freq: "weekly", days: [6], who: ""},
    {name: "Put the shopping away", freq: "weekly", days: [0], who: "rotate"},
    {name: "Pay the bills", freq: "monthly", who: ""},
    {name: "Test the smoke alarms", freq: "monthly", who: ""},
    {name: "Clean out the car", freq: "monthly", who: "rotate"}
  ]]
];
const COMMON_FLAT = COMMON_CHORES.flatMap(([group, list]) => list.map(c => ({...c, group, days: c.days || []})));
const suggestText = c => {
  const days = (c.days || []).length === 7 ? "every day" : (c.days || []).map(i => DAYS[i][1].slice(0, 3)).join(", ");
  return c.freq === "daily" ? "Every day" : c.freq === "monthly" ? "Monthly" : `${c.freq === "weekly" ? "Weekly" : "Fortnightly"} · ${days}`;
};
const whoText = w => w === "rotate" ? "takes turns" : "anyone";

/* ---------- Family tab: everyone in the house, usual cooks ---------- */
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
  renderChoreForm(); renderCommon();
  const pnl = document.getElementById("commonPanel"); if (pnl && !chores.length && !pnl.dataset.seen){ pnl.open = true; pnl.dataset.seen = "1"; }
  const el = document.getElementById("choreList");
  el.innerHTML = chores.length ? chores.map(c => {
    const who = c.who === "rotate" ? '<span class="pchip none">Takes turns</span>' : person(c.who) ? pchip(person(c.who)) : '<span class="pchip none">Anyone</span>';
    return `<div class="chrow"><div class="cm"><b>${esc(c.name)}</b><small>${esc(freqText(c))} ${who}</small></div>
      <div class="acts"><button class="linkbtn" data-choreedit="${esc(c.id)}">Edit</button><button class="linkbtn" data-choredel="${esc(c.id)}">Remove</button></div></div>`;
  }).join("") : `<p class="empty">No chores yet. Add your own above, or pick from <strong>Choose from common chores</strong>.</p>`;
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

/* ---------- Common chores picker ---------- */
const haveChore = name => chores.some(c => c.name.trim().toLowerCase() === name.toLowerCase());
function renderCommon(){
  const body = document.getElementById("commonBody"); if (!body) return;
  const keep = new Set([...document.querySelectorAll("input[data-common]:checked:not(:disabled)")].map(x => x.dataset.common));
  let i = 0;
  body.innerHTML = COMMON_CHORES.map(([group, list]) => {
    const rows = list.map(c => {
      const idx = i++; const have = haveChore(c.name);
      return `<li class="${have ? "have" : ""}"><label><input type="checkbox" data-common="${idx}" data-group="${esc(group)}"${have ? " checked disabled" : keep.has(String(idx)) ? " checked" : ""}><span class="cn">${esc(c.name)}</span></label>
        <small>${esc(suggestText(c))} · ${whoText(c.who)}</small>${have ? '<span class="chip okchip">Added</span>' : `<button class="linkbtn" data-commonedit="${idx}">Change first</button>`}</li>`;
    }).join("");
    const left = list.filter(c => !haveChore(c.name)).length;
    return `<div class="cgroup"><div class="cg-head"><span class="mlab">${esc(group)}</span>${left ? `<button class="linkbtn" data-commonall="${esc(group)}">Tick all</button>` : '<span class="cg-sub">all added</span>'}</div><ul class="commonlist">${rows}</ul></div>`;
  }).join("");
  const who = document.getElementById("common-who"); const cur = who.value || "suggested";
  who.innerHTML = `<option value="suggested">As suggested (anyone or take turns)</option><option value="">Anyone</option><option value="rotate">Take turns</option>` + people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  who.value = [...who.options].some(o => o.value === cur) ? cur : "suggested";
  document.getElementById("ch-names").innerHTML = COMMON_FLAT.map(c => `<option value="${esc(c.name)}">`).join("");
  updateCommonCount();
}
function updateCommonCount(){
  const n = document.querySelectorAll("input[data-common]:checked:not(:disabled)").length;
  const b = document.getElementById("commonAdd"); if (!b) return;
  b.textContent = n ? `Add ${n} chore${n > 1 ? "s" : ""}` : "Add ticked chores";
}
// Fill how often, which days and who from a common chore's suggestion
function applySuggestion(c){
  document.getElementById("ch-freq").value = c.freq;
  renderChoreForm();
  document.getElementById("ch-who").value = c.who || "";
  document.querySelectorAll('input[name="chday"]').forEach(x => x.checked = (c.days || []).includes(+x.value));
  renderChoreForm();
}

/* ---------- Render everything family-related ---------- */
function renderFamily(){
  if (typeof renderAccount === "function"){ renderAcctBar(); renderAccount(); }
  renderPeople(); renderCalendar(); renderChores();
}

/* ---------- Events ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
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
  if (b.id === "choreStarter"){ const pnl = document.getElementById("commonPanel"); pnl.open = true; pnl.scrollIntoView({block: "start"}); }
  if (d.commonall){
    const boxes = [...document.querySelectorAll(`input[data-common][data-group="${d.commonall}"]:not(:disabled)`)];
    const on = boxes.some(x => !x.checked); boxes.forEach(x => x.checked = on); updateCommonCount();
  }
  if (d.commonedit !== undefined){
    const c = COMMON_FLAT[+d.commonedit]; resetChoreForm();
    document.getElementById("ch-name").value = c.name;
    applySuggestion(c);
    document.getElementById("choreFormTitle").textContent = "Add a chore";
    document.getElementById("choreMsg").textContent = "Change anything you like, then tap Add chore.";
    document.getElementById("choreForm").scrollIntoView({block: "center"});
  }
  if (b.id === "commonAdd" && canSave()){
    const msg = document.getElementById("commonMsg");
    const picked = [...document.querySelectorAll("input[data-common]:checked:not(:disabled)")].map(x => COMMON_FLAT[+x.dataset.common]);
    if (!picked.length){ msg.textContent = "Tick at least one chore first."; return; }
    const whoAll = document.getElementById("common-who").value;
    b.disabled = true; const base = Date.now();
    for (const [i, c] of picked.entries()){
      const who = whoAll === "suggested" ? c.who : whoAll;
      await db.collection("chores").add({name: c.name, freq: c.freq, days: c.days, who, start: dkey(thisMonday()), created: base + i});
    }
    b.disabled = false;
    msg.textContent = `Added ${picked.length} chore${picked.length > 1 ? "s" : ""}. They're on the calendar now; edit any of them in the list below.`;
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
  if (d.common !== undefined) updateCommonCount();
  if (c.id === "ch-name" && !document.getElementById("ch-id").value){
    const m = COMMON_FLAT.find(x => x.name.toLowerCase() === c.value.trim().toLowerCase()); if (m) applySuggestion(m);
  }
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
})();
