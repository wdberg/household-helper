/* Household Helper: daily reminders on this phone.
   Once a day, at the time you choose, the phone shows one notification with what matters today:
   who's cooking and what's for dinner, your chores, food to use up, and tomorrow's lunchboxes.
   A server timer sends it, so it arrives even when the app is closed.
   Loaded after account.js; uses Cloud, me, toast, friendlyError. */

const VAPID_PUBLIC = "BBJZmJ4UuLjMtQBWZ0ENYuUDqyF0ykolEr-bSRgcFcfcGUzynbPZ3eYXA3gnocgKPZG5UPuy0x2Qe11goGZ2X5g";
const REMIND_PREFS = [["cook", "Who's cooking and tonight's dinner"], ["chores", "My chores for today"], ["pantry", "Food to use up"], ["lunch", "Tomorrow's lunchboxes"]];
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || "");
const installed = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let pushRow = null, pushSub = null, pushBusy = false;

function b64ToBytes(b64){
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
const timeLabel = hm => { const [h, m] = hm.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };
const TIMES = Array.from({length: 32}, (_, i) => { const mins = 6 * 60 + i * 30; return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`; });

async function loadPushState(){
  pushRow = null; pushSub = null;
  if (!pushSupported() || !Cloud.fam) return;
  try{
    const reg = await navigator.serviceWorker.ready;
    pushSub = await reg.pushManager.getSubscription();
    if (pushSub) pushRow = await Cloud.getPush(pushSub.endpoint);
  }catch{ /* offline */ }
}

function renderReminders(){
  const panel = document.getElementById("remindPanel"), el = document.getElementById("remindBody");
  if (!panel || !el) return;
  panel.hidden = !Cloud.fam;
  if (!Cloud.fam) return;
  if (isIOS && !installed()){
    el.innerHTML = `<p class="tip">On iPhone, reminders only work in the installed app. Add Household Helper to your Home Screen (Safari → Share → <strong>Add to Home Screen</strong>), open it from the icon, sign in, then come back here.</p>`;
    return;
  }
  if (!pushSupported()){ el.innerHTML = `<p class="tip">This browser can't show reminders. Try the installed app on your phone, or Chrome on a computer.</p>`; return; }
  if (Notification.permission === "denied"){
    el.innerHTML = `<p class="tip">Notifications are blocked for Household Helper on this phone. To turn them on, open your phone's <strong>Settings</strong>, find <strong>Notifications</strong>, then Household Helper (or your browser), and allow them. Then come back here.</p>`;
    return;
  }
  const on = !!(pushSub && pushRow);
  const prefs = {cook: true, chores: true, pantry: true, lunch: true, ...((pushRow && pushRow.prefs) || {})};
  const at = (pushRow && pushRow.remind_at) || "16:00";
  el.innerHTML = `
    <p class="tip">One notification a day, at the time you choose, with what matters today. It arrives even when the app is closed. Each phone has its own reminder.</p>
    <label class="check remtoggle"><input type="checkbox" id="remOn"${on ? " checked" : ""}> Daily reminder on this phone</label>
    ${on ? `
      <label class="authform"><span>Remind me at</span><select id="remAt">${TIMES.map(t => `<option value="${t}"${t === at ? " selected" : ""}>${timeLabel(t)}</option>`).join("")}</select></label>
      <fieldset class="rempick"><legend>Include</legend>
        ${REMIND_PREFS.filter(([k]) => !(k === "lunch" && Cloud.fam.role === "kid")).map(([k, label]) => `<label class="check"><input type="checkbox" data-rempref="${k}"${prefs[k] ? " checked" : ""}> ${label}</label>`).join("")}
      </fieldset>
      ${!me ? `<p class="tip">To get your own chores, set <strong>Who's using this phone?</strong> above.</p>` : ""}
      <div class="row"><button class="btn ghost" id="remTest">Send a test reminder now</button><span class="tip" id="remMsg"></span></div>` : `<p class="tip" id="remMsg"></p>`}`;
}

async function turnOn(){
  const msg = document.getElementById("remMsg");
  const perm = await Notification.requestPermission();
  if (perm !== "granted"){ renderReminders(); return; }
  const reg = await navigator.serviceWorker.ready;
  pushSub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC)});
  const k = pushSub.toJSON().keys || {};
  const row = {endpoint: pushSub.endpoint, p256dh: k.p256dh, auth: k.auth, person_id: me || null, remind_at: "16:00",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Perth", prefs: {cook: true, chores: true, pantry: true, lunch: Cloud.fam.role !== "kid"}};
  await Cloud.savePush(row);
  pushRow = row;
  renderReminders();
  toast("Daily reminders are on. Choose the time that suits you.");
  if (msg) msg.textContent = "";
}
async function turnOff(){
  if (pushSub){ try{ await Cloud.deletePush(pushSub.endpoint); }catch{} try{ await pushSub.unsubscribe(); }catch{} }
  pushSub = null; pushRow = null; renderReminders();
}
async function saveRow(changes){
  if (!pushRow) return;
  pushRow = {...pushRow, ...changes};
  try{ await Cloud.savePush({endpoint: pushRow.endpoint, p256dh: pushRow.p256dh, auth: pushRow.auth, person_id: pushRow.person_id, remind_at: pushRow.remind_at, tz: pushRow.tz, prefs: pushRow.prefs, last_sent: changes.remind_at ? null : pushRow.last_sent}); }
  catch(err){ toast(friendlyError(err)); }
}

document.addEventListener("change", async e => {
  const c = e.target; if (!c.closest || !c.closest("#remindBody")) return;
  if (c.id === "remOn"){
    if (pushBusy) return; pushBusy = true; c.disabled = true;
    try{ c.checked ? await turnOn() : await turnOff(); }
    catch(err){ const msg = document.getElementById("remMsg"); if (msg) msg.textContent = /denied|permission/i.test(String(err && err.message)) ? "Notifications weren't allowed." : "Couldn't turn reminders on: " + friendlyError(err); c.checked = false; }
    pushBusy = false; c.disabled = false;
  }
  if (c.id === "remAt") await saveRow({remind_at: c.value}); // a new time can fire again today
  if (c.dataset.rempref) await saveRow({prefs: {...(pushRow.prefs || {}), [c.dataset.rempref]: c.checked}});
});
document.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b || b.id !== "remTest") return;
  const msg = document.getElementById("remMsg"); b.disabled = true; msg.textContent = "Sending…";
  try{ const r = await Cloud.testPush(pushSub.endpoint); msg.textContent = r && r.results && r.results[0] === "sent" ? "Sent. It should pop up in a few seconds." : "Couldn't deliver it. Try turning reminders off and on again."; }
  catch(err){ msg.textContent = friendlyError(err); }
  b.disabled = false;
});

// Keep "my chores" pointed at whoever uses this phone
document.addEventListener("change", e => { if (e.target.id === "meSel" && pushRow) saveRow({person_id: e.target.value || null}); });

// Signing out stops this phone's reminders (they'd otherwise keep showing the family's plans)
{
  const baseSignOut = Cloud.signOut;
  Cloud.signOut = async function(){
    if (pushSub){ try{ await Cloud.deletePush(pushSub.endpoint); }catch{} try{ await pushSub.unsubscribe(); }catch{} pushSub = null; pushRow = null; }
    return baseSignOut.apply(this, arguments);
  };
}

Cloud.onChange(async () => { await loadPushState(); renderReminders(); if (pushRow && (pushRow.person_id || null) !== (me || null) && me) saveRow({person_id: me}); });
loadPushState().then(renderReminders);
