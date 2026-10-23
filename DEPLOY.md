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
| `ANTHROPIC_MODEL` | *(optional)* defaults to `claude-sonnet-5`. See [Switching the AI provider](#switching-the-ai-provider). |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...`) |
| `STRIPE_PRICE_ID` | the recurring Core price id (`price_...`) |
| `STRIPE_WEBHOOK_SECRET` | signing secret of your webhook endpoint (`whsec_...`) |
| `SITE_URL` | `https://aeconnect.io` (Checkout redirect base) |

`NODE_VERSION` is already pinned to 20 in `netlify.toml`.

> If the Stripe vars are omitted, the Subscribe button **activates Core directly**
> (dev convenience) instead of charging — so don't ship to production without them.

Trigger a redeploy after setting these.

## Switching the AI provider

The assessment call goes through one engine (`netlify/functions/_lib/assessment.ts`). The vendor is chosen per request. You do not need new variables to stay on Claude: when `LLM_PROVIDER` is unset and `ANTHROPIC_API_KEY` is set, the provider is Anthropic and the model is `LLM_MODEL`, then `ANTHROPIC_MODEL`, then `claude-sonnet-5`.

| `LLM_PROVIDER` | Behavior | Required |
|---|---|---|
| *(unset)* | Anthropic if `ANTHROPIC_API_KEY` is set, otherwise the deterministic mock (`mock-dev-0`) | |
| `mock` | Same mock. No network call. Used by `npm run dev` without a key, and by `verify-site.mts` / `npm run eval`. | |
| `anthropic` | Claude | `ANTHROPIC_API_KEY` or `LLM_API_KEY` |
| `openai-compatible` | Ollama, vLLM, or any host that serves `POST {LLM_BASE_URL}/chat/completions` | `LLM_BASE_URL` (the `/v1` root, not the full completions path) and `LLM_MODEL`. `LLM_API_KEY` when that host requires a bearer token. |

```bash
# Ollama on the same machine
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:1.5b

# A hosted OpenAI-compatible API
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.example.com/v1
LLM_MODEL=your-model-id
LLM_API_KEY=...
```

The workspace header shows the model id that ran and the prompt version (`pv-draft-2`). A draft that fails the schema (enums, 8-digit MedDRA code, required rationale) is not stored and does not consume a trial case.

This build adds `Assessment.promptVersion`. Apply it to the database before deploying, from a machine that can reach Neon:

```bash
DATABASE_URL="<neon-url>" npx prisma db push
```

Local `DATABASE_URL` must be a `postgresql://` URL. The schema is already Postgres; the old SQLite file URL will not connect.

`ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` still work. Leave `LLM_*` unset on Netlify to keep production on Claude.

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

## File ingestion (client-side)

The workspace extracts text from uploads **in the browser** (PHI never leaves the
user's machine until the extracted text is submitted): plain text/email/CSV directly,
PDF via pdf.js, Word via mammoth, and images / scanned PDFs via tesseract.js OCR.
These libraries load lazily from public CDNs (cdnjs, jsDelivr) only when a matching
file is chosen.

> **If you add a Content-Security-Policy** to the site, allowlist `cdnjs.cloudflare.com`
> and `cdn.jsdelivr.net` (script/worker/wasm/connect) or OCR/PDF extraction will break.
> There is no CSP today, so it works out of the box. First OCR downloads the ~10 MB
> English model (cached thereafter).

## Not yet wired (intentional stubs)

- **Payments** — wired via Stripe Checkout + webhook (§5b). Until you set the
  `STRIPE_*` env vars, Subscribe activates Core directly without charging.
- **Data retention / backups** — Neon handles Postgres durability; PV records often need
  ~25-year retention (spec §7). Plan a backup/retention policy before real cases.

## Rolling back

The prior static site is just the v16 files, all still present in this repo. If you need
to revert to static-only, redeploy without env vars — the marketing pages serve normally;
only `/app` requires the functions + DB.
