# BJmeem — Supabase backend

Production backend for the BJmeem storefront: Postgres schema, Row Level
Security, business logic in SECURITY DEFINER functions, Edge Functions for
email and scheduled work, and a browser SDK in `js/supabase/`.

Read [`docs/BACKEND_ARCHITECTURE.md`](../docs/BACKEND_ARCHITECTURE.md) first —
it explains which operations are allowed from the browser and which are not.

---

## Layout

```
supabase/
  migrations/
    0001_core.sql        enums, app_settings, order numbering
    0002_identity.sql    profiles, role helpers, addresses, delivery zones
    0003_catalog.sql     categories, products, variants, images
    0004_commerce.sql    carts, wishlist, coupons
    0005_orders.sql      orders, items, status history, admin notes
    0006_loyalty.sql     tiers, accounts, ledger, rewards, referrals
    0007_engagement.sql  notifications, reviews, audit log, email outbox
    0008_functions.sql   signup wiring, pricing engine, coupon/reward rules
    0009_checkout.sql    place_order, order lifecycle, tracking, maintenance
    0010_rls.sql         admin RPCs + every RLS policy + grants
    0011_seed.sql        storage buckets, settings, tiers, zones, catalogue
  functions/
    _shared/email.ts         provider adapter + branded templates
    process-email-queue/     drains email_queue (schedule: every minute)
    loyalty-maintenance/     expiry, expiry warnings, birthdays (daily 03:00)
  tests/schema.test.mjs      runs every migration against real Postgres
```

## Setup

```bash
supabase init          # if not already
supabase link --project-ref <your-ref>
supabase db push       # applies migrations/ in order
```

Then set the Edge Function secrets — these must never reach the browser:

```bash
supabase secrets set \
  RESEND_API_KEY=re_xxx \
  EMAIL_FROM='BJmeem <hello@bjmeem.com>' \
  EMAIL_PROVIDER=resend \
  SITE_URL=https://bjmeem.com \
  CRON_SECRET="$(openssl rand -hex 32)"

supabase functions deploy process-email-queue --no-verify-jwt
supabase functions deploy loyalty-maintenance --no-verify-jwt
```

Schedule them (Supabase dashboard → Edge Functions → Schedules, or `pg_cron`):

| Function | Cron |
|---|---|
| `process-email-queue` | `* * * * *` |
| `loyalty-maintenance` | `0 3 * * *` |

During local development set `EMAIL_PROVIDER=log` to print mail to the function
log instead of sending it.

### Auth settings

In **Authentication → Providers → Email**: enable email confirmations. In
**URL Configuration** add `https://bjmeem.com/#/account` and
`https://bjmeem.com/#/reset-password` as redirect URLs. Signup, verification
and password-reset mail are sent by Supabase Auth itself — customise those
templates in the dashboard; the queue in this repo handles order and loyalty
mail only.

### Create the first admin

The privileged-column trigger deliberately blocks a customer from changing
their own role, with a carve-out for sessions that are not an end user. Run
this in the SQL editor (which has no `auth.uid()`):

```sql
update public.profiles set role = 'admin' where email = 'you@bjmeem.com';
```

## Front-end wiring

```html
<script>
  window.BJMEEM_CONFIG = {
    supabaseUrl: 'https://xxxx.supabase.co',
    supabaseAnonKey: 'eyJhbGciOi…',   // anon key only — safe to ship
    siteUrl: 'https://bjmeem.com'
  };
</script>
<script type="module">
  import BJmeemAPI from './js/supabase/index.js';
  const products = await BJmeemAPI.getProducts({ category: 'best-sellers' });
</script>
```

## Tests

```bash
npm install --no-save @electric-sql/pglite
node supabase/tests/schema.test.mjs
```

This boots a real Postgres in WASM, stubs the `auth` and `storage` schemas the
way Supabase provides them, applies all eleven migrations, then asserts the
behaviour that matters: pricing is recomputed server-side, stock is reserved
rather than deducted, overselling is refused, points are earned on delivery and
clawed back on refund, expiry never goes negative, guest tracking does not leak,
and a customer can neither read another customer's rows nor promote themselves
to admin.

## Configurable rules

Everything tunable lives in `app_settings` and is read through
`public.setting_numeric()` at runtime — no redeploy needed.

| Key | Default | Meaning |
|---|---|---|
| `loyalty.points_per_kwd` | `1` | Cozy Points per KWD of merchandise |
| `loyalty.expiry_months` | `12` | Months until earned points lapse |
| `loyalty.signup_bonus_points` | `25` | Credited on registration |
| `loyalty.birthday_bonus_points` | `50` | Credited during birthday month |
| `loyalty.referral_bonus_points` | `100` | To the referrer after a qualifying delivery |
| `delivery.default_fee` | `1.500` | Fallback when no zone matches |
| `tax.rate_percent` | `0` | VAT; Kuwait is currently zero |
| `inventory.low_stock_threshold` | `5` | Flags a variant as low on the dashboard |

Tier thresholds live in `loyalty_tiers`, delivery pricing in `delivery_zones`,
and reward pricing in `loyalty_rewards` — all editable from the admin API.

## Security notes

- The service-role key belongs in Edge Function secrets only. It appears
  nowhere in `js/`.
- `place_order()` accepts no monetary argument of any kind; the test asserts
  this against `pg_get_function_arguments`.
- The loyalty ledger is append-only. Corrections are compensating rows, so the
  history always reconciles to the balance.
- `order_admin_notes` is staff-only and never joined into any customer query.
- Delivery coordinates are stored only when a customer drops a pin on their own
  address. There is no continuous location tracking, and no courier-position
  table ships in this schema.
