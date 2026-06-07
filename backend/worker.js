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

   FRAUD DETECTION = GEO-SPREAD (built later with the in-house
   click method — STUB here for now):
     The signal is SPREAD vs REPETITION. Clicks scattered across
     many locations are legitimate at ANY volume — the link is
     spreading. Clicks piling up inside one ~200 m radius mean the
     link is NOT spreading — that is fake/farmed. (Same-IP counting
     is inadequate: a family compound has many phones/IPs in one
     place.) Threshold: WARN at 150 clustered clicks within 200 m
     (red notice on the worker's board), AUTO-BAN at 300. This needs
     per-click geo-coordinates that only the in-house click method
     will supply, so the live engine is a STUB until that exists.
     The static red warning already in the worker UI is the live
     deterrent meanwhile. Earned balance is never reduced (ban only).

   Attribution: the GATE CODE is the single key — the click
   sub-id, the Stripe metadata, and the owned-site gate.

   SESSION: does NOT expire on a device (persistent token). The
   login CODE expires in 10 minutes.

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
    "access-control-allow-headers": "content-type,authorization,stripe-signature,x-veliane-secret,x-clickmagick-secret",
  };
}

const CODE_TTL_SEC = 10 * 60;
const now = () => Date.now();
const rid = (p) => p + crypto.randomUUID().replace(/-/g, "").slice(0, 14);

/* ---------- tiny KV data layer ---------- */
async function kvGet(env, k) { const v = await env.STORE.get(k); return v ? JSON.parse(v) : null; }
async function kvPut(env, k, val, ttl) {
  const opt = ttl ? { expirationTtl: ttl } : undefined;
  await env.STORE.put(k, JSON.stringify(val), opt);
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
async function getSites(env) { return (await kvGet(env, "sites")) || []; }
async function getLinks(env) { return (await kvGet(env, "links")) || []; }

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
async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) { console.log("[mail skipped]", to, subject); return; }
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "Marketing <onboarding@resend.dev>", to, subject, text }),
  });
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

/* ============================================================ router ============================================================ */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "");

    try {
      /* ---- auth: request code ---- */
      if (p === "/auth/request" && req.method === "POST") {
        const { email } = await req.json();
        if (!email) return json({ error: "email required" }, 400);
        const isAdmin = email.toLowerCase() === (env.ADMIN_EMAIL || "").toLowerCase();
        const w = await workerByEmail(env, email);
        if (!isAdmin && !w) return json({ error: "not_registered" }, 403);
        const code = genCode();
        await kvPut(env, "code:" + email.toLowerCase(), { code, role: isAdmin ? "admin" : "worker", workerId: w ? w.id : null }, CODE_TTL_SEC);
        await sendEmail(env, email, "Your sign-in code", `Your code is ${code}. It expires in 10 minutes.`);
        return json({ ok: true });
      }

      /* ---- auth: verify code -> persistent session ---- */
      if (p === "/auth/verify" && req.method === "POST") {
        const { email, code } = await req.json();
        const rec = await kvGet(env, "code:" + String(email).toLowerCase());
        if (!rec || rec.code !== String(code).toUpperCase()) return json({ error: "bad_code" }, 401);
        await kvDel(env, "code:" + String(email).toLowerCase());
        const token = rid("s_") + crypto.randomUUID().replace(/-/g, "");
        const session = { email, role: rec.role, workerId: rec.workerId, since: now() };
        await kvPut(env, "session:" + token, session); // no TTL: persists on the device until signout
        let name = "Admin";
        if (rec.workerId) { const w = await kvGet(env, "worker:" + rec.workerId); name = w ? w.name : "Worker"; }
        return json({ token, role: rec.role, name });
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
        const sites = await getSites(env);
        const myLinks = (await getLinks(env)).filter((l) => l.workerId === w.id)
          .map((l) => ({ site: (sites.find((s2) => s2.id === l.siteId) || {}).name || "Link", coded: l.coded }));
        return json({
          name: w.name, currency: w.currency || "PHP",
          balance: w.balance || 0, pending: w.pending || 0,
          confirmed: w.confirmed || 0, clickPts: w.clickPts || 0,
          paidTotal: w.paidTotal || 0, rank, total: all.length,
          banned: !!w.banned, warned: !!w.warned, payoutReq: !!w.payoutReq,
          links: myLinks, payments,
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

      /* ---- admin: list workers ---- */
      if (p === "/workers" && req.method === "GET") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const all = await listWorkers(env);
        all.sort((a, b) => (b.balance - a.balance) || ((b.confirmed||0) - (a.confirmed||0)));
        return json({ workers: all.map(({ payout, ...pub }) => ({ ...pub, hasPayout: !!payout })) });
      }

      /* ---- admin: add worker ---- */
      if (p === "/workers" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { name, email, code, payout, currency } = await req.json();
        if (!name || !email) return json({ error: "name+email required" }, 400);
        if (await workerByEmail(env, email)) return json({ error: "email_exists" }, 409);
        const gate = (code || name).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "W";
        if (await workerByGate(env, gate)) return json({ error: "gate_taken" }, 409);
        const w = { id: rid("w_"), name, email, code: gate, payout: payout || "", currency: currency || "PHP",
          confirmed: 0, balance: 0, pending: 0, clickCarry: 0, clickPts: 0, paidTotal: 0,
          banned: false, warned: false, payoutReq: false };
        await saveWorker(env, w);
        return json({ ok: true, id: w.id, code: gate });
      }

      /* ---- admin: warn / ban a worker (graduated; never reduces balance) ---- */
      if (p === "/worker/flag" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId, banned, warned } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w) return json({ error: "no_worker" }, 404);
        if (typeof banned === "boolean") { w.banned = banned; if (banned) w.warned = false; }
        if (typeof warned === "boolean") w.warned = warned;
        await saveWorker(env, w);
        return json({ ok: true, banned: !!w.banned, warned: !!w.warned });
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
        const { name, baseUrl } = await req.json();
        if (!name) return json({ error: "name required" }, 400);
        const sites = await getSites(env);
        sites.push({ id: rid("st_"), name, baseUrl: baseUrl || "" });
        await kvPut(env, "sites", sites);
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
        const { siteId, workerId, coded, endResult } = await req.json();
        if (!siteId || !workerId || !coded) return json({ error: "siteId+workerId+coded required" }, 400);
        const links = await getLinks(env);
        const ex = links.find((l) => l.siteId === siteId && l.workerId === workerId);
        if (ex) { ex.coded = coded; ex.endResult = endResult || ""; }
        else links.push({ id: rid("lk_"), siteId, workerId, coded, endResult: endResult || "" });
        await kvPut(env, "links", links);
        return json({ ok: true });
      }
      if (p === "/links/remove" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { id } = await req.json();
        await kvPut(env, "links", (await getLinks(env)).filter((l) => l.id !== id));
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

      /* ---- admin: pay a worker (full settle -> 0; logs + emails; Wise is off-app) ---- */
      if (p === "/pay" && req.method === "POST") {
        const s = await requireSession(env, req);
        if (!s || s.role !== "admin") return json({ error: "unauthorized" }, 401);
        const { workerId } = await req.json();
        const w = await kvGet(env, "worker:" + workerId);
        if (!w || (w.balance || 0) <= 0) return json({ error: "nothing_to_pay" }, 400);
        const amount = w.balance; // banked (multiple of ₱100); the needle remainder stays
        const payments = (await kvGet(env, "payments")) || [];
        payments.push({ workerId, amount, ts: now() });
        await kvPut(env, "payments", payments);
        w.paidTotal = (w.paidTotal || 0) + amount; w.balance = 0; w.payoutReq = false;
        await saveWorker(env, w);
        await sendEmail(env, w.email, "Payment sent",
          `Hi ${w.name}, ₱${amount} has been settled and is on its way via Wise. Your progress toward the next ₱100 stays. Thank you.`);
        return json({ ok: true, paid: amount });
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
        if ((req.headers.get("x-veliane-secret") || "") !== (env.VELIANE_SECRET || "___"))
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
        if ((req.headers.get("x-veliane-secret") || "") !== (env.VELIANE_SECRET || "___"))
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
        if ((req.headers.get("x-veliane-secret") || "") !== (env.VELIANE_SECRET || "___"))
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

      /* ---- Tracker postback (generic intake; the in-house click method posts here) ----
         Endpoint name is a legacy label and will be renamed when the in-house
         click method is built. Map the tracker's fields to:
           gate   = the sub-id set per worker link
           event  = "click" | "conversion"
           unique = "1" for a real unique click (the tracker filters bots)
           id     = a unique click/event id for idempotency
           coords = reserved for the future GEO-SPREAD fraud check (200 m rule) */
      if (p === "/clickmagick/event" && req.method === "POST") {
        if ((req.headers.get("x-clickmagick-secret") || "") !== (env.CLICKMAGICK_SECRET || "___"))
          return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const gate = body.gate, id = body.id;
        const event = String(body.event || "click");
        const unique = body.unique === true || body.unique === "1" || body.unique === 1;
        if (await seen(env, "cm:" + id)) return json({ ok: true, dup: true });
        const w = await workerByGate(env, gate);
        if (!w) return json({ error: "no_gate" }, 404);
        if (event === "conversion") {
          await creditWorker(env, w, RESULT_VALUE, "result");
        } else if (event === "click" && unique) {
          // FRAUD DETECTION (GEO-SPREAD) — STUB. Built with the in-house click
          // method: concentration inside one ~200 m radius (link not spreading)
          // -> WARN 150 / BAN 300. Needs per-click geo-coordinates, not yet
          // available, so no auto warn/ban fires here. Spread = always legit.
          await addUniqueClicks(env, w, 1);
        }
        return json({ ok: true, balance: w.balance, pending: w.pending, banned: !!w.banned, warned: !!w.warned });
      }

      /* ---- Owned-site click (self-counted) ----
         For sites YOU own. The site's /r/<code> route fires this once per
         visitor-per-day (it builds `id`) after its own bot check — SAME secret
         as the rest of the owned site (x-veliane-secret). Dust (3 unique = 1 pt).
         Fraud detection is GEO-SPREAD, built later (STUB). Body: { gate, id, coords?, src } */
      if (p === "/owned/click" && req.method === "POST") {
        if ((req.headers.get("x-veliane-secret") || "") !== (env.VELIANE_SECRET || "___"))
          return json({ error: "unauthorized" }, 401);
        const body = await req.json();
        const gate = body.gate, id = body.id;
        if (await seen(env, "oc:" + id)) return json({ ok: true, dup: true });
        const w = await workerByGate(env, gate);
        if (!w) return json({ error: "no_gate" }, 404);
        // FRAUD DETECTION (GEO-SPREAD) — STUB. Built with the in-house click
        // method: concentration inside one ~200 m radius -> WARN 150 / BAN 300.
        // Needs per-click geo-coordinates, not yet available, so nothing fires here.
        await addUniqueClicks(env, w, 1);
        return json({ ok: true, balance: w.balance, pending: w.pending, banned: !!w.banned, warned: !!w.warned });
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

    // (2) Add-only reconcile — TODO when the in-house click method exists: pull its
    //     totals, compare to a stored "totals:<gate>" snapshot, credit ONLY positive
    //     deltas (never subtract). Balance stays monotonic.
    return;
  },
};
