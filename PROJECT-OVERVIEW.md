# Payment Foundation — Project Overview

## What it is

A lightweight tool for recruiting and paying part-time promoters and tracking what each is
owed. It does three things:

1. Keeps a roster of workers — each with a **gate code** that ties results back to them.
2. Credits **verified results** and **traffic dust** to a worker and tracks a running balance.
3. Lets the admin **pay** a worker, send a confirmation, and log it.

The promotion itself happens outside the tool; the foundation attributes results, tracks
balances, and records payments.

## Core model

Everything is in pesos — the canonical base. **1 point = ₱1.**

- **Verified result = flat ₱70.** A completed Stripe purchase, a paid action (subscription /
  deposit / booking), or a member who signed up *and* stayed active past a holding window.
- **Traffic dust = ₱1 per 3 unique clicks.** Same-IP repeats collapse to one per visitor per
  day; sustained same-IP clicking auto-warns then auto-bans the worker.

Balances bank in **₱100** chunks and a balance is **monotonic — it never decreases once
shown**. A refund or cancellation is absorbed (no clawback). The only consequence for abuse
is a ban, never a balance reduction. Paying a worker settles the **full** balance to zero.

## Everyday flow

1. Admin adds a site (marking whether it's owned) and a worker (name, email, currency, gate
   code, ID photo).
2. Admin **generates** each worker's link — per worker or for all at once — optionally tagged
   by source. The link, a locally-drawn QR, and a ready share message appear on the worker's
   page.
3. The worker shares their link with real people through channels they're permitted to use.
4. When someone they brought clicks (dust), signs up and stays active, or makes a real
   purchase, it credits that worker — automatically (the gate code rides the link / Stripe
   metadata, or a verified signal arrives) or by the admin injecting a confirmed result.
5. The admin pays the balance, the worker gets a confirmation, money is sent manually via
   Wise, and every payment is logged.

## Admin side (command board)

- Worker roster, ranked by balance owed; add and remove workers (payment history kept on
  removal). Tap a worker to expand: stats, bank details for payout prep, their links; warn or
  ban.
- **Our sites** registry, and a **link generator** (per worker or *All workers*, with optional
  source tags). Each link carries the gate code, a QR, status (active / paused / retired) and a
  stats line.
- Inject a verified result (₱70) or unique clicks (dust) to a chosen worker.
- Pay a worker — settles the full balance to zero, logs it, sends a confirmation email.
- Broadcast message to all workers; a private message to a single worker.
- Payment log kept indefinitely. Default currency for new workers from the device locale.

## Worker side (their page)

- Balance owed in their own currency, a progress bar that banks in ₱100, their needle/points,
  unique-click dust, and their rank.
- Payment status and full history; any broadcast or private message.
- Their active links — each with a QR to show or post and a one-tap **Share** (sends a ready
  message). A note that only verified results and genuine unique clicks count.

## Currencies

Top 20 built in, **display only — no conversion**. Default guessed from the device locale,
overridable. All amounts stay PHP-canonical (₱70 result, ₱100 bar, ₱1/point); a worker's
currency is a display conversion. A live approximate-FX reference is planned for the backend
stage.

## Architecture

- **`index.html`** — the whole UI. Runs standalone in a browser on local storage for solo
  testing. **Self-contained: no external scripts/CDN/network; QR codes are generated locally.**
- **`backend/worker.js`** — Cloudflare Worker: emailed login codes, persistent (no-expire)
  sessions, shared multi-device data in KV, email via Resend, and automatic intake from owned
  sites (clicks + verified signups), Stripe (purchases), and non-owned trackers.
- **Owned-site integration** lives on each site you own: a `/r/CODE` route counts the click and
  drops a 90-day cookie; sign-up reads the cookie and reports it. **worker.js owns the day-3
  recheck** (a cron credits ₱70 only for members still active). See `VELIANE-VERIFICATION.md`.

### How attribution works

- **Owned site:** link is `https://yoursite.com/r/CODE` (`?src=tag` optional). The route
  self-counts the click via `/owned/click` and sets the cookie; the cookie rides through to
  sign-up and Stripe metadata.
- **Non-owned site:** link is `…?s1=CODE&s2=tag`; a tracker reads the sub-id and posts unique
  clicks to `/clickmagick/event`.
- A completed purchase credits the worker from `metadata.gate` (only if `STRIPE_CREDIT=1`).
- Anything without a gate code, or that can't be independently attributed, is left uncredited.

## Status

- **Standalone single-file UI:** fully working for one person on one device (local data,
  on-screen login). Good for trying the whole flow.
- **Live multi-device:** deploy `worker.js`, set secrets, point `index.html` at it. For clicks
  to count you also add the `/r/CODE` route to each owned site (and a tracker for non-owned).
  Until then, generated links work and attribute sign-ups/purchases via cookie, but the per-link
  click counts stay at "—".
