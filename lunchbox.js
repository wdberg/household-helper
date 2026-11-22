/* Household Helper: school lunchbox planner.
   Monday to Friday for each child: a main, fruit or veg, a snack and an extra.
   Ideas are gluten free; with "nut-free school" on, nut ideas are left out and anything with nuts is flagged.
   Loaded after pantry.js; uses people, person, pchip, addShop, dkey, thisMonday and friends. */

const LB_SLOTS = [["main", "Main"], ["fruit", "Fruit or veg"], ["snack", "Snack"], ["extra", "Extra"]];
const LB_DAYS = DOW.slice(0, 5);
const LB_IDEAS = {
  main: ["Frittata slice", "GF wrap with hummus & chicken", "Lemongrass chicken rice paper rolls", "GF sandwich: chicken & avocado", "GF sandwich: ham, cheese & lettuce",
    "Tuna & bean salad", "GF pasta salad", "Leftover fried rice", "Sushi rolls (made with tamari)", "Cheese & GF crackers", "Rice cakes with cheese & ham",
    "Corn thins with avocado & cheese", "Cold chicken drumstick", "Mini quiches (sweet potato crust)", "Leftover dinner"],
  fruit: ["Apple slices", "Mandarin", "Banana", "Grapes", "Strawberries", "Watermelon cubes", "Pear", "Carrot sticks", "Cucumber sticks", "Cherry tomatoes",
    "Snow peas", "Capsicum strips", "Mango cheeks", "Blueberries", "Kiwi fruit"],
  snack: ["Yoghurt pouch", "Cheese stick", "Popcorn", "Boiled egg", "GF rice crackers", "Hummus & veg sticks", "Cheesy zucchini muffins", "Seed & oat bliss balls (nut-free)",
    "Plain corn chips", "Dried apricots", "Roasted chickpeas", "Cheese cubes", "Seaweed snacks", "GF banana bread", "Peanut butter on rice cakes", "Trail mix with nuts"],
  extra: ["Water bottle", "Small milk", "Fruit purée pouch", "GF nut-free muesli bar", "Cold water and an ice brick"]
};
const NUT_WORDS = /\b(nuts?|peanuts?|almonds?|cashews?|hazelnuts?|walnuts?|pecans?|pistachios?|macadamias?|brazil nuts?|nutella|satay|praline|marzipan|almond meal|peanut butter)\b/i;
const hasNuts = t => NUT_WORDS.test(t || "") && !/nut[- ]free/i.test(t || "");
let lbSettings = {kids: [], nutFree: true}, lbWeeks = {}, lbWeekOff = null, lbKid = "";

function lbMonday(){
  if (lbWeekOff === null) lbWeekOff = dowOf(todayUTC) >= 5 ? 1 : 0; // at the weekend, plan next week
  return thisMonday() + lbWeekOff * 7 * DAY_MS;
}
const lbPath = (mon, kid) => `lunch/${dkey(mon)}-${kid}`;
const lbPlan = (mon, kid) => (lbWeeks[`${dkey(mon)}-${kid}`] || {days: {}}).days || {};
const lbKids = () => (lbSettings.kids || []).map(person).filter(Boolean);
const recipeByTitle = t => { const x = String(t || "").trim().toLowerCase(); return x ? all().find(r => r.title.toLowerCase() === x) : null; };

function renderLunch(){
  const body = document.getElementById("lunchBody"); if (!body) return;
  const mon = lbMonday();
  document.getElementById("lbLabel").textContent = `Week of ${fmt(mon)} – ${fmt(mon + 4 * DAY_MS)}`;
  document.getElementById("lbToday").hidden = lbWeekOff === (dowOf(todayUTC) >= 5 ? 1 : 0);
  document.getElementById("lbNutFree").checked = !!lbSettings.nutFree;
  // Who needs a lunchbox
  document.getElementById("lbKidsPick").innerHTML = people.length
    ? people.map(p => `<label class="kidpick"><input type="checkbox" data-lbkid="${esc(p.id)}"${(lbSettings.kids || []).includes(p.id) ? " checked" : ""}>${pchip(p)}</label>`).join("")
    : '<span class="tip">Add your family on the Family &amp; sign in tab first.</span>';
  const kids = lbKids();
  if (!kids.length){ body.innerHTML = `<p class="empty">Tick who needs a school lunchbox above to start planning.</p>`; document.getElementById("lbTabs").innerHTML = ""; return; }
  if (!kids.some(k => k.id === lbKid)) lbKid = kids[0].id;
  document.getElementById("lbTabs").innerHTML = kids.length > 1 ? kids.map(k => `<button data-lbtab="${esc(k.id)}" aria-pressed="${k.id === lbKid}">${esc(k.name)}</button>`).join("") : "";
  const kid = person(lbKid); const plan = lbPlan(mon, lbKid);
  const filled = LB_DAYS.reduce((n, d) => n + LB_SLOTS.filter(([s]) => (plan[d] || {})[s]).length, 0);
  body.innerHTML = `<div class="panel-head"><h3>${esc(kid.name)}'s lunchboxes</h3><span class="tip">${filled ? `${filled} of ${LB_DAYS.length * LB_SLOTS.length} filled` : "Nothing planned yet"}</span></div>
    <div class="row lbacts adultonly">
      <button class="btn sm" data-lbfill="1">Fill the gaps with ideas</button>
      <button class="btn ghost sm" data-lbcopy="1">Copy last week</button>
      <button class="btn ghost sm" data-lbclear="1">Clear week</button>
    </div>
    <div class="lbdays">${LB_DAYS.map((d, i) => {
      const day = plan[d] || {};
      return `<article class="lbday"><div class="dn">${DAYS[i][1].slice(0, 3)} <span class="dd">${fmt(mon + i * DAY_MS)}</span></div>
        ${LB_SLOTS.map(([s, label]) => {
          const v = day[s] || ""; const r = recipeByTitle(v); const nut = lbSettings.nutFree && hasNuts(v);
          return `<label class="lbslot"><span class="mlab">${label}</span>
            <input value="${esc(v)}" list="lb-${s}" maxlength="80" data-lbday="${d}" data-lbslot="${s}" placeholder="${esc(LB_IDEAS[s][(i * 3 + LB_SLOTS.findIndex(x => x[0] === s)) % LB_IDEAS[s].length])}" aria-label="${DAYS[i][1]} ${label.toLowerCase()} for ${esc(kid.name)}" autocomplete="off">
            ${nut ? '<span class="chip nutflag">Contains nuts? Not for a nut-free school</span>' : ""}${r ? `<button type="button" class="linkbtn" data-open="${esc(r.id)}">Recipe</button>` : ""}</label>`;
        }).join("")}</article>`;
    }).join("")}</div>`;
  // Suggestions for each slot (nut ideas left out when the school is nut-free)
  LB_SLOTS.forEach(([s]) => {
    const dl = document.getElementById("lb-" + s);
    const extra = s === "main" || s === "snack" ? all().filter(r => r.type === (s === "main" ? "lunch" : "snack")).map(r => r.title) : [];
    dl.innerHTML = [...new Set([...LB_IDEAS[s], ...extra])].filter(x => !(lbSettings.nutFree && hasNuts(x))).map(x => `<option value="${esc(x)}">`).join("");
  });
}

async function saveLunchDay(mon, kid, day, slot, value){
  if (!db) return;
  const key = `${dkey(mon)}-${kid}`;
  const cur = lbWeeks[key] || {kid, week: dkey(mon), days: {}};
  const days = {...cur.days, [day]: {...(cur.days[day] || {}), [slot]: value}};
  if (!value) delete days[day][slot];
  lbWeeks = {...lbWeeks, [key]: {...cur, days}};
  await db.doc(lbPath(mon, kid)).set({kid, week: dkey(mon), days});
}
async function setLunchWeek(mon, kid, days){
  lbWeeks = {...lbWeeks, [`${dkey(mon)}-${kid}`]: {kid, week: dkey(mon), days}};
  if (db) await db.doc(lbPath(mon, kid)).set({kid, week: dkey(mon), days});
}

// One idea per empty slot, varied across days and children, skipping nut ideas for nut-free schools
function fillGaps(mon, kid){
  const plan = lbPlan(mon, kid); const days = JSON.parse(JSON.stringify(plan));
  const kidIdx = Math.max(0, (lbSettings.kids || []).indexOf(kid));
  const wk = Math.round((mon - PLAN_START) / (7 * DAY_MS));
  LB_DAYS.forEach((d, i) => {
    days[d] = days[d] || {};
    LB_SLOTS.forEach(([s], si) => {
      if (days[d][s]) return;
      const list = LB_IDEAS[s].filter(x => !(lbSettings.nutFree && hasNuts(x)) && x !== "Leftover dinner");
      const n = list.length; const pick = list[(((i + kidIdx * 2 + wk * 3 + si) % n) + n) % n];
      days[d][s] = s === "extra" && i % 2 ? "Water bottle" : pick; // an extra treat every second day
    });
  });
  return days;
}

function lunchShoppingItems(mon){
  const items = new Map();
  lbKids().forEach(k => { const plan = lbPlan(mon, k.id); LB_DAYS.forEach(d => LB_SLOTS.forEach(([s]) => {
    const v = ((plan[d] || {})[s] || "").trim();
    if (v && !/^(leftover|water bottle|cold water)/i.test(v)){ const key = v.toLowerCase(); if (!items.has(key)) items.set(key, {name: v, kids: new Set()}); items.get(key).kids.add(k.name); }
  })); });
  return [...items.values()];
}

/* ---------- Events ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset; const mon = lbMonday();
  if (b.id === "lbPrev"){ lbWeekOff--; renderLunch(); }
  if (b.id === "lbNext"){ lbWeekOff++; renderLunch(); }
  if (b.id === "lbToday"){ lbWeekOff = null; renderLunch(); }
  if (d.lbtab){ lbKid = d.lbtab; renderLunch(); }
  if (d.lbfill){ await setLunchWeek(mon, lbKid, fillGaps(mon, lbKid)); renderLunch(); }
  if (d.lbcopy){
    const prev = lbPlan(mon - 7 * DAY_MS, lbKid);
    const msg = document.getElementById("lbMsg");
    if (!Object.keys(prev).length){ msg.textContent = "Nothing was planned last week to copy."; return; }
    await setLunchWeek(mon, lbKid, JSON.parse(JSON.stringify(prev))); renderLunch(); msg.textContent = "Copied last week's lunchboxes.";
  }
  if (d.lbclear){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Tap again to clear"; return; }
    await setLunchWeek(mon, lbKid, {}); renderLunch();
  }
  if (b.id === "lbShop"){
    const msg = document.getElementById("lbMsg");
    if (!db){ msg.textContent = "This browser can't save."; return; }
    const wk = dkey(mon);
    const have = new Set(shopItems.filter(x => x.week === wk).map(x => x.name.toLowerCase()));
    const list = lunchShoppingItems(mon).filter(x => !have.has(`${x.name} (lunchbox)`.toLowerCase()));
    if (!list.length){ msg.textContent = lunchShoppingItems(mon).length ? "Everything is already on this week's shopping list." : "Plan some lunchboxes first."; return; }
    b.disabled = true;
    for (const x of list) await addShop(`${x.name} (lunchbox)`, "all", wk);
    b.disabled = false;
    msg.innerHTML = `Added ${list.length} item${list.length > 1 ? "s" : ""} to Everyone's shopping list for the week of ${esc(fmt(mon))}. <button class="linkbtn" data-view="calendar">See lists</button>`;
  }
});
document.addEventListener("change", async e => {
  const c = e.target; const d = c.dataset || {};
  if (d.lbslot){
    const v = c.value.trim().slice(0, 80);
    await saveLunchDay(lbMonday(), lbKid, d.lbday, d.lbslot, v);
    // Refresh just this slot's nut flag and recipe link
    const label = c.closest(".lbslot"); if (label){
      label.querySelectorAll(".nutflag, .linkbtn").forEach(x => x.remove());
      if (lbSettings.nutFree && hasNuts(v)) label.insertAdjacentHTML("beforeend", '<span class="chip nutflag">Contains nuts? Not for a nut-free school</span>');
      const r = recipeByTitle(v); if (r) label.insertAdjacentHTML("beforeend", `<button type="button" class="linkbtn" data-open="${esc(r.id)}">Recipe</button>`);
    }
  }
  if (d.lbkid !== undefined && db){
    const kids = new Set(lbSettings.kids || []); c.checked ? kids.add(d.lbkid) : kids.delete(d.lbkid);
    lbSettings = {...lbSettings, kids: people.map(p => p.id).filter(id => kids.has(id))};
    if (c.checked) lbKid = d.lbkid;
    await db.doc("lunch/settings").set(lbSettings);
  }
  if (c.id === "lbNutFree" && db){ lbSettings = {...lbSettings, nutFree: c.checked}; await db.doc("lunch/settings").set(lbSettings); renderLunch(); }
});

(() => {
  renderLunch();
  if (!db) return;
  const typing = () => { const a = document.activeElement; return a && a.matches && a.matches("#lunchBody input"); };
  let timer = null;
  const later = () => { if (typing()){ clearTimeout(timer); timer = setTimeout(later, 800); } else renderLunch(); };
  db.doc("lunch/settings").onSnapshot(s => { lbSettings = s.exists ? {kids: [], nutFree: true, ...s.data()} : {kids: [], nutFree: true}; later(); });
  db.collection("lunch").onSnapshot(s => {
    lbWeeks = {}; s.docs.forEach(x => { if (x.id !== "settings") lbWeeks[x.id] = x.data(); });
    later();
  });
  db.collection("people").onSnapshot(() => later());
})();
