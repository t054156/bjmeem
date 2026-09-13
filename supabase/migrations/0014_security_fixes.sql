-- =====================================================================
-- BJmeem 0014 — security fixes from the read-only audit.
--
-- Additive only. No table is dropped, no row is deleted. Policies are
-- replaced in place and one trigger is added.
--
--   Finding  3  staff read customer data without the permission ticked
--   Finding  6  no rate limit or duplicate-order guard
--   Finding  9  avatars bucket is public
--   Finding 10  app_settings readable by anyone
-- =====================================================================

-- =====================================================================
-- Finding 3 — read rules must check the individual permission, not
-- merely "is this person staff".
--
-- has_permission() already returns true for owner and admin, and for a
-- staff member only when that key is ticked in profiles.permissions.
-- Hiding a tab in the dashboard hid the button, not the data; these
-- policies are what actually decides.
-- =====================================================================

-- -------------------------------------------------------- profiles
-- Everyone still reads their own row. Staff need 'customers'.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.has_permission('customers'));

-- ------------------------------------------------------- addresses
-- Home addresses. Staff need 'customers'.
drop policy if exists addresses_staff_read on public.addresses;
create policy addresses_staff_read on public.addresses
  for select to authenticated
  using (public.has_permission('customers'));

-- ---------------------------------------------------------- orders
-- The Orders screen and the Customer screen both legitimately show
-- orders, so either permission opens them.
drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders
  for select to authenticated
  using (user_id = auth.uid()
         or public.has_permission('orders')
         or public.has_permission('customers'));

drop policy if exists orders_staff_write on public.orders;
create policy orders_staff_write on public.orders
  for update to authenticated
  using (public.has_permission('orders'))
  with check (public.has_permission('orders'));

drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_items.order_id
                   and (o.user_id = auth.uid()
                        or public.has_permission('orders')
                        or public.has_permission('customers'))));

drop policy if exists order_history_read on public.order_status_history;
create policy order_history_read on public.order_status_history
  for select to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_status_history.order_id
                   and (o.user_id = auth.uid()
                        or public.has_permission('orders')
                        or public.has_permission('customers'))));

-- Internal notes stay staff-only, now gated on the orders permission.
drop policy if exists admin_notes_staff on public.order_admin_notes;
create policy admin_notes_staff on public.order_admin_notes
  for all to authenticated
  using (public.has_permission('orders'))
  with check (public.has_permission('orders'));

-- --------------------------------------------------------- loyalty
-- Same defect, same class of data: points balances and history are
-- personal. Staff need 'loyalty' or 'customers'.
drop policy if exists loyalty_accounts_own on public.loyalty_accounts;
create policy loyalty_accounts_own on public.loyalty_accounts
  for select to authenticated
  using (user_id = auth.uid()
         or public.has_permission('loyalty')
         or public.has_permission('customers'));

drop policy if exists loyalty_txn_own on public.loyalty_transactions;
create policy loyalty_txn_own on public.loyalty_transactions
  for select to authenticated
  using (user_id = auth.uid()
         or public.has_permission('loyalty')
         or public.has_permission('customers'));

drop policy if exists coupon_redemptions_own on public.coupon_redemptions;
create policy coupon_redemptions_own on public.coupon_redemptions
  for select to authenticated
  using (user_id = auth.uid()
         or public.has_permission('coupons')
         or public.has_permission('customers'));

-- =====================================================================
-- Finding 6 — one account could call place_order() as fast as it liked.
-- Each accepted order puts stock on hold, so a few hundred calls take
-- the whole shop out of stock until someone cancels them by hand.
--
-- Enforced as a BEFORE INSERT trigger on orders, so it applies to every
-- path into the table, not just place_order().
-- =====================================================================

create or replace function public.orders_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_minute integer;
  v_hour   integer;
  v_dupe   uuid;
begin
  -- Orders keyed in by the shop (phone, WhatsApp, walk-in) are already
  -- behind an admin login and are not limited.
  if new.user_id is null or public.is_staff() then
    return new;
  end if;

  select count(*) into v_minute
    from public.orders
   where user_id = new.user_id
     and created_at > now() - interval '1 minute';
  if v_minute >= 3 then
    raise exception
      'TOO_MANY_ORDERS: please wait a minute before placing another order'
      using errcode = 'P0001';
  end if;

  select count(*) into v_hour
    from public.orders
   where user_id = new.user_id
     and created_at > now() - interval '1 hour';
  if v_hour >= 12 then
    raise exception
      'TOO_MANY_ORDERS: too many orders from this account in the last hour'
      using errcode = 'P0001';
  end if;

  -- Same account, same amount, within a minute: a double submit or a
  -- retry, not a second order. Cancelled orders do not count, so a
  -- genuine re-order after a cancellation still goes through.
  select id into v_dupe
    from public.orders
   where user_id = new.user_id
     and total_amount = new.total_amount
     and order_status <> 'cancelled'
     and created_at > now() - interval '60 seconds'
   limit 1;
  if v_dupe is not null then
    raise exception
      'DUPLICATE_ORDER: that order was already placed a moment ago'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_rate_limit_trg on public.orders;
create trigger orders_rate_limit_trg
  before insert on public.orders
  for each row execute function public.orders_rate_limit();

-- Makes the two counting queries above an index lookup rather than a scan.
create index if not exists orders_user_recent_idx
  on public.orders (user_id, created_at desc);

-- =====================================================================
-- Finding 9 — the avatars bucket was world-readable and the file path
-- carries the customer's account id.
-- =====================================================================

update storage.buckets set public = false where id = 'avatars';

drop policy if exists "avatars are public" on storage.objects;
create policy "avatars readable by owner and staff"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars'
         and ((storage.foldername(name))[1] = auth.uid()::text
              or public.has_permission('customers')));

-- Product photos stay public on purpose: they are shop photographs, and
-- the storefront must show them to visitors with no account.

-- =====================================================================
-- Finding 10 — app_settings was readable by anyone on the internet.
--
-- Nothing in the storefront reads this table; only the admin dashboard
-- does. Server-side pricing keeps working because setting() is
-- SECURITY DEFINER and is called from inside other definer functions.
-- =====================================================================

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings
  for select to authenticated
  using (public.is_staff());

-- Reading one key at a time through the helper was an equivalent way in.
-- Postgres grants EXECUTE to PUBLIC on every new function, so revoking from
-- anon and authenticated alone leaves the door open: PUBLIC must go too.
-- Server-side pricing is unaffected. These helpers are called from inside
-- SECURITY DEFINER functions, which run with the owner's rights.
revoke execute on function public.setting(text, jsonb)           from public, anon, authenticated;
revoke execute on function public.setting_numeric(text, numeric) from public, anon, authenticated;
