// Household Helper reminder sender (Supabase Edge Function).
// Every 15 minutes a timer calls this. For each phone with reminders on, at its chosen local time,
// it works out that person's reminders (who's cooking and tonight's dinner, their chores, food to use up,
// tomorrow's lunchboxes) and sends one notification. Signed-in people can also ask for a test reminder.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";
import PLAN from "./plan.json" with { type: "json" };

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let secrets: Record<string, string> | null = null;
async function getSecrets() {
  if (!secrets) {
    const { data, error } = await sb.from("app_secrets").select("name,value");
    if (error) throw error;
    secrets = Object.fromEntries((data || []).map((r: { name: string; value: string }) => [r.name, r.value]));
    webpush.setVapidDetails("https://wdberg.github.io/household-helper/", secrets.vapid_public, secrets.vapid_private);
  }
  return secrets!;
}

const DAY = 86400000, PLAN_START = Date.UTC(2026, 10, 23);
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const dkey = (t: number) => new Date(t).toISOString().slice(0, 10);
const parseDay = (s?: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
const dowOf = (t: number) => (new Date(t).getUTCDay() + 6) % 7;
const mondayOf = (t: number) => t - dowOf(t) * DAY;
const mins = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

// The phone's local date (as a UTC midnight timestamp) and time of day
function localNow(tz: string, now = new Date()): { t: number; hm: string } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
  } catch { return localNow("Australia/Perth", now); }
  return { t: Date.UTC(+parts.year, +parts.month - 1, +parts.day), hm: `${parts.hour}:${parts.minute}` };
}

// deno-lint-ignore no-explicit-any
type Docs = Record<string, any>;
const coll = (docs: Docs, name: string) => Object.entries(docs).filter(([k]) => k.startsWith(name + "/") && !k.slice(name.length + 1).includes("/")).map(([k, v]) => ({ ...v, id: k.slice(name.length + 1) }));

// ----- Tonight's dinner: the same rules as the app's 4-week plan and roster -----
// deno-lint-ignore no-explicit-any
function rosterSegments(c: any): [string, number][] | null {
  if (c.preset === "2224") return c.nextBreak === "2" ? [["away", 14], ["home", 14], ["away", 14], ["home", 28]] : [["away", 14], ["home", 28], ["away", 14], ["home", 14]];
  if (c.preset === "22") return [["away", 14], ["home", 14]];
  if (c.preset === "21") return [["away", 14], ["home", 7]];
  if (c.preset === "custom") { const on = Math.max(1, Math.min(60, +c.on || 14)), off = Math.max(1, Math.min(60, +c.off || 14)); return [["away", on], ["home", off]]; }
  return null;
}
function dinnerFor(t: number, docs: Docs): string | null {
  const cfg = { preset: "none", ...(docs["settings/roster"] || {}) };
  const start = parseDay(cfg.start); const segs = start != null ? rosterSegments(cfg) : null;
  const cycle = segs ? segs.reduce((a, [, n]) => a + n, 0) : 1;
  let st = "home";
  if (segs && start != null) { let i = Math.floor((t - start) / DAY); i = ((i % cycle) + cycle) % cycle; for (const [s, n] of segs) { if (i < n) { st = s; break; } i -= n; } }
  const w = Math.floor((t - PLAN_START) / (7 * DAY)); const rot = ((w % 4) + 4) % 4; const i = dowOf(t); const k = DOW[i];
  const swaps = (docs["plan/rotation"] || {}).dinners || {};
  let id: string;
  if (st === "away" && segs && start != null) {
    const n = Math.floor((t - start) / DAY); const freezerFrom = start + segs[0][1] * DAY;
    const list: string[] = t >= freezerFrom ? PLAN.FREEZER : PLAN.EASY; id = list[((n % list.length) + list.length) % list.length];
  } else if (i < 5) id = swaps[`w${rot + 1}-${k}`] || (PLAN.ROTATION as Record<string, string>[])[rot][k];
  else return "leftovers";
  return (PLAN.titles as Record<string, string>)[id] || (docs[`recipes/${id}`] || {}).title || null;
}

// ----- Chores: the same rules as the app -----
// deno-lint-ignore no-explicit-any
function choreStart(c: any) { const s = parseDay(c.start); if (s != null) return s; if (c.created) { const d = new Date(c.created); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); } return PLAN_START; }
// deno-lint-ignore no-explicit-any
function choreDue(c: any, t: number) {
  const st = choreStart(c); if (t < st) return false;
  const days = Array.isArray(c.days) && c.days.length ? c.days : [dowOf(st)];
  switch (c.freq) {
    case "daily": return true;
    case "weekly": return days.includes(dowOf(t));
    case "fortnightly": return days.includes(dowOf(t)) && Math.round((mondayOf(t) - mondayOf(st)) / (7 * DAY)) % 2 === 0;
    case "monthly": { const d = new Date(t), want = new Date(st).getUTCDate(); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); return d.getUTCDate() === Math.min(want, last); }
    case "once": return dkey(t) === dkey(st);
  }
  return false;
}
// deno-lint-ignore no-explicit-any
function choreWho(c: any, t: number, people: any[], chores: any[]) {
  if (c.who === "rotate") {
    if (!people.length) return null;
    const rot = chores.filter(x => x.who === "rotate"); const wk = Math.floor((mondayOf(t) - PLAN_START) / (7 * DAY));
    const n = people.length; return people[((wk + Math.max(0, rot.indexOf(c))) % n + n) % n];
  }
  return c.who ? people.find(p => p.id === c.who) || null : null;
}

// ----- One person's reminder for today -----
// deno-lint-ignore no-explicit-any
function buildReminder(docs: Docs, sub: any, role: string, t: number): string[] {
  const prefs = { cook: true, chores: true, pantry: true, lunch: true, ...(sub.prefs || {}) };
  const people = coll(docs, "people").sort((a, b) => (a.created || 0) - (b.created || 0));
  const name = (id?: string) => (people.find(p => p.id === id) || {}).name;
  const me = sub.person_id; const lines: string[] = [];
  if (prefs.cook) {
    const cooks = docs["settings/cooks"] || {}; const k = dkey(t);
    const cookId = cooks.dates && k in cooks.dates ? cooks.dates[k] : (cooks.weekly || {})[DOW[dowOf(t)]];
    const what = dinnerFor(t, docs);
    if (cookId && cookId === me) lines.push(`🍳 You're cooking tonight${what ? `: ${what}` : ""}.`);
    else if (cookId && name(cookId)) lines.push(`🍳 ${name(cookId)} is cooking tonight${what ? `: ${what}` : ""}.`);
    else if (what) lines.push(`🍳 Tonight: ${what}.`);
  }
  if (prefs.chores && me) {
    const chores = coll(docs, "chores").sort((a, b) => (a.created || 0) - (b.created || 0));
    const done = docs[`done/${dkey(t)}`] || {};
    const mine = chores.filter(c => choreDue(c, t) && !(c.id in done) && (choreWho(c, t, people, chores) || {}).id === me).map(c => c.name);
    if (mine.length) lines.push(`🧹 Your chores today: ${mine.join(", ")}.`);
  }
  if (prefs.pantry) {
    const soon = coll(docs, "pantry").filter(it => +it.qty > 0 && parseDay(it.useBy) != null)
      .map(it => ({ it, d: Math.round((parseDay(it.useBy)! - t) / DAY) })).filter(x => x.d >= 0 && x.d <= 1).sort((a, b) => a.d - b.d);
    if (soon.length) lines.push(`🥬 Use soon: ${soon.slice(0, 4).map(x => `${x.it.name} (${x.d === 0 ? "today" : "tomorrow"})`).join(", ")}${soon.length > 4 ? "…" : ""}.`);
  }
  if (prefs.lunch && role !== "kid") {
    const tom = t + DAY; const di = dowOf(tom);
    const kids: string[] = ((docs["lunch/settings"] || {}).kids || []).filter((id: string) => name(id));
    if (di < 5 && kids.length) {
      const bits = kids.map(id => { const day = ((docs[`lunch/${dkey(mondayOf(tom))}-${id}`] || {}).days || {})[DOW[di]] || {}; return day.main ? `${name(id)}: ${day.main}` : `${name(id)}: not planned yet`; });
      lines.push(`🍱 Tomorrow's lunchboxes: ${bits.join("; ")}.`);
    }
  }
  return lines;
}

async function loadDocs(householdId: string) {
  const out: Docs = {}; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb.from("docs").select("path,data").eq("household_id", householdId).range(from, from + size - 1);
    if (error) throw error;
    (data || []).forEach((r: { path: string; data: unknown }) => out[r.path] = r.data);
    if (!data || data.length < size) break;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function send(sub: any, title: string, body: string) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title, body, url: "https://wdberg.github.io/household-helper/" }), { TTL: 6 * 3600 });
    return "sent";
  // deno-lint-ignore no-explicit-any
  } catch (e: any) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) { await sb.from("push_subs").delete().eq("endpoint", sub.endpoint); return "gone"; }
    console.error("push failed", e && e.statusCode, e && e.body);
    return "failed";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // deno-lint-ignore no-explicit-any
  let body: any = {}; try { body = await req.json(); } catch { /* no body */ }
  const s = await getSecrets();
  const isCron = !!s.cron_secret && req.headers.get("x-cron-secret") === s.cron_secret;

  // Checking the reminder rules with sample data (timer secret only; nothing is read or sent)
  if (isCron && body.dryRun) return json({ lines: buildReminder(body.docs || {}, body.sub || {}, body.role || "adult", parseDay(body.date) ?? localNow("Australia/Perth").t) });

  // A signed-in person asking for a test reminder on their own phone(s)
  if (!isCron) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await sb.auth.getUser(token);
    if (!u || !u.user) return json({ error: "not signed in" }, 401);
    let q = sb.from("push_subs").select("*").eq("user_id", u.user.id);
    if (body.endpoint) q = q.eq("endpoint", body.endpoint);
    const { data: subs } = await q;
    if (!subs || !subs.length) return json({ error: "no phone set up for reminders" }, 404);
    const results = [];
    for (const sub of subs) {
      const { data: m } = await sb.from("members").select("role").eq("user_id", sub.user_id).eq("household_id", sub.household_id).maybeSingle();
      const lines = m ? buildReminder(await loadDocs(sub.household_id), sub, m.role, localNow(sub.tz).t) : [];
      results.push(await send(sub, "Household Helper: test reminder", lines.length ? lines.join("\n") : "Reminders are working! There's nothing to remind you about right now."));
    }
    return json({ results });
  }

  // The 15-minute timer: send each phone its reminder once a day at its chosen time (up to 2 hours late if missed)
  const { data: subs, error } = await sb.from("push_subs").select("*");
  if (error) return json({ error: error.message }, 500);
  const docsCache: Record<string, Docs> = {}; let sent = 0, skipped = 0;
  for (const sub of subs || []) {
    const now = localNow(sub.tz); const today = dkey(now.t);
    const late = mins(now.hm) - mins(sub.remind_at);
    if (sub.last_sent === today || late < 0 || late > 120) { skipped++; continue; }
    const { data: m } = await sb.from("members").select("role").eq("user_id", sub.user_id).eq("household_id", sub.household_id).maybeSingle();
    if (!m) { await sb.from("push_subs").delete().eq("endpoint", sub.endpoint); skipped++; continue; } // no longer in that family
    const docs = docsCache[sub.household_id] ||= await loadDocs(sub.household_id);
    const lines = buildReminder(docs, sub, m.role, now.t);
    await sb.from("push_subs").update({ last_sent: today }).eq("endpoint", sub.endpoint);
    if (!lines.length) { skipped++; continue; } // nothing to remind about today
    if (await send(sub, "Household Helper", lines.join("\n")) === "sent") sent++;
  }
  return json({ sent, skipped });
});
