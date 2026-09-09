// Runs the BJmeem migrations against a real Postgres (PGlite/WASM) and then
// exercises the checkout, loyalty and RLS paths end to end.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIG = process.argv[2] ?? fileURLToPath(new URL('../migrations/', import.meta.url));
const db = new PGlite();

const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };

function assert(cond, msg) { cond ? ok(msg) : bad(msg); }

// ---- Supabase-shaped bootstrap (auth + storage + roles) -----------------
await db.exec(`
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema storage;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$fn$;

create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $fn$
  select string_to_array(name, '/')
$fn$;
`);
console.log('bootstrap ok');

// ---- run migrations -----------------------------------------------------
const files = readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
for (const f of files) {
  const sql = readFileSync(path.join(MIG, f), 'utf8');
  try {
    await db.exec(sql);
    console.log('applied ' + f);
  } catch (e) {
    console.error('FAILED ' + f + '\n  ' + e.message);
    process.exit(1);
  }
}

const q = async (sql, params) => (await db.query(sql, params)).rows;
const asUser = async (id) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);

console.log('\n--- schema sanity ---');
const tables = await q(`select count(*)::int n from information_schema.tables
                        where table_schema='public' and table_type='BASE TABLE'`);
assert(tables[0].n >= 25, `tables created: ${tables[0].n}`);

const norls = await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                       where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
assert(norls.length === 0, 'RLS enabled on every public table' +
  (norls.length ? ' — MISSING: ' + norls.map(r => r.relname).join(', ') : ''));

const prods = await q(`select count(*)::int n from public.products`);
const vars  = await q(`select count(*)::int n from public.product_variants`);
assert(prods[0].n === 24, `seeded products: ${prods[0].n}`);
assert(vars[0].n > 200, `seeded variants: ${vars[0].n}`);

console.log('\n--- signup ---');
const [u1] = await q(`insert into auth.users (email, raw_user_meta_data)
  values ('mariam@example.com', '{"first_name":"Mariam","last_name":"A","phone_number":"99887766","date_of_birth":"1998-09-15"}'::jsonb)
  returning id`);
const uid = u1.id;
const prof = await q(`select * from public.profiles where id=$1`, [uid]);
assert(prof.length === 1, 'profile auto-created on signup');
assert(!!prof[0].referral_code, `referral code generated: ${prof[0].referral_code}`);
const acct = await q(`select * from public.loyalty_accounts where user_id=$1`, [uid]);
assert(acct.length === 1 && /^BJ-\d+$/.test(acct[0].member_number),
  `loyalty card issued: ${acct[0]?.member_number}`);
assert(acct[0].points_balance === 25, `signup bonus credited: ${acct[0].points_balance}`);
const welcome = await q(`select * from public.email_queue where template='welcome'`);
assert(welcome.length === 1, 'welcome email queued');

console.log('\n--- cart + pricing ---');
await asUser(uid);
const [addr] = await q(`insert into public.addresses
  (user_id,label,full_name,phone_number,governorate,area,block,street,building_number)
  values ($1,'home','Mariam A','99887766','Hawalli','Salmiya','4','12','8') returning id`, [uid]);
assert(true, 'address created');
const isDefault = await q(`select is_default from public.addresses where id=$1`, [addr.id]);
assert(isDefault[0].is_default === true, 'first address auto-defaults');

const [cart] = await q(`select public.get_or_create_cart() as id`);
const [v1] = await q(`select pv.id, pv.product_id, coalesce(pv.price_override,p.price) price
  from public.product_variants pv join public.products p on p.id=pv.product_id
  where p.slug='teddy-cloud-cotton-set' and pv.size='M' and pv.color='Pink'`);
await q(`insert into public.cart_items (cart_id,product_id,variant_id,quantity) values ($1,$2,$3,2)`,
  [cart.id, v1.product_id, v1.id]);

const [pv] = await q(`select public.preview_cart($1) as p`, [addr.id]);
const preview = pv.p;
assert(Number(preview.subtotal) === 25.8, `subtotal from DB prices: ${preview.subtotal}`);
assert(Number(preview.delivery_fee) === 0,
  `free delivery applied over threshold: ${preview.delivery_fee}`);
assert(Number(preview.total_amount) === 25.8, `total: ${preview.total_amount}`);
assert(preview.can_checkout === true, 'cart is checkoutable');

console.log('\n--- coupon ---');
const [c1] = await q(`select public.validate_coupon('WELCOME10', 25.8, $1) as r`, [uid]);
assert(c1.r.valid === true, 'WELCOME10 validates for a first order');
assert(Number(c1.r.discount) === 2.58, `10% discount computed: ${c1.r.discount}`);
const [cBad] = await q(`select public.validate_coupon('COZY5', 25.8, $1) as r`, [uid]);
assert(cBad.r.valid === false && cBad.r.reason === 'MINIMUM_NOT_MET',
  `minimum spend enforced: ${cBad.r.reason}`);
await q(`select public.apply_coupon_to_cart('WELCOME10')`);

console.log('\n--- checkout ---');
const stockBefore = await q(`select stock_quantity, reserved_quantity from public.product_variants where id=$1`, [v1.id]);
const [ord] = await q(`select public.place_order($1,'cod','Leave with concierge') as r`, [addr.id]);
const order = ord.r;
assert(/^BJ-\d{4}-\d{6}$/.test(order.order_number), `order number: ${order.order_number}`);
assert(Number(order.total_amount) === 23.22, `total after coupon: ${order.total_amount}`);
const stockAfter = await q(`select stock_quantity, reserved_quantity from public.product_variants where id=$1`, [v1.id]);
assert(stockAfter[0].reserved_quantity === stockBefore[0].reserved_quantity + 2,
  `stock reserved, not deducted: reserved ${stockBefore[0].reserved_quantity} -> ${stockAfter[0].reserved_quantity}`);
assert(stockAfter[0].stock_quantity === stockBefore[0].stock_quantity,
  'stock_quantity untouched until delivery');
const emptied = await q(`select count(*)::int n from public.cart_items where cart_id=$1`, [cart.id]);
assert(emptied[0].n === 0, 'cart emptied');
const snap = await q(`select product_name, unit_price, total_price from public.order_items where order_id=$1`, [order.order_id]);
assert(snap.length === 1 && snap[0].product_name === 'Teddy Cloud Cotton Set',
  'order item snapshot written');
const hist = await q(`select status from public.order_status_history where order_id=$1`, [order.order_id]);
assert(hist.length === 1 && hist[0].status === 'pending', 'initial status history row');
const red = await q(`select count(*)::int n from public.coupon_redemptions where order_id=$1`, [order.order_id]);
assert(red[0].n === 1, 'coupon redemption recorded');

console.log('\n--- price tampering is impossible ---');
// There is no parameter through which a client could pass an amount.
const args = await q(`select pg_get_function_arguments(p.oid) a from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='place_order'`);
assert(!/numeric/.test(args[0].a), `place_order accepts no amounts: (${args[0].a})`);

console.log('\n--- delivery: loyalty, stock, totals ---');
await q("select set_config('request.jwt.claim.sub','',false)"); await db.exec(`update public.profiles set role='admin' where id='${uid}'`); await asUser(uid);
await q(`select public.admin_update_order_status($1,'confirmed')`, [order.order_id]);
await q(`select public.admin_update_order_status($1,'delivered')`, [order.order_id]);
const afterDeliver = await q(`select stock_quantity, reserved_quantity from public.product_variants where id=$1`, [v1.id]);
assert(afterDeliver[0].stock_quantity === stockBefore[0].stock_quantity - 2,
  `stock deducted on delivery: ${afterDeliver[0].stock_quantity}`);
assert(afterDeliver[0].reserved_quantity === stockBefore[0].reserved_quantity,
  'reservation released on delivery');
const earn = await q(`select points, transaction_type from public.loyalty_transactions
  where order_id=$1 and transaction_type='earn'`, [order.order_id]);
assert(earn.length === 1 && earn[0].points === 23, `points earned on delivery: ${earn[0]?.points}`);
const acct2 = await q(`select points_balance, lifetime_points from public.loyalty_accounts where user_id=$1`, [uid]);
assert(acct2[0].points_balance === 48, `balance = 25 signup + 23 earned = ${acct2[0].points_balance}`);
const p2 = await q(`select total_orders, total_spent from public.profiles where id=$1`, [uid]);
assert(p2[0].total_orders === 1, 'profile order count updated');

console.log('\n--- refund reverses points and restocks ---');
await q(`select public.admin_update_order_status($1,'refunded')`, [order.order_id]);
const acct3 = await q(`select points_balance, lifetime_points from public.loyalty_accounts where user_id=$1`, [uid]);
assert(acct3[0].points_balance === 25, `points clawed back: ${acct3[0].points_balance}`);
assert(acct3[0].lifetime_points === 25, `lifetime reduced so tier cannot be gamed: ${acct3[0].lifetime_points}`);
const restock = await q(`select stock_quantity from public.product_variants where id=$1`, [v1.id]);
assert(restock[0].stock_quantity === stockBefore[0].stock_quantity, 'stock returned on refund');

console.log('\n--- loyalty card ---');
const [card] = await q(`select public.get_loyalty_card() as c`);
assert(card.c.member_number === acct[0].member_number, 'card exposes member number, not the UUID');
assert(card.c.tier.code === 'cozy' && card.c.next_tier.code === 'teddy',
  `tier ${card.c.tier.code} -> next ${card.c.next_tier.code} (${card.c.next_tier.points_needed} to go)`);

console.log('\n--- overselling ---');
const [v2] = await q(`select id, product_id from public.product_variants limit 1`);
await q(`update public.product_variants set stock_quantity=1, reserved_quantity=0 where id=$1`, [v2.id]);
await q(`insert into public.cart_items (cart_id,product_id,variant_id,quantity) values ($1,$2,$3,5)`,
  [cart.id, v2.product_id, v2.id]);
let blocked = false;
try { await q(`select public.place_order($1,'cod') as r`, [addr.id]); }
catch (e) { blocked = /CHECKOUT_BLOCKED/.test(e.message); }
assert(blocked, 'checkout refuses to oversell');
await q(`delete from public.cart_items where cart_id=$1`, [cart.id]);
let violated = false;
try { await q(`update public.product_variants set reserved_quantity=99 where id=$1`, [v2.id]); }
catch (e) { violated = /variants_reserve_le_stock_chk/.test(e.message); }
assert(violated, 'CHECK constraint makes over-reservation unrepresentable');

console.log('\n--- RLS ---');
const [u2] = await q(`insert into auth.users (email, raw_user_meta_data)
  values ('other@example.com','{"first_name":"Other"}'::jsonb) returning id`);
await q("select set_config('request.jwt.claim.sub','',false)"); await db.exec(`update public.profiles set role='customer' where id='${uid}'`);
await db.exec(`grant usage on schema public to authenticated`);
await asUser(u2.id);
await db.exec(`set role authenticated`);
const seen = await q(`select count(*)::int n from public.addresses`);
assert(seen[0].n === 0, "a customer cannot see another customer's addresses");
const seenOrders = await q(`select count(*)::int n from public.orders`);
assert(seenOrders[0].n === 0, "a customer cannot see another customer's orders");
let promoBlocked = false;
try { await q(`update public.profiles set role='admin' where id=$1`, [u2.id]); }
catch (e) { promoBlocked = /PRIVILEGED_COLUMN/.test(e.message); }
assert(promoBlocked, 'a customer cannot promote themselves to admin');
let pointsBlocked = false;
try { await q(`update public.profiles set loyalty_points=99999 where id=$1`, [u2.id]); }
catch (e) { pointsBlocked = /PRIVILEGED_COLUMN/.test(e.message); }
assert(pointsBlocked, 'a customer cannot mint loyalty points');
let ledgerBlocked = false;
try { await q(`insert into public.loyalty_transactions (user_id,transaction_type,points,description)
               values ($1,'bonus',5000,'hack')`, [u2.id]); }
catch (e) { ledgerBlocked = true; }
assert(ledgerBlocked, 'a customer cannot write to the loyalty ledger');
let notesBlocked = false;
const notes = await q(`select count(*)::int n from public.order_admin_notes`).catch(() => { notesBlocked = true; return [{n:-1}]; });
assert(notesBlocked || notes[0].n === 0, 'internal admin notes are invisible to customers');
await db.exec(`reset role`);

console.log('\n--- guest tracking ---');
const [t] = await q(`select public.track_order($1,'mariam@example.com') as r`, [order.order_number]);
assert(t.r.found === true && t.r.history.length >= 3,
  `tracking returns ${t.r.history?.length} status events`);
const [tBad] = await q(`select public.track_order($1,'wrong@example.com') as r`, [order.order_number]);
assert(tBad.r.found === false, 'tracking does not leak on a wrong email');

console.log('\n--- birthday + expiry maintenance ---');
const bd = await q(`select public.grant_birthday_bonus() as n`);
assert(bd[0].n >= 1, `birthday bonus granted: ${bd[0].n}`);
const bd2 = await q(`select public.grant_birthday_bonus() as n`);
assert(bd2[0].n === 0, 'birthday bonus cannot be claimed twice in a year');

// Backdate the signup bonus so it is due to expire. The ledger is append-only,
// so even this test fixture has to raise the privileged flag.
let fixtureBlocked = false;
try {
  await q(`update public.loyalty_transactions set expires_at = now() - interval '1 day'
           where transaction_type='signup_bonus'`);
} catch (e) { fixtureBlocked = /LEDGER_APPEND_ONLY/.test(e.message); }
assert(fixtureBlocked, 'ledger rejects an unprivileged UPDATE, even from the service role');

await q(`select set_config('bjmeem.privileged','on',false)`);
await q(`update public.loyalty_transactions set expires_at = now() - interval '1 day'
         where transaction_type='signup_bonus'`);
await q(`select set_config('bjmeem.privileged','off',false)`);

const balBefore = await q(`select points_balance from public.loyalty_accounts where user_id=$1`, [uid]);
const ex = await q(`select public.expire_loyalty_points() as n`);
assert(ex[0].n >= 1, `expired ${ex[0].n} lapsed point batch(es)`);
const balAfter = await q(`select points_balance from public.loyalty_accounts where user_id=$1`, [uid]);
assert(balAfter[0].points_balance < balBefore[0].points_balance,
  `balance reduced by expiry: ${balBefore[0].points_balance} -> ${balAfter[0].points_balance}`);
assert(balAfter[0].points_balance >= 0, 'expiry never drives the balance negative');

console.log('\n--- reorder ---');
await asUser(uid);
const [ro] = await q(`select public.reorder($1) as r`, [order.order_id]);
assert(ro.r.added === 1, `reorder re-added ${ro.r.added} line(s)`);

console.log('\n--- admin: roles ---');
await q(`select set_config('request.jwt.claim.sub','',false)`);
await db.exec(`update public.profiles set role='owner' where id='${uid}'`);
await asUser(uid);
const roles = await q(`select public.is_owner() o, public.is_admin() a, public.is_staff() s`);
assert(roles[0].o && roles[0].a && roles[0].s, 'owner satisfies is_owner/is_admin/is_staff');
const perm = await q(`select public.has_permission('products') p`);
assert(perm[0].p === true, 'owner has every permission implicitly');

console.log('\n--- admin: overview ---');
const [ov] = await q(`select public.admin_overview() as o`);
assert(typeof ov.o.revenue_today !== 'undefined' && typeof ov.o.revenue_month !== 'undefined',
  `revenue today/month present: ${ov.o.revenue_today} / ${ov.o.revenue_month}`);
assert(ov.o.total_products === 24, `product count: ${ov.o.total_products}`);
assert(Array.isArray(ov.o.low_stock_alerts), `low-stock alerts array (${ov.o.low_stock_alerts.length})`);
assert(typeof ov.o.open_counts.pending === 'number', 'per-status order counts present');

console.log('\n--- admin: product visibility (§4) ---');
const [prodRow] = await q(`select id, slug from public.products where slug='bow-bow-shorts-set'`);
await q(`select public.admin_set_product_visibility($1, false)`, [prodRow.id]);
const hidden = await q(`select is_active from public.products where id=$1`, [prodRow.id]);
assert(hidden[0].is_active === false, 'product hidden, not deleted');
const stillThere = await q(`select count(*)::int n from public.products where id=$1`, [prodRow.id]);
assert(stillThere[0].n === 1, 'hidden product still stored in Supabase');

// A shopper must not see it.
await asUser(u2.id);
await db.exec(`set role authenticated`);
const shopperSees = await q(`select count(*)::int n from public.products where id=$1`, [prodRow.id]);
assert(shopperSees[0].n === 0, 'hidden product is invisible to the public store (RLS)');
await db.exec(`reset role`);
await asUser(uid);
await q(`select public.admin_set_product_visibility($1, true)`, [prodRow.id]);
const shown = await q(`select is_active from public.products where id=$1`, [prodRow.id]);
assert(shown[0].is_active === true, 'product restored to visible');

console.log('\n--- admin: duplicate + variants (§3, §5) ---');
const [dup] = await q(`select public.admin_duplicate_product($1) as r`, [prodRow.id]);
assert(/-copy/.test(dup.r.slug), `duplicated as ${dup.r.slug}`);
const dupRow = await q(`select is_active from public.products where id=$1`, [dup.r.product_id]);
assert(dupRow[0].is_active === false, 'duplicate starts hidden so a draft never goes live');
const dupStock = await q(`select coalesce(sum(stock_quantity),0)::int n from public.product_variants where product_id=$1`,
  [dup.r.product_id]);
assert(dupStock[0].n === 0, 'duplicate starts with zero stock');

const [nv] = await q(`select public.admin_upsert_variant($1,'M','Teddy Pink','BJM-TEST-TPK-M',5) as r`,
  [dup.r.product_id]);
assert(nv.r.available_quantity === 5, `variant created with available=${nv.r.available_quantity}`);
const [uv] = await q(`select public.admin_upsert_variant($1,'M','Teddy Pink','BJM-TEST-TPK-M',9,$2) as r`,
  [dup.r.product_id, nv.r.variant_id]);
assert(uv.r.stock_quantity === 9, `stock updated to ${uv.r.stock_quantity}`);

// Cannot cut stock below what live orders are holding.
await db.exec(`update public.product_variants set reserved_quantity=4 where id='${nv.r.variant_id}'`);
let belowReserved = false;
try { await q(`select public.admin_upsert_variant($1,'M','Teddy Pink','BJM-TEST-TPK-M',2,$2)`,
  [dup.r.product_id, nv.r.variant_id]); }
catch (e) { belowReserved = /STOCK_BELOW_RESERVED/.test(e.message); }
assert(belowReserved, 'refuses to set stock below reserved quantity');
let negStock = false;
try { await q(`select public.admin_upsert_variant($1,'S','Teddy Pink','BJM-NEG',-3)`, [dup.r.product_id]); }
catch (e) { negStock = /NEGATIVE_STOCK/.test(e.message); }
assert(negStock, 'refuses negative stock');

console.log('\n--- admin: staff permission gating (§21) ---');
await q(`select set_config('request.jwt.claim.sub','',false)`);
await db.exec(`update public.profiles set role='staff', permissions='{}'::jsonb where id='${u2.id}'`);
await asUser(u2.id);
assert((await q(`select public.has_permission('products') p`))[0].p === false,
  'staff with empty permissions has none');
let staffBlocked = false;
try { await q(`select public.admin_duplicate_product($1)`, [prodRow.id]); }
catch (e) { staffBlocked = /FORBIDDEN/.test(e.message); }
assert(staffBlocked, 'staff without the products permission cannot duplicate');

await q(`select set_config('request.jwt.claim.sub','',false)`);
await db.exec(`update public.profiles set permissions='{"products":true}'::jsonb where id='${u2.id}'`);
await asUser(u2.id);
assert((await q(`select public.has_permission('products') p`))[0].p === true,
  'granting one permission works');
assert((await q(`select public.has_permission('loyalty') p`))[0].p === false,
  'other permissions stay denied');

let roleEscalation = false;
try { await q(`select public.admin_set_role($1,'owner')`, [u2.id]); }
catch (e) { roleEscalation = /FORBIDDEN|CANNOT_CHANGE_OWN_ROLE/.test(e.message); }
assert(roleEscalation, 'staff cannot promote anyone (role changes are owner-only)');

await asUser(uid);
let selfRole = false;
try { await q(`select public.admin_set_role($1,'customer')`, [uid]); }
catch (e) { selfRole = /CANNOT_CHANGE_OWN_ROLE/.test(e.message); }
assert(selfRole, 'even the owner cannot change their own role');
const [sr] = await q(`select public.admin_set_role($1,'staff','{"orders":true}'::jsonb) as r`, [u2.id]);
assert(sr.r.role === 'staff', 'owner can set roles and permissions');

console.log('\n--- admin: reports (§16) ---');
const [rep] = await q(`select public.admin_sales_report(now() - interval '30 days', now(), 'day') as r`);
assert(typeof rep.r.totals.revenue !== 'undefined', `sales report totals: ${JSON.stringify(rep.r.totals)}`);
assert(typeof rep.r.excluded.cancelled === 'number',
  'cancelled/refunded reported separately, not as revenue');
const [bs] = await q(`select public.admin_best_sellers(30, 5) as r`);
assert(Array.isArray(bs.r.products) && Array.isArray(bs.r.sizes) && Array.isArray(bs.r.colors),
  `best sellers by product/size/colour (${bs.r.products.length} products)`);

console.log('\n--- admin: customers are locked out (§1, §20) ---');
await q(`select set_config('request.jwt.claim.sub','',false)`);
await db.exec(`update public.profiles set role='customer', permissions='{}'::jsonb where id='${u2.id}'`);
await asUser(u2.id);
for (const [fn, args] of [['admin_overview', ''], ['admin_sales_report', ''],
                          ['admin_best_sellers', ''], ['admin_dashboard_stats', '']]) {
  let blocked = false;
  try { await q(`select public.${fn}(${args})`); } catch (e) { blocked = /FORBIDDEN/.test(e.message); }
  assert(blocked, `customer calling ${fn}() is refused server-side`);
}
let visBlocked = false;
try { await q(`select public.admin_set_product_visibility($1,false)`, [prodRow.id]); }
catch (e) { visBlocked = /FORBIDDEN/.test(e.message); }
assert(visBlocked, 'customer cannot hide a product');

console.log('\nDone.');
await db.close();
