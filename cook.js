/* Household Helper: "What can I cook?"
   Matches what's in the pantry against every recipe's ingredients and suggests what you can make,
   putting first the recipes that use up food close to its use-by date.
   Loaded after pantry.js; uses pantry, useState, daysLeft, USES, PRODUCTS, all(), addShop and friends. */

const BASICS = /^(salt|pepper|oil|olive oil|water|ice|cooking spray|salt and pepper)$/;
const STOP = new Set(["fresh", "chopped", "diced", "sliced", "grated", "finely", "roughly", "large", "small", "medium", "ripe", "cooked", "leftover", "free", "gluten", "plain",
  "optional", "serve", "to", "and", "or", "of", "for", "with", "the", "a", "an", "in", "into", "cut", "halved", "hulled", "drained", "rinsed", "frozen", "crushed", "tin", "tins", "jar",
  "can", "cans", "pack", "packs", "bunch", "each", "handful", "handfuls", "big", "slice", "slices", "clove", "cloves", "cup", "cups", "tbsp", "tsp", "g", "kg", "ml", "l", "x", "baby",
  "whole", "lean", "fillets", "fillet", "extra", "bag", "bottle", "sachet", "loaf", "half", "pinch", "splash", "juice", "zest", "piece", "pieces", "range", "your", "favourite",
  "labelled", "check", "gf", "mixed", "seasonal", "plus", "about", "some", "few", "squeeze"]);
const stem = w => w.replace(/(ies)$/, "y").replace(/(oes|ches|shes|sses)$/, m => m.slice(0, -2)).replace(/s$/, "");
const words = t => String(t || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w)).map(stem);

// Each recipe's ingredients as short lines: the app's product list for built-in dinners, the written list otherwise
function recipeIngredients(r){
  if (USES[r.id]) return Object.keys(USES[r.id]).map(id => PRODUCTS[id][0]);
  const lines = Array.isArray(r.ingredients) ? r.ingredients : String(r.ingredients || "").split("\n");
  const list = lines.map(x => x.trim()).filter(Boolean);
  return list.length ? list : (r.key || []);
}
// Words that make a different ingredient: "coconut milk" isn't milk, "rice noodles" aren't rice
const MODIFIERS = new Set(["coconut", "almond", "soy", "oat", "rice", "peanut", "sour", "curry", "fish", "oyster", "sweet", "spring", "cream", "corn", "tomato", "chilli", "lemongrass", "stock"]);
// Does a pantry item cover an ingredient? Either their main words match ("Greek yoghurt" / "3 cups plain Greek yoghurt"),
// or every word of the item is in the ingredient ("Chicken" / "500g chicken thighs"), and the ingredient isn't a different thing
function covers(item, line){
  const iw = words(item), lwList = words(line), lw = new Set(lwList);
  if (!iw.length || !lw.size) return false;
  const iset = new Set(iw);
  if ([...lw].some(w => MODIFIERS.has(w) && !iset.has(w) && w !== lwList[lwList.length - 1])) return false;
  return iw[iw.length - 1] === lwList[lwList.length - 1] || iw.every(w => lw.has(w));
}
const isBasic = line => BASICS.test(String(line).toLowerCase().replace(/^[\d\s./]+(g|kg|ml|l|tbsp|tsp|cups?)?\s*/, "").trim());

function cookSuggestions(type){
  const have = pantry.filter(it => ["ok", "none", "soon"].includes(useState(it)));
  if (!have.length) return [];
  return all().filter(r => type === "all" || r.type === type).map(r => {
    const ings = recipeIngredients(r).filter(l => !isBasic(l));
    const got = [], need = [], usesUp = new Set();
    ings.forEach(line => {
      const match = have.find(it => covers(it.name, line));
      if (match){ got.push(line); if (useState(match) === "soon") usesUp.add(match); }
      else need.push(line);
    });
    return {r, got, need, usesUp: [...usesUp], cover: ings.length ? got.length / ings.length : 0};
  }).filter(x => x.got.length && (x.cover >= 0.34 || x.usesUp.length))
    // How much you already have counts most; using up food that's about to go off gives a boost
    .sort((a, b) => (b.cover + 0.3 * Math.min(b.usesUp.length, 2)) - (a.cover + 0.3 * Math.min(a.usesUp.length, 2)) || b.got.length - a.got.length)
    .slice(0, 8);
}

let cookType = "all";
function renderCook(){
  const el = document.getElementById("cookList"); if (!el) return;
  document.querySelectorAll("[data-cooktype]").forEach(b => b.setAttribute("aria-pressed", b.dataset.cooktype === cookType));
  const have = pantry.filter(it => ["ok", "none", "soon"].includes(useState(it)));
  if (!have.length){ el.innerHTML = `<p class="empty">Add what's in your fridge, freezer and pantry below, and ideas will appear here.</p>`; return; }
  const list = cookSuggestions(cookType);
  if (!list.length){ el.innerHTML = `<p class="empty">No ${cookType === "all" ? "" : cookType + " "}recipes match what you have yet. Add a few more items, or try another meal.</p>`; return; }
  el.innerHTML = list.map(x => {
    const total = x.got.length + x.need.length;
    return `<article class="cookcard">
      <div class="cc-head"><b>${esc(x.r.title)}</b><span class="chip">${esc(x.r.type)}</span>${x.r.time ? `<span class="tip">${esc(x.r.time)}</span>` : ""}</div>
      <div class="cc-bar" aria-label="You have ${x.got.length} of ${total} ingredients"><span style="width:${Math.round(x.cover * 100)}%"></span></div>
      <div class="tip">You have <strong>${x.got.length} of ${total}</strong> ingredients${x.need.length ? "" : ". You can make this now!"}</div>
      ${x.usesUp.length ? `<div class="cc-uses">Uses up ${x.usesUp.map(it => `<span class="ub soon">${esc(it.name)}</span>`).join(" ")}</div>` : ""}
      ${x.need.length ? `<details class="cc-need"><summary>You'll also need ${x.need.length} thing${x.need.length > 1 ? "s" : ""}</summary><ul>${x.need.map(n => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
      <div class="row"><button class="linkbtn" data-open="${esc(x.r.id)}">Recipe</button>${x.need.length ? `<button class="linkbtn" data-cookneed="${esc(x.r.id)}">Add what's missing to the shopping list</button>` : ""}</div>
    </article>`;
  }).join("");
}

// Keep the ideas in step with the pantry
{
  const base = renderPantry;
  renderPantry = function(){ base(); renderCook(); };
}

document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
  if (d.cooktype){ cookType = d.cooktype; renderCook(); }
  if (b.id === "goCook"){ setView("pantry"); const p = document.getElementById("cookPanel"); if (p) p.scrollIntoView({block: "start"}); }
  if (d.cookneed){
    if (!db) return;
    const x = cookSuggestions("all").concat(cookSuggestions(cookType)).find(s => s.r.id === d.cookneed); if (!x) return;
    const wk = dkey(thisMonday()); const who = person(me) ? me : "all";
    const have = new Set(shopItems.filter(i => i.week === wk).map(i => i.name.toLowerCase()));
    const add = x.need.map(n => `${n} (${x.r.title})`).filter(n => !have.has(n.toLowerCase()));
    b.disabled = true;
    for (const n of add) await addShop(n, who, wk);
    b.textContent = add.length ? `Added ${add.length} to ${person(me) ? person(me).name + "'s" : "Everyone's"} list` : "Already on the list";
  }
});

renderCook();
