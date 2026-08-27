/* ============================================================
   Marketing — Payment Foundation : Cloudflare Worker (API)
   ------------------------------------------------------------
   Production backend behind index.html. Does what the browser
   cannot: email login codes, store records across devices, hold
   payout details, and auto-credit results from Stripe, owned
   sites, and the (future) in-house click method.

   REWARD MODEL (PH-canonical; 1 point = ₱1):
     - verified result (purchase / paid action / day-3-active
       signup) = 70 points (₱70).
     - traffic = dust: 3 unique clicks = 1 point (₱1).
   Balance banks in ₱100 steps (BAR_FULL); the remainder is the
   worker's "needle". BALANCE IS MONOTONIC: it only ever goes up
   until a payout zeroes it. Refund/cancel after a credit does
   NOT reverse the balance (ABSORB — no clawback). Bad behaviour
   is handled by a ban, never by reducing earned balance.

   FRAUD DETECTION = CITY-CLUSTER (LIVE):
     The signal is SPREAD vs CONCENTRATION. A promoter whose clicks
     are spread across many cities keeps each city's tally low and is
     never flagged. Clicks piling up in ONE city (country|region|city)
     mean the link is NOT spreading — likely farmed. (Per-IP counting
     is inadequate: a family compound has many phones/IPs in one
     place.) Tally is per coarse geo: WARN at CLUSTER_WARN (default
     2000) sets a red warning flag on the worker's board; AUTO-BAN at
     CLUSTER_BAN (default 4000). Both tunable via [vars]. Clicks are
     dust (₱1 per 3) so thresholds are lenient. Geo is supplied by
     owned sites (request body) and by the /go redirector (request.cf);
     no geo -> still counts, just unflagged. Balance never reduced (ban only).

   Attribution: the GATE CODE is the single key — the click
   sub-id, the Stripe metadata, and the owned-site gate.

   SESSION: does NOT expire on a device (persistent token). The
   login CODE expires in 10 minutes.

   PROVISIONAL ACCOUNTS (job applications): admin presses "Add worker"
   ONCE on an application -> account is created (or reused if the email
   already exists) + the applicant is emailed a 72-HOUR code with a
   prefilled login link. First successful code login = permanent (and
   the application row disappears). No login within 72h -> the account
   AND its application auto-delete (cron sweep + login-time check).

   STORAGE: Cloudflare KV (binding: STORE).

   Secrets (wrangler secret put …):
     ADMIN_EMAIL            command-board email
     RESEND_API_KEY         re_… (codes + payment confirmations)
     MAIL_FROM              verified sender
     STRIPE_WEBHOOK_SECRET  whsec_…
     VELIANE_SECRET         shared secret in x-veliane-secret
     STRIPE_CREDIT          "1" to credit purchases via Stripe (default off)
     HOLD_DAYS              days before a signup is rechecked (default 3)
     ACTIVE_WINDOW_DAYS     "still active" = activity within N days at recheck (default 2)
     TRACK_SECRET           x-track-secret for /track/event (optional; falls back to VELIANE_SECRET)
   Tunables (defaults in code): RL_EMAIL_PER_HOUR 7, RL_IP_PER_HOUR 15,
   CLUSTER_WARN 2000, CLUSTER_BAN 4000.
   ============================================================ */

const BAR_FULL = 100;       // points that bank ₱100 to the payable balance
const RESULT_VALUE = 70;    // one verified result = 70 points (₱70)
const CLICKS_PER_POINT = 3; // 3 unique clicks = 1 point (₱1) — dust

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors(), ...extra },
  });

function cors() {
  return {
    "access-control-allow-origin": "*", // tighten to your index.html origin in production
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,stripe-signature,x-veliane-secret,x-track-secret",
  };
}

/* Accept the original shared secret OR a second secret (VELIANE_SECRET_2), so an
   additional owned site (APlusZ) can carry its own secret WITHOUT rotating the
   shared VELIANE_SECRET, which would break the other live sites. Reads x-veliane-secret. */
function okVeliane(req, env) {
  const got = req.headers.get("x-veliane-secret") || "";
  return (!!env.VELIANE_SECRET   && got === env.VELIANE_SECRET) ||
         (!!env.VELIANE_SECRET_2 && got === env.VELIANE_SECRET_2);
}

const CODE_TTL_SEC = 10 * 60;
const PROV_TTL_MS = 72 * 3600 * 1000;     // provisional account life (no activity -> vanish)
const PROV_CODE_TTL_SEC = 72 * 3600;      // the emailed application code lives exactly as long
const now = () => Date.now();
const rid = (p) => p + crypto.randomUUID().replace(/-/g, "").slice(0, 14);

/* ---------- tiny KV data layer ---------- */
async function kvGet(env, k) { const v = await env.STORE.get(k); return v ? JSON.parse(v) : null; }
async function kvPut(env, k, val, ttl) {
  const opt = ttl ? { expirationTtl: ttl } : undefined;
  await env.STORE.put(k, JSON.stringify(val), opt);
}

/* ---------- live FX rates (PHP base; cached ~24h; display-only) ----------
   Source open.er-api.com (free, no key, 160+ currencies, base PHP).
   On API failure: return last cached; if none, minimal {PHP:1} so the front shows pesos. */
async function getFx(env) {
  const KEY = "fx:rates", MAX_AGE = 24 * 3600 * 1000;
  let cached = null;
  try { cached = await kvGet(env, KEY); } catch (e) {}
  if (cached && cached.ts && (Date.now() - cached.ts) < MAX_AGE && cached.rates) return cached;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/PHP", { cf: { cacheTtl: 3600 } });
    const d = await r.json();
    if (d && d.result === "success" && d.rates) {
      const fresh = { ts: Date.now(), base: "PHP", rates: d.rates };
      try { await kvPut(env, KEY, fresh); } catch (e) {}
      return fresh;
    }
  } catch (e) {}
  return cached || { ts: 0, base: "PHP", rates: { PHP: 1 } };
}
async function kvDel(env, k) { await env.STORE.delete(k); }

async function listWorkers(env) {
  const idx = (await kvGet(env, "idx:workers")) || [];
  const out = [];
  for (const id of idx) { const w = await kvGet(env, "worker:" + id); if (w) out.push(w); }
  return out;
}
async function saveWorker(env, w) {
  await kvPut(env, "worker:" + w.id, w);
  const idx = (await kvGet(env, "idx:workers")) || [];
  if (!idx.includes(w.id)) { idx.push(w.id); await kvPut(env, "idx:workers", idx); }
}
async function workerByGate(env, gate) {
  const all = await listWorkers(env);
  return all.find((w) => w.code.toUpperCase() === String(gate).toUpperCase()) || null;
}
async function workerByEmail(env, email) {
  const all = await listWorkers(env);
  return all.find((w) => w.email.toLowerCase() === String(email).toLowerCase()) || null;
}
/* delete a worker everywhere it lives: record, index, links, application rows */
async function removeWorkerEverywhere(env, workerId) {
  await kvDel(env, "worker:" + workerId);
  const idx = ((await kvGet(env, "idx:workers")) || []).filter((x) => x !== workerId);
  await kvPut(env, "idx:workers", idx);
  await kvPut(env, "links", (await getLinks(env)).filter((l) => l.workerId !== workerId));
  await kvPut(env, "applications", ((await kvGet(env, "applications")) || []).filter((a) => a.workerId !== workerId));
}
async function getSites(env) { return (await kvGet(env, "sites")) || []; }
async function getLinks(env) { return (await kvGet(env, "links")) || []; }

/* ---------- link-engine mirror (server-side) ----------
   Must build the exact same "coded" URL the admin's Generate button builds
   client-side, so an auto-filled link is indistinguishable from a manual one. */
function deriveLabelSrv(url) {
  try {
    const h = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "");
    const core = h.split(".")[0] || "site";
    return core.charAt(0).toUpperCase() + core.slice(1);
  } catch (e) { return "Site"; }
}
function buildTrackingLinkSrv(baseUrl, gate, owned, apiOrigin) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : "https://" + baseUrl); }
  catch (e) { return baseUrl; }
  if (owned) return u.origin + "/r/" + encodeURIComponent(gate);
  return apiOrigin.replace(/\/$/, "") + "/go/" + encodeURIComponent(gate) + "?u=" + encodeURIComponent(u.toString());
}
/* One link per registered site, auto-filled the instant a worker account is
   created — mirrors "Generate for ALL" so nobody ever opens an empty page.
   Same dedup key as POST /links (workerId+source+siteId), so it's safe to
   call again later (e.g. admin re-runs mass-generate) without duplicating rows. */
async function createLinksForNewWorker(env, w, apiOrigin) {
  const sites = await getSites(env);
  if (!sites.length) return;
  const links = await getLinks(env);
  let changed = false;
  for (const site of sites) {
    const ex = links.find((l) => l.workerId === w.id && (l.source || "") === "" && l.siteId === site.id);
    if (ex) continue;
    const coded = buildTrackingLinkSrv(site.url, w.code, !!site.owned, apiOrigin);
    links.push({ id: rid("lk_"), workerId: w.id, siteId: site.id, baseUrl: site.url, owned: !!site.owned,
      label: deriveLabelSrv(site.url), coded, title: site.name || "", desc: "", source: "", status: "active", ts: now() });
    changed = true;
  }
  if (changed) await kvPut(env, "links", links);
}
/* Symmetric to createLinksForNewWorker: the instant a NEW SITE is registered,
   every EXISTING worker gets a link to it too. So a durable code (e.g. a
   standing test account) always has a current link for whatever site goes
   live next — no manual "Generate for ALL", no new code to hand a webmaster
   ever again. Same dedup key, safe to call repeatedly. */
async function createLinksForNewSite(env, site, apiOrigin) {
  const workers = await listWorkers(env);
  if (!workers.length) return;
  const links = await getLinks(env);
  let changed = false;
  for (const w of workers) {
    const ex = links.find((l) => l.workerId === w.id && (l.source || "") === "" && l.siteId === site.id);
    if (ex) continue;
    const coded = buildTrackingLinkSrv(site.url, w.code, !!site.owned, apiOrigin);
    links.push({ id: rid("lk_"), workerId: w.id, siteId: site.id, baseUrl: site.url, owned: !!site.owned,
      label: deriveLabelSrv(site.url), coded, title: site.name || "", desc: "", source: "", status: "active", ts: now() });
    changed = true;
  }
  if (changed) await kvPut(env, "links", links);
}

/* ---------- auth (persistent session; code expires) ---------- */
async function requireSession(env, req) {
  const auth = req.headers.get("authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  if (!tok) return null;
  const s = await kvGet(env, "session:" + tok);
  return s || null; // no expiry: a device stays signed in until signout
}
function genCode() {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = ""; const r = crypto.getRandomValues(new Uint8Array(6));
  for (let i = 0; i < 6; i++) s += a[r[i] % a.length];
  return s;
}

/* ---------- email (Resend) ---------- */
/* Returns {ok, reason, detail} — NEVER throws, so a mail problem can't take an
   endpoint down, but callers can now SEE a failure instead of assuming success.
   The old version awaited the fetch and ignored the response entirely: a bad key,
   an unverified sender domain, a rejected recipient or a rate-limit all looked
   exactly like a successful send. That is why "code sent" could be a lie. */
async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) { console.log("[mail SKIPPED — no RESEND_API_KEY]", to, subject); return { ok: false, reason: "no_api_key" }; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM || "Marketing <onboarding@resend.dev>", to, subject, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.log("[mail FAILED]", r.status, to, subject, body.slice(0, 300));
      return { ok: false, reason: "provider_" + r.status, detail: body.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    console.log("[mail ERROR]", to, subject, String(e));
    return { ok: false, reason: "network", detail: String(e) };
  }
}

/* ---------- Stripe signature verify (Web Crypto) ---------- */
async function verifyStripe(env, payload, sigHeader) {
  if (!env.STRIPE_WEBHOOK_SECRET || !sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

/* ---------- idempotency (never count an event twice) ---------- */
async function seen(env, id) {
  if (!id) return false;
  const k = "seen:" + id;
  if (await env.STORE.get(k)) return true;
  await env.STORE.put(k, "1", { expirationTtl: 120 * 24 * 3600 }); // ~chargeback window
  return false;
}

/* ---------- credit (monotonic banking; banned earns nothing) ---------- */
async function creditWorker(env, w, points, kind) {
  if (w.banned) return w;
  w.pending = (w.pending || 0) + points;
  while (w.pending >= BAR_FULL) { w.pending -= BAR_FULL; w.balance = (w.balance || 0) + BAR_FULL; }
  if (kind === "result") w.confirmed = (w.confirmed || 0) + 1;
  await saveWorker(env, w);
  return w;
}
async function addUniqueClicks(env, w, clicks) {
  if (w.banned) return w;
  const carry = (w.clickCarry || 0) + Math.max(0, Math.floor(clicks || 0));
  const pts = Math.floor(carry / CLICKS_PER_POINT);
  w.clickCarry = carry % CLICKS_PER_POINT;
  if (pts > 0) { w.clickPts = (w.clickPts || 0) + pts; await creditWorker(env, w, pts, "click"); }
  else await saveWorker(env, w);
  return w;
}

/* ---------- city-cluster key from a coarse geo {country,region,city} ---------- */
function clusterKey(geo) {
  if (!geo) return null;
  const c  = String(geo.country || geo.c  || "").trim();
  const r  = String(geo.region  || geo.r  || "").trim();
  const ci = String(geo.city    || geo.ci || "").trim();
  const key = [c, r, ci].filter(Boolean).join("|").toLowerCase();
  return key || null;
}

/* ---------- count one dust click + city-cluster warn/ban (city-level only) ----------
   Concentration in ONE city (link not spreading) -> WARN/BAN. A promoter spread across
   many cities keeps each city's tally low and is never flagged. Cost of abuse is dust
   (clicks = ₱1 per 3); thresholds are lenient + tunable via CLUSTER_WARN / CLUSTER_BAN.
   Geo is coarse (city centroid): owned sites forward the visitor's geo in the body; the
   /go redirector reads it from request.cf. No geo present -> still counts, just unflagged. */
async function countDust(env, w, geo) {
  if (w.banned) return w;                       // banned earns nothing, no tally
  const key = clusterKey(geo);
  if (key) {
    w.geo = w.geo || {};
    w.geo[key] = (w.geo[key] || 0) + 1;
    const WARN = parseInt(env.CLUSTER_WARN || "2000", 10);
    const BAN  = parseInt(env.CLUSTER_BAN  || "4000", 10);
    if (w.geo[key] >= BAN) { w.banned = true; await saveWorker(env, w); return w; }
    if (w.geo[key] >= WARN) w.warned = true;
  }
  await addUniqueClicks(env, w, 1);             // saves w (geo + warned included)
  return w;
}

/* ---------- per-site click attribution ----------
   The gate code is deliberately identical across every site, so the ping alone
   cannot say which site a click came from. Two signals, in order:
     1. an explicit `site` in the ping (id, hostname or URL) — exact
     2. otherwise the calling server's IP, stored as "ip:1.2.3.4"
   Unmapped IP buckets are resolved at DISPLAY time through the `ipsite` map, so
   the moment the admin labels an IP once, every past AND future click from that
   server relabels itself. Nothing to migrate, no webmaster coordination. */
function hostOf(u) {
  try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); }
  catch (e) { return String(u || "").trim().toLowerCase().replace(/^www\./, ""); }
}
function siteBucket(sites, hint, ip) {
  if (hint) {
    const raw = String(hint).trim();
    const h = hostOf(raw), lc = raw.toLowerCase();
    const hit = (sites || []).find((x) => x.id === raw || hostOf(x.url) === h || String(x.name || "").toLowerCase() === lc);
    if (hit) return hit.id;
  }
  return ip ? "ip:" + ip : "unknown";
}
function tally(obj, key, n) { const o = obj || {}; o[key] = (o[key] || 0) + (n || 1); return o; }
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "");

    try {
      /* ---- auth: request code (rate-limited per email + per IP, hourly buckets) ---- */
      if (p === "/auth/request" && req.method === "POST") {
        const { email } = await req.json();
        if (!email) return json({ error: "email required" }, 400);
        const isAdmin = email.toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
        let w = await workerByEmail(env, email);
        // login-time check: an unactivated provisional past 72h is gone (account + application)
        if (w && w.provTs && (now() - w.provTs) > PROV_TTL_MS) {
          await removeWorkerEverywhere(env, w.id);
          w = null;
        }
        if (!isAdmin && !w) return json({ error: "not_registered" }, 403);

        // hourly buckets auto-expire; defaults 7/email, 15/IP per hour (override via env)
        const EMAIL_MAX = parseInt(env.RL_EMAIL_PER_HOUR || "7", 10);
        const IP_MAX    = parseInt(env.RL_IP_PER_HOUR    || "15", 10);
        const ip   = req.headers.get("cf-connecting-ip") || "0";
        const slot = Math.floor(Date.now() / 3600000); // changes every hour
        const emKey = "rl:em:" + email.toLowerCase() + ":" + slot;
        const ipKey = "rl:ip:" + ip + ":" + slot;
        const emN = parseInt((await env.STORE.get(emKey)) || "0", 10);
        const ipN = parseInt((await env.STORE.get(ipKey)) || "0", 10);
        if (emN >= EMAIL_MAX) return json({ error: "rate_limited", scope: "email", message: "Too many code requests for this email. Please wait up to an hour, then try again." }, 429);
        if (ipN >= IP_MAX)    return json({ error: "rate_limited", scope: "ip",    message: "Too many code requests from this connection. Please wait up to an hour, then try again." }, 429);
        await env.STORE.put(emKey, String(emN + 1), { expirationTtl: 3700 });
        await env.STORE.put(ipKey, String(ipN + 1), { expirationTtl: 3700 });

        const code = genCode();
        await kvPut(env, "code:" + email.toLowerCase(), { code, role: isAdmin ? "admin" : "worker", workerId: w ? w.id : null }, CODE_TTL_SEC);
        const sent = await sendEmail(env, email, "Your sign-in code",
          `Your code is ${code}. It expires in 10 minutes.\n\nIf this lands in Spam or Junk, please mark it "Not spam" so the next one reaches your inbox.`);
        if (!sent.ok) {
          // The code IS stored — but do not claim it was emailed when it was not.
          console.log("[auth mail failed]", email, sent.reason, sent.detail || "");
          return json({ error: "mail_failed", reason: sent.reason }, 502);
        }
        return json({ ok: true });
      }

      /* ---- auth: verify code -> persistent session ---- */
      if (p === "/auth/verify" && req.method === "POST") {
        const { email, code } = await req.json();
        const rec = await kvGet(env, "code:" + String(email).toLowerCase());
        if (!rec || rec.code !== String(code).toUpperCase()) return json({ error: "bad_code" }, 401);
        await kvDel(env, "code:" + String(email).toLowerCase());
        // first code login ACTIVATES a provisional account (expired ones are swept here too)
        if (rec.workerId) {
          const wv = await kvGet(env, "worker:" + rec.workerId);
          if (!wv) return json({ error: "bad_code" }, 401);
          if (wv.provTs && (now() - wv.provTs) > PROV_TTL_MS) {
            await removeWorkerEverywhere(env, wv.id);
            return json({ error: "bad_code" }, 401);
          }
          if (wv.provTs) { delete wv.provTs; await saveWorker(env, wv); } // permanent
          const apps0 = (await kvGet(env, "applications")) || [];
          const apps1 = apps0.filter((x) => x.workerId !== wv.id);
          if (apps1.length !== apps0.length) await kvPut(env, "applications", apps1);
        }
        const token = rid("s_") + crypto.randomUUID().replace(/-/g, "");
        const session = { email, role: rec.role, workerId: rec.workerId, since: now() };
        await kvPut(env, "session:" + token, session); // no TTL: persists on the device until signout
        let name = "Admin";
        if (rec.workerId) { const w = await kvGet(env, "worker:" + rec.workerId); name = w ? w.name : "Worker"; }
        return json({ token, role: rec.role, name });
      }

      /* ---- public: a "Jobs" visitor leaves an application (no login, no email sent) ---- */
      if (p === "/apply" && req.method === "POST") {
        let body = {}; try { body = await req.json(); } catch (e) {}
        const name   = String(body.name    || "").trim().slice(0, 80);
        const email  = String(body.email   || "").trim().slice(0, 120);
        // the apply form now collects a WhatsApp number instead of a city;
        // `city` is still accepted so older cached clients keep working
        const wa     = String(body.wa      || "").trim().slice(0, 40);
        const city   = String(body.city    || "").trim().slice(0, 80);
        const msg    = String(body.message || "").trim().slice(0, 1000);
        const gender = (String(body.gender || "").trim().toLowerCase() === "female") ? "female"
                     : (String(body.gender || "").trim().toLowerCase() === "male")   ? "male" : "";
        const photo  = String(body.photo || "").startsWith("data:image/") ? String(body.photo).slice(0, 400000) : "";
        if (!name || !email || !(wa || city) || !gender) return json({ error: "name_email_wa_gender_required" }, 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "bad_email" }, 400);
        // soft anti-spam: cap applications per IP per hour (reuses RL_IP_PER_HOUR, min 5)
        const cap  = Math.max(parseInt(env.RL_IP_PER_HOUR || "15", 10), 5);
        const ip   = req.headers.get("cf-connecting-ip") || "0";
        const slot = Math.floor(Date.now() / 3600000);
        const aKey = "rl:ap:" + ip + ":" + slot;
        const aN   = parseInt((await env.STORE.get(aKey)) || "0", 10);
        if (aN >= cap) return json({ error: "rate_limited", message: "Too many applications from this connection. Please try again later." }, 429);
        await env.STORE.put(aKey, String(aN + 1), { expirationTtl: 3700 });
        const apps = (await kvGet(env, "applications")) || [];
        apps.unshift({ id: rid("app_"), name, email, msg, wa, city, gender, photo, ts: now() });
        if (apps.length > 200) apps.length = 200; // keep only the newest 200
        await kvPut(env, "applications", apps);
        return json({ ok: true });
      }

      /* ---- admin: delete one application ---- */
      if (p === "/apply/delete" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { id } = await req.json();
        await kvPut(env, "applications", ((await kvGet(env, "applications")) || []).filter((a) => a.id !== id));
        return json({ ok: true });
      }

      /* ---- admin: clear all applications ---- */
      if (p === "/apply/clear" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        await kvPut(env, "applications", []);
        return json({ ok: true });
      }

      /* ---- admin: ONE press on an application = account + login email ----
         New email  -> provisional worker (provTs) is created.
         Known email -> the existing account is reused (no duplicate).
         Either way the applicant gets ONE email: prefilled link + a 6-char
         code valid 72h. The application row is marked "sent" (button locks).
         Body: { id } ---- */
      if (p === "/apply/create" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const b = await req.json();
        const id = b.id;
        const apps = (await kvGet(env, "applications")) || [];
        const a = apps.find((x) => x.id === id);
        if (!a) return json({ error: "no_application" }, 404);
        if (a.sent) return json({ error: "already_sent" }, 409);
        const cfg = (await kvGet(env, "config")) || {};
        const wname = String(b.name || a.name || "").trim().slice(0, 80) || a.name;
        const wccy  = String(b.currency || cfg.currency || "PHP");
        const wlang = String(b.lang || "en");
        const wcity = (b.city !== undefined ? String(b.city) : (a.city || "")).trim().slice(0, 80);
        const wwa   = (b.wa   !== undefined ? String(b.wa)   : (a.wa   || "")).trim().slice(0, 40);
        const wgender = (() => { const g = String(b.gender !== undefined ? b.gender : (a.gender || "")).trim().toLowerCase();
          return g === "female" ? "female" : g === "male" ? "male" : ""; })();
        const wphoto = (b.photo !== undefined)
          ? (String(b.photo).startsWith("data:image/") ? String(b.photo).slice(0, 400000) : "")
          : (a.photo || "");
        // an edited email re-targets which account this becomes / reuses
        const wemail = (b.email !== undefined && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim()))
          ? String(b.email).trim().slice(0, 120) : a.email;
        a.email = wemail; a.city = wcity; a.wa = wwa; a.gender = wgender; a.photo = wphoto; a.name = wname;
        let w = await workerByEmail(env, wemail);
        const reused = !!w;
        if (!w) {
          let gate = wname.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "W";
          while (await workerByGate(env, gate)) gate = (gate.slice(0, 6) + genCode().slice(0, 2)).slice(0, 8);
          w = { id: rid("w_"), name: wname, email: wemail, code: gate, payout: "",
            currency: wccy, lang: wlang, city: wcity, wa: wwa, gender: wgender,
            phone: wwa, photo: wphoto, bank: null, bankStatus: "",
            confirmed: 0, balance: 0, pending: 0, clickCarry: 0, clickPts: 0, paidTotal: 0,
            note: "", banned: false, warned: false, payoutReq: false, provTs: now() };
          await saveWorker(env, w);
          await createLinksForNewWorker(env, w, url.origin);
        } else {
          w.currency = wccy; w.lang = wlang; w.name = wname;
          if (wcity) w.city = wcity;
          if (wwa) { w.wa = wwa; if (!w.phone) w.phone = wwa; }
          if (wgender) w.gender = wgender;
          if (wphoto) w.photo = wphoto;
          await saveWorker(env, w);
        }
        const code = genCode();
        await kvPut(env, "code:" + wemail.toLowerCase(), { code, role: "worker", workerId: w.id }, PROV_CODE_TTL_SEC);
        a.sent = true; a.sentTs = now(); a.workerId = w.id;
        await kvPut(env, "applications", apps);
        const hireSent = await sendEmail(env, wemail, "Your account has been created",
          `Hi ${w.name},\n\nYour account has been created.\n\nOpen this link:\nhttps://pay.veliane.org/?email=${encodeURIComponent(wemail)}\n\nThen enter this 6 character code: ${code}\n\nPlease sign in within 72 hours.\n\nIf this lands in Spam or Junk, please mark it "Not spam" so the next one reaches your inbox.`);
        if (!hireSent.ok) console.log("[hire mail failed]", wemail, hireSent.reason, hireSent.detail || "");
        // Account is created either way — but the admin must KNOW if the email bounced.
        return json({ ok: true, workerId: w.id, code: w.code, reused, mailed: hireSent.ok, mailError: hireSent.ok ? "" : hireSent.reason });
      }

      /* ---- auth: signout (clears the device session) ---- */
      if (p === "/auth/signout" && req.method === "POST") {
        const auth = req.headers.get("authorization") || "";
        const tok = auth.replace(/^Bearer\s+/i, "").trim();
        if (tok) await kvDel(env, "session:" + tok);
        return json({ ok: true });
      }

      /* ---- worker: own live data ---- */
      if (p === "/me" && req.method === "GET") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "worker") return json({ error: "unauthorized" }, 401);
        const w = await kvGet(env, "worker:" + s.workerId);
        if (!w) return json({ error: "not_found" }, 404);
        const all = await listWorkers(env);
        const sorted = all.sort((a, b) => (b.balance - a.balance) || ((b.confirmed||0) - (a.confirmed||0)));
        const rank = sorted.findIndex((x) => x.id === w.id) + 1;
        const payments = ((await kvGet(env, "payments")) || []).filter((x) => x.workerId === w.id).sort((a, b) => b.ts - a.ts);
        const myLinks = (await getLinks(env)).filter((l) => l.workerId === w.id);
        const allMsgs = (await kvGet(env, "messages")) || [];
        const messages = allMsgs
          .filter((m) => m.workerId == null || m.workerId === w.id)
          .sort((a, b) => b.ts - a.ts)
          .map((m) => ({ id: m.id, text: m.text, ts: m.ts }));
        return json({
          id: w.id, code: w.code,
          name: w.name, currency: w.currency || "PHP", lang: w.lang || "",
          ccyLock: !!w.ccyLock,
          balance: w.balance || 0, pending: w.pending || 0,
          confirmed: w.confirmed || 0, clickPts: w.clickPts || 0,
          paidTotal: w.paidTotal || 0, rank, total: all.length,
          banned: !!w.banned, warned: !!w.warned, payoutReq: !!w.payoutReq,
          // payout state — the cash button is dead unless payState === "cash_armed"
          payState: w.payState || "", payPending: w.payPending || 0,
          note: w.note || "", messages,
          phone: w.phone || "", photo: w.photo || "",
          bank: w.bank || null, bankStatus: w.bankStatus || "",
          links: myLinks, payments,
          fx: await getFx(env),
        });
      }

      /* ---- worker: set payout-timing preference ---- */
      if (p === "/me/payout-request" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "worker") return json({ error: "unauthorized" }, 401);
        const { on } = await req.json();
        const w = await kvGet(env, "worker:" + s.workerId);
        if (!w) return json({ error: "not_found" }, 404);
        w.payoutReq = !!on; await saveWorker(env, w);
        return json({ ok: true, payoutReq: w.payoutReq });
      }

      /* ---- worker: set own display currency ---- */
      if (p === "/me/currency" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "worker") return json({ error: "unauthorized" }, 401);
        const { currency } = await req.json();
        const w = await kvGet(env, "worker:" + s.workerId);
        if (!w) return json({ error: "not_found" }, 404);
        // admin's pick is absolute while locked — earnings are PHP, the display
        // should not drift to a currency that has nothing to do with the work
        if (w.ccyLock) return json({ error: "currency_locked", currency: w.currency || "PHP" }, 409);
        w.currency = String(currency || "PHP"); await saveWorker(env, w);
        return json({ ok: true, currency: w.currency });
      }

      /* ---- admin: set a worker's display currency, and lock it to that pick ---- */
      if (p === "/worker/currency" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, currency, lock } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (currency) w.currency = String(currency);
        w.ccyLock = lock === false ? false : true;   // setting a currency locks it unless explicitly unlocking
        await saveWorker(env, w);
        return json({ ok: true, currency: w.currency, ccyLock: !!w.ccyLock });
      }

      /* ---- worker: submit bank/RIB details (locks until admin reopens) ---- */
      if (p === "/me/bank" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "worker") return json({ error: "unauthorized" }, 401);
        const w = await kvGet(env, "worker:" + s.workerId);
        if (!w) return json({ error: "not_found" }, 404);
        if (w.bankStatus === "submitted") return json({ error: "locked", message: "Your details are submitted. Ask the admin to reopen them if you need a change." }, 423);
        const b = await req.json();
        w.bank = { holder:String(b.holder||""), country:String(b.country||""), method:String(b.method||""), details:String(b.details||""), notes:String(b.notes||"") };
        w.bankStatus = "submitted";
        await saveWorker(env, w);
        return json({ ok: true, bankStatus: w.bankStatus });
      }

      /* ---- admin: list workers ---- */
      if (p === "/workers" && req.method === "GET") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const all = await listWorkers(env);
        all.sort((a, b) => (b.balance - a.balance) || ((b.confirmed||0) - (a.confirmed||0)));
        return json({ workers: all.map(({ payout, ...pub }) => ({ ...pub, hasPayout: !!payout })) });
      }

      /* ---- admin: label an unidentified click source (IP -> site), once.
         Buckets resolve at display time, so this relabels every past and future
         click from that server instantly. Pass siteId:"" to forget a mapping. ---- */
      if (p === "/clicks/map-ip" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { ip, siteId } = await req.json();
        if (!ip) return json({ error: "ip required" }, 400);
        const map = (await kvGet(env, "ipsite")) || {};
        if (siteId) map[String(ip)] = String(siteId); else delete map[String(ip)];
        await kvPut(env, "ipsite", map);
        return json({ ok: true, ipsite: map });
      }

      /* ---- admin: one-shot board state (workers + notice + default currency + sites + links + payments) ---- */
      if (p === "/admin/state" && req.method === "GET") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const all = await listWorkers(env);
        all.sort((a, b) => (b.balance - a.balance) || ((b.confirmed||0) - (a.confirmed||0)));
        const workers = all.map(({ payout, ...pub }) => ({ ...pub }));
        const cfg = (await kvGet(env, "config")) || {};
        return json({
          workers,
          messages: ((await kvGet(env, "messages")) || []).sort((a, b) => b.ts - a.ts),
          defaultCurrency: cfg.currency || "PHP",
          sites: await getSites(env),
          links: await getLinks(env),
          payments: (await kvGet(env, "payments")) || [],
          applications: (await kvGet(env, "applications")) || [],
          ipsite: (await kvGet(env, "ipsite")) || {},
          fx: await getFx(env),
        });
      }

      /* ---- admin: add worker ---- */
      if (p === "/workers" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { name, email, code, payout, currency, phone, photo } = await req.json();
        if (!name || !email) return json({ error: "name+email required" }, 400);
        if (await workerByEmail(env, email)) return json({ error: "email_exists" }, 409);
        const gate = (code || name).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "W";
        if (await workerByGate(env, gate)) return json({ error: "gate_taken" }, 409);
        const cfg = (await kvGet(env, "config")) || {};
        const w = { id: rid("w_"), name, email, code: gate, payout: payout || "", currency: currency || cfg.currency || "PHP",
          phone: phone || "", photo: photo || "", bank: null, bankStatus: "",
          confirmed: 0, balance: 0, pending: 0, clickCarry: 0, clickPts: 0, paidTotal: 0,
          note: "", banned: false, warned: false, payoutReq: false };
        await saveWorker(env, w);
        await createLinksForNewWorker(env, w, url.origin);
        return json({ ok: true, id: w.id, code: gate });
      }

      /* ---- admin: warn / ban a worker (graduated; never reduces balance) ---- */
      if (p === "/worker/flag" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, banned, warned, payoutReq } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (typeof banned === "boolean") { w.banned = banned; if (banned) w.warned = false; }
        if (typeof warned === "boolean") w.warned = warned;
        if (typeof payoutReq === "boolean") w.payoutReq = payoutReq;
        await saveWorker(env, w);
        return json({ ok: true, banned: !!w.banned, warned: !!w.warned, payoutReq: !!w.payoutReq });
      }

      /* ---- admin: set a worker's private note ---- */
      if (p === "/worker/note" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, note } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        w.note = String(note || ""); await saveWorker(env, w);
        return json({ ok: true });
      }

      /* ---- admin: reopen a worker's bank details for editing ("send back") ---- */
      if (p === "/worker/bank-reopen" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        w.bankStatus = "editing"; // keeps existing values; worker can edit + resend
        await saveWorker(env, w);
        return json({ ok: true });
      }

      /* ---- admin: set / replace / clear a worker's ID photo (admin-injected) ---- */
      if (p === "/worker/photo" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, photo } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        w.photo = String(photo || "");
        await saveWorker(env, w);
        return json({ ok: true });
      }

      /* ---- admin: set a worker's phone (optional) ---- */
      if (p === "/worker/phone" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, phone } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        w.phone = String(phone || "");
        await saveWorker(env, w);
        return json({ ok: true });
      }

      /* ---- admin: remove a worker (payments are kept for the log) ---- */
      if (p === "/worker/remove" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (w.payState === "processing") return json({ error: "payout_processing" }, 409);
        if (w.payState === "cash_armed") return json({ error: "cash_armed_remove" }, 409);
        await kvDel(env, "worker:" + workerId);
        const idx = ((await kvGet(env, "idx:workers")) || []).filter((x) => x !== workerId);
        await kvPut(env, "idx:workers", idx);
        await kvPut(env, "links", (await getLinks(env)).filter((l) => l.workerId !== workerId));
        return json({ ok: true });
      }

      /* ---- admin: send a message to ONE worker or ALL ----
         Body: { text, workerId }  (workerId omitted/empty/"all" => broadcast)
         Each send is a new dated entry. Nothing rewrites it later. ---- */
      if (p === "/message" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const b = await req.json();
        const text = String(b.text || "").trim().slice(0, 1000);
        if (!text) return json({ error: "empty" }, 400);
        let workerId = b.workerId;
        if (!workerId || workerId === "all") {
          workerId = null;
        } else if (!(await kvGet(env, "worker:" + workerId))) {
          return json({ error: "no_worker" }, 404);
        }
        const msgs = (await kvGet(env, "messages")) || [];
        msgs.unshift({ id: rid("m_"), text, workerId: workerId, ts: now() });
        if (msgs.length > 500) msgs.length = 500;
        await kvPut(env, "messages", msgs);
        return json({ ok: true });
      }

      /* ---- admin: delete one message (removed for everyone) ---- */
      if (p === "/message/delete" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { id } = await req.json();
        const msgs = (await kvGet(env, "messages")) || [];
        const next = msgs.filter((m) => m.id !== id);
        await kvPut(env, "messages", next);
        return json({ ok: true, removed: msgs.length - next.length });
      }

      /* ---- admin: clear all messages ---- */
      if (p === "/message/clear" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        await kvPut(env, "messages", []);
        return json({ ok: true });
      }

      /* ---- admin: default currency for new workers ---- */
      if (p === "/config/currency" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { currency } = await req.json();
        const cfg = (await kvGet(env, "config")) || {};
        cfg.currency = String(currency || "PHP");
        await kvPut(env, "config", cfg);
        return json({ ok: true, currency: cfg.currency });
      }

      /* ---- admin: sites + referral links ---- */
      if (p === "/sites" && req.method === "GET") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        return json({ sites: await getSites(env), links: await getLinks(env) });
      }
      if (p === "/sites" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const apiOrigin = url.origin; // capture before `url` below shadows this with the site's URL string
        const { name, url: siteUrl, owned } = await req.json();
        if (!name) return json({ error: "name required" }, 400);
        const sites = await getSites(env);
        const site = { id: rid("st_"), name, url: siteUrl || "", owned: !!owned, ts: now() };
        sites.push(site);
        await kvPut(env, "sites", sites);
        await createLinksForNewSite(env, site, apiOrigin);
        return json({ ok: true });
      }
      if (p === "/sites/remove" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { id } = await req.json();
        await kvPut(env, "sites", (await getSites(env)).filter((x) => x.id !== id));
        await kvPut(env, "links", (await getLinks(env)).filter((l) => l.siteId !== id));
        return json({ ok: true });
      }
      if (p === "/links" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const b = await req.json();
        const workerId = b.workerId, coded = b.coded;
        if (!workerId || !coded) return json({ error: "workerId+coded required" }, 400);
        const source = b.source || "";
        const siteId = b.siteId || null;
        const baseUrl = b.baseUrl || "";
        const links = await getLinks(env);
        const ex = links.find((l) => l.workerId === workerId && (l.source || "") === source && ((siteId && l.siteId === siteId) || l.baseUrl === baseUrl));
        if (ex) {
          ex.baseUrl = baseUrl; ex.owned = !!b.owned; ex.label = b.label || ex.label || "";
          ex.coded = coded; ex.title = b.title || ""; ex.desc = b.desc || "";
          ex.source = source; ex.siteId = siteId || ex.siteId || null;
          ex.status = ex.status || "active"; ex.ts = now();
          await kvPut(env, "links", links);
          return json({ ok: true, id: ex.id });
        }
        const id = rid("lk_");
        links.push({ id, workerId, siteId, baseUrl, owned: !!b.owned, label: b.label || "", coded,
          title: b.title || "", desc: b.desc || "", source, status: "active", ts: now() });
        await kvPut(env, "links", links);
        return json({ ok: true, id });
      }
      if (p === "/links/remove" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { id } = await req.json();
        await kvPut(env, "links", (await getLinks(env)).filter((l) => l.id !== id));
        return json({ ok: true });
      }
      if (p === "/links/status" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { id, status } = await req.json();
        const links = await getLinks(env);
        const l = links.find((x) => x.id === id);
        if (!l) return json({ error: "no_link" }, 404);
        l.status = status || "active";
        await kvPut(env, "links", links);
        return json({ ok: true });
      }

      /* ---- admin: inject by reason (result = +₱70, or unique clicks = dust) ---- */
      if (p === "/inject" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, type, clicks } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (type === "clicks") {
          await addUniqueClicks(env, w, clicks || 0);
        } else if (["purchase", "paid_action", "active"].includes(type)) {
          await creditWorker(env, w, RESULT_VALUE, "result");
        } else {
          return json({ error: "type must be purchase | paid_action | active | clicks" }, 400);
        }
        return json({ ok: true, balance: w.balance, pending: w.pending });
      }

      /* ---- admin: START a payout -> "processing" (no money moved, no email).
         Snapshots the banked amount; balance stays put so it's still correct
         if the worker earns more before the transfer is confirmed. ---- */
      if (p === "/pay" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w || (w.balance || 0) <= 0) return json({ error: "nothing_to_pay" }, 400);
        if (w.payState === "processing") return json({ error: "already_processing" }, 409);
        if (w.payState === "cash_armed") return json({ error: "cash_armed" }, 409);
        w.payState = "processing"; w.payPending = w.balance; w.payTs = now();
        await saveWorker(env, w);
        return json({ ok: true, status: "processing", amount: w.payPending });
      }

      /* ---- admin: CONFIRM the Wise transfer was sent -> "paid" + email ---- */
      if (p === "/pay/confirm" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (w.payState !== "processing") return json({ error: "not_processing" }, 409);
        const amount = w.payPending || 0; // banked snapshot taken at /pay (multiple of ₱100)
        if (amount <= 0) { w.payState = ""; w.payPending = 0; await saveWorker(env, w); return json({ error: "nothing_to_pay" }, 400); }
        const payments = (await kvGet(env, "payments")) || [];
        payments.push({ workerId, amount, ts: now(), method: "online", confirmedBy: "admin" });
        await kvPut(env, "payments", payments);
        w.paidTotal = (w.paidTotal || 0) + amount;
        w.balance = Math.max(0, (w.balance || 0) - amount); // keeps anything earned while processing
        w.payState = "paid"; w.payPending = 0; w.payoutReq = false;
        await saveWorker(env, w);
        await sendEmail(env, w.email, "Payment sent",
          `Hi ${w.name}, ₱${amount} has been sent via Wise and is on its way. Your progress toward the next ₱100 stays. Thank you.`);
        return json({ ok: true, paid: amount });
      }

      /* ---- CASH TRACK (face-to-face) -------------------------------------
         Two presences, two acts. Admin ARMS the button standing in front of
         the worker (that is the in-person half). The worker's single press
         FINALISES it and zeroes the balance (that is their half). Neither
         alone completes the payment.
         Until armed, payState is not "cash_armed", so /me/cash-received
         returns 409 and the button does nothing however often it is pressed. */
      if (p === "/pay/cash/arm" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if ((w.balance || 0) <= 0) return json({ error: "nothing_to_pay" }, 400);
        if (w.payState === "processing") return json({ error: "already_processing" }, 409);
        // idempotent: arming an already-armed worker just re-reports the snapshot
        if (w.payState !== "cash_armed") { w.payPending = w.balance; w.payTs = now(); w.payState = "cash_armed"; await saveWorker(env, w); }
        return json({ ok: true, status: "cash_armed", amount: w.payPending });
      }

      /* ---- admin: DISARM (handover aborted, worker walked off, wrong person) ---- */
      if (p === "/pay/cash/disarm" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (w.payState !== "cash_armed") return json({ error: "not_armed" }, 409);
        w.payState = ""; w.payPending = 0;
        await saveWorker(env, w);
        return json({ ok: true, status: "disarmed" });
      }

      /* ---- worker: "Received ₱X in cash" — the finalising press ---- */
      if (p === "/me/cash-received" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "worker") return json({ error: "unauthorized" }, 401);
        const w = await kvGet(env, "worker:" + s.workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        // Not armed = dead button. Covers idle taps, curious taps, and any
        // second press after the first one already settled it.
        if (w.payState !== "cash_armed") return json({ error: "not_armed" }, 409);
        const amount = w.payPending || 0;
        if (amount <= 0) { w.payState = ""; w.payPending = 0; await saveWorker(env, w); return json({ error: "nothing_to_pay" }, 400); }
        const payments = (await kvGet(env, "payments")) || [];
        payments.push({ workerId: w.id, amount, ts: now(), method: "cash",
          confirmedBy: "worker", ip: req.headers.get("cf-connecting-ip") || "" });
        await kvPut(env, "payments", payments);
        w.paidTotal = (w.paidTotal || 0) + amount;
        w.balance = Math.max(0, (w.balance || 0) - amount); // exact snapshot — anything earned mid-handover survives
        w.payState = "paid"; w.payPending = 0; w.payoutReq = false;
        await saveWorker(env, w);
        return json({ ok: true, paid: amount });
      }

      /* ---- admin: CANCEL a pending payout (Wise not sent) -> back to unpaid ---- */
      if (p === "/pay/cancel" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (w.payState !== "processing") return json({ error: "not_processing" }, 409);
        w.payState = ""; w.payPending = 0;
        await saveWorker(env, w);
        return json({ ok: true, status: "cancelled" });
      }

      /* ---- Stripe webhook: completed purchase -> +₱70 to the gate owner ----
         OFF by default. Set STRIPE_CREDIT=1 to credit purchases here. Refund/
         cancel is ABSORB (never reversed). */
      if (p === "/stripe/webhook" && req.method === "POST") {
        const payload = await req.text();
        const ok = await verifyStripe(env, payload, req.headers.get("stripe-signature"));
        if (!ok) return json({ error: "bad_signature" }, 400);
        const event = JSON.parse(payload);
        if (event.type === "checkout.session.completed" && env.STRIPE_CREDIT === "1") {
          if (await seen(env, event.id)) return json({ received: true, dup: true });
          const sess = event.data.object;
          const gate = (sess.metadata && (sess.metadata.gate || sess.metadata.ref)) || null;
          if (gate) { const w = await workerByGate(env, gate); if (w) await creditWorker(env, w, RESULT_VALUE, "result"); }
        }
        return json({ received: true });
      }

      /* ---- Owned-site intake (ALTERNATIVE): the site ran its OWN day-3 check and
         posts only confirmed-active members -> +₱70 each. Use EITHER this OR the
         worker.js-owned flow below (/veliane/signup + /veliane/activity), never
         both for the same member. Body: { gate, delta, members? } */
      if (p === "/veliane/intake" && req.method === "POST") {
        if (!okVeliane(req, env))
          return json({ error: "unauthorized" }, 401);
        const { gate, delta, members } = await req.json();
        const w = await workerByGate(env, gate);
        if (!w) return json({ error: "no_gate" }, 404);
        let n = 0;
        if (Array.isArray(members) && members.length) {
          for (const mid of members) { if (!(await seen(env, "vel:" + mid))) { await creditWorker(env, w, RESULT_VALUE, "result"); n++; } }
        } else {
          n = Math.max(0, Math.floor(delta || 0));
          for (let i = 0; i < n; i++) await creditWorker(env, w, RESULT_VALUE, "result");
        }
        return json({ ok: true, credited: n, balance: w.balance });
      }

      /* ---- Owned-site signup (worker.js OWNS the day-3 recheck) ----
         Fire on registration. Records the signup as PENDING (uncredited).
         worker.js holds HOLD_DAYS, then its cron reverifies activity and
         credits +₱70 only if still active (else skips). Idempotent by memberId.
         Body: { gate, memberId } */
      if (p === "/veliane/signup" && req.method === "POST") {
        if (!okVeliane(req, env))
          return json({ error: "unauthorized" }, 401);
        const { gate, memberId } = await req.json();
        if (!gate || !memberId) return json({ error: "gate+memberId required" }, 400);
        const w = await workerByGate(env, gate);
        if (!w) return json({ error: "no_gate" }, 404);
        const key = "psignup:" + memberId;
        if (await kvGet(env, key)) return json({ ok: true, dup: true });
        await kvPut(env, key, { memberId, gate, workerId: w.id, signupTs: now(), lastActive: now(), resolved: false });
        const idx = (await kvGet(env, "idx:pending")) || [];
        if (!idx.includes(memberId)) { idx.push(memberId); await kvPut(env, "idx:pending", idx); }
        return json({ ok: true, pending: true });
      }

      /* ---- Owned-site activity ping (feeds the day-3 recheck) ----
         Fire whenever a pending member is active (e.g., on login). Refreshes
         lastActive so the cron can tell active from dormant. Ignored once
         resolved. Body: { memberId } or { members: [ids] } */
      if (p === "/veliane/activity" && req.method === "POST") {
        if (!okVeliane(req, env))
          return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const ids = Array.isArray(body.members) ? body.members : (body.memberId ? [body.memberId] : []);
        let n = 0;
        for (const mid of ids) {
          const rec = await kvGet(env, "psignup:" + mid);
          if (rec && !rec.resolved) { rec.lastActive = now(); await kvPut(env, "psignup:" + mid, rec); n++; }
        }
        return json({ ok: true, updated: n });
      }

      /* ---- /track/event : generic intake for your in-house click method (clicks + conversions) ----
         Auth: x-track-secret (falls back to VELIANE_SECRET). Map the tracker's fields to:
           gate   = the sub-id set per worker link
           event  = "click" | "conversion"
           unique = "1" for a real unique click (the tracker filters bots)
           id     = a unique click/event id for idempotency
           geo    = { country, region, city } for the city-cluster fraud check */
      if (p === "/track/event" && req.method === "POST") {
        if ((req.headers.get("x-track-secret") || "") !== (env.TRACK_SECRET || env.VELIANE_SECRET || "___"))
          return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const gate = body.gate, id = body.id;
        const event = String(body.event || "click");
        const unique = body.unique === true || body.unique === "1" || body.unique === 1;
        if (await seen(env, "tk:" + id)) return json({ ok: true, dup: true });
        const w = await workerByGate(env, gate);
        if (!w) return json({ error: "no_gate" }, 404);
        if (event === "conversion") {
          await creditWorker(env, w, RESULT_VALUE, "result");
        } else if (event === "click" && unique) {
          const geo = body.geo || { country: body.country, region: body.region, city: body.city };
          await countDust(env, w, geo);
        }
        return json({ ok: true, balance: w.balance, pending: w.pending, banned: !!w.banned, warned: !!w.warned });
      }

      /* ---- /owned/click : self-counted clicks for sites YOU own ----
         The site's /r/<code> route fires this once per visitor-per-day (it builds
         `id`) after its own bot check — SAME secret as the rest of the owned site
         (x-veliane-secret). Dust (3 unique = 1 pt). City-cluster fraud check uses
         the visitor geo if the site forwards it. Body: { gate, id, geo?, src? } */
      if (p === "/owned/click" && req.method === "POST") {
        if (!okVeliane(req, env))
          return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const gate = body.gate, id = body.id;
        if (await seen(env, "oc:" + id)) return json({ ok: true, dup: true });
        const w = await workerByGate(env, gate);
        if (!w) return json({ error: "no_gate" }, 404);
        // visitor geo forwarded by the site (optional); enables city-cluster warn/ban
        const geo = body.geo || { country: body.country, region: body.region, city: body.city };
        // which site / which channel — tallied on w, persisted by countDust's save
        const bucket = siteBucket(await getSites(env), body.site, req.headers.get("cf-connecting-ip"));
        w.clicksBySite = tally(w.clicksBySite, bucket, 1);
        if (body.src) w.clicksBySrc = tally(w.clicksBySrc, String(body.src).trim().slice(0, 32), 1);
        await countDust(env, w, geo);
        return json({ ok: true, balance: w.balance, pending: w.pending, banned: !!w.banned, warned: !!w.warned });
      }

      /* ---- non-owned redirector: yoursite link /go/CODE?u=<dest> counts a dust click
             (visitor geo from request.cf for city-cluster) then forwards to <dest> ---- */
      if (p.startsWith("/go/") && req.method === "GET") {
        const code = decodeURIComponent(p.slice(4)).trim().slice(0, 64);
        const dest = url.searchParams.get("u") || "";
        const ua = req.headers.get("user-agent") || "";
        const isBot = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|embed|monitor/i.test(ua);
        if (code && !isBot) {
          const ip = req.headers.get("cf-connecting-ip") || "na";
          const day = new Date().toISOString().slice(0, 10);
          if (!(await seen(env, "go:" + code + ":" + ip + ":" + day))) {
            const w = await workerByGate(env, code);
            if (w) {
              const cf = req.cf || {};
              // destination is right there in the link — exact site, no guessing
              const hit = (await getSites(env)).find((x) => hostOf(x.url) === hostOf(dest));
              w.clicksBySite = tally(w.clicksBySite, hit ? hit.id : (dest ? "url:" + hostOf(dest) : "unknown"), 1);
              const src = url.searchParams.get("s1") || url.searchParams.get("src") || "";
              if (src) w.clicksBySrc = tally(w.clicksBySrc, src.trim().slice(0, 32), 1);
              await countDust(env, w, { country: cf.country, region: cf.region, city: cf.city });
            }
          }
        }
        let target = "";
        try { target = new URL(dest).toString(); }
        catch (e) { if (dest) target = "https://" + dest.replace(/^https?:\/\//i, ""); }
        return Response.redirect(target || "https://example.com/", 302);
      }

      return json({ error: "not_found", path: p }, 404);
    } catch (e) {
      return json({ error: "server_error", detail: String(e) }, 500);
    }
  },

  /* ---- cron: resolve day-3 signups + add-only reconcile ----
     Wire a daily cron in wrangler.toml:  [triggers]  crons = ["0 3 * * *"] */
  async scheduled(event, env, ctx) {
    // (1) Day-3 signups: reverify activity, then credit (+₱70) or skip. Never reduces balance.
    const holdMs = (parseInt(env.HOLD_DAYS || "3", 10)) * 24 * 3600 * 1000;
    const winMs  = (parseInt(env.ACTIVE_WINDOW_DAYS || "2", 10)) * 24 * 3600 * 1000;
    const t = now();
    const idx = (await kvGet(env, "idx:pending")) || [];
    const keep = [];
    for (const mid of idx) {
      const rec = await kvGet(env, "psignup:" + mid);
      if (!rec || rec.resolved) continue;
      if (t - rec.signupTs < holdMs) { keep.push(mid); continue; }   // not yet HOLD_DAYS old
      const active = (t - rec.lastActive) <= winMs;                  // still active at the recheck?
      if (active) { const w = await kvGet(env, "worker:" + rec.workerId); if (w) await creditWorker(env, w, RESULT_VALUE, "result"); }
      await kvDel(env, "psignup:" + mid);                            // resolved: credited if active, skipped if dormant
    }
    await kvPut(env, "idx:pending", keep);

    // (2) Provisional sweep: accounts created from a job application that
    //     were never activated (no code login) within 72h vanish — together
    //     with their application row. One press; a fresh application later
    //     recreates cleanly.
    const allW = await listWorkers(env);
    for (const w of allW) {
      if (w.provTs && (t - w.provTs) > PROV_TTL_MS) await removeWorkerEverywhere(env, w.id);
    }

    // (3) Add-only reconcile — TODO when the in-house click method exists: pull its
    //     totals, compare to a stored "totals:<gate>" snapshot, credit ONLY positive
    //     deltas (never subtract). Balance stays monotonic.
    return;
  },
};
