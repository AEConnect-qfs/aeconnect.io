# Deploying aeconnect.io (site + AI workspace)

This repo is the **full aeconnect.io site**: the existing v16 marketing pages **plus**
the self-serve AI workspace at `/app`, backed by **Netlify Functions**. Deploying it
replaces the current static-only deploy cleanly — every existing URL (`/`, `/features`,
`/blog/...`, `/beta`, `/contact`, `/e2b-r3-checklist`) is preserved, and `/app` + `/api/*`
are added.

> **Important workflow change:** the site now has a build step and serverless
> functions. Drag-and-drop / zip uploads **will not run the functions**. You must
> deploy either from Git (recommended) or with `netlify deploy --build` (CLI).

---

## What you need

- A **Netlify** account (you already host aeconnect.io there).
- A **Neon** account (free) — serverless Postgres, https://neon.tech. SQLite is local-dev only.
- An **Anthropic API key** — the AI engine. Without it, the app runs a deterministic
  *mock* assessment (fine for a demo, not for production).

---

## 1. Provision the database (Neon)

1. Create a Neon project. Neon gives you two connection strings:
   - a **pooled** one (host contains `-pooler`) — used at runtime by the functions,
   - a **direct** one — used to run migrations.
2. Keep both handy. They look like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/DB?sslmode=require
   postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/DB?sslmode=require
   ```

## 2. Switch Prisma to Postgres (one code change)

Edit `prisma/schema.prisma` — change the datasource block from `sqlite` to:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")   // pooled — runtime
  directUrl = env("DIRECT_URL")     // direct — migrations
}
```

(`binaryTargets` in the generator already includes `rhel-openssl-3.0.x` for Netlify's
runtime — leave it.)

> Local dev after this change: point `DATABASE_URL` at a Neon **dev branch** (Neon →
> Branches → create `dev`) or a local Postgres. The old `dev.db` SQLite file is no longer used.

## 3. Create the tables in Neon (run once, from your machine)

```bash
cd "QORO Intelligence Inc/aeconnect-site"
DATABASE_URL="<neon-pooled-url>" DIRECT_URL="<neon-direct-url>" npx prisma db push
```

This creates all tables (User, Case, Assessment, FieldDecision, AuditLog, BillingUsage).

## 4. Point Netlify at this repo

**Recommended — Git-connected (auto-deploys on push):**
1. Push this repo to GitHub/GitLab (`git remote add origin … && git push -u origin master`).
2. In Netlify, either connect the repo to your **existing aeconnect.io site**
   (Site configuration → Build & deploy → link repository) so the domain carries over,
   or create a new site from the repo and move the `aeconnect.io` domain to it.
3. Netlify reads `netlify.toml` automatically — build command, publish dir, functions
   dir, Node version, and the `/api/*` → functions redirect are all already configured.
   **Leave the build settings blank in the UI** so `netlify.toml` wins.

**Alternative — manual CLI deploy (no Git):**
```bash
npm i -g netlify-cli
netlify login
netlify link            # pick your aeconnect.io site
netlify deploy --build --prod
```
`--build` is what runs the build + bundles the functions. A plain `netlify deploy` (or
drag-drop) skips that and the API will 404.

## 5. Set environment variables in Netlify

Site configuration → Environment variables. Add:

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** URL (append `&pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL` | Neon **direct** URL (only needed if you run migrations from Netlify; safe to include) |
| `JWT_SECRET` | a long random string — generate with `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | your Anthropic key (server-side only; never shipped to the browser) |
| `ANTHROPIC_MODEL` | *(optional)* defaults to `claude-sonnet-4-20250514` |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...`) |
| `STRIPE_PRICE_ID` | the recurring Core price id (`price_...`) |
| `STRIPE_WEBHOOK_SECRET` | signing secret of your webhook endpoint (`whsec_...`) |
| `SITE_URL` | `https://aeconnect.io` (Checkout redirect base) |

`NODE_VERSION` is already pinned to 20 in `netlify.toml`.

> If the Stripe vars are omitted, the Subscribe button **activates Core directly**
> (dev convenience) instead of charging — so don't ship to production without them.

Trigger a redeploy after setting these.

## 5b. Configure Stripe (payments)

1. **Product + price:** Stripe Dashboard → Products → create "AE Connect Core",
   add a **recurring $20/month** price. Copy its id (`price_...`) → `STRIPE_PRICE_ID`.
2. **Secret key:** Developers → API keys → copy the secret key → `STRIPE_SECRET_KEY`.
3. **Webhook:** Developers → Webhooks → Add endpoint:
   - URL: `https://aeconnect.io/api/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the signing secret (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.
4. Set `SITE_URL=https://aeconnect.io` so Checkout redirects back correctly.

The Subscribe button → `create-checkout-session` → Stripe Checkout → on success the
webhook flips the account to Core. Cancellations/expiries downgrade it back to trial.

## 6. Verify the live deploy

1. Visit `https://aeconnect.io/app` → sign up.
2. Create a case, paste an adverse-event narrative, **Run AI assessment**.
   - With `ANTHROPIC_API_KEY` set, this is a real Claude assessment; the header trial
     counter should tick up.
3. Accept/override fields → set an e-signature PIN → **Sign off & clear** (locks the case).
4. Netlify → Functions tab shows invocation logs for `assess`, `signoff`, etc.
5. Confirm the trial gate: process 5 cases; the 6th should be blocked with a
   "subscribe" prompt (HTTP 402) — no Claude call is made for the blocked request.

Local smoke test (against a local/dev DB) still works with:
```bash
npm run dev          # http://localhost:8787/app
npx tsx verify-site.mts   # 12 end-to-end checks
```

---

## Not yet wired (intentional stubs)

- **Payments** — wired via Stripe Checkout + webhook (§5b). Until you set the
  `STRIPE_*` env vars, Subscribe activates Core directly without charging.
- **Data retention / backups** — Neon handles Postgres durability; PV records often need
  ~25-year retention (spec §7). Plan a backup/retention policy before real cases.

## Rolling back

The prior static site is just the v16 files, all still present in this repo. If you need
to revert to static-only, redeploy without env vars — the marketing pages serve normally;
only `/app` requires the functions + DB.
