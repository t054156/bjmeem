-- =====================================================================
-- BJmeem 0013 — owner/admin/staff permissions, admin RPCs, realtime
--
-- Extends the existing schema. No tables are duplicated: products,
-- product_variants, orders, loyalty_* etc. all already exist.
-- =====================================================================

-- Granular staff permissions. owner/admin ignore this; staff are gated by it.
alter table public.profiles
  add column if not exists permissions jsonb not null default '{}'::jsonb;

comment on column public.profiles.permissions is
  'Staff-only capability map, e.g. {"orders":true,"products":false}. Ignored for owner/admin.';

-- --------------------------------------------------------- role helpers
-- owner is a superset of admin. Re-created so every existing RLS policy that
-- calls is_admin()/is_staff() picks the new role up with no policy changes.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_role() in ('owner', 'admin');
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_role() in ('owner', 'admin', 'staff');
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.auth_role() = 'owner';
$$;

/** owner/admin always true; staff only where their permission map says so. */
create or replace function public.has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.auth_role() in ('owner', 'admin') then true
    when public.auth_role() = 'staff' then coalesce(
      (select (permissions ->> p_key)::boolean from public.profiles where id = auth.uid()),
      false)
    else false
  end;
$$;

grant execute on function public.is_owner()            to authenticated;
grant execute on function public.has_permission(text)  to authenticated;

-- Only an owner may change roles or staff permissions.
create or replace function public.admin_set_role(
  p_user_id uuid,
  p_role    public.user_role,
  p_permissions jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old public.user_role;
begin
  if not public.is_owner() then
    raise exception 'FORBIDDEN: only the owner can change roles' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'CANNOT_CHANGE_OWN_ROLE' using errcode = 'P0001';
  end if;

  select role into v_old from public.profiles where id = p_user_id;
  if v_old is null then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform set_config('bjmeem.privileged', 'on', true);
  update public.profiles
     set role = p_role,
         permissions = coalesce(p_permissions, permissions)
   where id = p_user_id;
  perform set_config('bjmeem.privileged', 'off', true);

  perform public.write_audit('role_change', 'profiles', p_user_id,
    jsonb_build_object('role', v_old),
    jsonb_build_object('role', p_role, 'permissions', p_permissions));

  return jsonb_build_object('user_id', p_user_id, 'role', p_role);
end;
$$;

grant execute on function public.admin_set_role(uuid, public.user_role, jsonb) to authenticated;

-- =====================================================================
-- DASHBOARD OVERVIEW  (§2)
-- =====================================================================
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz    text := 'Asia/Kuwait';
  v_today date := (now() at time zone v_tz)::date;
  v_month date := date_trunc('month', (now() at time zone v_tz))::date;
  v_low   integer := public.setting_numeric('inventory.low_stock_threshold', 5)::integer;
  -- Cancelled / returned / refunded never count as revenue.
  v_paidish public.order_status[] :=
    array['pending','confirmed','preparing','packed','out_for_delivery','delivered']::public.order_status[];
begin
  if not public.is_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'orders_today', (select count(*) from public.orders
       where (created_at at time zone v_tz)::date = v_today),

    'status_counts', (
      select coalesce(jsonb_object_agg(s.status, s.c), '{}'::jsonb)
      from (select order_status::text as status, count(*) c
            from public.orders group by order_status) s),

    'open_counts', jsonb_build_object(
      'pending',          (select count(*) from public.orders where order_status = 'pending'),
      'confirmed',        (select count(*) from public.orders where order_status = 'confirmed'),
      'preparing',        (select count(*) from public.orders where order_status = 'preparing'),
      'packed',           (select count(*) from public.orders where order_status = 'packed'),
      'out_for_delivery', (select count(*) from public.orders where order_status = 'out_for_delivery'),
      'delivered',        (select count(*) from public.orders where order_status = 'delivered'),
      'cancelled',        (select count(*) from public.orders where order_status = 'cancelled')),

    'revenue_today', (select coalesce(sum(total_amount), 0) from public.orders
       where (created_at at time zone v_tz)::date = v_today
         and order_status = any (v_paidish)),

    'revenue_month', (select coalesce(sum(total_amount), 0) from public.orders
       where (created_at at time zone v_tz)::date >= v_month
         and order_status = any (v_paidish)),

    'total_customers', (select count(*) from public.profiles where role = 'customer'),
    'total_products',  (select count(*) from public.products),
    'active_products', (select count(*) from public.products where is_active),

    'low_stock_count', (select count(*) from public.v_variant_availability
       where is_active and available_quantity between 1 and v_low),
    'out_of_stock_count', (select count(*) from public.v_variant_availability
       where is_active and available_quantity <= 0),
    'low_stock_threshold', v_low,

    'recent_orders', (
      select coalesce(jsonb_agg(o order by o.created_at desc), '[]'::jsonb)
      from (select id, order_number, customer_name, total_amount,
                   order_status::text as order_status, created_at
            from public.orders order by created_at desc limit 8) o),

    -- "Teddy Pink Set – M – Only 2 left"
    'low_stock_alerts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'variant_id', a.variant_id, 'product_id', a.product_id,
               'product_name', a.name, 'size', a.size, 'color', a.color,
               'sku', a.sku, 'available', a.available_quantity,
               'label', a.name || ' – ' || a.color || ' / ' || a.size ||
                        ' – Only ' || a.available_quantity || ' left')), '[]'::jsonb)
      from (select v.*, p.name
            from public.v_variant_availability v
            join public.products p on p.id = v.product_id
            where v.is_active and p.is_active
              and v.available_quantity between 0 and v_low
            order by v.available_quantity asc, p.name asc
            limit 12) a));
end;
$$;

grant execute on function public.admin_overview() to authenticated;

-- =====================================================================
-- REPORTS  (§16)
-- =====================================================================
create or replace function public.admin_sales_report(
  p_from timestamptz default (now() - interval '30 days'),
  p_to   timestamptz default now(),
  p_granularity text default 'day')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bucket text := case lower(coalesce(p_granularity, 'day'))
                     when 'week'  then 'week'
                     when 'month' then 'month'
                     else 'day' end;
  v_paidish public.order_status[] :=
    array['pending','confirmed','preparing','packed','out_for_delivery','delivered']::public.order_status[];
begin
  if not public.is_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'granularity', v_bucket,
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'bucket', b.bucket, 'orders', b.orders, 'revenue', b.revenue)
               order by b.bucket), '[]'::jsonb)
      from (select date_trunc(v_bucket, created_at) as bucket,
                   count(*) as orders,
                   coalesce(sum(total_amount), 0) as revenue
            from public.orders
            where created_at between p_from and p_to
              and order_status = any (v_paidish)
            group by 1) b),
    'totals', (
      select jsonb_build_object(
        'orders', count(*),
        'revenue', coalesce(sum(total_amount), 0),
        'average_order_value', coalesce(round(avg(total_amount), 3), 0),
        'items_sold', coalesce((select sum(oi.quantity) from public.order_items oi
                                join public.orders o2 on o2.id = oi.order_id
                                where o2.created_at between p_from and p_to
                                  and o2.order_status = any (v_paidish)), 0))
      from public.orders
      where created_at between p_from and p_to and order_status = any (v_paidish)),
    'excluded', jsonb_build_object(
      'cancelled', (select count(*) from public.orders
                    where created_at between p_from and p_to and order_status = 'cancelled'),
      'refunded',  (select count(*) from public.orders
                    where created_at between p_from and p_to
                      and order_status in ('refunded','returned'))));
end;
$$;

create or replace function public.admin_best_sellers(
  p_days integer default 30,
  p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_paidish public.order_status[] :=
    array['pending','confirmed','preparing','packed','out_for_delivery','delivered']::public.order_status[];
begin
  if not public.is_staff() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'products', (
      select coalesce(jsonb_agg(x order by x.units desc), '[]'::jsonb) from (
        select oi.product_name as name, sum(oi.quantity)::int as units,
               round(sum(oi.total_price), 3) as revenue
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where o.created_at >= v_from and o.order_status = any (v_paidish)
        group by oi.product_name order by units desc limit p_limit) x),
    'sizes', (
      select coalesce(jsonb_agg(x order by x.units desc), '[]'::jsonb) from (
        select oi.size as name, sum(oi.quantity)::int as units
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where o.created_at >= v_from and o.order_status = any (v_paidish)
        group by oi.size order by units desc) x),
    'colors', (
      select coalesce(jsonb_agg(x order by x.units desc), '[]'::jsonb) from (
        select oi.color as name, sum(oi.quantity)::int as units
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where o.created_at >= v_from and o.order_status = any (v_paidish)
        group by oi.color order by units desc) x));
end;
$$;

grant execute on function public.admin_sales_report(timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_best_sellers(integer, integer)               to authenticated;

-- =====================================================================
-- PRODUCT + VARIANT OPERATIONS  (§3, §5)
-- =====================================================================

/** Duplicate a product with all its variants and images, as a hidden draft. */
create or replace function public.admin_duplicate_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new uuid;
  v_slug text;
  v_name text;
  i integer := 1;
begin
  if not public.has_permission('products') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select name || ' (copy)', slug || '-copy' into v_name, v_slug
  from public.products where id = p_product_id;

  if v_name is null then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  while exists (select 1 from public.products where slug = v_slug) loop
    i := i + 1;
    v_slug := (select slug from public.products where id = p_product_id) || '-copy-' || i;
  end loop;

  insert into public.products (
    name, slug, description, category_id, price, compare_at_price, cost_price,
    material, fabric, pattern, care_instructions,
    is_active, is_featured, is_new_arrival, is_best_seller)
  select v_name, v_slug, description, category_id, price, compare_at_price, cost_price,
         material, fabric, pattern, care_instructions,
         false,          -- copies start hidden so a half-finished draft never goes live
         is_featured, is_new_arrival, is_best_seller
  from public.products where id = p_product_id
  returning id into v_new;

  insert into public.product_variants (product_id, size, color, sku, stock_quantity, price_override, is_active)
  select v_new, size, color,
         sku || '-C' || substr(replace(v_new::text, '-', ''), 1, 4),
         0,             -- a copy starts with no stock
         price_override, is_active
  from public.product_variants where product_id = p_product_id;

  insert into public.product_images (product_id, image_url, alt_text, sort_order, is_primary)
  select v_new, image_url, alt_text, sort_order, is_primary
  from public.product_images where product_id = p_product_id;

  perform public.write_audit('duplicate', 'products', v_new,
    jsonb_build_object('source', p_product_id), jsonb_build_object('slug', v_slug));

  return jsonb_build_object('product_id', v_new, 'slug', v_slug, 'name', v_name);
end;
$$;

/** Create or update a variant. Refuses to drop stock below what live orders hold. */
create or replace function public.admin_upsert_variant(
  p_product_id uuid,
  p_size text,
  p_color text,
  p_sku text,
  p_stock_quantity integer,
  p_variant_id uuid default null,
  p_price_override numeric default null,
  p_is_active boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_old public.product_variants;
begin
  if not public.has_permission('inventory') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_stock_quantity < 0 then
    raise exception 'NEGATIVE_STOCK' using errcode = 'P0001';
  end if;

  if p_variant_id is not null then
    select * into v_old from public.product_variants where id = p_variant_id for update;
    if v_old.id is null then
      raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if p_stock_quantity < v_old.reserved_quantity then
      raise exception 'STOCK_BELOW_RESERVED: % units are held by live orders',
        v_old.reserved_quantity using errcode = 'P0001';
    end if;

    update public.product_variants
       set size = p_size, color = p_color, sku = p_sku,
           stock_quantity = p_stock_quantity,
           price_override = p_price_override,
           is_active = p_is_active
     where id = p_variant_id
    returning id into v_id;

    perform public.write_audit('variant_update', 'product_variants', v_id,
      to_jsonb(v_old), jsonb_build_object('stock_quantity', p_stock_quantity,
        'size', p_size, 'color', p_color, 'is_active', p_is_active));
  else
    insert into public.product_variants (
      product_id, size, color, sku, stock_quantity, price_override, is_active)
    values (p_product_id, p_size, p_color, p_sku, p_stock_quantity, p_price_override, p_is_active)
    returning id into v_id;

    perform public.write_audit('variant_create', 'product_variants', v_id, null,
      jsonb_build_object('product_id', p_product_id, 'size', p_size,
                         'color', p_color, 'stock_quantity', p_stock_quantity));
  end if;

  return (select jsonb_build_object(
            'variant_id', v.variant_id, 'sku', v.sku, 'size', v.size, 'color', v.color,
            'stock_quantity', v.stock_quantity, 'reserved_quantity', v.reserved_quantity,
            'available_quantity', v.available_quantity)
          from public.v_variant_availability v where v.variant_id = v_id);
end;
$$;

/** Show/hide a product. Never deletes — the row stays for history and reporting. */
create or replace function public.admin_set_product_visibility(
  p_product_id uuid, p_is_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_old boolean;
begin
  if not public.has_permission('products') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select is_active into v_old from public.products where id = p_product_id;
  if v_old is null then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.products set is_active = p_is_active where id = p_product_id;

  perform public.write_audit(
    case when p_is_active then 'product_show' else 'product_hide' end,
    'products', p_product_id,
    jsonb_build_object('is_active', v_old), jsonb_build_object('is_active', p_is_active));

  return jsonb_build_object('product_id', p_product_id, 'is_active', p_is_active);
end;
$$;

grant execute on function public.admin_duplicate_product(uuid)                        to authenticated;
grant execute on function public.admin_upsert_variant(
  uuid, text, text, text, integer, uuid, numeric, boolean)                            to authenticated;
grant execute on function public.admin_set_product_visibility(uuid, boolean)          to authenticated;

-- =====================================================================
-- STAFF PERMISSION GATES on the existing admin RPCs
-- =====================================================================
-- admin_adjust_loyalty already requires is_admin(); widen to permission-based
-- so a trusted staff member can be granted loyalty rights without full admin.
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
  if not public.has_permission('loyalty') then
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

-- =====================================================================
-- REALTIME  (§22)
-- Guarded: the publication only exists on a real Supabase project.
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.orders;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.notifications;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.product_variants;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- Realtime respects RLS, so staff receive order events and customers do not.
alter table public.orders            replica identity full;
alter table public.product_variants  replica identity full;

-- =====================================================================
-- INDEXES for the admin search paths (§17)
-- =====================================================================
create index if not exists orders_customer_name_idx  on public.orders (lower(customer_name));
create index if not exists profiles_name_idx         on public.profiles (lower(first_name), lower(last_name));
create index if not exists profiles_phone_idx        on public.profiles (phone_number);
create index if not exists variants_sku_lower_idx    on public.product_variants (lower(sku));
create index if not exists products_name_lower_idx   on public.products (lower(name));
