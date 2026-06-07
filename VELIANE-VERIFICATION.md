# Owned-site verification — spec for your side (e.g. Veliane)

The payment foundation can't touch your site's code. These are the rules to build **on the
site you own** so that (1) clicks count and (2) only real members are reported. The clean-pay
model rests on this: the foundation credits what your site reports, so your site must report
only real activity.

All POSTs to the worker carry header `x-veliane-secret: <VELIANE_SECRET>` — the one secret
that covers every site you own.

## 0. One redirect route per site (`/r/:code`) — clicks + cookie

Add a single route that answers `/r/CODE`. It is **one route, not every page** (the cookie it
sets is read site-wide). The route:

- reads the gate `code` and an optional `?src=` tag,
- sets a 90-day `vref` cookie (and `vsrc` for the source),
- skips obvious bots / link-preview crawlers,
- counts the click once per visitor-per-day by posting to the worker:

```
POST https://<your-worker>/owned/click
Header: x-veliane-secret: <VELIANE_SECRET>
Body:   { "gate":"CARLOS", "id":"CARLOS:<ip>:<YYYY-MM-DD>", "ip":"<ip>", "src":"instagram" }
```

The worker does the dust math (3 unique = ₱1) and the per-IP auto warn/ban. Ready-made code
for Next.js / Node / PHP / Cloudflare is in `OWNED-SITE-referral-snippet.md`; the edited
Veliane version is the delivered `r/[code]/route.ts`.

## 1. Tag the sign-up with the worker's gate

When a member signs up, read the `vref` cookie and **store it on the member record** with a
signup timestamp:

```
member { id, gate, signup_ts, last_active_ts, status }
```

No cookie → `gate: null` (counts for no worker). Then tell the worker a signup happened:

```
POST /veliane/signup   Body: { "gate":"CARLOS", "memberId":"<id>" }
```

This records a **pending** signup — it does not pay yet.

## 2. Report activity (so the worker can confirm day-3)

On each visit while the member is signed in, ping:

```
POST /veliane/activity   Body: { "memberId":"<id>" }
```

That refreshes `last_active_ts`. **You don't decide when it's "real" — the worker does.** A
scheduled job in `worker.js` holds each pending signup `HOLD_DAYS` (default 3) and then
credits a flat **₱70** only if the member was active within `ACTIVE_WINDOW_DAYS` (default 2);
otherwise it's dropped. A page that merely reloads won't pass, because activity must land
inside that window.

> Optional, if you'd rather confirm on your side: instead of signup+activity, do your own
> day-3 check and push confirmed members with
> `POST /veliane/intake { "gate":"CARLOS", "delta":1, "amountEach":70 }`. Pick **one** path —
> the signup+activity path (above) is the one wired in the delivered `referral.ts`.

## 3. Health view (same data)

Track `signup_ts`, `last_active_ts` per member and surface **active %** and a list of
zero-activity members. It's both your platform-health gauge and a sanity check on the growth.

## 4. 90-day auto-purge of dead profiles

If a member has zero activity since signup, purge it on day 90 to clear dormant fakes.
**Guardrail:** never purge in a way that un-records a member who already triggered a payout —
keep the payment record separate.

## 5. Idempotency

Every member has a unique id. The worker dedupes by it (signup is recorded once; clicks dedupe
per visitor-per-day). Keep sending the real `memberId` so retries never double-pay.

## 6. Purchases (when you have a paid plan)

Route paid subscriptions through Stripe with `metadata.gate` set to the member's gate code
(see README). The worker credits ₱70 per completed checkout when `STRIPE_CREDIT=1`. Keep raw
signups out of every intake and the model stays clean.
