# BJmeem — Backend Architecture

Supabase (PostgreSQL + Auth + Storage + Edge Functions) behind the existing
HTML/CSS/JS storefront.

---

## 1. Trust boundary

The single most important design decision: **what the browser is allowed to write
directly**. Anything that determines money, stock or entitlement is not on that list.

### Green — direct from the browser (anon key + RLS)

These are safe because RLS scopes every row to `auth.uid()`, and a malicious client
can only corrupt its own non-financial data.

| Operation | Table | Why it's safe |
|---|---|---|
| Read catalogue | `categories`, `products`, `product_variants`, `product_images` | Public read, `is_active` filtered. No secrets. |
| Read/update own profile | `profiles` | RLS `id = auth.uid()`. Privileged columns blocked by trigger (§3). |
| CRUD own addresses | `addresses` | RLS `user_id = auth.uid()`. |
| CRUD own cart | `carts`, `cart_items` | Quantities only. **Prices are never read from here at checkout.** |
| CRUD own wishlist | `wishlist_items` | Unique `(user_id, product_id)`. |
| Read own orders | `orders`, `order_items`, `order_status_history` | Read-only to customers. |
| Read own loyalty | `loyalty_accounts`, `loyalty_transactions` | Read-only. |
| Read/ack notifications | `notifications` | Only `is_read` is updatable. |
| Write reviews | `product_reviews` | Insert only; `is_verified_purchase` and `status` set by trigger. |

### Amber — SECURITY DEFINER SQL functions (RPC)

Multi-table, must be atomic, must not trust client input. Run inside one transaction
so a crash cannot half-apply. Called with the anon key; they re-derive `auth.uid()`
themselves and ignore any user id passed in.

| RPC | Guards |
|---|---|
| `place_order()` | Recomputes subtotal from DB prices, locks variants `FOR UPDATE` in id order (deadlock-free), verifies stock, validates coupon + loyalty reward, writes order + items + reservation + history + notification, clears cart. |
| `preview_cart()` | Same pricing engine, no writes — lets the UI show a total that will match checkout exactly. |
| `validate_coupon()` | Window, min spend, usage caps, per-customer caps, tier gating. |
| `redeem_loyalty_reward()` | Balance check, prevents negative balance and double redemption. |
| `cancel_my_order()` | Only pre-fulfilment statuses; releases reservation. |
| `track_order()` | Order number + email lookup for guests, rate-limit friendly, returns no PII beyond the order. |
| `reorder()` | Re-adds still-purchasable variants to the cart. |
| `admin_*()` | Re-check `is_admin()` server-side regardless of what the UI shows. |

### Red — Edge Functions only (service-role key, never shipped to the browser)

| Function | Why it can't be in SQL or the browser |
|---|---|
| `send-email` | Holds the transactional-email provider API key. |
| `process-email-queue` | Drains `email_queue`; scheduled. |
| `loyalty-maintenance` | Point expiry + birthday bonuses; scheduled, needs to bypass RLS. |

**Supabase Auth** handles signup/verification/reset emails itself — those templates are
configured in the dashboard, not re-implemented here.

---

## 2. Why money is recomputed, never accepted

Every price input at checkout is discarded:

- **Unit price** ← `coalesce(product_variants.price_override, products.price)`
- **Delivery fee** ← `delivery_zones` matched on the address governorate, waived above
  the zone's `free_delivery_threshold`
- **Coupon discount** ← `validate_coupon()` against `coupons` + `coupon_redemptions`
- **Loyalty discount** ← `loyalty_rewards.reward_value`, gated on `points_balance`
- **Total** ← `subtotal − discount − loyalty_discount + delivery + tax`

`place_order()` takes an address id, a payment method, an optional coupon *code* and an
optional reward *id*. It takes no amounts at all, so there is nothing to tamper with in
DevTools.

## 3. Privileged columns

`profiles.role`, `profiles.loyalty_points`, `profiles.total_spent`, `profiles.total_orders`
are writable by the row's owner under RLS but are frozen by
`enforce_profile_privileged_columns()`, which raises unless the caller is an admin or the
change came from a `SECURITY DEFINER` routine. This is deliberate: RLS grants row access,
triggers enforce column-level intent. Same pattern guards `orders` (customers may not move
their own order to `delivered`).

## 4. Inventory model

`available = stock_quantity − reserved_quantity`.

| Transition | Effect |
|---|---|
| Order placed | `reserved_quantity += qty` |
| → `delivered` | `stock_quantity −= qty`, `reserved_quantity −= qty` |
| → `cancelled` (pre-delivery) | `reserved_quantity −= qty` |
| → `returned` / `refunded` (post-delivery) | `stock_quantity += qty` |

Race safety comes from locking the variant rows `FOR UPDATE` **ordered by id** before any
stock arithmetic, so two concurrent checkouts for the same variant serialise instead of
deadlocking. A `CHECK (reserved_quantity <= stock_quantity)` makes overselling
unrepresentable even if a code path were missed.

## 5. Loyalty integrity

Points are never written by the client. `loyalty_accounts.points_balance` and
`lifetime_points` are derived columns maintained by a trigger on `loyalty_transactions`
— the ledger is the source of truth, the balance is a cache. Earning fires only on
`delivered`; `returned`/`refunded` insert a compensating `refund_adjustment` row rather
than mutating history. Tier is recomputed from `loyalty_tiers` thresholds, which live in
the database so they can change without a deploy.

Expiry is modelled as `loyalty_transactions.expires_at` on earning rows;
`loyalty-maintenance` inserts negative `expiry` rows for lapsed points.

## 6. Identity

`auth.users` → trigger `handle_new_user()` → creates `profiles`, `loyalty_accounts`
(with a public `member_number` like `BJ-10284`, never the UUID), a referral code, and a
signup bonus. Runs `SECURITY DEFINER` because the new user has no session yet.

## 7. Storage

Bucket `product-images`, public read, writes restricted to admin/staff by storage policy.
`avatars` bucket is owner-writable, public read.

## 8. Files

```
supabase/migrations/   0001…0010  schema, functions, RLS, seed
supabase/functions/    send-email, process-email-queue, loyalty-maintenance
js/supabase/           browser client modules (auth, cart, orders, loyalty, …)
```
