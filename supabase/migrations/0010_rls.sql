-- =====================================================================
-- BJmeem 0010 — admin operations + Row Level Security
--
-- Default posture: every table has RLS enabled and NO policy grants
-- anything unless it is written below. Tables with no policy at all
-- (order_counters, email_queue) are reachable only by SECURITY DEFINER
-- functions and the service role.
-- =====================================================================

-- Only advertised coupons are listable by customers; targeted codes stay hidden
-- and can be used only by typing them (validated through validate_coupon()).
alter table public.coupons add column is_public boolean not null default false;

-- =====================================================================
-- ADMIN OPERATIONS
-- =====================================================================

create or replace function public.admin_update_order_status(
  p_order_id uuid,
  p_status   public.order_status,
  p_note     text default null,
  p_courier_name text default null,
  p_courier_phone text default null,
  p_tracking_reference text default null,
  p_estimated_delivery_time timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old public.orders;
begin
  if not public.is_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_old from public.orders where id = p_order_id for update;
  if v_old.id is null then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform set_config('bjmeem.privileged', 'on', true);
  update public.orders
     set order_status = p_status,
         courier_name = coalesce(p_courier_name, courier_name),
         courier_phone = coalesce(p_courier_phone, courier_phone),
         tracking_reference = coalesce(p_tracking_reference, tracking_reference),
         estimated_delivery_time = coalesce(p_estimated_delivery_time, estimated_delivery_time),
         payment_status = case
           when p_status = 'delivered' and payment_method = 'cod' then 'paid'::public.payment_status
           when p_status = 'refunded' then 'refunded'::public.payment_status
           else payment_status end
   where id = p_order_id;
  perform set_config('bjmeem.privileged', 'off', true);

  if p_note is not null then
    update public.order_status_history
       set note = p_note
     where id = (select id from public.order_status_history
                 where order_id = p_order_id order by created_at desc limit 1);
  end if;

  perform public.write_audit('order_status_change', 'orders', p_order_id,
    jsonb_build_object('status', v_old.order_status),
    jsonb_build_object('status', p_status, 'note', p_note));

  return jsonb_build_object('order_id', p_order_id, 'status', p_status);
end;
$$;

-- Manual loyalty adjustment, always audited.
create or replace function public.admin_adjust_loyalty(
  p_user_id uuid,
  p_points  integer,
  p_reason  text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_balance integer;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_points = 0 then
    raise exception 'POINTS_MUST_BE_NONZERO' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;

  insert into public.loyalty_transactions (
    user_id, transaction_type, points, description, created_by, expires_at)
  values (
    p_user_id, 'manual_adjustment', p_points, p_reason, auth.uid(),
    case when p_points > 0
         then now() + make_interval(months => public.setting_numeric('loyalty.expiry_months', 12)::int)
    end);

  select points_balance into v_balance from public.loyalty_accounts where user_id = p_user_id;

  perform public.write_audit('loyalty_adjustment', 'loyalty_accounts', p_user_id,
    null, jsonb_build_object('points', p_points, 'reason', p_reason, 'balance_after', v_balance));

  return jsonb_build_object('user_id', p_user_id, 'points', p_points, 'balance', v_balance);
end;
$$;

create or replace function public.admin_set_stock(
  p_variant_id uuid,
  p_stock_quantity integer,
  p_reason text default 'Manual stock update')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old public.product_variants;
begin
  if not public.is_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into v_old from public.product_variants where id = p_variant_id for update;
  if v_old.id is null then
    raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_stock_quantity < v_old.reserved_quantity then
    raise exception 'STOCK_BELOW_RESERVED: % units are reserved by live orders',
      v_old.reserved_quantity using errcode = 'P0001';
  end if;

  update public.product_variants
     set stock_quantity = p_stock_quantity
   where id = p_variant_id;

  perform public.write_audit('stock_change', 'product_variants', p_variant_id,
    jsonb_build_object('stock_quantity', v_old.stock_quantity),
    jsonb_build_object('stock_quantity', p_stock_quantity, 'reason', p_reason));

  return jsonb_build_object('variant_id', p_variant_id, 'stock_quantity', p_stock_quantity);
end;
$$;

create or replace function public.admin_dashboard_stats(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_from timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  if not public.is_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'window_days', p_days,
    'orders_total', (select count(*) from public.orders where created_at >= v_from),
    'revenue', (select coalesce(sum(total_amount), 0) from public.orders
                 where created_at >= v_from
                   and order_status not in ('cancelled','refunded','returned')),
    'average_order_value', (select coalesce(round(avg(total_amount), 3), 0) from public.orders
                 where created_at >= v_from
                   and order_status not in ('cancelled','refunded','returned')),
    'orders_by_status', (select coalesce(jsonb_object_agg(order_status, c), '{}'::jsonb)
                 from (select order_status, count(*) c from public.orders
                       where created_at >= v_from group by order_status) s),
    'new_customers', (select count(*) from public.profiles where created_at >= v_from),
    'pending_fulfilment', (select count(*) from public.orders
                 where order_status in ('pending','confirmed','preparing','packed')),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object(
                        'variant_id', v.variant_id, 'sku', v.sku,
                        'size', v.size, 'color', v.color,
                        'available', v.available_quantity)), '[]'::jsonb)
                 from public.v_variant_availability v
                 where v.is_active
                   and v.available_quantity <= public.setting_numeric('inventory.low_stock_threshold', 5)),
    'loyalty_outstanding', (select coalesce(sum(points_balance), 0) from public.loyalty_accounts));
end;
$$;

-- =====================================================================
-- ENABLE RLS EVERYWHERE
-- =====================================================================
alter table public.app_settings          enable row level security;
alter table public.order_counters        enable row level security;
alter table public.profiles              enable row level security;
alter table public.delivery_zones        enable row level security;
alter table public.addresses             enable row level security;
alter table public.categories            enable row level security;
alter table public.products              enable row level security;
alter table public.product_variants      enable row level security;
alter table public.product_images        enable row level security;
alter table public.carts                 enable row level security;
alter table public.cart_items            enable row level security;
alter table public.wishlist_items        enable row level security;
alter table public.coupons               enable row level security;
alter table public.coupon_redemptions    enable row level security;
alter table public.orders                enable row level security;
alter table public.order_items           enable row level security;
alter table public.order_status_history  enable row level security;
alter table public.order_admin_notes     enable row level security;
alter table public.loyalty_tiers         enable row level security;
alter table public.loyalty_accounts      enable row level security;
alter table public.loyalty_transactions  enable row level security;
alter table public.loyalty_rewards       enable row level security;
alter table public.referrals             enable row level security;
alter table public.notifications         enable row level security;
alter table public.product_reviews       enable row level security;
alter table public.audit_logs            enable row level security;
alter table public.email_queue           enable row level security;

-- ------------------------------------------------------- settings
create policy settings_read on public.app_settings
  for select to anon, authenticated using (true);
create policy settings_admin on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------- profiles
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_staff());
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ------------------------------------------------------ addresses
create policy addresses_own on public.addresses
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy addresses_staff_read on public.addresses
  for select to authenticated using (public.is_staff());

-- ------------------------------------------------- delivery zones
create policy zones_read on public.delivery_zones
  for select to anon, authenticated using (is_active or public.is_staff());
create policy zones_admin on public.delivery_zones
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------- catalog
create policy categories_read on public.categories
  for select to anon, authenticated using (is_active or public.is_staff());
create policy categories_admin on public.categories
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

create policy products_read on public.products
  for select to anon, authenticated using (is_active or public.is_staff());
create policy products_admin on public.products
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

create policy variants_read on public.product_variants
  for select to anon, authenticated using (is_active or public.is_staff());
create policy variants_admin on public.product_variants
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

create policy images_read on public.product_images
  for select to anon, authenticated using (true);
create policy images_admin on public.product_images
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ------------------------------------------------------------ cart
create policy carts_own on public.carts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy cart_items_own on public.cart_items
  for all to authenticated
  using (exists (select 1 from public.carts c
                 where c.id = cart_items.cart_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.carts c
                 where c.id = cart_items.cart_id and c.user_id = auth.uid()));

-- -------------------------------------------------------- wishlist
create policy wishlist_own on public.wishlist_items
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --------------------------------------------------------- coupons
-- Customers see only publicly advertised, currently-valid coupons.
create policy coupons_public_read on public.coupons
  for select to authenticated
  using (public.is_staff()
         or (is_public and is_active
             and starts_at <= now()
             and (expires_at is null or expires_at > now())));
create policy coupons_admin on public.coupons
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy coupon_redemptions_own on public.coupon_redemptions
  for select to authenticated using (user_id = auth.uid() or public.is_staff());

-- ---------------------------------------------------------- orders
create policy orders_select_own on public.orders
  for select to authenticated using (user_id = auth.uid() or public.is_staff());
-- Writes go through place_order() / cancel_my_order() / admin_update_order_status().
create policy orders_staff_write on public.orders
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

create policy order_items_read on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_items.order_id
                   and (o.user_id = auth.uid() or public.is_staff())));

create policy order_history_read on public.order_status_history
  for select to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_status_history.order_id
                   and (o.user_id = auth.uid() or public.is_staff())));

-- Internal notes: staff only, never visible to the customer.
create policy admin_notes_staff on public.order_admin_notes
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- --------------------------------------------------------- loyalty
create policy tiers_read on public.loyalty_tiers
  for select to anon, authenticated using (is_active or public.is_staff());
create policy tiers_admin on public.loyalty_tiers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy loyalty_accounts_own on public.loyalty_accounts
  for select to authenticated using (user_id = auth.uid() or public.is_staff());

create policy loyalty_txn_own on public.loyalty_transactions
  for select to authenticated using (user_id = auth.uid() or public.is_staff());

create policy rewards_read on public.loyalty_rewards
  for select to anon, authenticated using (is_active or public.is_staff());
create policy rewards_admin on public.loyalty_rewards
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy referrals_own on public.referrals
  for select to authenticated
  using (referrer_user_id = auth.uid() or referred_user_id = auth.uid() or public.is_staff());

-- --------------------------------------------------- notifications
create policy notifications_own_read on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_own_update on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_staff on public.notifications
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Customers may flip is_read and nothing else.
create or replace function public.notifications_only_mark_read()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_staff() then return new; end if;
  if new.title is distinct from old.title
     or new.message is distinct from old.message
     or new.type is distinct from old.type
     or new.user_id is distinct from old.user_id
     or new.reference_id is distinct from old.reference_id then
    raise exception 'ONLY_IS_READ_IS_WRITABLE' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger notifications_read_only_flag
  before update on public.notifications
  for each row execute function public.notifications_only_mark_read();

-- --------------------------------------------------------- reviews
create policy reviews_read on public.product_reviews
  for select to anon, authenticated
  using (status = 'approved' or user_id = auth.uid() or public.is_staff());
create policy reviews_insert_own on public.product_reviews
  for insert to authenticated with check (user_id = auth.uid());
create policy reviews_update_own on public.product_reviews
  for update to authenticated
  using ((user_id = auth.uid() and status = 'pending') or public.is_staff())
  with check (user_id = auth.uid() or public.is_staff());
create policy reviews_delete_own on public.product_reviews
  for delete to authenticated using (user_id = auth.uid() or public.is_staff());

-- ------------------------------------------------------ audit logs
create policy audit_staff_read on public.audit_logs
  for select to authenticated using (public.is_staff());

-- order_counters and email_queue intentionally have no policies:
-- unreachable with the anon/authenticated keys, by design.

-- =====================================================================
-- GRANTS  (RLS decides rows; grants decide whether the table is visible)
-- =====================================================================
grant usage on schema public to anon, authenticated;

grant select on
  public.app_settings, public.categories, public.products, public.product_variants,
  public.product_images, public.delivery_zones, public.loyalty_tiers,
  public.loyalty_rewards, public.product_reviews, public.v_variant_availability
to anon, authenticated;

grant select, insert, update, delete on
  public.addresses, public.cart_items, public.wishlist_items, public.product_reviews
to authenticated;

grant select, insert, update on public.carts to authenticated;
grant select, update on public.notifications to authenticated;
grant select on
  public.profiles, public.orders, public.order_items, public.order_status_history,
  public.loyalty_accounts, public.loyalty_transactions, public.coupons,
  public.coupon_redemptions, public.referrals, public.audit_logs
to authenticated;
grant update on public.profiles to authenticated;

-- Staff-only tables still need a grant for the policies to matter.
grant select, insert, update, delete on
  public.order_admin_notes, public.categories, public.products, public.product_variants,
  public.product_images, public.coupons, public.delivery_zones, public.loyalty_tiers,
  public.loyalty_rewards, public.app_settings, public.orders
to authenticated;

-- RPC surface
grant execute on function public.get_or_create_cart()                      to authenticated;
grant execute on function public.preview_cart(uuid, text, uuid)            to authenticated;
grant execute on function public.apply_coupon_to_cart(text)                to authenticated;
grant execute on function public.redeem_loyalty_reward(uuid)               to authenticated;
grant execute on function public.place_order(uuid, public.payment_method, text, text, uuid)
                                                                           to authenticated;
grant execute on function public.cancel_my_order(uuid, text)               to authenticated;
grant execute on function public.reorder(uuid)                             to authenticated;
grant execute on function public.get_loyalty_card()                        to authenticated;
grant execute on function public.validate_coupon(text, numeric, uuid)      to authenticated;
grant execute on function public.track_order(text, text)                   to anon, authenticated;
grant execute on function public.resolve_delivery_zone(text)               to anon, authenticated;

grant execute on function public.admin_update_order_status(
  uuid, public.order_status, text, text, text, text, timestamptz)          to authenticated;
grant execute on function public.admin_adjust_loyalty(uuid, integer, text) to authenticated;
grant execute on function public.admin_set_stock(uuid, integer, text)      to authenticated;
grant execute on function public.admin_dashboard_stats(integer)            to authenticated;

-- Maintenance routines are for the service role (Edge Functions) only.
revoke execute on function public.expire_loyalty_points()   from public, anon, authenticated;
revoke execute on function public.notify_expiring_points()  from public, anon, authenticated;
revoke execute on function public.grant_birthday_bonus()    from public, anon, authenticated;
revoke execute on function public.price_cart(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.enqueue_email(text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.write_audit(text, text, uuid, jsonb, jsonb)
  from public, anon, authenticated;
