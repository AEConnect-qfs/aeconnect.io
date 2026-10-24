# Deploying aeconnect.io (site + AI workspace)

This repo is the **full aeconnect.io site**: marketing pages **plus**
the self-serve AI workspace at `/app/`, backed by **Netlify Functions**.

`/` is the marketing homepage (HTTP 200, canonical `https://aeconnect.io/`). It does
**not** redirect to the workspace. Public URLs use a trailing slash (`/contact/`,
`/blog/…/`, `/app/`). `netlify.toml` 301s the non-slash form, and also 301s
`http://` and `www` to `https://aeconnect.io`. `/api/*` is rewritten to functions
and is `noindex`.

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

## 2. Prisma is already Postgres

`prisma/schema.prisma` uses `provider = "postgresql"`. The datasource block should stay:

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
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...`), only if a checkout flow is configured |
| `STRIPE_PRICE_ID` | Stripe price id, only if a checkout flow is configured |
| `STRIPE_WEBHOOK_SECRET` | signing secret of your webhook endpoint (`whsec_...`) |
| `SITE_URL` | `https://aeconnect.io` |

`NODE_VERSION` is already pinned to 20 in `netlify.toml`.

The public offer is a 14-day company-email sandbox with unlimited cases, plus annual Starter, Growth, and Scale. There is no monthly self-serve plan on the public site.

Trigger a redeploy after setting these.

## 5b. Payments

Do not publish a monthly self-serve price. Annual plans are sold through Contact sales and Book a demo. The 14-day sandbox starts from `/trial/` after the company email is verified.

## 6. Verify the live deploy

1. Visit `https://aeconnect.io/` (marketing page, 200) and `https://aeconnect.io/app/` → sign up.
2. Create a case, paste an adverse-event narrative, **Run AI assessment**.
   - With `ANTHROPIC_API_KEY` set, this is a real Claude assessment and returns a structured draft.
3. Accept or override fields, then **Download case**. E-signature sign-off is not part of this site; it stays on `app.aeconnect.io`.
4. Netlify → Functions tab shows invocation logs for `assess`, `cases`, and so on.
5. The public trial is the 14-day sandbox at `/trial/`, not a capped case allowance.

Local smoke test (against a local/dev DB) still works with:
```bash
npm run dev          # http://localhost:8787/  and  http://localhost:8787/app/
npx tsx verify-site.mts   # page, redirect, validation, and billing checks
```

---

## File ingestion (client-side)

The workspace extracts text from uploads **in the browser** (the file itself is not
uploaded; extracted text is what the API stores): plain text/email/CSV directly,
PDF via pdf.js, Word via mammoth, and images / scanned PDFs via tesseract.js OCR.
The entry scripts are self-hosted under `/vendor/` at pinned versions, with SRI,
and load only after a matching file is chosen.

`netlify.toml` already sends a Content-Security-Policy. Scripts and workers are
`'self'` (plus `blob:` for workers). Tesseract still downloads its core WASM and
the English traineddata from exact jsDelivr versions
(`tesseract.js-core@5.1.0`, `@tesseract.js-data/eng@1.0.0`). Google Fonts are
allowlisted. Do not add `cdnjs.cloudflare.com`. The local dev server sends the
same CSP **without** HSTS or `upgrade-insecure-requests`.

First OCR downloads the English model (cached thereafter).

## Not yet wired (intentional stubs)

- **Payments** — the public site sells the 14-day sandbox and annual plans. It does not list a monthly self-serve price.
- **Data retention / backups** — Neon handles Postgres durability; PV records often need
  ~25-year retention (spec §7). Plan a backup/retention policy before real cases.

## Rolling back

The prior static site is just the v16 files, all still present in this repo. If you need
to revert to static-only, redeploy without env vars — the marketing pages serve normally;
only `/app` requires the functions + DB.
