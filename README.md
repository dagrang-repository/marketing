# Payment Foundation — README

A lightweight tool for paying part-time promoters and tracking what each is owed. See
`PROJECT-OVERVIEW.md` for the full description; this file covers the files, running it, and
going live.

## How pay is earned (don't weaken it)

Two streams, both attributed by a per-worker **gate code**:

- **Verified result = flat ₱70.** A completed Stripe purchase, a paid action, or a member
  confirmed active after a holding window. One result, ₱70, period — not a percentage.
- **Traffic dust = ₱1 per 3 unique clicks.** Real clicks earn a little. Repeats from the
  same IP collapse (one per visitor per day), and per-IP velocity auto-warns then auto-bans
  a worker farming from one place.

Everything is in pesos (the canonical base): **1 point = ₱1**, balances bank in **₱100**
chunks, and a balance is **monotonic — it never goes down once shown**. Refunds/cancels are
absorbed (no clawback); the only consequence for abuse is a ban. Paying a worker settles the
**full** balance to zero and logs it.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole UI — login, admin command board, worker view. Mobile-first, works on desktop. **Fully self-contained: no external scripts, no CDN, no network. QR codes are generated locally.** |
| `backend/worker.js` | Cloudflare Worker backend (auth, records, intake, pay, Stripe + owned-site + tracker intake, day-3 cron). |
| `backend/wrangler.toml` | Deploy config + the secret list. |
| `VELIANE-VERIFICATION.md` | What to build on an owned site (e.g. Veliane) so clicks count and only real members are reported. |
| `PROJECT-OVERVIEW.md` | Full project overview. |

> The owned-site click snippet itself (`OWNED-SITE-referral-snippet.md`) and the edited
> Veliane `r/[code]/route.ts` live with your site, not in this package.

## Use it locally now

Open `index.html` in any browser. It runs standalone:

- Set an admin email on first run.
- Add a site or two under **Our sites** (tick "I own this site" for clean links).
- Add workers — each gets a gate code and their own display currency.
- **Generate** links — pick a site + a worker (or *All workers*), optionally a source tag
  (instagram / whatsapp…). Each worker gets their own link, a locally-drawn **QR**, and a
  ready share message on their page.
- Inject a verified result (₱70) or unique clicks (dust) to a worker.
- Pay → settles the full balance to zero and logs it.
- Broadcast to all workers, or a private note to one. Warn / ban a worker.
- Sign in with a worker's email to see their own view.

In local mode the data lives in that one browser and the login code is shown on screen
instead of emailed. Real multi-device use needs the backend below.

## Deploy the backend (live, multi-device)

Cloudflare Workers + a KV store.

1. Create a KV namespace and bind it as `STORE` (see `wrangler.toml`).
2. Set secrets (see the full annotated list in `wrangler.toml`):
   ```
   wrangler secret put ADMIN_EMAIL
   wrangler secret put RESEND_API_KEY
   wrangler secret put MAIL_FROM            # "Marketing <no-reply@yourdomain.com>"
   wrangler secret put VELIANE_SECRET       # one secret for every site you own
   wrangler secret put STRIPE_WEBHOOK_SECRET  # only if crediting purchases
   wrangler secret put CLICKMAGICK_SECRET     # only if a non-owned tracker posts in
   ```
   Sessions are persistent (no expiry), so there is no `SESSION_TTL_HOURS`.
3. Deploy: `wrangler deploy`
4. Point the UI at it. In the live version `index.html`'s local-storage layer is swapped for
   calls to these endpoints:

   | UI action | Endpoint |
   |---|---|
   | send code | `POST /auth/request` `{email}` |
   | verify | `POST /auth/verify` `{email,code}` → `{token,role,name}` (persistent) |
   | worker's own view | `GET /me` (Bearer token) → balance, needle, points, clicks, rank |
   | request payout | `POST /me/payout-request` |
   | list workers | `GET /workers` (admin) |
   | add worker | `POST /workers` `{name,email,code,payout,currency,photo}` |
   | warn / ban | `POST /worker/flag` `{workerId,action}` |
   | sites / links | `GET/POST /sites`, `GET/POST /links` |
   | inject result / clicks | `POST /inject` `{workerId,type,amount}` |
   | pay (full settle) | `POST /pay` `{workerId}` |

   Send the session token as `Authorization: Bearer <token>`.

### Coded links

A worker's link carries their gate code:

- **Owned site** → clean path: `https://yoursite.com/r/CARLOS` (optionally `?src=instagram`).
  The site's `/r/CODE` route sets a 90-day cookie and **self-counts the click** by posting to
  `/owned/click` (see `VELIANE-VERIFICATION.md` + the snippet). No third party.
- **Site you don't own** → `https://partner.com/p?s1=CARLOS&s2=instagram`. A tracker (e.g.
  BeMob) reads the sub-id and posts unique clicks to `/clickmagick/event`.

The gate code is the single key across clicks, sign-ups and purchases.

### Stripe (optional — credit purchases)

Add a webhook to `https://<your-worker>/stripe/webhook`, event `checkout.session.completed`,
and put the gate code in metadata:

```js
metadata: { gate: "CARLOS" }
```

Crediting is **OFF by default** (`STRIPE_CREDIT` unset) so the owned-site / tracker pipe
governs conversions and you never double-credit. Set `STRIPE_CREDIT=1` to turn it on; it
credits the flat **₱70** result value per completed checkout.

### Owned sites & sign-ups (verified-active)

On each owned site: the `/r/CODE` route counts the click and drops the cookie; at sign-up,
read the cookie and POST `/veliane/signup {gate, memberId}`; on each visit while the code is
set, POST `/veliane/activity {memberId}`. **worker.js owns the day-3 recheck** — it holds the
signup `HOLD_DAYS` days, then credits ₱70 only if the member was active. All POSTs carry
`x-veliane-secret: <VELIANE_SECRET>`. See `VELIANE-VERIFICATION.md`.

## Security notes

- Encrypt payout details before storing in production (envelope-encrypt the GCash/bank field;
  never log it).
- Login codes expire in 10 minutes; sessions are persistent on a device until sign-out.
- Tighten `access-control-allow-origin` in `worker.js` from `*` to your real UI origin.
- Use opaque gate codes (e.g. `w_8f3a`) if you don't want codes to reveal who's who.

## Notes

- Payout is manual on purpose — the tool records and notifies; the money is sent via Wise. No
  payment credentials sit in the app. Run one small test transfer before the first real payout.
- Anything that arrives without a gate code, or that you can't independently attribute, is
  left uncredited rather than guessed.
- Currencies are **display-only, no conversion** (20 built in, default from device locale). A
  live FX reference is planned for the backend stage.
