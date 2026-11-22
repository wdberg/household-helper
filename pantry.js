/* Household Helper: pantry and use-by tracker.
   Loaded after family.js, so it uses db, person, me, addShop, dkey and the other helpers there.
   Each batch is its own entry with its own use-by date. Synced with the family account like everything else. */

const PLACES = [["fridge", "Fridge"], ["freezer", "Freezer"], ["pantry", "Pantry"]];
const SOON_DAYS = 3;
let pantry = [], pantryShow = "all";
const today = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); }; // fresh each time, as the app can stay open for days

const daysLeft = it => { const t = fromKey(it.useBy); return t == null ? null : Math.round((t - today()) / DAY_MS); };
function useState(it){
  if (!(+it.qty > 0)) return "out";
  const d = daysLeft(it);
  if (d == null) return "none";
  return d < 0 ? "bad" : d <= SOON_DAYS ? "soon" : "ok";
}
function useText(it){
  const d = daysLeft(it);
  if (d == null) return "No use-by date";
  if (d < -1) return `Expired ${-d} days ago`;
  if (d === -1) return "Expired yesterday";
  if (d === 0) return "Use by today";
  if (d === 1) return "Use by tomorrow";
  return `Use by ${fmtLong(fromKey(it.useBy))}${d <= 14 ? ` · ${d} days` : ""}`;
}
function shortUse(it){
  const d = daysLeft(it);
  return d == null ? "no date" : d < -1 ? `expired ${-d} days ago` : d === -1 ? "expired yesterday" : d === 0 ? "use today" : d === 1 ? "use by tomorrow" : `use within ${d} days`;
}
const qtyText = it => `${+(+it.qty || 0).toFixed(2)}${it.unit ? " " + it.unit : ""}`;
const needsUsing = () => pantry.filter(it => ["bad", "soon"].includes(useState(it))).sort((a, b) => daysLeft(a) - daysLeft(b));

/* Recipes that use an item, by matching words in the item's name */
const GENERIC = new Set(["fresh", "frozen", "pack", "free", "range", "gluten", "plain", "large", "small", "fillets", "fillet", "lean", "baby", "mixed", "whole", "with", "tins", "tin", "jar", "bottle", "bunch", "organic"]);
function recipesFor(name){
  const words = String(name).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length >= 3 && !GENERIC.has(w));
  if (!words.length) return [];
  const stems = words.map(w => w.replace(/(es|s)$/, ""));
  return all().filter(r => {
    const txt = [r.title, ...(r.key || []), ...(Array.isArray(r.ingredients) ? r.ingredients : String(r.ingredients || "").split("\n"))].join(" ").toLowerCase();
    return stems.some(s => new RegExp("\\b" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(txt));
  }).slice(0, 3);
}

/* ---------- Rendering ---------- */
function renderPantryAlerts(){
  const list = needsUsing();
  const bad = list.some(it => useState(it) === "bad");
  const text = list.length ? `<span><strong>${list.length} thing${list.length > 1 ? "s" : ""} to use up:</strong> ${list.slice(0, 4).map(it => `${esc(it.name)} (${esc(shortUse(it))})`).join(", ")}${list.length > 4 ? "…" : ""}</span><button class="btn ghost sm" data-view="pantry">See pantry</button>` : "";
  ["pantryAlertWeek", "pantryAlertCal"].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.hidden = !list.length; el.className = "usealert" + (bad ? " bad" : ""); el.innerHTML = text;
  });
  const panel = document.getElementById("useSoonPanel");
  panel.hidden = !list.length;
  document.getElementById("useSoon").innerHTML = `<ul class="uselist">${list.map(it => {
    const rs = recipesFor(it.name);
    return `<li><span><span class="ub ${useState(it)}">${esc(useText(it))}</span> <strong>${esc(it.name)}</strong> · ${esc(qtyText(it))} in the ${esc(it.where)}</span>
      ${rs.length ? `<span class="useideas">Ideas: ${rs.map(r => `<button class="linkbtn" data-open="${esc(r.id)}">${esc(r.title)}</button>`).join(", ")}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}
function pantryRow(it){
  const st = useState(it);
  const chip = st === "out" ? '<span class="ub out">Out</span>' : `<span class="ub ${st === "ok" || st === "none" ? "" : st}">${esc(useText(it))}</span>`;
  return `<div class="pitem" id="pt-${esc(it.id)}">
    <div class="pm"><div class="pn">${esc(it.name)}</div><div class="pd">${chip}${it.addedBy && person(it.addedBy) ? pchip(person(it.addedBy)) : ""}</div></div>
    <div class="qty"><button data-ptstep="-1" data-id="${esc(it.id)}" aria-label="One less ${esc(it.name)}">−</button><span>${esc(qtyText(it))}</span><button data-ptstep="1" data-id="${esc(it.id)}" aria-label="One more ${esc(it.name)}">+</button></div>
    <div class="pacts">
      <button class="linkbtn" data-ptlist="${esc(it.id)}">Add to shopping list</button>
      <button class="linkbtn" data-ptbatch="${esc(it.id)}">Add another batch</button>
      <button class="linkbtn" data-ptedit="${esc(it.id)}">Edit</button>
      <button class="linkbtn" data-ptdel="${esc(it.id)}">${st === "out" || st === "bad" ? "Remove" : "Used up"}</button>
    </div></div>`;
}
function renderPantry(){
  const counts = {all: pantry.length, soon: needsUsing().length};
  PLACES.forEach(([k]) => counts[k] = pantry.filter(it => it.where === k).length);
  document.getElementById("pantryWhere").innerHTML = [["all", "All"], ...PLACES, ["soon", "Use soon"]]
    .map(([k, l]) => `<button data-ptshow="${k}" aria-pressed="${k === pantryShow}">${l}${counts[k] ? ` (${counts[k]})` : ""}</button>`).join("");
  const order = (a, b) => { const x = daysLeft(a), y = daysLeft(b); return (x == null) - (y == null) || (x ?? 0) - (y ?? 0) || a.name.localeCompare(b.name); };
  const el = document.getElementById("pantryList");
  if (!pantry.length){ el.innerHTML = `<p class="empty">Nothing tracked yet. Add what's in the fridge, freezer and pantry above, starting with anything that goes off quickly.</p>`; }
  else if (pantryShow === "soon"){
    const list = needsUsing();
    el.innerHTML = list.length ? `<div class="pgroup">${list.map(pantryRow).join("")}</div>` : `<p class="empty">Nothing needs using in the next ${SOON_DAYS} days.</p>`;
  } else {
    el.innerHTML = PLACES.filter(([k]) => pantryShow === "all" || pantryShow === k).map(([k, label]) => {
      const list = pantry.filter(it => it.where === k).sort(order);
      if (!list.length) return pantryShow === k ? `<p class="empty">Nothing in the ${label.toLowerCase()} yet.</p>` : "";
      return `<div class="pgroup"><div class="cg-head"><span class="mlab">${label}</span><span class="cg-sub">${list.length} item${list.length > 1 ? "s" : ""}</span></div>${list.map(pantryRow).join("")}</div>`;
    }).join("");
  }
  document.getElementById("pantryCount").textContent = counts.soon ? `${counts.soon} to use soon` : "";
  const names = [...new Set([...pantry.map(it => it.name), ...Object.values(PRODUCTS).map(p => p[0])])].sort();
  document.getElementById("pt-names").innerHTML = names.map(n => `<option value="${esc(n)}">`).join("");
  renderPantryAlerts();
  if (typeof queries !== "undefined" && queries.pantry) applyFilter("pantry");
}
FILTERS.pantry = {items: "#pantryList .pitem", groups: "#pantryList .pgroup"};

function resetPantryForm(keep){
  const f = document.getElementById("pantryForm"); f.reset();
  document.getElementById("pt-id").value = "";
  document.getElementById("pt-qty").value = 1;
  if (keep){ document.getElementById("pt-name").value = keep.name; document.getElementById("pt-where").value = keep.where; document.getElementById("pt-unit").value = keep.unit || ""; }
  document.getElementById("pantryFormTitle").textContent = keep ? `Add another batch of ${keep.name}` : "Add to the pantry";
  document.getElementById("pantrySave").textContent = "Add";
  document.getElementById("pantryCancel").hidden = !keep;
}

/* ---------- Events ---------- */
async function savePantry(it){ if (db) await db.collection("pantry").doc(it.id).set({...it, id: undefined}); }
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset; const it = d.id || d.ptlist || d.ptbatch || d.ptedit || d.ptdel ? pantry.find(x => x.id === (d.id || d.ptlist || d.ptbatch || d.ptedit || d.ptdel)) : null;
  if (d.ptshow){ pantryShow = d.ptshow; renderPantry(); }
  if (d.ptdays !== undefined){
    document.getElementById("pt-date").value = +d.ptdays ? dkey(today() + (+d.ptdays) * DAY_MS) : "";
  }
  if (d.ptstep && it){ await savePantry({...it, qty: Math.max(0, Math.round(((+it.qty || 0) + (+d.ptstep)) * 100) / 100)}); }
  if (d.ptlist && it){
    const msg = document.getElementById("pantryMsg");
    await addShop(it.name, person(me) ? me : "all", dkey(thisMonday()));
    msg.textContent = `Added ${it.name} to ${person(me) ? person(me).name + "'s" : "Everyone's"} shopping list for this week.`;
  }
  if (d.ptdel && it){
    if (d.confirm !== "1"){ d.confirm = "1"; b.textContent = "Tap again to remove"; return; }
    if (db) await db.collection("pantry").doc(it.id).delete();
  }
  if (d.ptbatch && it){ resetPantryForm(it); document.getElementById("pantryForm").scrollIntoView({block: "center"}); document.getElementById("pt-date").focus(); }
  if (d.ptedit && it){
    resetPantryForm();
    document.getElementById("pt-id").value = it.id;
    document.getElementById("pt-name").value = it.name;
    document.getElementById("pt-where").value = it.where;
    document.getElementById("pt-qty").value = +it.qty || 0;
    document.getElementById("pt-unit").value = it.unit || "";
    document.getElementById("pt-date").value = it.useBy || "";
    document.getElementById("pantryFormTitle").textContent = `Edit ${it.name}`;
    document.getElementById("pantrySave").textContent = "Save changes";
    document.getElementById("pantryCancel").hidden = false;
    document.getElementById("pantryForm").scrollIntoView({block: "center"});
  }
  if (b.id === "pantryCancel") resetPantryForm();
});
document.addEventListener("submit", async e => {
  if (e.target.id !== "pantryForm") return;
  e.preventDefault();
  const msg = document.getElementById("pantryMsg");
  if (!db){ msg.textContent = "This browser can't save. Open the app in Safari or Chrome."; return; }
  const v = id => document.getElementById(id).value.trim();
  const id = v("pt-id"); const old = pantry.find(x => x.id === id);
  const data = {name: v("pt-name").slice(0, 80), where: v("pt-where"), qty: Math.max(0, parseFloat(v("pt-qty")) || 0), unit: v("pt-unit").slice(0, 20), useBy: v("pt-date")};
  if (!data.name){ msg.textContent = "Give it a name first."; return; }
  try{
    if (old){ await savePantry({...old, ...data}); msg.textContent = `Saved ${data.name}.`; }
    else { await db.collection("pantry").add({...data, addedBy: person(me) ? me : "", created: Date.now()}); msg.textContent = `Added ${data.name}${data.useBy ? `, ${shortUse(data)}` : ""}.`; }
    resetPantryForm(); document.getElementById("pt-name").focus();
  }catch{ msg.textContent = "Couldn't save. The phone's storage may be full."; }
});

(() => {
  renderPantry(); resetPantryForm();
  if (!db) return;
  db.collection("pantry").onSnapshot(s => {
    pantry = s.docs.map(x => ({...x.data(), id: x.id}));
    const a = document.activeElement;
    if (a && a.closest && a.closest("#pantryForm")) { renderPantryAlerts(); setTimeout(renderPantry, 0); return; }
    renderPantry();
  });
  // Dates move on: refresh the flags when the app comes back on screen
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") renderPantry(); });
})();
